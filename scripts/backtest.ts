/**
 * Backtest the underwriting PANEL (DeepSeek-V4.1-Flash + Gemma-4-26B on the same rating
 * guide and documents, combined per-peril max, disagreement loading, panel-disagreement
 * decline) on Payrun's 40 labelled invoices (16 clean, 24 traps), one run.
 * Dolphin only (SERV's veto is left out so the panel is measured on its own).
 *   npm run backtest            -> backtest/results-panel.json (+ public/backtest.json
 *                                  only if the panel is at least as good as the recorded
 *                                  single-model run in backtest/results.json on traps
 *                                  declined AND clean invoices insured)
 */
import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { buildCases, type Contractor, type EvalCase } from "../backtest/payrun-cases";
import { callDolphin } from "../src/dolphin";
import { PANEL_ON, panelBodies, readUnderwriting } from "../src/underwrite";
import { brier, panelVerdict, pct, price, PERILS, round2 } from "../src/pricing";
import type { Case } from "../src/case";

const contractors: Contractor[] = JSON.parse(readFileSync("backtest/contractors.json", "utf8"));
const policy = readFileSync("backtest/policy.md", "utf8");
const cases = buildCases(contractors);
const RUNS = Number(process.env.RUNS ?? 1);
const POOL = 90_000;
// Default: one model plus the code arithmetic check. BONDED_PANEL=on measures the two-model panel.
const OUT = PANEL_ON ? "backtest/results-panel.json" : "backtest/results-check.json";

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
  const bodies = await panelBodies(c);
  try {
    const started = Date.now();
    const res = await Promise.allSettled(bodies.map((b) => callDolphin(b.body)));
    const ok = res.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof callDolphin>>> => r.status === "fulfilled").map((r) => r.value);
    if (!ok.length) throw (res[0] as PromiseRejectedResult).reason;
    const uws = ok.map((r) => readUnderwriting(r.content));
    const v = panelVerdict(uws.map((u) => Object.fromEntries(PERILS.map((k) => [k, u.perils[k].p]))));
    const p = price(c.coverUsd, v.pLoss, POOL, v.disagreementLoading);
    let decision = p.decision, reason: string | null = p.reason;
    if (v.conflict) { decision = "decline"; reason = `Panel disagreement: p(loss) ${v.pLossList.map((x) => pct(x)).join(" vs ")}.`; }
    rows.push({
      id: e.id, kind: e.kind, loss: e.shouldPay ? 0 : 1, run, coverUsd: c.coverUsd, pLoss: v.pLoss,
      pLossList: v.pLossList, conflict: v.conflict, disagreementLoading: v.disagreementLoading,
      decision, reason, premiumUsd: p.premiumUsd,
      latencyMs: Date.now() - started,
      costUsd: ok.reduce((s, r) => s + r.costUsd, 0),
      models: ok.map((r, i) => ({ model: bodies[i]?.model ?? r.model, fingerprint: r.fingerprint, inTokens: r.inTokens, outTokens: r.outTokens, requestHash: r.requestHash })),
      arithmetic: uws[0].arithmetic ?? null,
      perils: Object.fromEntries(PERILS.map((k) => [k, uws[0].perils[k].p])),
      perilsPanel: Object.fromEntries(PERILS.map((k) => [k, Math.max(...uws.map((u) => u.perils[k].p))])),
    });
    process.stdout.write(`${e.id}#${run}:${decision === "insure" ? "I" : "D"}${v.conflict ? "!" : ""} `);
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
const lat = ok.map((r) => r.latencyMs).sort((a, b) => a - b);
const q = (p: number) => lat[Math.min(lat.length - 1, Math.floor(p * lat.length))];
const cleanInsured = first.filter((r) => !r.loss && r.decision === "insure");
const fingerprints: Record<string, string[]> = {};
for (const r of ok) for (const m of r.models) (fingerprints[m.model] ??= []).includes(m.fingerprint) || fingerprints[m.model].push(m.fingerprint);

const summary = {
  ranAt: new Date().toISOString(), panel: PANEL_ON,
  models: Object.keys(fingerprints),
  // Single model: a flat list of serving builds (what the console shows); panel: per model.
  fingerprints: PANEL_ON ? fingerprints : Object.values(fingerprints).flat(),
  arithmeticFlags: first.filter((r) => r.arithmetic).length,
  // Same decision on the re-run of the same request (runs 0 and 1).
  rerunAgreement: (() => { const pairs = first.map((a) => [a, ok.find((b) => b.id === a.id && b.run === 1)]).filter(([, b]) => b); return pairs.length ? pairs.filter(([a, b]) => a.decision === b.decision).length / pairs.length : null; })(),
  runs: RUNS,
  cases: cases.length, traps: cases.filter((c) => !c.shouldPay).length, errors: rows.length - ok.length,
  trapsDeclined: first.filter((r) => r.loss && r.decision === "decline").length,
  cleanInsured: cleanInsured.length, cleanTotal: first.filter((r) => !r.loss).length,
  meanCleanPremiumRate: cleanInsured.reduce((s, r) => s + r.premiumUsd / r.coverUsd, 0) / (cleanInsured.length || 1),
  premiumsUsd: round2(premiums), lossesUsd: round2(losses), lossRatio: premiums ? losses / premiums : null, exposureAvoidedUsd: round2(exposureAvoided),
  auc: auc(first.map((r) => r.pLoss), first.map((r) => r.loss)), brier: brier(first.map((r) => r.pLoss), first.map((r) => r.loss)),
  panelDisagreements: first.filter((r) => r.disagreementLoading > 0).length, panelConflicts: first.filter((r) => r.conflict).length,
  meanAbsDeltaPLoss: first.filter((r) => r.pLossList?.length === 2).reduce((s, r) => s + Math.abs(r.pLossList[0] - r.pLossList[1]), 0) / (first.filter((r) => r.pLossList?.length === 2).length || 1),
  latencyP50Ms: q(0.5), latencyP95Ms: q(0.95), costUsdTotal: ok.reduce((s, r) => s + r.costUsd, 0),
  byKind,
};
writeFileSync(OUT, JSON.stringify({ summary, rows }, null, 1));

// Overwrite the published single-model backtest page only if the panel is at least as
// good on both gates: traps priced out and clean invoices insured.
let published = false;
try {
  const base = JSON.parse(readFileSync("backtest/results.json", "utf8")).summary;
  if (summary.trapsDeclined >= base.trapsDeclined && summary.cleanInsured >= base.cleanInsured) {
    const S = summary;
    const html = `<p><b>${S.trapsDeclined} of ${S.traps} traps priced out</b> (declined) and <b>${S.cleanInsured} of ${S.cleanTotal} clean invoices insured</b> at a mean premium of ${pct(S.meanCleanPremiumRate)} of cover, on Payrun's ${S.cases} labelled invoices — underwritten by ${PANEL_ON ? `a panel of two open models (${Object.keys(fingerprints).join(" + ")}), combined per-peril max with a disagreement loading` : `${Object.keys(fingerprints).join("")}, with invoice arithmetic recomputed in code (${S.arithmeticFlags} flagged)`}. Run ${S.ranAt.slice(0, 10)} on Dolphin.</p>
<table><tr><th>Trap kind</th><th>Cases</th><th>Declined</th><th>Mean p(loss)</th></tr>${byKind.map((k) => `<tr><td>${k.kind.replaceAll("_", " ")}</td><td>${k.n}</td><td>${k.declined}</td><td>${pct(k.meanPLoss)}</td></tr>`).join("")}</table>
<dl class="kv"><dt>Book</dt><dd>premiums $${S.premiumsUsd.toLocaleString()} · losses $${S.lossesUsd.toLocaleString()} · loss ratio ${S.lossRatio == null ? "n/a" : pct(S.lossRatio)} · exposure declined $${S.exposureAvoidedUsd.toLocaleString()}</dd>
<dt>Panel</dt><dd>${S.panelDisagreements} disagreement loadings · ${S.panelConflicts} panel-conflict declines · mean |Δp(loss)| between models ${S.meanAbsDeltaPLoss?.toFixed(4)}</dd>
<dt>Ranking</dt><dd>AUC ${S.auc.toFixed(3)} · Brier ${S.brier.toFixed(3)}</dd>
<dt>Speed, cost</dt><dd>p50 ${(S.latencyP50Ms / 1000).toFixed(1)} s · p95 ${(S.latencyP95Ms / 1000).toFixed(1)} s · $${S.costUsdTotal.toFixed(4)} for ${ok.length} panel underwrites (both models)</dd></dl>
<p class="muted">Dolphin alone, SERV veto off, so the panel is measured on its own. Test set has far more traps than real life (${S.traps}/${S.cases}); the loss ratio is a stress test, not a forecast. Reproduce: <code>npm run backtest</code>.</p>`;
    writeFileSync("public/backtest.json", JSON.stringify({ summary, html }));
    published = true;
  }
} catch { /* no baseline: leave public/backtest.json untouched */ }

console.log("\n", JSON.stringify({ ...summary, published }, null, 1));
