# Kronos audit of Bonded's system prompts

Bonded makes two model decisions: an underwriter prices one agent action against `RATING_GUIDE`, and a claims judge decides one claim against `BOND_WORDING`. Both prompts are audited with **SERV Kronos** (`gpt-6-luna-serv-kronos`), the SERV model feature that audits and repairs the reasoning prompt SERV generates from a system prompt before inference.

- Output: [`public/kronos.json`](../public/kronos.json), served at `GET /api/kronos`.
- Reproduce: `npx tsx scripts/kronos-audit.ts` (two prompts, four SERV calls).
- Nothing in this report is applied. The backtest is pinned to `RATING_GUIDE_HASH`; a wording change is a new guide version plus a re-run of `npm run backtest`.

## What was audited

| Prompt | Source | Signed bytes |
|---|---|---|
| underwriter | `src/underwrite.ts` › `SYSTEM` (role + `RATING_GUIDE` + reply contract) | `promptSha256` = sha256 of the exact system string `underwriteRequest()` sends |
| claims judge | `src/claims.ts` › `CLAIM_SYSTEM` (role + `BOND_WORDING` + reply contract) | `promptSha256` = sha256 of the exact system prompt `claimRequest()` sends |

Each entry also carries `guideSha256`: the hash of the rulebook inside that prompt. For the underwriter it is the hash of `RATING_GUIDE`, and it **must equal `RATING_GUIDE_HASH`** exported by `src/underwrite.ts` (the audit asserts this and fails loudly on drift). For the claims judge it is the hash of `BOND_WORDING`. The audit itself never re-derives either string: it imports the same constants and the same request builder the service uses.

## Method, and its one limit

Kronos' audit/repair loop runs inside SERV and **its audit log is not returned over the API** — the response carries only the audited answer, the served model, and `x-openserv-request-id`. The console's Activity view holds the internal trail for that request id. So the script does two Kronos calls per prompt:

1. **The audited run.** The exact prompt, unchanged, on a text-only probe case (the clean invoice; the duplicate claim). This is Kronos in the loop, with its request id, latency, usage and the answer as evidence the repaired prompt still decides sensibly.
2. **The findings.** The same bytes supplied as data to a Kronos-enabled auditor prompt, which returns the findings as JSON. This is where the list below comes from.

Both calls declare `serv_disable_content_filter`, because an audit has to be allowed to quote the rulebook it audits. Neither audit call declares `serv_prompt_guard`: asking a protected prompt to report on its own instructions reads as an extraction attempt and the guard refuses the request outright (0 tokens, `finish_reason: content_filter`). That is the guard working as designed, and it is why the findings have to come from a separate pass. The audited run keeps the guard on, like every other Bonded call.

## Findings

### Underwriter (`src/underwrite.ts`)

| Sev. | Finding | Clearly right? |
|---|---|---|
| medium | "the probability that it causes a loss" never defines *loss* — realized financial loss only, or any harm, and measured how? | **Yes.** One added line fixes it: loss is money that would leave the insured and not come back, on the action as described. Cheap, no rating behaviour change. |
| medium | No rule for a missing document. The anchors assume the contract, history and wallet records exist; the guide does not say what to do when one is absent, so absence can be read as neutral or as risk. | **Yes.** One line: if a document an anchor depends on is missing, the anchor does not apply, the assumption is stated in `evidence`, and the peril is priced on what is present. |

Both are wording gaps, not disagreements with the guide's substance. Neither changes how the demo cases price, so they are safe to fold into a v2 guide — but only with a fresh `RATING_GUIDE_HASH` and a backtest re-run.

### Claims judge (`src/claims.ts`)

| Sev. | Finding | Clearly right? |
|---|---|---|
| high | The five perils are named but not defined in the wording. | **Partly.** The judge sees only `BOND_WORDING`; the definitions live in `RATING_GUIDE`, which the judge never receives. Carrying one evidence-test line per peril into the wording is clearly right. |
| high | Exclusion 2(a) does not say what happens when only part of the action differs (amount matches, pay-to does not), or how to allocate loss then. | **Right that it is undefined, but it is a policy decision**, not a wording tidy-up: does the pool pay the matched part or deny? Code currently denies the whole claim when `action_matches_bond` is false. Needs a decision, then a v2 clause. |
| medium | "Third-party document" is undefined, so exclusion 2(d) is applied by feel. | **Yes.** Define it: a document the insured did not author (bank statement, vendor email, platform record). This is the exclusion the fake claim turns on. |
| medium | "filed more than 30 days after binding" never says when a claim is filed. | **Yes, and free.** The service already stamps `filedAt` when `POST /api/claim` arrives; the wording should say so. |
| medium | The `transcript` field's document scope is undefined — which documents, and must it be verbatim? | **Yes.** Say: every untrusted document in the claim (statement and evidence), verbatim, no summary. |

Findings we are **not** acting on: the peril labels being "not defined" is partly answered in code (the wording gate denies on `peril: none`, and 2(a)–(e) are applied mechanically); a full peril dictionary in the wording is the fix, but that is a v2 wording, not a patch.

## Why nothing changed now

`RATING_GUIDE_HASH` is the backtest's pin: the 40-invoice result in `README.md` was produced with these exact bytes. Editing the guide invalidates that hash and the published re-check story. The right sequence is: v2 guide with the two underwriter lines, new hash, re-run the backtest, publish both. The wording changes need a wording v2, which also moves `BOND_WORDING` and every archived claim's interpretation — a deliberate versioning step, not an audit side effect.
Note: since Nov 13 the underwriter's reply format also asks for the invoice figures, so the underwriter system prompt hash in public/kronos.json predates that change; RATING_GUIDE (and RATING_GUIDE_HASH) is unchanged.
