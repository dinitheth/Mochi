import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { encodeFunctionData, formatEther, parseEther } from 'viem';
import type { Env } from '../../config/env.js';
import { explorerAddressUrl, explorerTxUrl, getPublicClient } from '../../config/monad.js';
import { getNftMarketConfig } from '../../config/nft.js';
import { addToRegistry, readRegistry } from '../../config/collections.js';
import { loadArtifact } from '../../config/artifacts.js';
import { privySendTransaction } from '../../config/privy.js';
import { approvalGate } from '../../middleware/approval-gate.js';
import { auditLog } from '../../middleware/audit-log.js';
import { ERC721_ABI, addTool, assertAddress, formatTokenUnits, resolveWallet, textResult } from '../shared.js';
import { simulateTx, type SimResult } from '../../middleware/simulate.js';
import { getOpenSeaNativeBuyTransaction, listOpenSeaMonadListings } from '../../integrations/opensea.js';

const MARKET_ABI = [
  {
    type: 'function',
    name: 'getListing',
    stateMutability: 'view',
    inputs: [
      { name: 'nft', type: 'address' },
      { name: 'tokenId', type: 'uint256' },
    ],
    outputs: [
      { name: 'seller', type: 'address' },
      { name: 'price', type: 'uint256' },
      { name: 'active', type: 'bool' },
    ],
  },
  {
    type: 'function',
    name: 'buy',
    stateMutability: 'payable',
    inputs: [
      { name: 'nft', type: 'address' },
      { name: 'tokenId', type: 'uint256' },
    ],
    outputs: [],
  },
] as const;

const AUCTION_ABI = [
  {
    type: 'function',
    name: 'getAuction',
    stateMutability: 'view',
    inputs: [{ name: 'auctionId', type: 'uint256' }],
    outputs: [
      { name: 'seller', type: 'address' },
      { name: 'nft', type: 'address' },
      { name: 'tokenId', type: 'uint256' },
      { name: 'reserve', type: 'uint256' },
      { name: 'highestBid', type: 'uint256' },
      { name: 'highestBidder', type: 'address' },
      { name: 'endTime', type: 'uint64' },
      { name: 'settled', type: 'bool' },
    ],
  },
  {
    type: 'function',
    name: 'auctionCount',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'bid',
    stateMutability: 'payable',
    inputs: [{ name: 'auctionId', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'settle',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'auctionId', type: 'uint256' }],
    outputs: [],
  },
] as const;

const OWNER_OF_ABI = [  {
    type: 'function',
    name: 'ownerOf',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'nextTokenId',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
] as const;

interface CollectionStat {
  name: string;
  contractAddress: string;
  floorMON: string;
  volume24hMON: string;
  holders: number;
  momentum: string;
  why: string;
}

async function fetchNansenCollections(env: Env): Promise<CollectionStat[] | null> {
  if (!env.NANSEN_API_KEY) return null;
  try {
    const res = await fetch('https://api.nansen.ai/api/v1/nft/collections?chain=monad&orderBy=volume24h&limit=5', {
      headers: { Authorization: `Bearer ${env.NANSEN_API_KEY}`, accept: 'application/json' },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { collections?: Array<Record<string, unknown>> };
    if (!Array.isArray(data.collections)) return null;
    return data.collections.slice(0, 5).map((c) => ({
      name: String(c.name ?? c.collection ?? 'Unknown'),
      contractAddress: String(c.contract ?? c.address ?? ''),
      floorMON: String(c.floorPrice ?? c.floor ?? '0'),
      volume24hMON: String(c.volume24h ?? c.volume ?? '0'),
      holders: Number(c.holders ?? 0),
      momentum: String(c.trend ?? 'unknown'),
      why: 'Ranked by 24h volume via Nansen.',
    }));
  } catch {
    return null;
  }
}

/** Live scan of our MicroMarket: active listings for tokenIds 1..cap. */
async function scanLocalListings(
  env: Env,
  collection: `0x${string}`,
  market: `0x${string}`,
  cap = 25,
): Promise<Array<{ tokenId: string; priceWei: bigint; seller: string }>> {
  const client = getPublicClient(env);
  const out: Array<{ tokenId: string; priceWei: bigint; seller: string }> = [];
  for (let i = 1; i <= cap; i++) {
    try {
      const [seller, price, active] = (await client.readContract({
        address: market,
        abi: MARKET_ABI,
        functionName: 'getListing',
        args: [collection, BigInt(i)],
      })) as [string, bigint, boolean];
      if (active) out.push({ tokenId: String(i), priceWei: price, seller });
    } catch {
      continue;
    }
  }
  return out;
}

export function registerNFTTools(server: McpServer, env: Env): void {
  addTool(
    server,
    'nft_opensea_listings',
    'Find active Monad NFT listings for an OpenSea collection. Read-only discovery; does not buy or prepare a transaction.',
    {
      collectionSlug: z.string().min(1).max(100).describe('OpenSea collection slug from opensea.io/collection/...'),
      limit: z.number().int().min(1).max(50).default(10).describe('Maximum active Monad listings to return'),
    },
    async ({ collectionSlug, limit }: { collectionSlug: string; limit: number }) => {
      try {
        if (env.MONAD_NETWORK !== 'mainnet') throw new Error('OpenSea Monad listings are available only when MONAD_NETWORK=mainnet.');
        const listings = await listOpenSeaMonadListings(env, collectionSlug, limit);
        await auditLog({ tool: 'nft_opensea_listings', result: 'ok', params: { collectionSlug, limit, resultCount: listings.length, network: 'mainnet' } });
        return textResult({
          ok: true,
          provider: 'OpenSea',
          network: 'Monad mainnet (143)',
          collectionSlug,
          listings,
          summary: listings.length
            ? `Found ${listings.length} active Monad listing${listings.length === 1 ? '' : 's'} for ${collectionSlug} on OpenSea. Read-only market data; verify again before purchase.`
            : `No active Monad listings were returned for ${collectionSlug}.`,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await auditLog({ tool: 'nft_opensea_listings', result: 'error', error: message, params: { collectionSlug } });
        return textResult({ ok: false, error: message });
      }
    },
  );

  addTool(
    server,
    'nft_opensea_buy',
    'Buy one active OpenSea Monad NFT listing with native MON. Rechecks the order after mandatory human approval, simulates the exact transaction, and rejects ERC20 or multi-transaction fulfillment.',
    {
      orderHash: z.string().describe('OpenSea Seaport order hash from nft_opensea_listings'),
      protocolAddress: z.string().describe('OpenSea protocol_address for the listing'),
      contractAddress: z.string().describe('NFT contract address from the listing'),
      tokenId: z.string().describe('NFT token ID from the listing'),
      maxPriceMON: z.string().describe('Maximum listing price in MON; purchase is refused above this amount'),
      userId: z.string().optional().describe('User/session id owning the wallet'),
    },
    async ({ orderHash, protocolAddress, contractAddress, tokenId, maxPriceMON, userId }: { orderHash: string; protocolAddress: string; contractAddress: string; tokenId: string; maxPriceMON: string; userId?: string }) => {
      try {
        if (env.MONAD_NETWORK !== 'mainnet') throw new Error('OpenSea purchases are available only when MONAD_NETWORK=mainnet.');
        assertAddress(protocolAddress, 'protocolAddress');
        assertAddress(contractAddress, 'contractAddress');
        if (!/^0x[0-9a-f]{64}$/i.test(orderHash)) throw new Error('Invalid OpenSea order hash.');
        if (!/^\d+$/.test(tokenId)) throw new Error('tokenId must be an integer.');
        const maxPrice = parseEther(maxPriceMON);
        if (maxPrice <= 0n) throw new Error('maxPriceMON must be greater than zero.');
        const wallet = await resolveWallet(env, userId);
        const client = getPublicClient(env);
        const chainId = await client.getChainId();
        if (chainId !== 143) throw new Error(`Configured RPC returned chain ID ${chainId}; expected Monad mainnet (143).`);

        const firstTx = await getOpenSeaNativeBuyTransaction(env, {
          orderHash,
          protocolAddress: protocolAddress as `0x${string}`,
          contractAddress: contractAddress as `0x${string}`,
          tokenId,
          fulfiller: wallet.address as `0x${string}`,
        });
        if (firstTx.value > maxPrice) throw new Error(`Active listing costs ${formatEther(firstTx.value)} MON, above your ${maxPriceMON} MON maximum.`);
        const firstSimulation = await simulateTx(env, { from: wallet.address, to: firstTx.to, value: firstTx.value, data: firstTx.data });
        if (!firstSimulation.ok) throw new Error(`OpenSea purchase simulation failed; no transaction was sent: ${firstSimulation.reason}`);

        const gate = await approvalGate({
          action: 'nft_buy',
          details: {
            network: 'Monad mainnet (143)',
            marketplace: 'OpenSea',
            buyer: wallet.address,
            orderHash,
            nft: contractAddress,
            tokenId,
            quotedPriceMON: formatEther(firstTx.value),
            maxPriceMON,
            currency: 'MON',
            transactionTarget: firstTx.to,
            simulation: `SAFE_TO_SEND; estimated fee ${formatEther(firstSimulation.feeWei)} MON`,
          },
          valueWei: firstTx.value,
          forceApproval: true,
          env,
          reason: `Buy OpenSea Monad NFT ${contractAddress} #${tokenId} for ${formatEther(firstTx.value)} MON (maximum ${maxPriceMON} MON)`,
          userId,
        });
        if (gate.decision !== 'approved') {
          await auditLog({ tool: 'nft_opensea_buy', userId, result: 'rejected', params: { orderHash, contractAddress, tokenId, priceWei: firstTx.value.toString() } });
          return textResult({ ok: false, approvalRequired: true, requestId: gate.requestId, summary: `OpenSea purchase not sent. ${gate.message}` });
        }

        // Do not execute stale API output after a potentially long human approval.
        const freshTx = await getOpenSeaNativeBuyTransaction(env, {
          orderHash,
          protocolAddress: protocolAddress as `0x${string}`,
          contractAddress: contractAddress as `0x${string}`,
          tokenId,
          fulfiller: wallet.address as `0x${string}`,
        });
        if (freshTx.value > maxPrice || freshTx.value > firstTx.value || freshTx.to !== firstTx.to || freshTx.data !== firstTx.data) {
          throw new Error('Listing terms or calldata changed after approval. Request a fresh approval.');
        }
        const simulation = await simulateTx(env, { from: wallet.address, to: freshTx.to, value: freshTx.value, data: freshTx.data });
        if (!simulation.ok) throw new Error(`Fresh OpenSea purchase simulation failed; nothing was sent: ${simulation.reason}`);
        const hash = await privySendTransaction(env, wallet, { to: freshTx.to, value: freshTx.value, data: freshTx.data });
        const receipt = await client.waitForTransactionReceipt({ hash });
        if (receipt.status !== 'success') throw new Error(`OpenSea purchase reverted: ${hash}`);
        await auditLog({ tool: 'nft_opensea_buy', userId, result: 'ok', txHash: hash, params: { orderHash, contractAddress, tokenId, priceWei: freshTx.value.toString() } });
        return textResult({
          ok: true,
          provider: 'OpenSea',
          network: 'Monad mainnet (143)',
          orderHash,
          nft: { contractAddress, tokenId },
          priceMON: formatEther(freshTx.value),
          maxPriceMON,
          txHash: hash,
          explorerUrl: explorerTxUrl(env, hash),
          simulatedFeeMON: formatEther(simulation.feeWei),
          blockNumber: receipt.blockNumber.toString(),
          summary: `Bought ${contractAddress} #${tokenId} on OpenSea for ${formatEther(freshTx.value)} MON. Transaction: ${explorerTxUrl(env, hash)}`,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await auditLog({ tool: 'nft_opensea_buy', userId, result: 'error', error: message, params: { orderHash, contractAddress, tokenId } });
        return textResult({ ok: false, error: message });
      }
    },
  );

  addTool(
    server,
    'nft_research_collections',
    'Research top NFT collections on Monad: live MicroMarket listings on testnet, Nansen when configured, else labeled fallback.',
    {
      limit: z.number().int().min(1).max(10).default(5).describe('How many collections to return'),
    },
    async ({ limit }: { limit: number }) => {
      try {
        const live = await fetchNansenCollections(env);
        if (live) {
          await auditLog({ tool: 'nft_research_collections', result: 'ok', params: { limit, source: 'nansen-live' } });
          const top = live[0];
          return textResult({
            ok: true,
            source: 'nansen-live',
            collections: live.slice(0, limit),
            recommendation: top ? `${top.name}: floor ${top.floorMON} MON, 24h vol ${top.volume24hMON} MON, ${top.momentum}. ${top.why}` : null,
            summary: `Top ${Math.min(limit, live.length)} Monad collections by 24h volume (live, Nansen). Top pick: ${top?.name} @ ${top?.floorMON} MON floor.`,
          });
        }

        // Live local markets on testnet (V2 first, then legacy).
        const nmc = getNftMarketConfig(env);
        const listings: Array<{ tokenId: string; priceWei: bigint; seller: string; market: string }> = [];
        for (const mkt of nmc.markets.length > 0 ? nmc.markets : []) {
          const found = await scanLocalListings(env, nmc.collection, mkt);
          for (const l of found) listings.push({ ...l, market: mkt });
        }
          // Launched collections from the registry (first 10 ids each, first market).
          try {
            const regMarket = nmc.markets[0];
            if (regMarket) {
              const reg = await readRegistry();
              for (const entry of Object.values(reg)) {
                if (entry.address.toLowerCase() === nmc.collection.toLowerCase()) continue;
                const found = await scanLocalListings(env, entry.address as `0x${string}`, regMarket, 10);
                for (const l of found) {
                  listings.push({ ...l, market: regMarket, collectionName: entry.name, collectionAddress: entry.address } as unknown as { tokenId: string; priceWei: bigint; seller: string; market: string });
                }
              }
            }
          } catch {
            /* registry optional */
          }
          // Live auctions (id 1..count, cap 25).
          const auctions: Array<Record<string, string>> = [];
          if (nmc.auctionHouse) {
            try {
              const client = getPublicClient(env);
              const count = (await client.readContract({ address: nmc.auctionHouse, abi: AUCTION_ABI, functionName: 'auctionCount' })) as bigint;
              const cap = count > 25n ? 25n : count;
              for (let i = 1n; i <= cap; i++) {
                try {
                  const row = (await client.readContract({ address: nmc.auctionHouse as `0x${string}`, abi: AUCTION_ABI, functionName: 'getAuction', args: [i] })) as unknown as [string, string, bigint, bigint, bigint, string, number, boolean];
                  const [seller, nftA, tokenIdA, reserveA, highestBidA, highestBidderA, endTimeA, settledA] = row;
                  if (seller !== '0x0000000000000000000000000000000000000000' && !settledA) {
                    auctions.push({
                      auctionId: i.toString(),
                      nft: nftA,
                      tokenId: tokenIdA.toString(),
                      reserveMON: formatTokenUnits(reserveA, 18),
                      highestBidMON: formatTokenUnits(highestBidA, 18),
                      highestBidder: highestBidderA,
                      endsInSec: String(Math.max(0, Number(endTimeA) - Math.floor(Date.now() / 1000))),
                    });
                  }
                } catch {
                  continue;
                }
              }
            } catch {
              /* auctions unavailable — listings still stand */
            }
          }
          if (listings.length > 0) {
            const floor = listings.reduce((a, b) => (a.priceWei < b.priceWei ? a : b));
            const listed = listings.slice(0, limit).map((l) => ({
              name: (l as unknown as { collectionName?: string }).collectionName ?? nmc.collectionName,
              contractAddress: (l as unknown as { collectionAddress?: string }).collectionAddress ?? nmc.collection,
              tokenId: l.tokenId,
              priceMON: formatTokenUnits(l.priceWei, 18),
              priceWei: l.priceWei.toString(),
              seller: l.seller,
              market: l.market,
              explorerUrl: `${explorerAddressUrl(env, (l as unknown as { collectionAddress?: string }).collectionAddress ?? nmc.collection)}`,
            }));
            await auditLog({ tool: 'nft_research_collections', result: 'ok', params: { limit, source: 'micromarket-live', count: listings.length } });
            return textResult({
              ok: true,
              source: 'micromarket-live',
              collections: [
                {
                  name: nmc.collectionName,
                  contractAddress: nmc.collection,
                  market: nmc.market,
                  floorMON: formatTokenUnits(floor.priceWei, 18),
                  activeListings: listings.length,
                  cheapestTokenId: floor.tokenId,
                  why: 'Live on our testnet MicroMarket — every listing is directly buyable via nft_buy.',
                },
              ],
              listings: listed,
              auctions,
              recommendation: `${nmc.collectionName} #${floor.tokenId}: floor ${formatTokenUnits(floor.priceWei, 18)} MON (${listings.length} listed, all buyable now).`,
              summary: `${nmc.collectionName}: floor ${formatTokenUnits(floor.priceWei, 18)} MON across ${listings.length} live listings. Cheapest is #${floor.tokenId}.`,
            });
          }

        await auditLog({ tool: 'nft_research_collections', result: 'ok', params: { limit, source: 'empty' } });
        return textResult({
          ok: true,
          source: 'empty',
          collections: [],
          summary: 'No live listings found. Set NANSEN_API_KEY for mainnet rankings, or list NFTs on the testnet MicroMarket.',
        });
      } catch (err) {
        return textResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  addTool(
    server,
    'nft_get_user_collection',
    'List NFTs owned by a wallet: ERC721 enumeration when supported, otherwise ownerOf-scan fallback.',
    {
      address: z.string().optional().describe('Owner address. Defaults to the agent wallet.'),
      contractAddress: z.string().optional().describe('Limit to a single ERC721 contract'),
      userId: z.string().optional().describe('User/session id owning the wallet'),
    },
    async ({ address, contractAddress, userId }: { address?: string; contractAddress?: string; userId?: string }) => {
      try {
        let owner = address;
        if (!owner) owner = (await resolveWallet(env, userId)).address;
        assertAddress(owner, 'owner');
        if (contractAddress) assertAddress(contractAddress, 'contract');
        const client = getPublicClient(env);
        const contracts = contractAddress
          ? [contractAddress as `0x${string}`]
          : env.MONAD_NETWORK === 'testnet'
            ? [getNftMarketConfig(env).collection]
            : [];
        if (contracts.length === 0) {
          return textResult({
            ok: true,
            owner,
            nfts: [],
            summary: `No contract scope given. Pass contractAddress to scan holdings for ${owner}.`,
          });
        }
        const nfts: Array<{ contract: string; tokenId: string; tokenURI: string | null }> = [];
        for (const c of contracts) {
          // Path 1: tokenOfOwnerByIndex enumeration.
          let enumerated = false;
          try {
            const bal = (await client.readContract({ address: c, abi: ERC721_ABI, functionName: 'balanceOf', args: [owner as `0x${string}`] })) as bigint;
            if (bal > 0n) {
              const count = bal > 20n ? 20n : bal;
              for (let i = 0n; i < count; i++) {
                try {
                  const id = (await client.readContract({ address: c, abi: ERC721_ABI, functionName: 'tokenOfOwnerByIndex', args: [owner as `0x${string}`, i] })) as bigint;
                  let uri: string | null = null;
                  try {
                    uri = (await client.readContract({ address: c, abi: ERC721_ABI, functionName: 'tokenURI', args: [id] })) as string;
                  } catch {
                    uri = null;
                  }
                  nfts.push({ contract: c, tokenId: id.toString(), tokenURI: uri });
                  enumerated = true;
                } catch {
                  break;
                }
              }
            } else {
              enumerated = true; // zero balance, nothing to scan
            }
          } catch {
            enumerated = false;
          }
          // Path 2: ownerOf scan over minted range (for minimal ERC721s).
          if (!enumerated) {
            try {
              const next = (await client.readContract({ address: c, abi: OWNER_OF_ABI, functionName: 'nextTokenId' }).catch(() => 51n)) as bigint;
              const cap = next > 51n ? 51n : next;
              for (let id = 1n; id < cap && nfts.length < 20; id++) {
                try {
                  const o = (await client.readContract({ address: c, abi: OWNER_OF_ABI, functionName: 'ownerOf', args: [id] })) as string;
                  if (o.toLowerCase() === owner.toLowerCase()) {
                    let uri: string | null = null;
                    try {
                      uri = (await client.readContract({ address: c, abi: ERC721_ABI, functionName: 'tokenURI', args: [id] })) as string;
                    } catch {
                      uri = null;
                    }
                    nfts.push({ contract: c, tokenId: id.toString(), tokenURI: uri });
                  }
                } catch {
                  continue;
                }
              }
            } catch (e) {
              return textResult({ ok: false, error: `Cannot enumerate ${c}: ${e instanceof Error ? e.message : String(e)}` });
            }
          }
        }
        await auditLog({ tool: 'nft_get_user_collection', userId, result: 'ok', params: { owner } });
        return textResult({ ok: true, owner, count: nfts.length, nfts, summary: `${owner} holds ${nfts.length} NFT(s) across ${contracts.length} contract(s).` });
      } catch (err) {
        return textResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  addTool(
    server,
    'nft_buy',
    'Purchase an NFT. ALWAYS requires explicit human approval. Verifies the listing price is within maxPrice, then executes via the marketplace.',
    {
      contractAddress: z.string().describe('NFT contract address (0x...)'),
      tokenId: z.string().describe('Token id to buy'),
      maxPrice: z.string().describe('Max price willing to pay in MON, e.g. "5"'),
      marketplace: z.string().optional().describe('Marketplace contract. Defaults to the configured MicroMarket on testnet.'),
      userId: z.string().optional().describe('User/session id owning the wallet'),
    },
    async ({ contractAddress, tokenId, maxPrice, marketplace, userId }: { contractAddress: string; tokenId: string; maxPrice: string; marketplace?: string; userId?: string }) => {
      try {
        assertAddress(contractAddress, 'nft contract');
        const nmc = getNftMarketConfig(env);
        const market = (marketplace ?? nmc.market ?? undefined) as `0x${string}` | undefined;
        if (market) assertAddress(market, 'marketplace');
        const wallet = await resolveWallet(env, userId);
        let maxWei: bigint;
        try {
          maxWei = parseEther(maxPrice);
        } catch {
          throw new Error(`Invalid maxPrice "${maxPrice}".`);
        }

        // MicroMarket path: read the listing and enforce maxPrice on-chain truth.
        let listPrice: bigint | null = null;
        if (market) {
          try {
            const client = getPublicClient(env);
            const [, price, active] = (await client.readContract({
              address: market,
              abi: MARKET_ABI,
              functionName: 'getListing',
              args: [contractAddress as `0x${string}`, BigInt(tokenId)],
            })) as [string, bigint, boolean];
            if (!active) throw new Error(`Token #${tokenId} is not actively listed on ${market}.`);
            listPrice = price;
          } catch (e) {
            if (e instanceof Error && /not actively listed/.test(e.message)) throw e;
            // Non-MicroMarket router: proceed to generic path below.
            listPrice = null;
          }
        }
        if (listPrice !== null && listPrice > maxWei) {
          return textResult({
            ok: false,
            error: `Listed at ${formatEther(listPrice)} MON, above your max of ${maxPrice} MON. Not buying.`,
            summary: `Skipped: ${contractAddress} #${tokenId} costs ${formatEther(listPrice)} MON > max ${maxPrice} MON. Raise maxPrice or pick another.`,
          });
        }

        const shownPrice = listPrice !== null ? `${formatTokenUnits(listPrice, 18)} MON` : `up to ${maxPrice} MON`;
        const client = getPublicClient(env);
        const value = listPrice ?? maxWei;
        // Pre-flight: simulate the exact buy before asking a human.
        let sim: SimResult | null = null;
        let buyData: `0x${string}` | null = null;
        if (market) {
          buyData = encodeFunctionData({
            abi: MARKET_ABI,
            functionName: 'buy',
            args: [contractAddress as `0x${string}`, BigInt(tokenId)],
          });
          sim = await simulateTx(env, { from: wallet.address, to: market, value, data: buyData });
          if (!sim.ok) {
            await auditLog({ tool: 'nft_buy', userId, result: 'error', error: `simulation: ${sim.reason}`, params: { contractAddress, tokenId } });
            return textResult({
              ok: false,
              error: `Pre-flight simulation failed — purchase blocked before approval: ${sim.reason}`,
              summary: `Not asking for approval: the buy would fail on-chain (${sim.reason}). No funds moved.`,
            });
          }
        }
        const gate = await approvalGate({
          action: 'nft_buy',
          details: {
            buyer: wallet.address,
            contractAddress,
            tokenId,
            listingPriceMON: listPrice !== null ? formatEther(listPrice) : null,
            maxPriceMON: maxPrice,
            marketplace: market ?? null,
            simulation: sim ? `${sim.verdict}, fee ≈ ${formatEther(sim.feeWei)} MON` : null,
          },
          valueWei: listPrice ?? maxWei,
          env,
          forceApproval: true,
          reason: `NFT purchase ${contractAddress} #${tokenId} for ${shownPrice}`,
          userId,
        });
        if (gate.decision !== 'approved') {
          await auditLog({ tool: 'nft_buy', userId, result: 'rejected', params: { contractAddress, tokenId } });
          return textResult({
            ok: false,
            approvalRequired: true,
            requestId: gate.requestId,
            summary: `NFT purchase requires your explicit approval. ${gate.message} Review ${contractAddress} #${tokenId} (${shownPrice}) in the dashboard. No funds moved.`,
          });
        }

        if (!market) {
          await auditLog({ tool: 'nft_buy', userId, result: 'error', error: 'no-marketplace-adapter' });
          return textResult({
            ok: false,
            approved: true,
            error: 'Approved, but no marketplace was configured. Pass `marketplace` or set MICROMARKET_ADDRESS.',
            summary: `Approved to buy ${contractAddress} #${tokenId} up to ${maxPrice} MON, but no marketplace contract was given so nothing was submitted.`,
          });
        }

        const hash = await privySendTransaction(env, wallet, { to: market, value, data: buyData as `0x${string}` });
        const receipt = await client.waitForTransactionReceipt({ hash });
        await auditLog({ tool: 'nft_buy', userId, result: 'ok', txHash: hash, params: { contractAddress, tokenId } });
        return textResult({
          ok: true,
          txHash: hash,
          explorerUrl: explorerTxUrl(env, hash),
          contractAddress,
          tokenId,
          paidMON: formatEther(value),
          simulatedFeeMON: sim ? formatEther(sim.feeWei) : null,
          blockNumber: receipt.blockNumber.toString(),
          gasUsed: receipt.gasUsed.toString(),
          summary: `You own ${contractAddress} #${tokenId}! Paid ${formatEther(value)} MON. Tx ${hash} in block ${receipt.blockNumber}. View: ${explorerTxUrl(env, hash)}`,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await auditLog({ tool: 'nft_buy', userId, result: 'error', error: msg });
        return textResult({ ok: false, error: msg });
      }
    },
  );

  addTool(
    server,
    'nft_bid',
    'Bid on a live NFT auction. ALWAYS requires explicit human approval. Refunds automatically if outbid later.',
    {
      auctionId: z.string().describe('Auction id to bid on'),
      amount: z.string().describe('Bid amount in MON, e.g. "0.6"'),
      auctionHouse: z.string().optional().describe('Auction house contract. Defaults to the configured one on testnet.'),
      userId: z.string().optional().describe('User/session id owning the wallet'),
    },
    async ({ auctionId, amount, auctionHouse, userId }: { auctionId: string; amount: string; auctionHouse?: string; userId?: string }) => {
      try {
        const nmc = getNftMarketConfig(env);
        const ah = (auctionHouse ?? nmc.auctionHouse ?? undefined) as `0x${string}` | undefined;
        if (!ah) throw new Error('No auction house configured. Pass `auctionHouse` or set AUCTION_HOUSE_ADDRESS.');
        assertAddress(ah, 'auction house');
        const id = BigInt(auctionId);
        const wallet = await resolveWallet(env, userId);
        let bidWei: bigint;
        try {
          bidWei = parseEther(amount);
        } catch {
          throw new Error(`Invalid amount "${amount}".`);
        }

        const client = getPublicClient(env);
        const row = (await client.readContract({ address: ah, abi: AUCTION_ABI, functionName: 'getAuction', args: [id] })) as unknown as [string, string, bigint, bigint, bigint, string, number, boolean];
        const [aseller, anft, atokenId, areserve, ahighestBid, , aendTime] = row;
        const asettled = row[7];
        if (aseller === '0x0000000000000000000000000000000000000000') throw new Error(`Auction #${auctionId} does not exist.`);
        if (asettled) throw new Error(`Auction #${auctionId} already settled.`);
        const nowSec = Math.floor(Date.now() / 1000);
        if (nowSec >= Number(aendTime)) throw new Error(`Auction #${auctionId} already ended. Call nft_settle_auction.`);
        if (bidWei < areserve) throw new Error(`Bid ${amount} MON is below the reserve of ${formatEther(areserve)} MON.`);
        if (ahighestBid > 0n && (bidWei * 10000n < ahighestBid * 10500n)) {
          throw new Error(`Bid must be ≥5% over ${formatEther(ahighestBid)} MON (min ${formatTokenUnits((ahighestBid * 10500n) / 10000n, 18)} MON).`);
        }
        const endsIn = Number(aendTime) - nowSec;

        const gate = await approvalGate({
          action: 'nft_bid',
          details: {
            bidder: wallet.address,
            auctionId,
            nft: anft,
            tokenId: atokenId.toString(),
            bidMON: amount,
            currentHighestMON: formatEther(ahighestBid),
            endsInSec: endsIn,
            auctionHouse: ah,
          },
          valueWei: bidWei,
          env,
          forceApproval: true,
          reason: `Bid ${amount} MON on auction #${auctionId} (${anft} #${atokenId.toString()})`,
          userId,
        });
        if (gate.decision !== 'approved') {
          await auditLog({ tool: 'nft_bid', userId, result: 'rejected', params: { auctionId, amount } });
          return textResult({
            ok: false,
            approvalRequired: true,
            requestId: gate.requestId,
            summary: `Bid requires your explicit approval. ${gate.message} Review ${amount} MON on auction #${auctionId} in the dashboard. No funds moved.`,
          });
        }

        const data = encodeFunctionData({ abi: AUCTION_ABI, functionName: 'bid', args: [id] });
        const hash = await privySendTransaction(env, wallet, { to: ah, value: bidWei, data });
        const receipt = await client.waitForTransactionReceipt({ hash });
        await auditLog({ tool: 'nft_bid', userId, result: 'ok', txHash: hash, params: { auctionId, amount } });
        return textResult({
          ok: true,
          txHash: hash,
          explorerUrl: explorerTxUrl(env, hash),
          auctionId,
          bidMON: amount,
          blockNumber: receipt.blockNumber.toString(),
          gasUsed: receipt.gasUsed.toString(),
          summary: `Bid ${amount} MON on auction #${auctionId} — you lead. Tx ${hash} in block ${receipt.blockNumber}. View: ${explorerTxUrl(env, hash)}. Outbid? You're refunded automatically.`,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await auditLog({ tool: 'nft_bid', userId, result: 'error', error: msg });
        return textResult({ ok: false, error: msg });
      }
    },
  );

  addTool(
    server,
    'nft_launch_collection',
    'Launch a new NFT collection: deploys the contract, batch-mints the supply to you, and lists a floor batch on the marketplace. ALWAYS requires explicit human approval.',
    {
      name: z.string().min(1).max(64).describe('Collection name, e.g. "NeoNads"'),
      symbol: z.string().min(1).max(12).describe('Collection symbol, e.g. "NEON"'),
      supply: z.number().int().min(1).max(100).describe('Total tokens to mint (1-100)'),
      listCount: z.number().int().min(0).max(20).default(5).describe('How many of the first tokens to list (0-20)'),
      floorPrice: z.string().default('0.1').describe('Listing price in MON for the floor batch'),
      userId: z.string().optional().describe('User/session id owning the wallet'),
    },
    async ({ name, symbol, supply, listCount, floorPrice, userId }: { name: string; symbol: string; supply: number; listCount: number; floorPrice: string; userId?: string }) => {
      try {
        if (env.MONAD_NETWORK !== 'testnet') throw new Error('Launchpad is testnet-only for now.');
        if (listCount > supply) throw new Error(`listCount (${listCount}) exceeds supply (${supply}).`);
        let floorWei: bigint;
        try {
          floorWei = parseEther(floorPrice);
        } catch {
          throw new Error(`Invalid floorPrice "${floorPrice}".`);
        }
        if (listCount > 0 && floorWei <= 0n) throw new Error('floorPrice must be > 0 when listing.');
        const wallet = await resolveWallet(env, userId);
        const nmc = getNftMarketConfig(env);
        if (!nmc.market) throw new Error('No marketplace configured.');
        const artifact = await loadArtifact('MockNFT.sol', 'MockNFT');

        const gate = await approvalGate({
          action: 'nft_launch_collection',
          details: { creator: wallet.address, name, symbol, supply, listCount, floorPriceMON: floorPrice, marketplace: nmc.market },
          valueWei: 0n,
          env,
          forceApproval: true,
          reason: `Launch "${name}" (${symbol}): deploy + mint ${supply} + list ${listCount} @ ${floorPrice} MON`,
          userId,
        });
        if (gate.decision !== 'approved') {
          await auditLog({ tool: 'nft_launch_collection', userId, result: 'rejected', params: { name, symbol, supply } });
          return textResult({
            ok: false,
            approvalRequired: true,
            requestId: gate.requestId,
            summary: `Collection launch needs your explicit approval. ${gate.message} Review "${name}" x${supply} in the dashboard. Nothing deployed.`,
          });
        }

        const client = getPublicClient(env);
        // 1) Deploy (creation tx: no `to`; constructor carries name/symbol).
        const { encodeDeployData } = await import('viem');
        const deployData = encodeDeployData({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          abi: artifact.abi as any,
          bytecode: artifact.bytecode,
          args: [name, symbol.toUpperCase()],
        });
        const deployHash = await privySendTransaction(env, wallet, { value: 0n, data: deployData });
        const deployReceipt = await client.waitForTransactionReceipt({ hash: deployHash });
        const collection = deployReceipt.contractAddress;
        if (!collection) throw new Error('Deployment receipt has no contract address.');
        // 2) Batch-mint the full supply to the creator.
        const mintData = encodeFunctionData({
          abi: [{ type: 'function', name: 'mintBatch', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'count', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }] }],
          functionName: 'mintBatch',
          args: [wallet.address as `0x${string}`, BigInt(supply)],
        });
        const mintHash = await privySendTransaction(env, wallet, { to: collection, value: 0n, data: mintData });
        await client.waitForTransactionReceipt({ hash: mintHash });
        // 3) Approve + list the floor batch (token ids 1..listCount).
        const listHashes: string[] = [];
        if (listCount > 0) {
          const approvalData = encodeFunctionData({
            abi: [{ type: 'function', name: 'setApprovalForAll', stateMutability: 'nonpayable', inputs: [{ name: 'operator', type: 'address' }, { name: 'approved', type: 'bool' }], outputs: [] }],
            functionName: 'setApprovalForAll',
            args: [nmc.market, true],
          });
          const approvalHash = await privySendTransaction(env, wallet, { to: collection, value: 0n, data: approvalData });
          await client.waitForTransactionReceipt({ hash: approvalHash });
          for (let id = 1; id <= listCount; id++) {
            const listData = encodeFunctionData({
              abi: [{ type: 'function', name: 'list', stateMutability: 'nonpayable', inputs: [{ name: 'nft', type: 'address' }, { name: 'tokenId', type: 'uint256' }, { name: 'price', type: 'uint256' }], outputs: [] }],
              functionName: 'list',
              args: [collection, BigInt(id), floorWei],
            });
            const h = await privySendTransaction(env, wallet, { to: nmc.market as `0x${string}`, value: 0n, data: listData });
            await client.waitForTransactionReceipt({ hash: h });
            listHashes.push(h);
          }
        }

        await addToRegistry({
          symbol: symbol.toUpperCase(),
          name,
          address: collection,
          deployTx: deployHash,
          supply,
          listed: listCount,
          floorPriceMON: listCount > 0 ? floorPrice : null,
          launchedAt: new Date().toISOString(),
          launchedBy: wallet.address,
        });
        await auditLog({ tool: 'nft_launch_collection', userId, result: 'ok', txHash: deployHash, params: { name, symbol, supply, collection } });
        return textResult({
          ok: true,
          collection,
          name,
          symbol: symbol.toUpperCase(),
          supply,
          listed: listCount,
          floorPriceMON: listCount > 0 ? floorPrice : null,
          deployTx: deployHash,
          mintTx: mintHash,
          listTxs: listHashes,
          explorerUrl: explorerAddressUrl(env, collection),
          summary: `Launched "${name}" (${symbol.toUpperCase()}) at ${collection}: minted ${supply}, listed ${listCount} @ ${floorPrice} MON floor. View: ${explorerAddressUrl(env, collection)}`,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await auditLog({ tool: 'nft_launch_collection', userId, result: 'error', error: msg });
        return textResult({ ok: false, error: msg });
      }
    },
  );

  addTool(
    server,
    'nft_settle_auction',
    'Settle an ended auction: winner gets the NFT, seller gets the pot (or NFT returns to seller if no bids). Callable by anyone.',
    {
      auctionId: z.string().describe('Auction id to settle'),
      auctionHouse: z.string().optional().describe('Auction house contract. Defaults to the configured one on testnet.'),
      userId: z.string().optional().describe('User/session id owning the wallet'),
    },
    async ({ auctionId, auctionHouse, userId }: { auctionId: string; auctionHouse?: string; userId?: string }) => {
      try {
        const nmc = getNftMarketConfig(env);
        const ah = (auctionHouse ?? nmc.auctionHouse ?? undefined) as `0x${string}` | undefined;
        if (!ah) throw new Error('No auction house configured.');
        assertAddress(ah, 'auction house');
        const wallet = await resolveWallet(env, userId);
        const client = getPublicClient(env);
        const data = encodeFunctionData({ abi: AUCTION_ABI, functionName: 'settle', args: [BigInt(auctionId)] });
        const hash = await privySendTransaction(env, wallet, { to: ah, value: 0n, data });
        const receipt = await client.waitForTransactionReceipt({ hash });
        await auditLog({ tool: 'nft_settle_auction', userId, result: 'ok', txHash: hash, params: { auctionId } });
        return textResult({
          ok: true,
          txHash: hash,
          explorerUrl: explorerTxUrl(env, hash),
          auctionId,
          blockNumber: receipt.blockNumber.toString(),
          summary: `Auction #${auctionId} settled. Tx ${hash} in block ${receipt.blockNumber}. Winner holds the NFT; seller holds the pot.`,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await auditLog({ tool: 'nft_settle_auction', userId, result: 'error', error: msg });
        return textResult({ ok: false, error: msg });
      }
    },
  );

  const OFFER_ABI = [
    {
      type: 'function',
      name: 'makeOffer',
      stateMutability: 'payable',
      inputs: [
        { name: 'nft', type: 'address' },
        { name: 'tokenId', type: 'uint256' },
        { name: 'expirySecs', type: 'uint64' },
      ],
      outputs: [{ name: 'offerId', type: 'uint256' }],
    },
    {
      type: 'function',
      name: 'acceptOffer',
      stateMutability: 'nonpayable',
      inputs: [
        { name: 'nft', type: 'address' },
        { name: 'tokenId', type: 'uint256' },
        { name: 'offerId', type: 'uint256' },
      ],
      outputs: [],
    },
    {
      type: 'function',
      name: 'cancelOffer',
      stateMutability: 'nonpayable',
      inputs: [
        { name: 'nft', type: 'address' },
        { name: 'tokenId', type: 'uint256' },
        { name: 'offerId', type: 'uint256' },
      ],
      outputs: [],
    },
    {
      type: 'function',
      name: 'cancel',
      stateMutability: 'nonpayable',
      inputs: [
        { name: 'nft', type: 'address' },
        { name: 'tokenId', type: 'uint256' },
      ],
      outputs: [],
    },
    {
      type: 'function',
      name: 'getOffer',
      stateMutability: 'view',
      inputs: [
        { name: 'nft', type: 'address' },
        { name: 'tokenId', type: 'uint256' },
        { name: 'offerId', type: 'uint256' },
      ],
      outputs: [
        { name: 'buyer', type: 'address' },
        { name: 'amount', type: 'uint256' },
        { name: 'expiry', type: 'uint64' },
        { name: 'active', type: 'bool' },
      ],
    },
  ] as const;

  async function resolveOfferMarket(marketplace: string | undefined): Promise<`0x${string}`> {
    const def = getNftMarketConfig(env).market;
    const mkt = (marketplace ?? def ?? undefined) as `0x${string}` | undefined;
    if (!mkt) throw new Error('No marketplace configured. Pass `marketplace` explicitly.');
    assertAddress(mkt, 'marketplace');
    return mkt;
  }

  addTool(
    server,
    'nft_offer',
    'Make a binding MON offer on any NFT (listed or not). Funds escrow in the marketplace; refunded on cancel. ALWAYS requires explicit human approval.',
    {
      contractAddress: z.string().describe('NFT contract address (0x...)'),
      tokenId: z.string().describe('Token id to bid on'),
      amount: z.string().describe('Offer amount in MON, e.g. "0.4"'),
      expirySecs: z.number().int().min(0).max(2592000).default(86400).describe('Offer validity in seconds, 0 = no expiry (default 24h)'),
      marketplace: z.string().optional().describe('Marketplace contract. Defaults to the Mochi demo marketplace on testnet.'),
      userId: z.string().optional().describe('User/session id owning the wallet'),
    },
    async ({ contractAddress, tokenId, amount, expirySecs, marketplace, userId }: { contractAddress: string; tokenId: string; amount: string; expirySecs: number; marketplace?: string; userId?: string }) => {
      try {
        assertAddress(contractAddress, 'nft contract');
        const mkt = await resolveOfferMarket(marketplace);
        const wallet = await resolveWallet(env, userId);
        let offerWei: bigint;
        try {
          offerWei = parseEther(amount);
        } catch {
          throw new Error(`Invalid amount "${amount}".`);
        }
        if (offerWei <= 0n) throw new Error('Offer must be > 0.');
        const data = encodeFunctionData({
          abi: OFFER_ABI,
          functionName: 'makeOffer',
          args: [contractAddress as `0x${string}`, BigInt(tokenId), BigInt(expirySecs)],
        });
        const sim = await simulateTx(env, { from: wallet.address, to: mkt, value: offerWei, data });
        if (!sim.ok) {
          return textResult({ ok: false, error: `Pre-flight failed, not requesting approval: ${sim.reason}`, summary: `Offer blocked before approval: ${sim.reason}.` });
        }
        const gate = await approvalGate({
          action: 'nft_offer',
          details: { buyer: wallet.address, contractAddress, tokenId, amountMON: amount, expirySecs, marketplace: mkt, simulation: `${sim.verdict}, fee ≈ ${formatEther(sim.feeWei)} MON` },
          valueWei: offerWei,
          env,
          forceApproval: true,
          reason: `Offer ${amount} MON on ${contractAddress} #${tokenId}`,
          userId,
        });
        if (gate.decision !== 'approved') {
          await auditLog({ tool: 'nft_offer', userId, result: 'rejected', params: { contractAddress, tokenId, amount } });
          return textResult({ ok: false, approvalRequired: true, requestId: gate.requestId, summary: `Offer needs approval. ${gate.message} No funds moved.` });
        }
        const hash = await privySendTransaction(env, wallet, { to: mkt, value: offerWei, data });
        const receipt = await getPublicClient(env).waitForTransactionReceipt({ hash });
        await auditLog({ tool: 'nft_offer', userId, result: 'ok', txHash: hash, params: { contractAddress, tokenId, amount } });
        return textResult({
          ok: true,
          txHash: hash,
          explorerUrl: explorerTxUrl(env, hash),
          contractAddress,
          tokenId,
          amountMON: amount,
          blockNumber: receipt.blockNumber.toString(),
          summary: `Offered ${amount} MON on ${contractAddress} #${tokenId} (escrowed). Tx ${hash}. Seller accepts via nft_accept_offer; cancel anytime with nft_cancel_offer for a full refund.`,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await auditLog({ tool: 'nft_offer', userId, result: 'error', error: msg });
        return textResult({ ok: false, error: msg });
      }
    },
  );

  addTool(
    server,
    'nft_accept_offer',
    'Accept an offer as the seller: escrowed MON pays out (royalty-aware), NFT transfers to the buyer.',
    {
      contractAddress: z.string().describe('NFT contract address (0x...)'),
      tokenId: z.string().describe('Token id'),
      offerId: z.string().describe('Offer id to accept'),
      marketplace: z.string().optional().describe('Marketplace contract. Defaults to the Mochi demo marketplace on testnet.'),
      userId: z.string().optional().describe('User/session id owning the wallet'),
    },
    async ({ contractAddress, tokenId, offerId, marketplace, userId }: { contractAddress: string; tokenId: string; offerId: string; marketplace?: string; userId?: string }) => {
      try {
        assertAddress(contractAddress, 'nft contract');
        const mkt = await resolveOfferMarket(marketplace);
        const wallet = await resolveWallet(env, userId);
        const data = encodeFunctionData({
          abi: OFFER_ABI,
          functionName: 'acceptOffer',
          args: [contractAddress as `0x${string}`, BigInt(tokenId), BigInt(offerId)],
        });
        const hash = await privySendTransaction(env, wallet, { to: mkt, value: 0n, data });
        const receipt = await getPublicClient(env).waitForTransactionReceipt({ hash });
        await auditLog({ tool: 'nft_accept_offer', userId, result: 'ok', txHash: hash, params: { contractAddress, tokenId, offerId } });
        return textResult({
          ok: true,
          txHash: hash,
          explorerUrl: explorerTxUrl(env, hash),
          blockNumber: receipt.blockNumber.toString(),
          summary: `Accepted offer #${offerId} on ${contractAddress} #${tokenId}. Tx ${hash}. Funds paid out, NFT moved to buyer.`,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await auditLog({ tool: 'nft_accept_offer', userId, result: 'error', error: msg });
        return textResult({ ok: false, error: msg });
      }
    },
  );

  addTool(
    server,
    'nft_cancel_offer',
    'Cancel your own offer and reclaim the escrowed MON in full.',
    {
      contractAddress: z.string().describe('NFT contract address (0x...)'),
      tokenId: z.string().describe('Token id'),
      offerId: z.string().describe('Offer id to cancel'),
      marketplace: z.string().optional().describe('Marketplace contract. Defaults to the Mochi demo marketplace on testnet.'),
      userId: z.string().optional().describe('User/session id owning the wallet'),
    },
    async ({ contractAddress, tokenId, offerId, marketplace, userId }: { contractAddress: string; tokenId: string; offerId: string; marketplace?: string; userId?: string }) => {
      try {
        assertAddress(contractAddress, 'nft contract');
        const mkt = await resolveOfferMarket(marketplace);
        const wallet = await resolveWallet(env, userId);
        const data = encodeFunctionData({
          abi: OFFER_ABI,
          functionName: 'cancelOffer',
          args: [contractAddress as `0x${string}`, BigInt(tokenId), BigInt(offerId)],
        });
        const hash = await privySendTransaction(env, wallet, { to: mkt, value: 0n, data });
        const receipt = await getPublicClient(env).waitForTransactionReceipt({ hash });
        await auditLog({ tool: 'nft_cancel_offer', userId, result: 'ok', txHash: hash, params: { contractAddress, tokenId, offerId } });
        return textResult({
          ok: true,
          txHash: hash,
          explorerUrl: explorerTxUrl(env, hash),
          blockNumber: receipt.blockNumber.toString(),
          summary: `Cancelled offer #${offerId} on ${contractAddress} #${tokenId}. Escrow refunded. Tx ${hash}.`,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await auditLog({ tool: 'nft_cancel_offer', userId, result: 'error', error: msg });
        return textResult({ ok: false, error: msg });
      }
    },
  );

  addTool(
    server,
    'nft_cancel_listing',
    'Cancel your fixed-price listing; the escrowed NFT returns to you.',
    {
      contractAddress: z.string().describe('NFT contract address (0x...)'),
      tokenId: z.string().describe('Token id'),
      marketplace: z.string().optional().describe('Marketplace contract. Defaults to the Mochi demo marketplace on testnet.'),
      userId: z.string().optional().describe('User/session id owning the wallet'),
    },
    async ({ contractAddress, tokenId, marketplace, userId }: { contractAddress: string; tokenId: string; marketplace?: string; userId?: string }) => {
      try {
        assertAddress(contractAddress, 'nft contract');
        const mkt = await resolveOfferMarket(marketplace);
        const wallet = await resolveWallet(env, userId);
        const data = encodeFunctionData({
          abi: OFFER_ABI,
          functionName: 'cancel',
          args: [contractAddress as `0x${string}`, BigInt(tokenId)],
        });
        const hash = await privySendTransaction(env, wallet, { to: mkt, value: 0n, data });
        const receipt = await getPublicClient(env).waitForTransactionReceipt({ hash });
        await auditLog({ tool: 'nft_cancel_listing', userId, result: 'ok', txHash: hash, params: { contractAddress, tokenId } });
        return textResult({
          ok: true,
          txHash: hash,
          explorerUrl: explorerTxUrl(env, hash),
          blockNumber: receipt.blockNumber.toString(),
          summary: `Cancelled listing of ${contractAddress} #${tokenId}. NFT returned to you. Tx ${hash}.`,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await auditLog({ tool: 'nft_cancel_listing', userId, result: 'error', error: msg });
        return textResult({ ok: false, error: msg });
      }
    },
  );
}
