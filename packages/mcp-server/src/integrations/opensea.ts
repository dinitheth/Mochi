import type { Env } from '../config/env.js';

const API_BASE = 'https://api.opensea.io/api/v2';

export interface OpenSeaListing {
  collectionSlug: string;
  orderHash: string;
  contractAddress: string;
  tokenId: string;
  currency: string;
  currencyDecimals: number;
  priceRaw: string;
  protocolAddress: string | null;
  openseaUrl: string;
}

export interface OpenSeaNativeBuyTransaction {
  to: `0x${string}`;
  data: `0x${string}`;
  value: bigint;
  quotedPriceRaw: bigint;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

async function openSeaRequest(env: Env, path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  if (!env.OPENSEA_API_KEY) throw new Error('Set OPENSEA_API_KEY to enable OpenSea marketplace integration.');
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'x-api-key': env.OPENSEA_API_KEY,
      accept: 'application/json',
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
    signal: AbortSignal.timeout(15_000),
  });
  const payload = record(await response.json().catch(() => null));
  if (!response.ok) {
    const detail = typeof payload?.detail === 'string' ? payload.detail :
      typeof payload?.message === 'string' ? payload.message : `HTTP ${response.status}`;
    throw new Error(`OpenSea request failed: ${detail}`);
  }
  if (!payload) throw new Error('OpenSea returned an invalid response.');
  return payload;
}

function parseWei(value: unknown, field: string): bigint {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && (/^\d+$/.test(value) || /^0x[0-9a-f]+$/i.test(value))) return BigInt(value);
  throw new Error(`OpenSea returned an invalid ${field}.`);
}

/** Build one same-chain native-MON purchase transaction and bind it to a fresh active listing. */
export async function getOpenSeaNativeBuyTransaction(
  env: Env,
  input: {
    orderHash: string;
    protocolAddress: `0x${string}`;
    contractAddress: `0x${string}`;
    tokenId: string;
    fulfiller: `0x${string}`;
  },
): Promise<OpenSeaNativeBuyTransaction> {
  if (!/^0x[0-9a-f]{64}$/i.test(input.orderHash)) throw new Error('orderHash must be a 32-byte hex order hash.');
  if (!/^\d+$/.test(input.tokenId)) throw new Error('tokenId must be a non-negative integer.');

  const protocol = input.protocolAddress.toLowerCase();
  const orderPayload = await openSeaRequest(
    env,
    `/orders/chain/monad/protocol/${encodeURIComponent(input.protocolAddress)}/${encodeURIComponent(input.orderHash)}`,
  );
  const order = record(orderPayload.order);
  const asset = record(order?.asset);
  const price = record(order?.price);
  const current = record(price?.current);
  if (
    order?.chain !== 'monad' || order.status !== 'ACTIVE' ||
    typeof order.order_hash !== 'string' || order.order_hash.toLowerCase() !== input.orderHash.toLowerCase() ||
    typeof order.protocol_address !== 'string' || order.protocol_address.toLowerCase() !== protocol ||
    typeof asset?.contract !== 'string' || asset.contract.toLowerCase() !== input.contractAddress.toLowerCase() ||
    asset.identifier !== input.tokenId || current?.currency !== 'MON' || current.decimals !== 18
  ) {
    throw new Error('OpenSea order is not an active Monad listing for the specified NFT, protocol, and native MON currency.');
  }
  const quotedPriceRaw = parseWei(current.value, 'listing price');

  const fulfillment = await openSeaRequest(env, '/listings/cross_chain_fulfillment_data', {
    method: 'POST',
    body: JSON.stringify({
      listings: [{ hash: input.orderHash, chain: 'monad', protocol_address: input.protocolAddress }],
      fulfiller: { address: input.fulfiller },
      payment: { chain: 'monad', token_address: '0x0000000000000000000000000000000000000000' },
    }),
  });
  if (!Array.isArray(fulfillment.transactions) || fulfillment.transactions.length !== 1) {
    throw new Error('OpenSea did not return exactly one same-chain purchase transaction; refusing a multi-step or cross-chain flow.');
  }
  const tx = record(fulfillment.transactions[0]);
  if (
    tx?.chain !== 'monad' || typeof tx.to !== 'string' || !/^0x[0-9a-f]{40}$/i.test(tx.to) ||
    tx.to.toLowerCase() !== protocol || typeof tx.data !== 'string' || !/^0x[0-9a-f]+$/i.test(tx.data) || tx.data.length < 10
  ) {
    throw new Error('OpenSea returned an unexpected chain, target, or calldata for the Monad purchase.');
  }
  const value = parseWei(tx.value, 'transaction value');
  if (value <= 0n || value !== quotedPriceRaw) {
    throw new Error('OpenSea transaction value did not exactly match the active listing price.');
  }
  return { to: tx.to as `0x${string}`, data: tx.data as `0x${string}`, value, quotedPriceRaw };
}

/** Read active Monad collection listings from OpenSea's documented v2 API. */
export async function listOpenSeaMonadListings(
  env: Env,
  collectionSlug: string,
  limit: number,
): Promise<OpenSeaListing[]> {
  if (!env.OPENSEA_API_KEY) throw new Error('Set OPENSEA_API_KEY to enable OpenSea marketplace discovery.');
  const slug = collectionSlug.trim();
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/i.test(slug)) throw new Error('collectionSlug must be a valid OpenSea collection slug.');

  const url = new URL(`${API_BASE}/listings/collection/${encodeURIComponent(slug)}/all`);
  url.searchParams.set('limit', String(limit));
  const response = await fetch(url, {
    headers: { 'x-api-key': env.OPENSEA_API_KEY, accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  const payload = record(await response.json().catch(() => null));
  if (!response.ok) {
    const detail = typeof payload?.detail === 'string' ? payload.detail :
      typeof payload?.message === 'string' ? payload.message : `HTTP ${response.status}`;
    throw new Error(`OpenSea listings request failed: ${detail}`);
  }
  if (!Array.isArray(payload?.listings)) throw new Error('OpenSea returned an invalid listings response.');

  const out: OpenSeaListing[] = [];
  for (const raw of payload.listings) {
    const listing = record(raw);
    if (!listing || listing.chain !== 'monad' || listing.status !== 'ACTIVE') continue;
    const asset = record(listing.asset);
    const price = record(listing.price);
    const current = record(price?.current);
    if (
      typeof listing.order_hash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(listing.order_hash) ||
      typeof asset?.contract !== 'string' || !/^0x[0-9a-f]{40}$/i.test(asset.contract) ||
      typeof asset.identifier !== 'string' || !/^\d+$/.test(asset.identifier) ||
      typeof current?.currency !== 'string' ||
      typeof current.value !== 'string' || !/^\d+$/.test(current.value) ||
      typeof current.decimals !== 'number' || !Number.isInteger(current.decimals) || current.decimals < 0 || current.decimals > 36
    ) continue;
    out.push({
      collectionSlug: slug,
      orderHash: listing.order_hash,
      contractAddress: asset.contract,
      tokenId: asset.identifier,
      currency: current.currency,
      currencyDecimals: current.decimals,
      priceRaw: current.value,
      protocolAddress: typeof listing.protocol_address === 'string' && /^0x[0-9a-f]{40}$/i.test(listing.protocol_address)
        ? listing.protocol_address
        : null,
      openseaUrl: `https://opensea.io/collection/${encodeURIComponent(slug)}`,
    });
  }
  return out;
}
