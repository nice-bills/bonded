# Bonded

**Before an AI agent pays, it buys a guarantee for that one action. If the pool won't insure it, the agent doesn't act.**

Bonded is an action guarantee pool for AI agents, built for the OpenServ SERV Hackathon 02 (Dolphin track). An open-weight underwriter (DeepSeek-V4.1-Flash on [Dolphin](https://dphn.ai)) reads the whole case in one multimodal call and prices the risk. SERV Reasoning screens and audits every decision. Premiums come in and claims go out in USDC on Base Sepolia. Other agents buy cover through OpenServ's x402 Agent Market.

It is a demo of an action guarantee pool on testnet funds, not an insurance product.

- Live console: https://bonded-pool.onrender.com
- x402 Agent Market: [Bonded Quote](https://platform.openserv.ai/workspace/paywall/0ae26100d76340369a7759f84ce13cd1) ($0.02) · [Bonded Claim](https://platform.openserv.ai/workspace/paywall/97f6b7afdca343cf9a99317f2104019a) ($0.01) · OpenServ agent #4958
- Pool: [`0x4D94…0BED` on Base Sepolia](https://sepolia.basescan.org/address/0x4D948Ed7a54061e8474612C98420Ae9b91400BED)

## Why open weights are the point
An insurer's loss history only means something while the underwriter stays the same. Closed models get swapped or pulled (OpenServ's own changelog: Qwen removed Aug 21, 13 models trimmed Sep 11, 2026). Bonded pins open MIT weights, records Dolphin's serving fingerprint on every decision, hashes its rating guide, and stores the exact request so anyone, a claimant included, can **re-check** a quote or claim on the same weights.

## How it works
1. **Quote.** The insured agent (in the demo: Payrun, a payments agent) sends the action (pay $1,800 to 0x…) and the case file: invoice image, emails (untrusted), vendor records, payment history, contract, policy (its own records). Dolphin returns per-peril probabilities with cited evidence and a verbatim transcript of the untrusted documents, including faint hidden text. Temperature 0, fixed seed.
2. **Price in code, not in the model.** p(loss) = 1 − Π(1 − p_peril). Premium = cover × p(loss) × 1.4 (min $0.50). Above 10% it is uninsurable: the agent must not act. One bond may use at most 25% of free pool capital; every active bond's cover is reserved (fully funded pool).
3. **SERV second line.** One SERV Reasoning call (`gpt-6-luna`) with `serv_prompt_guard` on the transcribed untrusted documents and `serv_shadow_agent` auditing the estimate against the rating rules. A guard block or an objection vetoes the bond.
4. **Bind.** The agent pays the premium in USDC to the pool; Bonded verifies the transfer log on chain (amount, recipient, after the quote, never reused) and issues the bond.
5. **Claim.** A separate Dolphin call (the claims judge) reads the original case, the quote and the claim evidence together, against a published wording (covered perils, exclusions). Code gates enforce the wording; SERV Prompt Guard, a SERV reviewer and Multipath (three rulebooks) can each veto; the Shadow Agent audits each decision as advisory; approved claims are paid from the pool on chain.
6. **Re-check.** `POST /api/recheck/:id` replays the byte-identical stored request on the same weights and compares the decision.

## Backtest (Payrun's 40 labelled invoices, 24 traps, 2 runs each)
| | |
|---|---|
| Traps priced out (declined) | **24 / 24** (wallet swaps, duplicates, over-cap, bad arithmetic, unapproved expenses, prompt injection) |
| Clean invoices insured | **31 of 32 across both runs** (16 / 16 on run 0; one clean invoice declined on the re-run at p 0.186), mean premium 1.75% of cover |
| Ranking (run 0) | AUC 1.000, Brier 0.009 |
| Arithmetic | recomputed in code from the figures the model reads; 3 / 3 bad-arithmetic invoices flagged on every run |
| Same decision on re-run | 97.5% (39/40) |
| Book | $783 premiums, $0 losses, $81,290 of trap exposure declined |
| Speed, cost | p50 7.0 s, p95 134 s (Dolphin long tail), $0.0075 for all 80 calls |

Finding: during one 80-call run Dolphin served from two vLLM builds (0.33.0rc1 for 68 calls, 0.32.0rc1 for 12). Same weights, different serving stack: Bonded records the fingerprint so drift is visible, which closed APIs never expose. Reproduce with `npm run backtest` (Dolphin only, SERV veto off). Full rows: `backtest/results-check.json` (current), `backtest/results.json` (before the arithmetic check), `backtest/results-panel.json` (two-model panel, now opt-in with `BONDED_PANEL=on`; see docs/DOLPHIN.md).

## Run it
```bash
npm install
cp .env.example .env   # DOLPHIN_API_KEY, SERV_API_KEY, BONDED_POOL_KEY, DEMO_AGENT_KEY
npm run render         # demo invoice images (needs chromium)
npm run dev            # console + API on http://localhost:3300
npm test               # pricing rules
npm run backtest       # 80 underwriting calls, ~1 minute, < $0.01
npm run openserv       # register Bonded on OpenServ + x402 workflows, then serve
```

## API
| Method | Path | |
|---|---|---|
| GET | `/api/pool` | capital, reserved, free, book, rules, rating guide hash |
| POST | `/api/quote` | `{case}` or `{caseId}` → NDJSON progress, then the quote |
| POST | `/api/bind` | `{quoteId, tx, beneficiary?}` → bond |
| POST | `/api/claim` | `{bondId, statement, evidence[]}` → NDJSON, then the judgment (+ payout tx) |
| POST | `/api/recheck/:id` | re-run a quote or claim on the same weights |
| GET | `/api/ledger` | recent quotes, bonds, claims |

OpenServ capabilities: `quote`, `bind`, `claim` (`openserv/agent.ts`), sold through two x402 workflows ("Bonded: guarantee an agent action", "Bonded: file a claim").

## Layout
`src/underwrite.ts` rating guide + underwriter · `src/claims.ts` wording + claims judge · `src/pricing.ts` money rules · `src/serv.ts` Prompt Guard + Shadow Agent · `src/dolphin.ts` streamed Dolphin client · `src/chain.ts` USDC on Base Sepolia · `src/service.ts` quote/bind/claim/recheck · `openserv/agent.ts` OpenServ agent · `public/index.html` console · `demo/` cases and documents · `scripts/backtest.ts`.

Shortcuts (marked `shortcut:` in code): JSON-file ledger on local disk, in-memory rate limits, testnet scale 1 USDC = $10,000 of cover.
