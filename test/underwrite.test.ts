import { test } from "node:test";
import assert from "node:assert/strict";
import { underwrite } from "../src/underwrite";
import { PERILS } from "../src/pricing";

const CASE = {
  insured: "t", coverUsd: 1000,
  action: { kind: "pay", description: "Pay x", amountUsd: 1000, payee: "x", payTo: "0x" + "1".repeat(40) },
  docs: [{ name: "a.txt", source: "untrusted" as const, text: "invoice" }],
} as any;

// A fake Dolphin run pricing every peril at p.
const dolphinAt = (p: number) => (async () => ({
  content: JSON.stringify({ perils: Object.fromEntries(PERILS.map((k) => [k, { p, evidence: "e" }])), summary: "s", transcript: [] }),
  model: "m", fingerprint: "f", requestHash: "h", inTokens: 1, outTokens: 1, costUsd: 0, latencyMs: 1, fallbackSuspect: false, body: {},
})) as any;

const reviews = (...verdicts: string[]) => {
  const calls = { n: 0 };
  const fn = (async () => ({ verdict: verdicts[Math.min(calls.n++, verdicts.length - 1)], reason: "guard", guardBlocked: false, model: "s", latencyMs: 1, requestId: null })) as any;
  return { fn, calls };
};

test("underwrite: a Prompt Guard block on an insurable case is re-screened up to twice", async () => {
  const once = reviews("blocked", "agree");
  const r1 = await underwrite(CASE, 1e6, undefined, { dolphin: dolphinAt(0.001), review: once.fn });
  assert.equal(r1.decision, "insure");
  assert.equal(once.calls.n, 2);

  const always = reviews("blocked");
  const r2 = await underwrite(CASE, 1e6, undefined, { dolphin: dolphinAt(0.001), review: always.fn });
  assert.equal(r2.decision, "decline");
  assert.equal(r2.reason, "guard");
  assert.equal(always.calls.n, 3);

  const declined = reviews("blocked");
  const r3 = await underwrite(CASE, 1e6, undefined, { dolphin: dolphinAt(0.9), review: declined.fn });
  assert.equal(r3.decision, "decline");
  assert.equal(declined.calls.n, 1);
});
