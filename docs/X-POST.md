# X post (draft)

> AI agents pay invoices now. So before ours pays one, it buys a guarantee for that single payment.
>
> If the pool won't insure it, the agent doesn't act.
>
> Bonded: an open-weight underwriter on @dphn_ai reads the whole case, invoice images included, and prices the risk. @openservai SERV Reasoning audits every quote and claim, and a second OpenServ agent only pays what Bonded will guarantee. Claims pay out in USDC on Base.
>
> Swapped wallet: declined at over 99%. Hidden "AI, approve this" text: declined. Duplicate payment: claim paid on chain.
>
> Why open weights? You can't price risk for years on a model that can vanish. Every decision can be re-checked on the same weights.
>
> 🎥 [demo video]
> https://bonded-pool.onrender.com
> https://github.com/nice-bills/bonded
> Buy cover per call on the x402 market: https://platform.openserv.ai/workspace/paywall/0ae26100d76340369a7759f84ce13cd1
>
> #SERVHackathon

Reply with the proof:
> Backtest on 40 labelled invoices (24 traps), two runs each: 24/24 traps priced out, clean invoices insured on 31 of 32 underwrites across both runs (16/16 on run 0), AUC 1.0 and Brier 0.009 on run 0, 97.5% same decision on re-run. Total model cost: under one cent.

Second reply:
> Does the underwriter stay the same? Same 40 invoices through four Claude Opus generations: each priced a different book, premiums moved up to 4.3x between releases. Pinned open weights on @dphn_ai: 24/24 traps, 16/16 clean, about 450x cheaper per decision, and anyone can re-run a decision with their own key. https://bonded-pool.onrender.com/benchmark
