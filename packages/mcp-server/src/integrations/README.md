# Monad mainnet integration adapters

Monad mainnet is chain ID **143**. Adapter entry points live here; MCP tools own wallet resolution,
human approval, simulation, signing, receipt checks, and audit logging. Adapters must never sign or
broadcast transactions themselves.

## Current integrations

| Adapter | MCP tools | Scope and limits | Configuration |
|---|---|---|---|
| 0x Swap API v2 | `defi_swap_tokens` | Firm exact-input quotes through AllowanceHolder; ERC-20 inputs only; both allowance target and execution target must match the documented Monad AllowanceHolder; exact amount allowance (including replacing an oversized allowance); forced human approval; fresh quote after approval; simulated calldata; receipt checked. Native-MON sell-token flows are not enabled. The 0x route may use supported liquidity venues such as Uniswap, but this is not a direct Uniswap adapter. | `OX_API_KEY` |
| OpenSea API v2 | `nft_opensea_listings`, `nft_opensea_buy` | Monad listings are read from the collection endpoint. Purchases re-verify one active Seaport order, require native MON, one same-chain transaction to the listing protocol, a caller price ceiling, forced approval, byte-identical post-approval calldata, simulation, and successful receipt. ERC-20 payment, sweeps, cross-chain purchases, offers, and listing creation are not enabled. | `OPENSEA_API_KEY` |
| Nansen Token Screener + Envio HyperSync | `defi_monad_market_brief` | Read-only 24-hour Monad token metrics, enriched with ERC-20 Transfer log counts over at most 2,000 recent blocks. The tool reports source availability and scan bounds; it does not rank tokens as financial advice or execute trades. | `NANSEN_API_KEY`, `HYPERSYNC_TOKEN`, `HYPERSYNC_URL=https://monad.hypersync.xyz` |
| Mochi Mission Planner | `defi_plan_monad_mission` | Read-only token research combining a bounded Nansen screen, Nansen Token God Mode flows for a selected token, bounded Envio Transfer logs, direct Monad ERC-20 balance reads, and matching Zerion positions where indexed. An optional 0x quote returns amounts and route venues only; no calldata is exposed and no transaction is sent. | `NANSEN_API_KEY`; optional `HYPERSYNC_TOKEN`, mainnet `HYPERSYNC_URL`, `ZERION_API_KEY`, `OX_API_KEY` |

Both write adapters check that the configured RPC is chain ID 143 and reject execution on testnet.
Testnet demo-contract flows remain separate and available through `MONAD_NETWORK=testnet`.

## Adapter checklist for future protocols

1. Verify chain ID 143 support and exact contract/API addresses from the protocol's official docs,
   deployment registry, and a live read-only chain check. A registry entry marked live is not a safety
   audit or proof that every API feature is available.
2. Add a dedicated integration module that validates API output fields, chain, tokens, spender,
   transaction target, calldata, and amount bounds. Do not accept user-supplied execution targets.
3. Keep reads separate from writes. Reads return normalized data with source and timestamp; writes
   prepare a bounded intent for the MCP tool layer.
4. Make the user intent concrete in the approval card: chain, wallet, assets, exact quantity, minimum
   output or maximum cost, destination protocol, and estimated fee. Mandatory actions use
   `forceApproval` so a broad auto-approval policy cannot bypass the human.
5. After approval, fetch fresh protocol data and enforce the exact approved bounds. Simulate the final
   calldata on the configured RPC, submit once, check receipt status, and record an audit entry.
6. Add protocol-specific tests and failure-mode coverage before exposing the tool. Keep any workflow
   requiring multiple transactions (approvals, bridges, or deposits) disabled until each step has its
   own approval and recovery behavior.

## Candidate status

Uniswap, 1inch, Aave V3, Kuru, Kintsu, aPriori, Morpho, Euler, Scatter, Mintpad/NFTs2Me, Beefy, Pendle,
and other protocols are **not direct MCP integrations yet**. Some may be usable as liquidity sources
behind 0x, but direct positions, staking, NFT-marketplace, or lending actions need their own verified
adapters and explicit limits before they can be called from the MCP.
