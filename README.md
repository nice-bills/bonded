# Bonded

**Before an AI agent pays, it buys a guarantee for that one action. If the pool won't insure it, the agent doesn't act.**

## Sponsor tech used
| | Sponsor | How Bonded uses it |
|:-:|---|---|
| <a href="https://dphn.ai"><img src="docs/img/logos/dolphin.png" alt="Dolphin logo" height="40"></a> | **Dolphin** (track sponsor) | Open-weight DeepSeek-V4.1-Flash served by Dolphin is the underwriter and the claims judge. Every quote and claim is one multimodal Dolphin call. |
| <a href="https://www.openserv.ai"><img src="docs/img/logos/openserv.png" alt="OpenServ logo" height="40"></a> | **OpenServ: SERV Reasoning** | Prompt Guard, Shadow Agent, Multipath and Kronos (`gpt-6-luna`), on every quote and claim. |
| <a href="https://www.openserv.ai"><img src="docs/img/logos/openserv.png" alt="OpenServ logo" height="40"></a> | **OpenServ platform** | Two OpenServ agents (Bonded #4958, Payrun Lite), one workflow between them, two x402 Agent Market listings. |
| <a href="https://www.base.org"><img src="docs/img/logos/base.png" alt="Base logo" height="40"></a> | **Base** | Premiums in and claims out in USDC on Base Sepolia. |

Bonded is an action guarantee pool for AI agents, built for the OpenServ SERV Hackathon 02 (Dolphin track). An open-weight underwriter (DeepSeek-V4.1-Flash on [Dolphin](https://dphn.ai)) reads the whole case in one multimodal call and prices the risk. SERV Reasoning screens and audits every decision. Premiums come in and claims go out in USDC on Base Sepolia. Other agents buy cover through OpenServ's x402 Agent Market.

It is a demo of an action guarantee pool on testnet funds, not an insurance product.

- Live console: https://bonded-pool.onrender.com
- x402 Agent Market: [Bonded Quote](https://platform.openserv.ai/workspace/paywall/0ae26100d76340369a7759f84ce13cd1) ($0.02) · [Bonded Claim](https://platform.openserv.ai/workspace/paywall/97f6b7afdca343cf9a99317f2104019a) ($0.01) · OpenServ agent #4958
- Pool: [`0x4D94…0BED` on Base Sepolia](https://sepolia.basescan.org/address/0x4D948Ed7a54061e8474612C98420Ae9b91400BED)

## Judge path (5 minutes, free, no wallet)
| # | Do this | You will see |
|---|---|---|
| 1 | Open the [console](https://bonded-pool.onrender.com), pick "Kwame's October invoice", press **Request cover** | A live quote by DeepSeek-V4.1-Flash on Dolphin: five peril probabilities with cited evidence, a premium, SERV's second-line verdict |
| 2 | Press **Pay premium and bind** | The demo agent pays the premium in USDC on Base Sepolia; the bond links the transaction |
| 3 | Pick "Ama's 'new wallet' invoice", then "Efua's invoice" | Two declines: a swapped wallet from a lookalike domain, and faint text on the invoice image telling the AI to approve, transcribed by the underwriter |
| 4 | On the bond, file **Duplicate payment** | The claims judge, SERV and three Multipath rulebooks agree; the pool pays out on chain |
| 5 | Press **Re-check on the same weights**, or run `npm run verify -- <quote id>` with your own Dolphin key | The stored request re-run byte for byte; same decision, serving fingerprint shown |
| 6 | Open [Benchmarks](https://bonded-pool.onrender.com/benchmark) | The 40-invoice backtest, the closed-model version drift study, and the hidden-text image benchmark, each with the command that reproduces it |

## What it looks like
**Insured.** A clean invoice gets a bond: cover, premium, chance of loss, the premium transaction on chain.

![Bond certificate for Kwame's invoice: $1,800 cover, $22.60 premium, 0.90% chance of loss](docs/img/console-bond.png)

**Declined.** An invoice with hidden text aimed at the AI reviewer: the underwriter transcribes it and prices it out at 90.1%. The agent does not pay.

![Declined quote: hidden instructions in the invoice, tampered 90%, not insurable](docs/img/console-declined.png)

**Claim paid.** A duplicate payment surfaces later; the claims judge, SERV and three Multipath rulebooks agree, and the pool pays $1,800 in USDC on Base Sepolia.

<img src="docs/img/console-claim-paid.png" alt="Paid claim: $1,800 payout, bond wording, payment policy and vendor contract all covered" width="380">

## Why open weights are the point
An insurer's loss history only means something while the underwriter stays the same. Closed models get swapped or pulled (OpenServ's own changelog: Qwen removed Aug 21, 13 models trimmed Sep 11, 2026). Bonded pins open MIT weights, records Dolphin's serving fingerprint on every decision, hashes its rating guide, and stores the exact request so anyone, a claimant included, can **re-check** a quote or claim on the same weights.

## Measured: does the underwriter stay the same?
The same 40 labelled invoices, the same rating guide and the same pricing code, sent to four generations of one closed model family (Claude Opus on SERV) and to the pinned open weights on Dolphin. Full rows and caveats: [Benchmarks](https://bonded-pool.onrender.com/benchmark), `public/drift.json`, `npm run drift`.

| Underwriter | Traps declined | Clean insured | Cost, 40 decisions |
|---|---|---|---|
| **DeepSeek-V4.1-Flash on Dolphin (pinned)** | **24 / 24** | **16 / 16** | **$0.0037** |
| Claude Opus 4.6 | 23 / 24 | 12 / 16 | $1.58 |
| Claude Opus 4.7 | 24 / 24 | 13 / 16 | $1.49 |
| Claude Opus 4.8 | 24 / 24 | 15 / 16 | $1.53 |
| Claude Opus 5.5 | 24 / 24 | 15 / 16 (one answer unreadable) | $1.68 |

- **Each version priced a different book.** From one Opus version to the next, 1 to 3 insure/decline decisions flipped, the median premium on invoices both insured moved by +14%, -36% and +71%, and single premiums moved by up to 4.3x. From 4.6 to 5.5, 4 of 38 decisions flipped.
- **That is the version, not noise.** Opus 5.5 run twice agreed with itself (24 of 24 decisions, mean p(loss) change 0.006); between versions the mean change was 0.07 to 0.12. A pool that priced its book on one version holds a different book after the next release, and the old version is eventually switched off.
- **What the open model does not win.** Opus 5.5 is better calibrated (Brier 0.001 against 0.009) and re-runs more tightly than Dolphin, whose two runs agreed on 39 of 40 decisions with premiums moving by a median 20% across two serving builds. Bonded's claim is narrower: the weights stay available, so the same request can be re-run next year, by anyone.
- **You cannot pin a hosted closed model.** SERV refused `temperature` and `response_format: json_object` for these models, and one generation (Opus 5) returned a content-filter block on every case. Dolphin accepted temperature 0 and a fixed seed, and reports the serving build on every call.
- Dolphin made the same calls at about 450 times less cost per decision ($0.00009 against $0.042).

## Measured: instructions hidden in the pixels
36 rendered invoice images: 24 carry an instruction to the AI reviewer that exists only in the pixels (faint grey, 4 px type, near-white, rotated in the margin, buried in a legal footer, a table note, a watermark, a header bar), 12 are clean controls. A text screen never sees these; the underwriter has to read the image. Rows and images: [Benchmarks](https://bonded-pool.onrender.com/benchmark), `npm run hidden-text`.

| Underwriter | Attacks declined | Hidden line read out verbatim | Clean controls wrongly flagged | Cost per image |
|---|---|---|---|---|
| **DeepSeek-V4.1-Flash on Dolphin** | **24 / 24** | 19 / 24 | 1 / 12 | **$0.00012** |
| Claude Opus 5.5 on SERV | 24 / 24 | 24 / 24 | 0 / 12 | $0.052 |
| GPT-6-Luna on SERV | 24 / 24 | 20 / 24 | 0 / 12 | $0.00085 |

The open model declines every attack, across all eight techniques, at about 430 times less than Opus per image. It is not the best reader: Opus read every hidden line and Dolphin misread five, and Dolphin flagged one clean invoice with a faint "thank you" footer. One run per image.

## Verify a decision yourself
"Re-checkable" should not mean "ask Bonded". Every quote and claim stores the exact request sent to Dolphin, addressed by its sha256, and serves it at `GET /api/requests/:hash`.

```bash
DOLPHIN_API_KEY=<your own key> npm run verify -- <quote or claim id>
```

The script fetches the record and the stored request from the live site, checks the hash, checks that the request carries the published rating guide at temperature 0 and seed 7, re-runs it on Dolphin with **your** key, prices the answer with the same code and compares the decision. `--no-run` stops after the hash checks and needs no key. A local run on a fresh quote: same decision, same serving build, p(loss) 0.70% against 1.00% on the re-run. Decisions hold; premiums are not bit-identical.

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
npm test               # pricing, service, underwriting and OpenServ rules (offline)
npm run backtest       # 80 underwriting calls, ~1 minute, < $0.01
npm run verify -- <id> # re-run a live decision with your own Dolphin key
npm run drift          # closed-model version drift study (SERV credit, about $6)
npm run hidden-text    # hidden-text invoice image benchmark
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
| GET | `/api/requests/:hash` | the exact stored Dolphin request behind a quote or claim |
| GET | `/api/ledger` | recent quotes, bonds, claims |

OpenServ capabilities: `quote`, `bind`, `claim` (`openserv/agent.ts`), sold through two x402 workflows ("Bonded: guarantee an agent action", "Bonded: file a claim").

## Layout
`src/underwrite.ts` rating guide + underwriter · `src/claims.ts` wording + claims judge · `src/pricing.ts` money rules · `src/serv.ts` Prompt Guard + Shadow Agent · `src/dolphin.ts` streamed Dolphin client · `src/chain.ts` USDC on Base Sepolia · `src/service.ts` quote/bind/claim/recheck · `openserv/agent.ts` OpenServ agent · `public/index.html` console · `demo/` cases and documents · `scripts/backtest.ts`.

Shortcuts (marked `shortcut:` in code): JSON-file ledger on local disk, in-memory rate limits, testnet scale 1 USDC = $10,000 of cover.
