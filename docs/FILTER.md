# Idea filter: why Bonded

Hackathon-filter pass for OpenServ SERV Hackathon 02, Dolphin track (deadline 2026-11-15 23:59 UTC).

## Event verdict: pass
Three tracks with specific constraints (Dolphin, Kite, Reppo), published criteria (creativity, user readiness, revenue potential), every entry must use SERV Reasoning, Edition 01 paid out ($1,000 in SERV per track). 116 registrations / 64 submissions on Nov 10; Dolphin is the thinnest track (Straggler, Cheap First, Lelang, Janus).

## Kill table
| Idea | Rule failed | Evidence |
|---|---|---|
| Trading / portfolio bots | Generic AI list; crowded | Kite track has ~15 entries |
| "Agent watches X and alerts" (Straggler-style) | Sponsor not the hero; no novelty ("a Hermes agent can do this") | user review of Straggler, 2026-11-13 |
| Uncensored-model apps | Not true: the API model is DeepSeek's aligned model | https://dphn.ai/models |
| Privacy agents on Dolphin | Requests can fall back to OpenRouter | https://dphn.ai/network |
| Agent trust scores | Crowded (ERC-8004 registries) | https://eips.ethereum.org/EIPS/eip-8004 |
| Escrow for verified work | Close prior art | dealwork.ai, Escroue, Judr |
| Agent arenas | Close prior art | SERVPIT |
| AI courtroom | Close prior art | Judr |
| Proxy-upgrade reviewer | Close prior art | Forta, Hypernative, yearn monitoring |
| Cheap-model-first answering | Already entered on this track | https://cheapfirst.designimp.com |
| Reppo-priced cover (Bonded v0) | Reppo/Kite tracks crowded; Dolphin is the better hero | user plan, 2026-10-31 |

## Checklist: Bonded
1. **Sponsor is the hero.** Remove Dolphin and the pool cannot exist: an insurer's loss history is only valid while the underwriter stays the same, and only open weights can promise that (closed models get pulled: OpenServ removed Qwen on Aug 21 and trimmed 13 models on Sep 11, 2026). Decisions are re-checkable on the same weights.
2. **Pushes the tech.** One 1M-context multimodal call reads the whole case (invoice image incl. faint hidden text, emails, records, contract, policy) at $0.0001 per quote; the backtest measures calibration, rerun agreement and serving-build drift.
3. **Theme fit.** Dolphin track: open models doing work closed models structurally cannot (stable, auditable underwriting). SERV Reasoning is the second line (Prompt Guard + Shadow Agent).
4. **One line.** "Before an AI agent pays, it buys a guarantee. If the pool won't insure it, the agent doesn't act."
5. **Visible in a minute.** Clean invoice insured at $25; wallet-swap invoice declined; hidden-instruction invoice declined; duplicate-payment claim paid on chain.
6. **Early.** Open-weight 1M multimodal model with a hosted API (DeepSeek-V4.1-Flash on Dolphin) + x402 agent markets: both 2026.
7. **Edge.** Won Edition 01 (Coinbase track) with Payrun, an invoice pay/hold/block agent: domain data (40 labelled invoices, 24 traps) and the first insured customer.
8. **Buildable.** Built and deployed in the window; scope cut: testnet USDC, JSON ledger.

## Prior art
See [prior-art.md](prior-art.md). Closest: Klaimee (yearly agent liability, human underwriting), Basefund (per-transaction, human), Nexus Mutual (pool, human claim votes), Cheap First (same Dolphin + SERV + x402 loop, but a model checker, not a cover pool). No per-action, open-model-underwritten, re-checkable cover found.
