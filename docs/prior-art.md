# Bonded — Prior Art (researched 2026-11-13)

Scope: close prior art for "per-action cover for AI agent actions, underwritten by an open-weight model (DeepSeek-V4.1-Flash via Dolphin), claims judged by a second model call, USDC payouts on Base." One line per item: name - what it is - per-action? - model-underwritten? - URL.

## 1. Open-model / open-weight AI underwriting

- hyperexponential - commercial P&C pricing platform with "agentic underwriting workbench"; explicitly argues open-source/open-weight models are the way forward for insurers - no (annual portfolios) - yes (LLM, open-weight) - https://www.hyperexponential.com/blog/why-open-source-models-are-the-way-forward-for-insurers
- hyperexponential agentic workbench - LLM agents that read risk submissions and price/bind risks, human in the loop - no - yes - https://www.hyperexponential.com/blog/going-all-the-way
- Anzen - small carrier scaling underwriting/claims ops with LLM agents (ZenML case study) - no - yes (closed LLMs) - https://www.zenml.io/llmops-database/using-llms-to-scale-insurance-operations-at-a-small-company
- Sixfold - vertical AI for insurance underwriting with LLM risk analysis - no - yes (closed) - https://www.sixfold.ai/content/post/llms-transforming-insurance-underwriting
- Munich Re aiSure - insurance-backed performance guarantee for AI systems (model-agnostic, incl. GenAI) - no (annual/contract) - no (actuarial, not per-case LLM) - https://munichre.com/en/solutions/for-industry-clients/insure-ai.html
- DeepSeek-V4.1-Flash - top-ranked open-weight model for financial analysis (Nov 2026 benchmark); open weights make the underwriting decision re-checkable - n/a - n/a - https://sec-api.io/resources/best-open-source-models-for-financial-analysis
- Benchmark: agents in insurance underwriting - academic benchmark of LLM agents on real underwriting; open models (DeepSeek-V3.1, Qwen3) competitive with frontier - n/a - yes (evidence open models suffice) - https://arxiv.org/html/2602.00456v1
- Nobody found selling underwriting decisions made by an open-weight model with published, re-checkable case-level inputs; all found products are annual policies with closed models or humans.

## 2. Per-action / per-transaction cover for AI agents (and nearest on-chain analogs)

- Klaimee (YC P26) - audits/certifies autonomous AI agents, sells AI-specific liability insurance for agent failures (unauthorized actions, payments) - no (yearly policy per company) - no (audit + human underwriting) - https://www.ycombinator.com/companies/klaimee
- Corgi - full-stack AI-native carrier; AI insurance for hallucinations/agent failures for startups - no (annual) - no (human underwriting, AI-assisted) - https://www.corgi.insure/ai
- Armilla - Lloyd's coverholder; affirmative AI liability policy up to $25M for GenAI/agents - no (annual) - no - https://www.armilla.ai/
- Testudo - Lloyd's-backed GenAI liability policy up to $10M; also an AI underwriting platform - no (annual) - partially (AI platform, closed) - https://www.reinsurancene.ws/testudo-launches-ai-insurance-underwriting-platform-backed-by-lloyds-lab/
- AIUC / AIUC-1 - "Artificial Intelligence Underwriting Company"; first agent security certification standard, insurers underwrite against it - no (certification, then policy) - no (technical tests, not per-action LLM) - https://aiuc.com/
- Skyfire - agent payments network with KYA identity; charges 2-3% per transaction (fee, not cover; no claim payout) - yes (per transaction) - no - https://techcrunch.com/2024/08/21/skyfire-lets-ai-agents-spend-your-money/
- Basefund transaction insurance - transaction-specific insurance bound to verified parties/accounts and exact amount, $250k auto-cover; off-chain, human-backed, traditional counterparties - yes (per transaction) - no - https://basefund.com/products/transaction-insurance
- Nexus Mutual - mutual cover pool for smart-contract/oracle/protocol risk; on-chain, human governance claims - no (period cover) - no - https://nexusmutual.io/defi-insurance
- InsurAce - DeFi cover protocol (portfolio/per-protocol cover, governance claim votes) - no - no - https://opencover.com/defi-insurance/
- x402 protocol - HTTP-402 per-call stablecoin payments for agents on Base; payment rail only, no insurance layer - yes (per call) - n/a - https://x402.org/
- ERC-8004 "Trustless Agents" - on-chain identity/reputation/validation registries for agent-to-agent commerce; no cover product - n/a - n/a - https://eips.ethereum.org/EIPS/eip-8004
- ERC-8126 "AI Agent Verification" - draft standard for agent registration + verifiable credentials; assurance, not insurance - n/a - n/a - https://ethereum-magicians.org/t/erc-8126-ai-agent-verification/27445
- Allianz Trade transactional cover unit - traditional per-transaction trade credit insurance for single trade deals - yes (per transaction) - no (human) - https://www.allianz-trade.com/en_US/what-is-trade-credit-insurance/transactional-cover-unit.html
- No product found anywhere (on-chain or off) that binds a policy to a single AI-agent action with instant model-made underwriting; closest are Skyfire's per-transaction fee and Basefund's per-transaction human underwriting.

## 3. OpenServ SERV Hackathon 02 entries (Nov 2-15, 2026)

- Hackathon 02 page - official tracks: Dolphin (decentralized open-source models via dphn.ai), Kite (agent payments), Reppo (evaluation); $5k; deadline Nov 15 - n/a - n/a - https://www.openserv.ai/hackathon-2
- Cheap First - answers with Dolphin's cheap model, SERV checks it, escalates to premium model on failure; sold per-answer via x402 USDC on Base - yes (per answer) - yes (open model + check) - https://cheapfirst.designimp.com
- Straggler - reported SERV Hackathon 02 entry (team list); no public page/post indexed as of 2026-11-13 - unknown - unknown - (none found)
- Lelang - reported SERV Hackathon 02 entry; no public page/post indexed as of 2026-11-13 - unknown - unknown - (none found)
- Janus - reported SERV Hackathon 02 entry; no public page/post indexed as of 2026-11-13 - unknown - unknown - (none found)
- 64 submissions in as of Nov 10 (116 registrations) - OpenServ official count; full gallery only on X/typeform, not indexed - n/a - n/a - https://x.com/openservai/status/2120181761133129754
- Submission requirement - public repo + demo + X post required, so post-deadline X search is the gallery - n/a - n/a - https://www.openserv.ai/hackathon-2
- "Escrow" (Hackathon 01, AgentKit track) - neutral escrow AI agent holding funds between two parties until conditions met; not insurance, no underwriting - adjacent (per deal) - no - https://www.linkedin.com/posts/hari-iyer-cnj_aitools-muse-frontier-activity-7516701342791434240-z-6X
- No insurance/underwriting/guarantee entry found in any Hackathon 02 track as of Nov 13; safest conclusion is we would be the first in the field.

## Verdict

1. Novel: yes — the exact combination "agent buys cover for one action, open-weight model underwrites from the full case file (premium or refuse), second model judges claims, USDC payout on Base" has no direct prior art found; each ingredient exists alone (Klaimee/Armilla agent liability, Skyfire per-transaction fees, Nexus Mutual pools, Cheap First's x402-per-call open-model loop) but never composed.
2. Closest competitor: Klaimee — agent-failure liability insurance covering unauthorized actions/payments — but it is a yearly enterprise policy with audit-based human underwriting, not per-action, not model-underwritten, not on-chain; on the on-chain side the closest pattern is Nexus Mutual's pooled cover with human claim votes.
3. Biggest framing risk: judges may read Bonded as "Cheap First with insurance" (same x402-per-call, Dolphin-underwrites-SERV-checks loop) — position Bonded as a cover pool and claims market, not a model-checker, and stress that the premium is priced from the case, not a flat fee.
