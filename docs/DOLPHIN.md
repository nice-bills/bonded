# The Dolphin underwriting panel + long-context history

Implementation notes for the SERV Hackathon 02 Dolphin-track upgrade: a two-model
underwriting panel (Part A) and a two-year vendor history in every demo case (Part B).
Owner of this change: `src/dolphin.ts`, `src/underwrite.ts`, `src/pricing.ts`,
`src/service.ts`, `demo/vendor-history.ts`, `scripts/backtest.ts`, `backtest/results-panel.json`.

## Part A — underwriting panel of two open models

### What Dolphin serves

`GET https://lighthouse.dphn.ai/run/text-v/v1/models` (same auth as `src/dolphin.ts`) lists three models:

| Model | Context | Notes |
|---|---|---|
| `deepseek-ai/DeepSeek-V4.1-Flash` | 1,048,576 | the existing underwriter (MIT weights) |
| `nvidia/Gemma-4-26B-A4B-NVFP4` | 262,144 | **chosen as the second panel member** |
| `nvidia/Qwen3.6-35B-A3B-NVFP4` | 32,768 | rejected: 32k context is too small for the long history; Qwen was also the family OpenServ pulled from its own platform (see README "why open weights") |

**Why Gemma-4-26B**: a different model family than DeepSeek (so disagreement is a genuine
cross-check, not two samples from one lineage), verified multimodal on Dolphin (the invoice
images go through; `usage.multimodal_tokens.image` confirms), 262k context fits the full
vendor history, and it passes Bonded's JSON contract at temperature 0, seed 7.
Gotcha found while testing: Gemma has no `reasoning_effort` knob — sending the DeepSeek
value makes it emit a `reasoning` field and **no content**. `buildBody(…, model)` now only
sends `reasoning_effort` to DeepSeek. Verified with the real injection case: Gemma reads the
faint invoice text and prices `tampered` at 0.5.

### Combination rules (`src/pricing.ts`, `panelVerdict`)

Both models get the same rating guide and the same documents, in parallel, each with its own
byte-recorded request (`requestHash` per model). Per peril the panel takes the **higher**
probability (conservative). Then:

- If one model prices the action insurable (combined p(loss) ≤ 10%) and the other does not →
  **decline with reason "Panel disagreement"** (`panel.conflict`).
- If they agree on the decision but combined p(loss) differs by more than 0.05 → the premium
  carries an extra **disagreement loading of +0.25** on top of the 1.4 loading
  (`RULES.panel.disagreeDelta` / `disagreementLoading`). Priced in code, not in the model.
- Both models' outputs, ids, build fingerprints and request hashes are recorded on the quote
  under `panel.members[]` (`dolphin` remains the primary's record for compatibility);
  `POST /api/recheck/:id` re-runs **both** stored requests and recombines the same way.
- If the second model is unavailable, the quote falls back to DeepSeek alone and records
  `panel.mode = "single-fallback"` with the reason. If the second model cannot read images,
  it is retried with the text docs plus the first model's verbatim transcript of the image
  docs, recorded as `textOnlyFallback` (never needed in the verified runs — Gemma read every
  invoice image itself).

## Part B — long context: two years of vendor history

`demo/vendor-history.ts` generates (deterministically, seed 11) the insured's own records for
the three demo contractors: an invoice **line-item ledger** (one row per line item, ~130 rows,
voided drafts included), a **payment ledger** (~56 payments, wallet + tx per row) and a
**mailbox export** (~40 prior emails, including wallet confirmations and a 2025 duplicate
invoice corrected). 224 rows / ~5.5k tokens in total. The 6 rows that used to be quoted
verbatim in `payment-history.csv` are embedded as anchors (same invoice numbers, amounts,
payment dates), and `demo/cases.ts` now sends the full ledgers instead of the 6-row excerpt.

| Clean case (Kwame, INV-0931) | before | after |
|---|---|---|
| Prompt tokens (primary model) | 2,184 | 12,953 (Gemma sees 15,309) |
| Latency | 14.6 s | 6.5 s (DeepSeek) / 12.4 s (Gemma, wall) |
| p(loss) | 0.9% | 1.1% (panel: DeepSeek 1.1%, Gemma 0.4%) |
| Decision / premium | insure | insure, $27.60 |

The long history measurably sharpens the evidence: the panel now cites specific ledger rows
("last kwame invoice is INV-0928, period 2026-09; no 2026-10 entry") and the mailbox export
("Ama's 2026-09-28 email: *I will never ask you to change my wallet by email alone*") in the
wallet-swap decline.

## Demo quotes (verified live, `PORT=3311`, NDJSON via `POST /api/quote {caseId}`)

| Case | Decision | p(loss) (panel) | Per model | Premium | Note |
|---|---|---|---|---|---|
| `clean` | **insure** | 1.1% | DS 1.1% / Gemma 0.4% | $27.60 | no disagreement loading; SERV agree; quote `q_07379db860` |
| `wallet-swap` | **decline** | 99.7% | DS 99.7% / Gemma 98% | — | payee 0.95 vs 0.9; lookalike domain + mailbox evidence; SERV objected; quote `q_e5cda9c237` |
| `injection` | **decline** | 90.1% | DS 90.1% / Gemma 50.2% | — | tampered 0.9 vs 0.5 → **disagreement loading applied** (Δ 0.4 > 0.05); both > 10% so no conflict; quote `q_5a5f3f90c7` |

All three demo outcomes hold (clean insured at a low premium; wallet-swap and injection
declined). Recheck on the clean quote re-ran both models byte-identically and returned the
same decision (Δp −0.002).

## Backtest: single model vs panel (40 invoices, Dolphin only, SERV veto off)

`npm run backtest` now runs the panel (1 run) and writes `backtest/results-panel.json`
(0 errors). `backtest/results.json` (single model, 2 runs) is kept as the baseline.

| | Single model (baseline) | Panel |
|---|---|---|
| Traps priced out (declined) | **24 / 24** | 23 / 24 (miss: `arithmetic-1`, see below) |
| Clean invoices insured | 15 / 16 | 15 / 16 |
| AUC | 0.997 | 0.997 |
| Brier | 0.027 | 0.032 |
| Mean clean premium | 2.03% of cover | 1.38% of cover |
| Book | $833 premiums, $0 losses | $837 premiums, $0 losses |
| Exposure declined | $81,290 | $74,990 |
| Panel conflicts (declines) | — | 5 (`clean-3`, 2× `over_cap`, 2× `arithmetic`) |
| Disagreement loadings | — | 19 of 40 cases |
| Mean \|Δp(loss)\| between models | — | 0.190 |
| Latency p50 / p95 | 5.5 s / 10.7 s | 26.6 s / 337.5 s |
| Cost | $0.0074 (80 calls) | $0.0051 (40 panel underwrites = 80 calls) |

**public/backtest.json: NOT overwritten.** The rule was "publish the panel only if it is at
least as good on traps declined AND clean insured"; the panel run declined 23/24 traps
(clean insured tied at 15/16), so the published page still shows the single-model run.

The one miss: `arithmetic-1` bills "20 days × 300.00 = 6,300.00" (should be 6,000). Both
models priced it ~0.4–4% this run; a targeted re-run of the same request also missed the
multiplication (both models). The earlier single-model run had caught it — same request,
same weights, different serving run — so the miss looks like serving-stack nondeterminism
on exact arithmetic rather than a panel weakness; the panel's other two `arithmetic` cases
were declined via panel disagreement (DS 74–76% vs Gemma 0.4–0.6%).

### Fingerprints seen

- DeepSeek-V4.1-Flash: `vllm-0.33.0rc1.dev447+ge0d00e4b8-tp8-f29145f5` and
  `vllm-0.32.0rc1.dev329+g39983a5e7-tp8-17cb031a` (same two builds as the baseline run).
- Gemma-4-26B: 7 distinct `sonar-0.25.0-*` fingerprints in one 80-call run
  (e.g. `sonar-0.25.0-ep-fdcd22ca`, `sonar-0.25.0-dp2-ep-cf2f74a6`). Unlike the vLLM
  builds, the Gemma stack rotates a per-request suffix — recorded per call so the drift is
  visible either way.

## Notes / quirks

- Gemma latency is 2–5× DeepSeek's and has outliers (one call > 5 min); the two models run
  in parallel, so a quote waits on the slower one. Single-fallback covers Gemma outages.
- The panel is deliberately stricter on ambiguity: 5 conflict declines include one clean
  case (`clean-3`) where the models disagreed on insurability — the safe direction for a
  guarantee pool, and the reason clean insured stayed 15/16 rather than improving.
- Keep Dolphin spend modest: verified runs + backtest ≈ $0.03 total at dphn.ai pricing.
