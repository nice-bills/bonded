/**
 * Verify a Bonded quote or claim without trusting Bonded's server:
 * fetch the record and its stored Dolphin request, check the hash and the published rating guide,
 * then re-run the request on Dolphin with YOUR OWN key and re-price it in code.
 *   npx tsx scripts/verify.ts <q_… | claim_…> [--base https://bonded-pool.onrender.com] [--no-run]
 * Exit: 0 same decision, 1 mismatch, 2 setup error (bad args, missing key, record not found, hash mismatch).
 */
import "dotenv/config";
import { callDolphin, DOLPHIN_MODEL, hashBody } from "../src/dolphin";
import { RATING_GUIDE, RATING_GUIDE_HASH, readUnderwriting } from "../src/underwrite";
import { panelVerdict, price, PERILS, pct } from "../src/pricing";
import { readJudgment } from "../src/claims";

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, i + 1 < args.length && !args[i + 1].startsWith("--") ? 2 : 1)[1] ?? "" : undefined; };
const noRun = flag("--no-run") !== undefined;
const base = (flag("--base") || process.env.BONDED_PUBLIC_URL || "https://bonded-pool.onrender.com").replace(/\/+$/, "");
const id = args[0];

const line = (ok: boolean, what: string) => console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
const die = (what: string): never => { line(false, what); process.exit(2); };

if (!id || !/^(q|claim)_/.test(id)) die("usage: verify.ts <quoteId q_… | claimId claim_…> [--base URL] [--no-run]");
const kind = id.startsWith("q_") ? "quote" : "claim";

async function getJson(url: string) {
  const res = await fetch(url);
  if (!res.ok) die(`GET ${url}: HTTP ${res.status}`);
  return { text: await res.text(), res };
}

const rec = JSON.parse((await getJson(`${base}/api/${kind === "quote" ? "quotes" : "claims"}/${encodeURIComponent(id)}`)).text);
const hash: string = rec?.dolphin?.requestHash;
if (!/^[a-f0-9]{64}$/.test(hash ?? "")) die(`${kind} ${id}: no request hash on record`);
line(true, `fetched ${kind} ${id} from ${base}`);

const raw = (await getJson(`${base}/api/requests/${hash}`)).text;
const body = JSON.parse(raw);
// The server hashed JSON.stringify(body); a parse/re-stringify round trip of plain JSON is byte-identical.
const got = hashBody(body);
if (got !== hash) die(`request hash: recorded ${hash}, served body hashes to ${got}`);
line(true, `request hash ${hash.slice(0, 16)}… matches the served body (${(raw.length / 1024).toFixed(0)} KB)`);

if (kind === "quote") {
  const sys = body.messages?.find((m: any) => m.role === "system")?.content;
  const guideOk = rec.ratingGuideHash === RATING_GUIDE_HASH && typeof sys === "string" && sys.includes(RATING_GUIDE);
  line(guideOk, `system prompt carries the published rating guide (sha256 ${RATING_GUIDE_HASH.slice(0, 16)}…)`);
  const decodeOk = body.model === DOLPHIN_MODEL && body.temperature === 0 && body.seed === 7;
  line(decodeOk, `model ${body.model}, temperature ${body.temperature}, seed ${body.seed}`);
  if (!guideOk || !decodeOk) die("request does not match the published underwriting setup");
}
if (noRun) { console.log("--no-run: stopped after the hash checks"); process.exit(0); }
if (!process.env.DOLPHIN_API_KEY) die("DOLPHIN_API_KEY is not set: export your own Dolphin key to re-run");

console.log(`re-running on Dolphin with your key (can take a minute)…`);
const run = await callDolphin(body).catch((e) => die(`Dolphin call failed: ${(e as Error).message}`));
line(true, `Dolphin answered in ${(run.latencyMs / 1000).toFixed(1)} s, served by ${run.model || "?"}${run.fallbackSuspect ? " (FALLBACK SUSPECT)" : ""}`);

let same: boolean;
if (kind === "quote") {
  const uw = readUnderwriting(run.content);
  const v = panelVerdict([Object.fromEntries(PERILS.map((k) => [k, uw.perils[k].p]))]);
  const loading = rec.panel?.disagreementLoading ?? 0;
  const p = price(rec.case.coverUsd, v.pLoss, rec.freeCapitalUsd, loading);
  // Compare the PRICED decision, before SERV's second-line veto, as recheck() does.
  const orig = price(rec.case.coverUsd, rec.pLoss, rec.freeCapitalUsd, loading);
  console.log(`  decision     original ${orig.decision.padEnd(8)} re-run ${p.decision}`);
  console.log(`  p(loss)      original ${pct(rec.pLoss).padEnd(8)} re-run ${pct(v.pLoss)}`);
  console.log(`  premium      original $${String(rec.premiumUsd).padEnd(7)} re-run $${p.premiumUsd}`);
  if (rec.decision !== orig.decision) console.log(`  note: the final decision was "${rec.decision}" (SERV verdict: ${rec.serv?.verdict}); the priced decision is compared`);
  same = p.decision === orig.decision;
} else {
  const j = readJudgment(run.content);
  console.log(`  decision     original ${String(rec.judgment?.decision).padEnd(8)} re-run ${j.decision}`);
  console.log(`  peril        original ${String(rec.judgment?.peril).padEnd(8)} re-run ${j.peril}`);
  same = j.decision === rec.judgment?.decision;
}
console.log(`  fingerprint  original ${rec.dolphin.fingerprint || "?"}  re-run ${run.fingerprint || "?"}`);
console.log(same ? "VERIFIED: same decision" : "MISMATCH");
process.exit(same ? 0 : 1);
