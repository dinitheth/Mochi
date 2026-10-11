/**
 * MCP Apps UI resources (ChatGPT Apps SDK / open MCP Apps standard).
 *
 * Two self-contained widgets (no external assets — CSP-safe) that run in the
 * host's iframe and talk back over the postMessage JSON-RPC bridge:
 *  - ui://monadmcp/marketplace/v1 — fixed-price listings grid with Buy/Offer
 *  - ui://monadmcp/auctions/v1 — live auctions with one-tap +5% bids
 * Widgets call back into data tools (nft_research_collections) and write
 * tools (nft_buy / nft_bid); write confirmations stay host-native via the
 * tool annotations registered in shared.ts.
 */

export const MARKETPLACE_URI = 'ui://monadmcp/marketplace/v1';
export const AUCTIONS_URI = 'ui://monadmcp/auctions/v1';
export const UI_MIME = 'text/html;profile=mcp-app';

const BRIDGE_JS = `
let __seq = 1;
const __pending = new Map();
function bridge(method, params) {
  const id = __seq++;
  window.parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*');
  return new Promise((resolve, reject) => { __pending.set(id, { resolve, reject }); });
}
window.addEventListener('message', (event) => {
  if (event.source !== window.parent) return;
  const msg = event.data;
  if (!msg || msg.jsonrpc !== '2.0') return;
  if (msg.id !== undefined && __pending.has(msg.id)) {
    const p = __pending.get(msg.id);
    __pending.delete(msg.id);
    if (msg.error) p.reject(msg.error); else p.resolve(msg.result);
  }
});
async function callTool(name, args) {
  const res = await bridge('tools/call', { name, arguments: args });
  const text = res?.content?.[0]?.text ?? '{}';
  try { return JSON.parse(text); } catch { return { ok: false, error: 'bad tool payload' }; }
}
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
`;

function shell(title: string, body: string, script: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font-family:system-ui,sans-serif;background:#0b0b12;color:#e8e8f0;margin:0;padding:12px}
h2{font-size:14px;color:#a5a5bd;margin:0 0 10px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}
.card{background:#14141d;border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:10px}
.card img{width:100%;border-radius:8px}
.price{font-weight:700;margin:6px 0 2px}
.row{display:flex;gap:6px;margin-top:8px}
button{flex:1;background:#836EF9;border:0;color:#fff;border-radius:8px;padding:8px;font-weight:600;cursor:pointer}
button.ghost{background:rgba(255,255,255,.06)}
.note{font-size:12px;color:#8a8aa0;margin-top:8px}
</style></head><body>${body}<script>${BRIDGE_JS}${script}<\/script></body></html>`;
}

export const MARKETPLACE_HTML = shell(
  '<h2>Mochi Market</h2><div id="list" class="grid"></div><div id="msg" class="note"></div>',
  '',
  `
(async () => {
  const list = document.getElementById('list');
  const msg = document.getElementById('msg');
  function render(items) {
    list.innerHTML = items.map((l, i) =>
      '<div class="card"><div style="font-weight:700">' + esc(l.name) + ' #' + esc(l.tokenId) + '</div>' +
      '<div class="price">' + esc(l.priceMON) + ' MON</div>' +
      '<div class="row"><button data-i="' + i + '">Buy</button></div></div>'
    ).join('');
    list.querySelectorAll('button').forEach((b) => {
      b.onclick = async () => {
        const l = items[Number(b.dataset.i)];
        msg.textContent = 'Submitting purchase — confirm in chat if asked…';
        const r = await callTool('nft_buy', { contractAddress: l.contractAddress, tokenId: String(l.tokenId), maxPrice: String(l.priceMON) });
        msg.textContent = r.summary ?? (r.ok ? 'Done.' : ('Failed: ' + (r.error ?? 'unknown')));
      };
    });
  }
  async function selfFetch() {
    try {
      const res = await callTool('nft_research_collections', { limit: 9 });
      const items = res.listings ?? [];
      if (!items.length) { msg.textContent = 'No live listings right now.'; return; }
      render(items);
    } catch (e) { msg.textContent = 'Could not load listings.'; }
  }
  let settled = false;
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return;
    const m = event.data;
    if (!m || m.jsonrpc !== '2.0' || m.id !== undefined) return;
    if (m.method === 'ui/notifications/tool-result') {
      const sc = m.params && m.params.structuredContent;
      if (sc && Array.isArray(sc.listings) && sc.listings.length) { settled = true; render(sc.listings); }
    }
  });
  setTimeout(() => { if (!settled) selfFetch(); }, 1200);
})();
  `.trim(),
);

export const AUCTIONS_HTML = shell(
  '<h2>Mochi Auctions</h2><div id="list" class="grid"></div><div id="msg" class="note"></div>',
  '',
  `
(async () => {
  const list = document.getElementById('list');
  const msg = document.getElementById('msg');
  function render(items) {
    list.innerHTML = items.map((a, i) =>
      '<div class="card"><div style="font-weight:700">Auction #' + esc(a.auctionId) + '</div>' +
      '<div>Reserve ' + esc(a.reserveMON) + ' MON</div>' +
      '<div class="price">Lead ' + esc(a.highestBidMON) + ' MON</div>' +
      '<div class="row"><button data-i="' + i + '">Bid +5%</button></div></div>'
    ).join('');
    list.querySelectorAll('button').forEach((b) => {
      b.onclick = async () => {
        const a = items[Number(b.dataset.i)];
        const cur = Number(a.highestBidMON || a.reserveMON || '0');
        const bid = (Math.max(cur * 1.05, Number(a.reserveMON || '0'))).toFixed(4);
        msg.textContent = 'Submitting bid of ' + bid + ' MON — confirm in chat if asked…';
        const r = await callTool('nft_bid', { auctionId: String(a.auctionId), amount: String(bid) });
        msg.textContent = r.summary ?? (r.ok ? 'Done.' : ('Failed: ' + (r.error ?? 'unknown')));
      };
    });
  }
  async function selfFetch() {
    try {
      const res = await callTool('nft_research_collections', { limit: 9 });
      const items = res.auctions ?? [];
      if (!items.length) { msg.textContent = 'No live auctions right now.'; return; }
      render(items);
    } catch (e) { msg.textContent = 'Could not load auctions.'; }
  }
  let settled = false;
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return;
    const m = event.data;
    if (!m || m.jsonrpc !== '2.0' || m.id !== undefined) return;
    if (m.method === 'ui/notifications/tool-result') {
      const sc = m.params && m.params.structuredContent;
      if (sc && Array.isArray(sc.auctions) && sc.auctions.length) { settled = true; render(sc.auctions); }
    }
  });
  setTimeout(() => { if (!settled) selfFetch(); }, 1200);
})();
  `.trim(),
);

export const PAYMENT_REQUEST_HTML = shell(
  '<h2>Mochi Pay</h2><div id="card" class="card"><p class="note">Preparing payment details…</p></div><div id="msg" class="note"></div>',
  '',
  `
(async () => {
  const card = document.getElementById('card');
  const msg = document.getElementById('msg');
  function render(p) {
    if (!p || !p.paymentUri || !p.qrDataUrl) { card.innerHTML = '<p class="note">Payment request data is incomplete.</p>'; return; }
    card.innerHTML = '<div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">' +
      '<img alt="Scan to pay on Monad" src="' + esc(p.qrDataUrl) + '" style="width:180px;height:180px;background:white;padding:8px;border-radius:8px">' +
      '<div><div style="font-size:20px;font-weight:700">' + esc(p.amount) + ' ' + esc(p.token) + '</div>' +
      '<p>' + esc(p.reason) + '</p><p>Invoice ' + esc(p.invoiceId) + '</p>' +
      '<p class="note">Pay to <code>' + esc(p.merchantAddress) + '</code></p>' +
      '<p class="note">Expires ' + esc(p.expiresAt) + '</p>' +
      '<div class="row"><a href="' + esc(p.paymentUri) + '" style="flex:1;text-align:center;background:#836EF9;color:white;border-radius:8px;padding:8px;text-decoration:none;font-weight:600">Open wallet</a>' +
      '<button class="ghost" id="copy">Copy link</button></div></div></div>';
    document.getElementById('copy').onclick = async () => {
      try { await navigator.clipboard.writeText(p.paymentUri); msg.textContent = 'Payment link copied.'; }
      catch { msg.textContent = 'Copy is unavailable in this host; use the wallet button or QR code.'; }
    };
  }
  let ready = false;
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return;
    const m = event.data;
    if (!m || m.jsonrpc !== '2.0' || m.id !== undefined || m.method !== 'ui/notifications/tool-result') return;
    const data = m.params && m.params.structuredContent;
    if (data && data.paymentUri) { ready = true; render(data); }
  });
  setTimeout(() => { if (!ready) card.innerHTML = '<p class="note">Call render_payment_request with the payment request details to show its QR code and wallet link.</p>'; }, 1200);
})();
  `.trim(),
);
