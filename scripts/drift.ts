/**
 * Version drift: the SAME 40 Payrun underwriting requests (same system prompt, documents and JSON
 * reply contract as scripts/backtest.ts) sent to several generations of one closed model family on
 * the OpenServ SERV inference API, priced by the same code, next to the pinned Dolphin model.
 *   PILOT=1 npm run drift   -> 3 cases on the newest model, cost projection for the full run
 *   npm run drift           -> backtest/results-drift.json (raw rows) + public/drift.json
 *   MODELS=a,b,c npm run drift  -> run a subset of versions (oldest to newest)
 * Raw answers are cached in backtest/results-drift.json and reused, so a re-run only calls what is missing.
 */
import "dotenv/config";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { buildCases, type Contractor, type EvalCase } from "../backtest/payrun-cases";
import { DOLPHIN_MODEL, parseJson } from "../src/dolphin";
import { RATING_GUIDE_HASH, readUnderwriting, underwriteRequest } from "../src/underwrite";
import { brier, combine, price, PERILS } from "../src/pricing";
import type { Case } from "../src/case";

const API = "https://inference-api.openserv.ai/v1";
const KEY = process.env.SERV_API_KEY;
if (!KEY) throw new Error("SERV_API_KEY is not set");
const ALL_MODELS = ["claude-opus-4.6", "claude-opus-4.7", "claude-opus-4.8", "claude-opus-5", "claude-opus-5.5"];
const MODELS = process.env.MODELS ? process.env.MODELS.split(",") : ALL_MODELS;
const NEWEST = MODELS[MODELS.length - 1];
const PILOT = process.env.PILOT === "1";
const POOL = 90_000;
const MAX_TOKENS = 3000; // pilot answers used ~1500 of 2000; headroom so long trap transcripts are not truncated
const RAW = "backtest/results-drift.json";
const LAYOUT = "prompt-in-user";
const SERV_SYSTEM = "Follow the instructions in the user message exactly.";

const contractors: Contractor[] = JSON.parse(readFileSync("backtest/contractors.json", "utf8"));
const policy = readFileSync("backtest/policy.md", "utf8");
const cases = buildCases(contractors);

// Same as scripts/backtest.ts (not exported there).
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

async function pool<T>(xs: T[], n: number, f: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < xs.length) await f(xs[i++]); }));
}

function auc(ps: number[], ys: number[]) {
  const pos = ps.filter((_, i) => ys[i] === 1), neg = ps.filter((_, i) => ys[i] === 0);
  let s = 0;
  for (const a of pos) for (const b of neg) s += a > b ? 1 : a === b ? 0.5 : 0;
  return pos.length && neg.length ? s / (pos.length * neg.length) : null;
}
const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

// SERV pricing is listed in cents per million tokens (claude-opus-5.5: 480 in / 2400 out = $4.80 / $24 per M).
const pricing: Record<string, { input: number; output: number }> = {};
for (const m of (await (await fetch(`${API}/models`, { headers: { authorization: `Bearer ${KEY}` } })).json()).items) pricing[m.modelId] = m.pricing;
const costOf = (model: string, u: any) => ((u?.prompt_tokens ?? 0) * pricing[model].input + (u?.completion_tokens ?? 0) * pricing[model].output) / 100 / 1e6;

// Parameters each model rejected (learned from 400s, then left out of every later call).
const OPTIONAL = ["seed", "reasoning_effort", "response_format", "temperature", "max_tokens"] as const;
const dropped: Record<string, string[]> = {};

type Raw = { model: string; run: number; id: string; content?: string; finishReason?: string; servModel?: string; usage?: any; costUsd?: number; latencyMs?: number; error?: string; params?: string[]; headers?: Record<string, string> };
const prev: Raw[] = existsSync(RAW) ? JSON.parse(readFileSync(RAW, "utf8")).raw ?? [] : [];
// Only answers produced with the current message layout are reused.
const raw: Raw[] = prev.filter((r) => !r.error && (r as any).layout === LAYOUT);
for (const r of raw) for (const p of OPTIONAL) if (r.params && !r.params.includes(p) && !(p === "max_tokens" && r.params.includes("max_completion_tokens"))) (dropped[r.model] ??= []).includes(p) || dropped[r.model].push(p);
const save = () => writeFileSync(RAW, JSON.stringify({ ...(existsSync(RAW) ? JSON.parse(readFileSync(RAW, "utf8")) : {}), raw }, null, 1));
let spent = 0;

async function callServ(model: string, base: Record<string, unknown>): Promise<Omit<Raw, "model" | "run" | "id">> {
  const started = Date.now();
  for (let attempt = 0; attempt < 6; attempt++) {
    const body: Record<string, unknown> = { ...base, model, max_tokens: MAX_TOKENS };
    for (const p of dropped[model] ?? []) delete body[p];
    if (dropped[model]?.includes("max_tokens")) body.max_completion_tokens = MAX_TOKENS;
    let res: Response, text: string;
    try {
      res = await fetch(`${API}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
      text = await res.text();
    } catch (e) {
      if (attempt === 5) throw new Error(`network: ${(e as Error).message}`);
      await new Promise((r) => setTimeout(r, 3000 * 2 ** attempt));
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt === 5) throw new Error(`SERV ${res.status}: ${text.slice(0, 200)}`);
      await new Promise((r) => setTimeout(r, Number(res.headers.get("retry-after") ?? 0) * 1000 || 3000 * 2 ** attempt));
      continue;
    }
    if (res.status === 400) {
      const bad = OPTIONAL.find((p) => p in body && !(dropped[model] ?? []).includes(p) && text.includes(p));
      if (!bad) throw new Error(`SERV 400: ${text.slice(0, 300)}`);
      (dropped[model] ??= []).push(bad);
      console.log(`\n${model} rejected ${bad}: ${text.slice(0, 200)}`);
      continue;
    }
    if (!res.ok) throw new Error(`SERV ${res.status}: ${text.slice(0, 300)}`);
    const json = JSON.parse(text);
    const ch = json.choices?.[0];
    const costUsd = costOf(model, json.usage);
    spent += costUsd;
    return {
      content: ch?.message?.content ?? "", finishReason: ch?.finish_reason, servModel: json.model, usage: json.usage, costUsd,
      latencyMs: Date.now() - started, params: Object.keys(body).filter((k) => k !== "model" && k !== "messages"),
      headers: Object.fromEntries([...res.headers].filter(([k]) => /cost|price|usage|request-id/i.test(k))),
    };
  }
  throw new Error("retries exhausted");
}

/** Parse and price one answer; anything short of five numeric perils is an error, not a decline. */
function priced(content: string | undefined, finishReason: string | undefined, coverUsd: number) {
  if (!content) throw new Error(`empty content (finish_reason ${finishReason})`);
  if (finishReason === "length") throw new Error("answer truncated (finish_reason length)");
  let j: any;
  try { j = parseJson<any>(content); } catch { throw new Error(`not JSON: ${content.slice(0, 80)}`); }
  const n = normalise(j);
  const uw = readUnderwriting(JSON.stringify(n.contract));
  const perils = Object.fromEntries(PERILS.map((k) => [k, uw.perils[k].p]));
  const p = price(coverUsd, combine(perils), POOL);
  const verbatim = PERILS.every((k) => typeof j?.perils?.[k]?.p === "number");
  return { pLoss: p.pLoss, decision: p.decision, premiumUsd: p.premiumUsd, perils, arithmetic: uw.arithmetic ?? null, shape: n.shape, invoiceFound: n.invoiceFound, verbatim };
}

/**
 * SERV rewrites the system prompt before the model sees it (a nonce-key probe came back with
 * paraphrased keys), so answers use their own key names. Map ONLY the shapes seen in the cached
 * answers onto the reply contract; anything else, or any of the five perils missing or outside
 * [0,1], is an error (readUnderwriting would otherwise clamp a missing p to 1, a silent decline).
 */
function normalise(j: any) {
  const val = (v: any) => (typeof v === "number" ? v : typeof v?.p === "number" ? v.p : typeof v?.probability === "number" ? v.probability : typeof v?.estimate === "number" ? v.estimate : NaN);
  const cands: { name: string; ps: number[] }[] = [];
  for (const [name, c] of [["(top level)", j], ...Object.entries(j ?? {})] as [string, any][]) {
    if (!c || typeof c !== "object" || Array.isArray(c)) continue;
    const ps = PERILS.map((k) => val(c[k]));
    if (ps.every(Number.isFinite)) cands.push({ name, ps });
  }
  if (!cands.length) throw new Error("no container with a numeric probability for all five perils");
  const revised = cands.find((c) => c.name.startsWith("revised"));
  const agree = cands.every((c) => c.ps.every((x, i) => x === cands[0].ps[i]));
  if (!revised && !agree) throw new Error(`conflicting peril containers: ${cands.map((c) => c.name).join(", ")}`);
  const pick = revised ?? cands[0];
  if (pick.ps.some((x) => x < 0 || x > 1)) throw new Error(`probability outside [0,1] in ${pick.name}: ${pick.ps.join(",")}`);
  const inv = j.invoice ?? j.invoice_figures ?? {};
  const rawLines: any[] = Array.isArray(inv.lines) ? inv.lines : Array.isArray(inv.line_items) ? inv.line_items
    : Object.keys(inv).filter((k) => /^line_\d+$/.test(k)).map((k) => inv[k])
      .concat(inv.quantity != null ? [{ quantity: inv.quantity, rate: inv.rate, amount: inv.line_amount }] : []);
  // A line given as prose ("5 days × 300.00 = 1,500.00") has no figures to check: treat the invoice as unread.
  const lines = rawLines.some((l) => !l || typeof l !== "object") ? [] : rawLines.map((l) => ({ qty: l?.qty ?? l?.quantity, rate: l?.rate ?? l?.unit_rate, amount: l?.amount ?? l?.line_amount }));
  const total = inv.total ?? inv.total_printed ?? inv.printed_total ?? inv.total_as_printed ?? inv.total_due ?? null;
  return {
    shape: pick.name, invoiceFound: lines.length > 0,
    contract: { perils: Object.fromEntries(PERILS.map((k, i) => [k, { p: pick.ps[i], evidence: "" }])), invoice: { lines, total }, summary: String(j.summary ?? "") },
  };
}

// ---- calls ----
const jobs = [
  ...(PILOT ? [] : MODELS.flatMap((model) => cases.map((e) => ({ model, run: 0, e })))),
  ...(PILOT ? cases.slice(0, 3) : cases).map((e) => ({ model: NEWEST, run: PILOT ? 0 : 1, e })),
].filter((j) => !raw.some((r) => r.model === j.model && r.run === j.run && r.id === j.e.id));
const bodies = new Map<string, Record<string, unknown>>();
for (const e of cases) {
  // SERV rewrites the system prompt before the model sees it (the reply contract and the rating anchors
  // are lost), and it requires one. So the underwriter prompt travels verbatim at the top of the user
  // message, under a one-line system prompt: same bytes of guide, contract and documents as Dolphin gets.
  const b: any = await underwriteRequest(toCase(e));
  const [sys, user] = b.messages;
  bodies.set(e.id, { ...b, messages: [{ role: "system", content: SERV_SYSTEM }, { role: "user", content: [{ type: "text", text: sys.content }, ...user.content] }] });
}

async function runJob(j: (typeof jobs)[number]) {
  let r: Raw;
  try { r = { model: j.model, run: j.run, id: j.e.id, layout: LAYOUT, ...(await callServ(j.model, bodies.get(j.e.id)!)) } as Raw; }
  catch (err) { r = { model: j.model, run: j.run, id: j.e.id, error: String((err as Error).message).slice(0, 300) }; }
  raw.push(r);
  save();
  process.stdout.write(`${j.model}#${j.run}:${j.e.id}:${r.error ? "ERR" : "ok"} ($${spent.toFixed(3)}) `);
}
// One sequential probe per model settles which parameters it accepts before the fan-out.
await Promise.all([...new Set(jobs.map((j) => j.model))].map(async (model) => {
  const mine = jobs.filter((j) => j.model === model);
  await runJob(mine[0]);
  await pool(mine.slice(1), 4, runJob);
}));
console.log(`\nspent this invocation: $${spent.toFixed(4)}`);

if (PILOT) {
  const ps = raw.filter((r) => r.model === NEWEST && r.run === 0 && !r.error).slice(0, 3);
  for (const r of ps) console.log(r.id, r.finishReason, r.latencyMs, JSON.stringify(r.usage), JSON.stringify(r.headers));
  const inT = mean(ps.map((r) => r.usage?.prompt_tokens ?? 0))!, outT = mean(ps.map((r) => r.usage?.completion_tokens ?? 0))!;
  const calls = [...ALL_MODELS.map((m) => [m, 40]), [NEWEST, 40]] as [string, number][];
  const proj = calls.reduce((s, [m, n]) => s + n * costOf(m, { prompt_tokens: inT, completion_tokens: outT }), 0);
  console.log(`mean tokens in ${inT} out ${outT}; projected 240 calls: $${proj.toFixed(2)} (pricing read as cents per M tokens); p50-ish latency ${median(ps.map((r) => r.latencyMs!))} ms`);
  process.exit(0);
}

// ---- analysis ----
type Cell = { pLoss: number; decision: "insure" | "decline"; premiumUsd: number };
const cover = new Map(cases.map((e) => [e.id, toCase(e).coverUsd]));
const trap = new Map(cases.map((e) => [e.id, !e.shouldPay]));
const cells: Record<string, Record<number, Record<string, Cell>>> = {};
const errs: Record<string, Record<number, { id: string; error: string }[]>> = {};
const meta: Record<string, { costUsd: number; lat: number[] }> = {};
const rowsOut: any[] = [];

const dolphin = JSON.parse(readFileSync("backtest/results-check.json", "utf8"));
for (const r of dolphin.rows) {
  if (r.error) { ((errs[DOLPHIN_MODEL] ??= {})[r.run] ??= []).push({ id: r.id, error: r.error }); continue; }
  ((cells[DOLPHIN_MODEL] ??= {})[r.run] ??= {})[r.id] = { pLoss: r.pLoss, decision: r.decision, premiumUsd: r.premiumUsd };
  if (r.run === 0) { const m = (meta[DOLPHIN_MODEL] ??= { costUsd: 0, lat: [] }); m.costUsd += r.costUsd; m.lat.push(r.latencyMs); }
}
for (const r of raw.filter((x) => MODELS.includes(x.model))) {
  let c: ReturnType<typeof priced> | null = null;
  let error = r.error;
  if (!error) try { c = priced(r.content, r.finishReason, cover.get(r.id)!); } catch (e) { error = (e as Error).message; }
  rowsOut.push({ ...r, ...(c ?? {}), error, coverUsd: cover.get(r.id), trap: trap.get(r.id) });
  if (r.run === 0) { const m = (meta[r.model] ??= { costUsd: 0, lat: [] }); m.costUsd += r.costUsd ?? 0; if (r.latencyMs) m.lat.push(r.latencyMs); }
  if (error || !c) { ((errs[r.model] ??= {})[r.run] ??= []).push({ id: r.id, error: error! }); continue; }
  ((cells[r.model] ??= {})[r.run] ??= {})[r.id] = { pLoss: c.pLoss, decision: c.decision, premiumUsd: c.premiumUsd };
}

const ARM_MODELS = [DOLPHIN_MODEL, ...MODELS];
const arms = ARM_MODELS.map((model, order) => {
  const run0 = cells[model]?.[0] ?? {};
  const ids = cases.map((e) => e.id).filter((id) => run0[id]);
  const cleanIns = ids.filter((id) => !trap.get(id) && run0[id].decision === "insure");
  const ps = ids.map((id) => run0[id].pLoss), ys = ids.map((id) => (trap.get(id) ? 1 : 0));
  const m = meta[model] ?? { costUsd: 0, lat: [] };
  return {
    model, host: model === DOLPHIN_MODEL ? "dolphin" : "serv", pinned: model === DOLPHIN_MODEL, order,
    trapsDeclined: ids.filter((id) => trap.get(id) && run0[id].decision === "decline").length,
    cleanInsured: cleanIns.length,
    auc: auc(ps, ys), brier: ids.length ? brier(ps, ys) : null,
    meanCleanPremiumPct: mean(cleanIns.map((id) => (100 * run0[id].premiumUsd) / cover.get(id)!)),
    costUsd: m.costUsd, costPerDecisionUsd: ids.length ? m.costUsd / ids.length : null,
    p50Ms: median(m.lat), errors: errs[model]?.[0]?.length ?? 0,
    paramsDropped: model === DOLPHIN_MODEL ? [] : [...(dropped[model] ?? [])],
  };
});

// Self-check: our metric code must reproduce the recorded Dolphin summary.
{
  const s = dolphin.summary, d = arms[0];
  if (d.trapsDeclined !== s.trapsDeclined || d.cleanInsured !== s.cleanInsured || Math.abs(d.auc! - s.auc) > 1e-9 || Math.abs(d.brier! - s.brier) > 1e-9 || Math.abs(d.meanCleanPremiumPct! / 100 - s.meanCleanPremiumRate) > 1e-9)
    throw new Error(`Dolphin metrics do not reproduce backtest/results-check.json: ${JSON.stringify(d)}`);
}

function compare(a: Record<string, Cell>, b: Record<string, Cell>) {
  const ids = cases.map((e) => e.id).filter((id) => a[id] && b[id]);
  const flipped = ids.filter((id) => a[id].decision !== b[id].decision);
  const both = ids.filter((id) => a[id].decision === "insure" && b[id].decision === "insure");
  return {
    n: ids.length, flipped, both,
    meanAbsPLossDelta: mean(ids.map((id) => Math.abs(a[id].pLoss - b[id].pLoss))),
    medianPremiumChangePct: median(both.map((id) => (100 * (b[id].premiumUsd - a[id].premiumUsd)) / a[id].premiumUsd)),
    maxPremiumRatio: both.length ? Math.max(...both.map((id) => Math.max(b[id].premiumUsd / a[id].premiumUsd, a[id].premiumUsd / b[id].premiumUsd))) : null,
  };
}
const pairList = [...MODELS.slice(1).map((to, i) => [MODELS[i], to]), ...(MODELS.length > 2 ? [[MODELS[0], NEWEST]] : [])];
// A version with no usable answer leaves its neighbours uncompared; bridge across it.
const dead = MODELS.filter((m) => !Object.keys(cells[m]?.[0] ?? {}).length);
for (const m of dead) { const i = MODELS.indexOf(m); if (i > 0 && i < MODELS.length - 1) pairList.push([MODELS[i - 1], MODELS[i + 1]]); }
const pairN: number[] = [];
const pairs = pairList.map(([from, to]) => {
  const c = compare(cells[from]?.[0] ?? {}, cells[to]?.[0] ?? {});
  pairN.push(c.n);
  return { from, to, decisionFlips: c.flipped.length, flippedCases: c.flipped, meanAbsPLossDelta: c.meanAbsPLossDelta, medianPremiumChangePct: c.medianPremiumChangePct, maxPremiumRatio: c.maxPremiumRatio, bothInsured: c.both.length };
});
const rerun = [DOLPHIN_MODEL, NEWEST].map((model) => {
  const c = compare(cells[model]?.[0] ?? {}, cells[model]?.[1] ?? {});
  return { model, n: c.n, sameDecision: c.n - c.flipped.length, meanAbsPLossDelta: c.meanAbsPLossDelta, flipped: c.flipped };
});
const rows = cases.map((e) => ({
  id: e.id, kind: e.kind, trap: !e.shouldPay, coverUsd: cover.get(e.id)!,
  byModel: Object.fromEntries(ARM_MODELS.filter((m) => cells[m]?.[0]?.[e.id]).map((m) => [m, cells[m][0][e.id]])),
}));

// ---- notes: plain statements generated from the numbers ----
const f = (x: number | null, d = 4) => (x == null ? "n/a" : x.toFixed(d));
const D = arms[0], closed = arms.slice(1);
const steps = pairs.slice(0, MODELS.length - 1).map((p, i) => ({ ...p, n: pairN[i] }));
const okSteps = steps.filter((p) => p.n > 0), deadSteps = steps.filter((p) => p.n === 0);
const totalFlips = okSteps.reduce((s, p) => s + p.decisionFlips, 0);
const withN = pairs.map((p, i) => ({ ...p, n: pairN[i] }));
const rd = rerun[0], rs = rerun[1];
const errList = ARM_MODELS.flatMap((m) => Object.entries(errs[m] ?? {}).flatMap(([run, xs]) => xs.filter((x) => !x.error.startsWith("SERV 402")).map((x) => `${m} run ${run} ${x.id}: ${x.error.replace(/\s+/g, " ").slice(0, 40)}`)));
const oldNew = withN.find((p) => p.from === MODELS[0] && p.to === NEWEST)!;
const cleanMed = (m: string) => median(Object.entries(cells[m]?.[0] ?? {}).filter(([id]) => !trap.get(id)).map(([, c]) => c.pLoss));
const live = closed.filter((a) => !dead.includes(a.model));
const okAnswers = rowsOut.filter((r) => !r.error);
const premPairs = pairs.filter((p) => p.bothInsured);
const notes = [
  `Every arm got the same 40 cases, the same rating guide, documents and JSON reply contract, and the same pricing code. One difference in layout: SERV rewrites a system prompt before the model sees it (a first run with the guide in the system prompt lost the reply contract and the rating anchors), so for the closed models the underwriter prompt travels verbatim at the top of the user message under a one-line system prompt; ${okAnswers.filter((r) => r.verbatim).length} of ${okAnswers.length} closed-model answers then used the contract's keys verbatim.`,
  `Dolphin (${DOLPHIN_MODEL}, recorded run 0) declined ${D.trapsDeclined}/24 traps and insured ${D.cleanInsured}/16 clean invoices; ${closed.map((a) => `${a.model} ${a.trapsDeclined}/24 and ${a.cleanInsured}/16`).join("; ")}.`,
  `Median p(loss) on clean invoices: ${live.map((a) => `${f(cleanMed(a.model), 3)} (${a.model})`).join(", ")}, Dolphin ${f(cleanMed(DOLPHIN_MODEL), 3)}; the limit is 0.10.`,
  ...(dead.length ? [`${dead.join(", ")} returned finish_reason content_filter with 0 completion tokens on every case and on a trivial one-line test prompt, so it is unavailable through SERV rather than judged; ${deadSteps.map((p) => `${p.from}→${p.to}`).join(" and ")} have no comparable cases and ${withN.slice(steps.length + 1).map((p) => `${p.from}→${p.to}`).join(", ")} is added as a bridge pair.`] : []),
  `Insure/decline flips between versions: ${okSteps.map((p) => `${p.from}→${p.to} ${p.decisionFlips} of ${p.n}${p.decisionFlips ? ` (${p.flippedCases.join(", ")})` : ""}`).join(", ")}, ${withN.slice(steps.length).map((p) => `${p.from}→${p.to} ${p.decisionFlips} of ${p.n}`).join(", ")}; ${premPairs.length ? `median premium change on cases both insured: ${premPairs.map((p) => `${p.from}→${p.to} ${f(p.medianPremiumChangePct, 1)}%`).join(", ")}` : "no pair has a case both versions insured, so premium change between versions is not measurable here (null)"}.`,
  `Mean |Δp(loss)| between versions was ${withN.filter((p) => p.n).map((p) => `${f(p.meanAbsPLossDelta, 3)} (${p.from}→${p.to})`).join(", ")}, so the probabilities move between versions even where the decision does not.`,
  `Same-model re-run: Dolphin gave the same decision on ${rd.sameDecision}/${rd.n} cases (mean |Δp(loss)| ${f(rd.meanAbsPLossDelta)}, its two runs served by ${dolphin.summary.fingerprints?.length ?? "?"} different vLLM builds), ${NEWEST} on ${rs.sameDecision}/${rs.n} (mean |Δp(loss)| ${f(rs.meanAbsPLossDelta)}); ${rs.n && rd.n && rs.sameDecision / rs.n > rd.sameDecision / rd.n ? `${NEWEST} re-ran more consistently than Dolphin on this set` : rs.n && rd.n && rs.sameDecision / rs.n < rd.sameDecision / rd.n ? `Dolphin re-ran more consistently than ${NEWEST} on this set` : "the two re-ran equally consistently on this set"}; the ${NEWEST} re-run covers ${rs.n} of 40 cases.`,
  `Each version ran once with 40 cases, so one or two flips are within same-model re-run noise and are not evidence of drift; claude-opus-4.6 also kept temperature 0 while later versions rejected it, a confound on any 4.6 comparison.`,
  `Parameters SERV rejected and that were left out: ${closed.map((a) => `${a.model} ${a.paramsDropped.join(", ") || "none"}`).join("; ")} (response_format json_object is rejected, only json_schema is allowed; seed and reasoning_effort were accepted, which does not show they were honoured); cost for 40 decisions was Dolphin $${f(D.costUsd)} and ${closed.map((a) => `${a.model} $${f(a.costUsd, 2)}`).join(", ")}, with SERV list prices read as cents per million tokens and content_filter prompt tokens assumed billed.`,
  `${errList.length ? `Errored calls, counted as neither insured nor declined and excluded from AUC, Brier and pairs: ${errList.filter((x) => !dead.some((m) => x.startsWith(m + " "))).join("; ")}${dead.length ? `; plus all 40 of ${dead.join(", ")}` : ""}.` : "No call errored."} Units: meanCleanPremiumPct and medianPremiumChangePct are percentages (1.5 = 1.5%), maxPremiumRatio is max(to/from, from/to) premium over cases both versions insured, AUC and Brier are over run 0.`,
];

const out = { generatedAt: new Date().toISOString(), cases: cases.length, traps: cases.filter((c) => !c.shouldPay).length, clean: cases.filter((c) => c.shouldPay).length, ratingGuideHash: RATING_GUIDE_HASH, arms, pairs, rerun: rerun.map(({ flipped, ...r }) => r), rows, notes };
writeFileSync("public/drift.json", JSON.stringify(out, null, 1));
writeFileSync(RAW, JSON.stringify({ ...out, rerunFlipped: rerun.map((r) => ({ model: r.model, flipped: r.flipped })), rowsFull: rowsOut, raw }, null, 1));

console.log("\nmodel                              traps  clean  AUC    Brier   clean%  cost$    p50s  err dropped");
for (const a of arms) console.log(`${a.model.padEnd(34)} ${String(a.trapsDeclined).padStart(2)}/24  ${String(a.cleanInsured).padStart(2)}/16  ${f(a.auc, 3)}  ${f(a.brier, 4)}  ${f(a.meanCleanPremiumPct, 2).padStart(5)}  ${f(a.costUsd, 3).padStart(7)}  ${f((a.p50Ms ?? 0) / 1000, 1).padStart(5)}  ${a.errors}  ${a.paramsDropped.join(",")}`);
console.log("\npair                                flips  mean|ΔpL|  medΔprem%  maxRatio  bothIns  flipped");
for (const p of pairs) console.log(`${`${p.from}→${p.to}`.padEnd(34)}  ${String(p.decisionFlips).padStart(4)}  ${f(p.meanAbsPLossDelta)}     ${f(p.medianPremiumChangePct, 1).padStart(6)}    ${f(p.maxPremiumRatio, 2).padStart(5)}    ${p.bothInsured}  ${p.flippedCases.join(",")}`);
for (const r of rerun) console.log(`rerun ${r.model}: ${r.sameDecision}/${r.n} same, mean|ΔpL| ${f(r.meanAbsPLossDelta)} ${r.flipped.join(",")}`);
console.log("\n" + notes.join("\n"));
