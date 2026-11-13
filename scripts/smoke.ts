/** Underwrite the demo cases directly (no chain, no ledger) and print what decided each one. */
import { CASES } from "../demo/cases";
import { underwrite } from "../src/underwrite";
import { pct } from "../src/pricing";

const ids = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(CASES);
await Promise.all(ids.map(async (id) => {
  const r = await underwrite(CASES[id], 90_000);
  const perils = Object.entries(r.underwriting.perils).map(([k, v]) => `${k}=${v.p}`).join(" ");
  console.log(`\n# ${id}: ${r.decision.toUpperCase()} p(loss) ${pct(r.pLoss)} premium $${r.premiumUsd} | ${r.dolphin.latencyMs} ms, ${r.dolphin.inTokens} in / ${r.dolphin.outTokens} out, $${r.dolphin.costUsd.toFixed(5)} ${r.dolphin.fingerprint}`);
  console.log(`  ${perils}\n  summary: ${r.underwriting.summary}\n  reason: ${r.reason}\n  SERV: ${r.serv.verdict} (${r.serv.latencyMs} ms) ${r.serv.reason}`);
  console.log(`  transcript: ${JSON.stringify(r.underwriting.transcript).slice(0, 400)}`);
}));
