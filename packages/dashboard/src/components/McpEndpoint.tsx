'use client';

import { useState } from 'react';

const ENDPOINT = 'https://mcp.getmochi.dev/mcp';

export default function McpEndpoint() {
  const [copied, setCopied] = useState(false);

  async function copyEndpoint() {
    try {
      await navigator.clipboard.writeText(ENDPOINT);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="endpoint-card">
      <div className="endpoint-label"><span className="endpoint-dot" /> MOCHI CONNECTION ADDRESS</div>
      <div className="endpoint-control">
        <code>{ENDPOINT}</code>
        <button type="button" onClick={copyEndpoint} aria-label="Copy Mochi connection address">
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <p className="endpoint-help" aria-live="polite">{copied ? 'Address copied. Paste it into your assistant’s MCP connection settings.' : 'Copy this address to connect Mochi to an MCP-compatible assistant.'}</p>
    </div>
  );
}
