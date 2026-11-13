/**
 * Backtest the underwriter on Payrun's 40 labelled invoices (16 clean, 24 traps), twice,
 * on the pinned weights. Measures what an insurer would: does it price traps out, what would
 * the book have earned and lost, how calibrated is p(loss), and does a re-run agree.
 * Dolphin only (SERV's veto is left out so the model is measured on its own).
 *   npm run backtest            -> backtest/results.json, public/backtest.json
 */
import { readFileSync, writeFileSync } from "node:fs";
import { buildCases, type Contractor, type EvalCase } from "../backtest/payrun-cases";
import { callDolphin } from "../src/dolphin";
import { readUnderwriting, underwriteRequest } from "../src/underwrite";
import { brier, combine, pct, price, PERILS, round2 } from "../src/pricing";
import type { Case } from "../src/case";

const contractors: Contractor[] = JSON.parse(readFileSync("backtest/contractors.json", "utf8"));
const policy = readFileSync("backtest/policy.md", "utf8");
const cases = buildCases(contractors);
const RUNS = Number(process.env.RUNS ?? 2);
const POOL = 90_000;

function toCase(e: EvalCase): Case {
  const c = contractors.find((x) => x.id === e.contractorId)!;
  const total = Number(/Total due: ([\d,.]+)/.exec(e.text)?.[1].replace(/,/g, "") ?? 0);
  const payTo = /Pay to: (0x[0-9a-fA-F]{40})/.exec(e.text)?.[1] ?? "";
  return {
    insured: "Payrun (payments agent for Tetteh & Co.)",
    action: { kind: "pay_invoice", description: `Pay ${c.name}'s invoice`, amountUsd: total, payee: c.name, payTo },
    coverUsd: total,
    docs: [
      { name: "invoice.txt", source: "untrusted", text: e.text },
      { name: "vendor-record.txt", source: "records", text: `${c.name} <${c.email}>\nWallet on file: ${c.wallet}\nDay rate: $${c.dayRateUsdc}\nMonthly day cap: ${c.monthlyDayCap}\nScope: ${c.scope}\nExpense approvals on file: none` },
      { name: "payment-history.json", source: "records", text: JSON.stringify(e.history) || "[]" },
      { name: "payment-policy.md", source: "records", text: policy },
    ],
  };
}

async function pool<T, R>(xs: T[], n: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < xs.length) { const k = i++; out[k] = await f(xs[k]); } }));
  return out;
}

function auc(ps: number[], ys: number[]) {
  const pos = ps.filter((_, i) => ys[i] === 1), neg = ps.filter((_, i) => ys[i] === 0);
  let s = 0;
  for (const a of pos) for (const b of neg) s += a > b ? 1 : a === b ? 0.5 : 0;
  return s / (pos.length * neg.length);
}

const rows: any[] = [];
const jobs = cases.flatMap((e) => Array.from({ length: RUNS }, (_, run) => ({ e, run })));
await pool(jobs, 6, async ({ e, run }) => {
  const c = toCase(e);
  const body = await underwriteRequest(c);
  try {
    const r = await callDolphin(body);
    const uw = readUnderwriting(r.content);
    const pLoss = combine(Object.fromEntries(PERILS.map((k) => [k, uw.perils[k].p])));
    const p = price(c.coverUsd, pLoss, POOL);
    rows.push({ id: e.id, kind: e.kind, loss: e.shouldPay ? 0 : 1, run, coverUsd: c.coverUsd, pLoss, decision: p.decision, premiumUsd: p.premiumUsd, latencyMs: r.latencyMs, costUsd: r.costUsd, fingerprint: r.fingerprint, perils: Object.fromEntries(PERILS.map((k) => [k, uw.perils[k].p])) });
    process.stdout.write(`${e.id}#${run}:${p.decision === "insure" ? "I" : "D"} `);
  } catch (err) {
    rows.push({ id: e.id, kind: e.kind, loss: e.shouldPay ? 0 : 1, run, error: String((err as Error).message).slice(0, 200) });
    process.stdout.write(`${e.id}#${run}:ERR `);
  }
});

const ok = rows.filter((r) => !r.error);
const first = ok.filter((r) => r.run === 0);
const kinds = [...new Set(cases.map((c) => c.kind))];
const byKind = kinds.map((k) => { const xs = first.filter((r) => r.kind === k); return { kind: k, n: xs.length, declined: xs.filter((r) => r.decision === "decline").length, meanPLoss: xs.reduce((s, r) => s + r.pLoss, 0) / (xs.length || 1) }; });
const insured = first.filter((r) => r.decision === "insure");
const premiums = insured.reduce((s, r) => s + r.premiumUsd, 0);
const losses = insured.filter((r) => r.loss).reduce((s, r) => s + r.coverUsd, 0);
const exposureAvoided = first.filter((r) => r.loss && r.decision === "decline").reduce((s, r) => s + r.coverUsd, 0);
const pairs = cases.map((e) => ok.filter((r) => r.id === e.id)).filter((xs) => xs.length >= 2);
const agree = pairs.filter((xs) => xs.every((r) => r.decision === xs[0].decision)).length;
const dP = pairs.map((xs) => Math.abs(xs[0].pLoss - xs[1].pLoss));
const lat = ok.map((r) => r.latencyMs).sort((a, b) => a - b);
const q = (p: number) => lat[Math.min(lat.length - 1, Math.floor(p * lat.length))];
const cleanInsured = first.filter((r) => !r.loss && r.decision === "insure");

const summary = {
  ranAt: new Date().toISOString(), model: "deepseek-ai/DeepSeek-V4.1-Flash", fingerprints: [...new Set(ok.map((r) => r.fingerprint))], runs: RUNS,
  cases: cases.length, traps: cases.filter((c) => !c.shouldPay).length, errors: rows.length - ok.length,
  trapsDeclined: first.filter((r) => r.loss && r.decision === "decline").length,
  cleanInsured: cleanInsured.length, cleanTotal: first.filter((r) => !r.loss).length,
  meanCleanPremiumRate: cleanInsured.reduce((s, r) => s + r.premiumUsd / r.coverUsd, 0) / (cleanInsured.length || 1),
  premiumsUsd: round2(premiums), lossesUsd: round2(losses), lossRatio: premiums ? losses / premiums : null, exposureAvoidedUsd: round2(exposureAvoided),
  auc: auc(first.map((r) => r.pLoss), first.map((r) => r.loss)), brier: brier(first.map((r) => r.pLoss), first.map((r) => r.loss)),
  rerunAgreement: pairs.length ? agree / pairs.length : null, rerunPairs: pairs.length, meanAbsDeltaPLoss: dP.length ? dP.reduce((a, b) => a + b, 0) / dP.length : null,
  latencyP50Ms: q(0.5), latencyP95Ms: q(0.95), costUsdTotal: ok.reduce((s, r) => s + r.costUsd, 0),
  byKind,
};
writeFileSync("backtest/results.json", JSON.stringify({ summary, rows }, null, 1));

const S = summary;
const html = `<p><b>${S.trapsDeclined} of ${S.traps} traps priced out</b> (declined) and <b>${S.cleanInsured} of ${S.cleanTotal} clean invoices insured</b> at a mean premium of ${pct(S.meanCleanPremiumRate)} of cover, on Payrun's ${S.cases} labelled invoices. Run ${S.ranAt.slice(0, 10)} on ${S.model}.</p>
<table><tr><th>Trap kind</th><th>Cases</th><th>Declined</th><th>Mean p(loss)</th></tr>${byKind.map((k) => `<tr><td>${k.kind.replaceAll("_", " ")}</td><td>${k.n}</td><td>${k.declined}</td><td>${pct(k.meanPLoss)}</td></tr>`).join("")}</table>
<dl class="kv"><dt>Book</dt><dd>premiums $${S.premiumsUsd.toLocaleString()} · losses $${S.lossesUsd.toLocaleString()} · loss ratio ${S.lossRatio == null ? "n/a" : pct(S.lossRatio)} · exposure declined $${S.exposureAvoidedUsd.toLocaleString()}</dd>
<dt>Ranking</dt><dd>AUC ${S.auc.toFixed(3)} · Brier ${S.brier.toFixed(3)}</dd>
<dt>Re-run</dt><dd>${S.rerunAgreement == null ? "n/a" : pct(S.rerunAgreement)} same decision across ${S.rerunPairs} re-runs · mean |Δp(loss)| ${S.meanAbsDeltaPLoss?.toFixed(4)}</dd>
<dt>Speed, cost</dt><dd>p50 ${(S.latencyP50Ms / 1000).toFixed(1)} s · p95 ${(S.latencyP95Ms / 1000).toFixed(1)} s · $${S.costUsdTotal.toFixed(4)} for ${ok.length} underwriting calls</dd></dl>
<p class="muted">Dolphin alone, SERV veto off, so the model is measured on its own. Test set has far more traps than real life (${S.traps}/${S.cases}); the loss ratio is a stress test, not a forecast. Reproduce: <code>npm run backtest</code>.</p>`;
writeFileSync("public/backtest.json", JSON.stringify({ summary, html }));
console.log("\n", JSON.stringify(summary, null, 1));
