import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AUCTIONS_HTML, AUCTIONS_URI, MARKETPLACE_HTML, MARKETPLACE_URI, UI_MIME } from './widgets.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyServer = any;

function registerUiResource(server: McpServer, name: string, uri: string, html: string): void {
  const s = server as AnyServer;
  const read = async (u: URL) => ({
    contents: [
      {
        uri: u.href,
        mimeType: UI_MIME,
        text: html,
        _meta: { ui: { prefersBorder: true } },
      },
    ],
  });
  if (typeof s.registerResource === 'function') {
    s.registerResource(name, uri, { description: `${name} widget`, mimeType: UI_MIME }, read);
  }
}

/**
 * Decoupled pattern (per MCP Apps guidance): data tools stay UI-free;
 * these two render tools own the widget templates. The model calls e.g.
 * nft_research_collections first, then the render tool with the prepared
 * data — the widget renders once from structuredContent (delivered to the
 * iframe as ui/notifications/tool-result). Hosts without UI still get the
 * human-readable text summary. When no data is passed, the widget
 * self-fetches via tools/call after load (legacy fallback).
 */
export function registerAppUI(server: McpServer): void {
  registerUiResource(server, 'monadmcp-marketplace', MARKETPLACE_URI, MARKETPLACE_HTML);
  registerUiResource(server, 'monadmcp-auctions', AUCTIONS_URI, AUCTIONS_HTML);

  const s = server as AnyServer;
  const register = (
    name: string,
    title: string,
    description: string,
    resourceUri: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    inputSchema: Record<string, any>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    outputSchema: Record<string, any>,
    invoking: string,
    invoked: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: (args: any) => Promise<any>,
  ) => {
    const config = {
      title,
      description,
      inputSchema,
      annotations: { readOnlyHint: true },
      _meta: {
        ui: { resourceUri },
        'openai/outputTemplate': resourceUri,
        'openai/toolInvocation/invoking': invoking,
        'openai/toolInvocation/invoked': invoked,
      },
    };
    // addTool is shared.ts's compat wrapper; it accepts (server, name,
    // description, inputSchema, handler, { outputSchema, _meta }) — but its
    // inputSchema type differs, so call the SDK directly here.
    if (typeof s.registerTool === 'function') {
      s.registerTool(name, { ...config, outputSchema }, handler);
    } else if (typeof s.tool === 'function') {
      s.tool(name, description, {}, handler);
    }
  };

  const listingShape = z.object({}).passthrough();
  const auctionShape = z.object({}).passthrough();

  register(
    'render_marketplace',
    'Mochi Market',
    'Show the Mochi Market widget with fixed-price NFT listings and Buy buttons. Call nft_research_collections first, then pass its listings as listingsJson (a JSON array of {name, tokenId, priceMON, contractAddress}). Mochi Market renders the supplied data; text-only hosts receive a written summary.',
    MARKETPLACE_URI,
    {
      listingsJson: z
        .string()
        .optional()
        .describe('JSON array of listings from nft_research_collections. Omit to let the widget fetch itself.'),
    },
    {
      count: z.number(),
      currency: z.string(),
      listings: z.array(listingShape),
    },
    'Loading Mochi Market…',
    'Mochi Market shown.',
    async ({ listingsJson }: { listingsJson?: string }) => {
      let listings: Array<Record<string, unknown>> = [];
      if (listingsJson) {
        try {
          const parsed: unknown = JSON.parse(listingsJson);
          if (Array.isArray(parsed)) listings = parsed as Array<Record<string, unknown>>;
        } catch {
          listings = [];
        }
      }
      const lines = listings.map(
        (l) => `- ${String(l.name ?? 'NFT')} #${String(l.tokenId ?? '?')}: ${String(l.priceMON ?? '?')} MON`,
      );
      const text =
        listings.length > 0
          ? `Showing ${listings.length} listing(s) (MON):\n${lines.join('\n')}\nWidget renders from live tool data.`
          : 'Mochi Market is ready. Pass listingsJson or let the widget fetch live data.';
      return {
        content: [{ type: 'text' as const, text }],
        structuredContent: { count: listings.length, currency: 'MON', listings },
      };
    },
  );
  register(
    'render_auctions',
    'Mochi Auctions',
    'Show the Mochi Auctions widget with current leaders, countdowns, and one-tap bids. Call nft_research_collections first, then pass its auctions as auctionsJson (a JSON array of {auctionId, reserveMON, highestBidMON}). Mochi Auctions renders the supplied data; text-only hosts receive a written summary.',
    AUCTIONS_URI,
    {
      auctionsJson: z
        .string()
        .optional()
        .describe('JSON array of auctions from nft_research_collections. Omit to let the widget fetch itself.'),
    },
    {
      count: z.number(),
      auctions: z.array(auctionShape),
    },
    'Loading Mochi Auctions…',
    'Mochi Auctions shown.',
    async ({ auctionsJson }: { auctionsJson?: string }) => {
      let auctions: Array<Record<string, unknown>> = [];
      if (auctionsJson) {
        try {
          const parsed: unknown = JSON.parse(auctionsJson);
          if (Array.isArray(parsed)) auctions = parsed as Array<Record<string, unknown>>;
        } catch {
          auctions = [];
        }
      }
      const lines = auctions.map(
        (a) =>
          `- Auction #${String(a.auctionId ?? '?')}: reserve ${String(a.reserveMON ?? '?')} MON, lead ${String(a.highestBidMON ?? a.reserveMON ?? '?')} MON`,
      );
      const text =
        auctions.length > 0
          ? `Showing ${auctions.length} live auction(s):\n${lines.join('\n')}\nWidget renders from live tool data.`
          : 'Mochi Auctions is ready. Pass auctionsJson or let the widget fetch live data.';
      return {
        content: [{ type: 'text' as const, text }],
        structuredContent: { count: auctions.length, auctions },
      };
    },
  );
}
