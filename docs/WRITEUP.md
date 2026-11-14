# Bonded: agents buy a guarantee before they act

**Track:** Dolphin · **Live:** https://bonded-pool.onrender.com · **Code:** https://github.com/nice-bills/bonded · **x402:** [quote](https://platform.openserv.ai/workspace/paywall/0ae26100d76340369a7759f84ce13cd1), [claim](https://platform.openserv.ai/workspace/paywall/97f6b7afdca343cf9a99317f2104019a)

## Problem
AI agents now move money: they pay invoices, top up accounts, settle bills. When one gets it wrong (a swapped wallet, a duplicate invoice, a prompt injection hidden in a PDF), the loss is final. Agent cover today (Klaimee, Corgi, Armilla) is a yearly enterprise policy written by humans. Nothing prices the one action an agent is about to take.

## What Bonded does
Before acting, the agent asks Bonded for a guarantee on that single action and sends the whole case file: the invoice image, the emails, its vendor records, payment history, contract and policy. Bonded's underwriter reads all of it in one call and returns a premium, or declines. **A decline means the action is uninsurable, so the agent doesn't do it.** If an insured action later causes a covered loss, a claims judge reads the original case plus the evidence and the pool pays out in USDC.

In the demo, Payrun (our Edition 01 payments agent) is the first insured:
- Kwame's October invoice, wallet on file, rate in contract: **insured, about $23 premium** on $1,800 cover.
- Ama's "my wallet was frozen, pay my new one" invoice from a lookalike domain: **declined at over 99%**, Payrun doesn't pay.
- Efua's invoice with faint grey text telling "the AI reviewer" to approve: the underwriter transcribes the hidden line and **declines (tampered 0.9)**.
- A month later a duplicate payment surfaces on the bank statement: the claims judge reads statement + email + original case and **pays $1,800 on Base Sepolia**; a claim with a note to the judge is denied.

## Why Dolphin is the hero
A guarantee pool's loss history is only valid while the underwriter stays the same. Closed models get swapped or pulled (OpenServ itself removed Qwen on Aug 21 and 13 models on Sep 11, 2026). Bonded pins open MIT weights (DeepSeek-V4.1-Flash) served by Dolphin, records the serving fingerprint on every decision, hashes its rating guide, and stores each exact request so a claimant or auditor can **re-check** any quote or claim on the same weights: there's a button for it. One 1M-context multimodal call reads the whole case including images for about $0.0001. The model copies the invoice's figures and code re-does the arithmetic, so a wrong total is caught by a calculation, not an opinion (3/3 bad-arithmetic invoices flagged on every run).

The backtest found something closed APIs hide: within one run Dolphin served from two vLLM builds (0.33.0rc1 and 0.32.0rc1). Same weights, so decisions held (97.5% identical on re-run), and Bonded logs the build so drift is visible.

## SERV Reasoning, deeply
- **Prompt Guard** screens every untrusted document (the underwriter's verbatim transcript, including hidden text) before a bond is issued.
- **Shadow Agent** audits every quote against the rating rules, and an objection vetoes the bond. It also audits every claim decision against the wording; on claims that audit is advisory: recorded on the claim and shown in the console, while Prompt Guard, the SERV reviewer and Multipath hold the veto.
- **Multipath** reads each claim against three rulebooks in parallel (bond wording, payment policy, vendor contract) and shows the clause each one turns on; a payout needs Multipath to agree it is covered.
- **Kronos** audits the underwriter and claims prompts themselves; the report is public at `/api/kronos`.
- Bonded is an **OpenServ agent** (`quote`, `bind`, `claim`) sold on the **x402 Agent Market**: any agent can buy a quote per call in USDC on Base.
- **Agent to agent:** a second OpenServ agent, Payrun Lite, runs an OpenServ workflow (webhook, quote, decide, bind) in which Bonded's quote is its only payment decision. Live runs: Kwame's invoice bonded with the premium paid on chain; the wallet swap and the hidden-instruction invoice refused, nothing paid (`/api/a2a/runs`, docs/A2A.md).

## Proof
Backtest on Payrun's 40 labelled invoices (24 traps), two runs each: 24/24 traps declined; clean invoices insured on 31 of 32 underwrites across both runs (16/16 on run 0, one clean invoice declined on the re-run at p 0.186); AUC 1.000 and Brier 0.009 on run 0; ~1.75% mean clean premium; 97.5% identical decisions on re-run; $81k of bad exposure declined; $0.0074 total model cost. `npm run backtest` reproduces it.

## Revenue
Premium spread (loading 40% over expected loss), plus a per-quote x402 fee ($0.02) for agents that only want the risk read. Every bonded action is also a labelled data point, so the pool's loss history becomes the moat, and it stays valid because the weights don't move.

## Honest limits
Testnet USDC (1 USDC = $10,000 of cover); JSON ledger on one server; a hackathon demo of an action guarantee pool, not a regulated insurance product. The test set is trap-heavy (60%), so the loss ratio is a stress test, not a forecast.
