import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hex } from "viem";

// Point the ledger at a scratch dir before src/store is loaded.
process.env.BONDED_DATA_DIR = mkdtempSync(join(tmpdir(), "bonded-test-"));
const { ledger, own } = await import("../src/store");
const { activeCover, bind, claim, recheck } = await import("../src/service");

const PAYER = "0x1111111111111111111111111111111111111111" as Hex;
const OTHER = "0x2222222222222222222222222222222222222222" as Hex;
const tx = (c: string) => ("0x" + c.repeat(64)) as Hex;
const DOC = { name: "evidence.txt", source: "untrusted" as const, text: "the loss" };

const quote = (id: string, over: Record<string, unknown> = {}) => ({
  id, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 900_000).toISOString(),
  decision: "insure", premiumUsd: 2, pLoss: 0.01, freeCapitalUsd: 10_000,
  payment: { to: PAYER, token: "USDC (Base Sepolia)", units: "20000", amount: 2 },
  case: { id: "clean", insured: "x", coverUsd: 1800, action: { kind: "pay", description: "Pay x", amountUsd: 1800, payee: "x", payTo: PAYER }, docs: [] },
  dolphin: { fingerprint: "quote-fingerprint" }, underwriting: { summary: "s" }, serv: { verdict: "agree" },
  panel: { members: [], disagreementLoading: 0 },
  ...over,
});

const capital = async () => 10_000;
const payer = async () => ({ ok: true as const, from: PAYER });
const bindDeps = { capital, verify: payer };

test("bind: one premium tx creates one bond under concurrency", async () => {
  const l = ledger();
  l.quotes.q_race_a = quote("q_race_a");
  l.quotes.q_race_b = quote("q_race_b");
  l.quotes.q_race_c = quote("q_race_c");
  const tx1 = tx("a");
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const verify = (async () => { await gate; return { ok: true as const, from: PAYER }; }) as any;
  const deps = { capital, verify };

  // Two binds of one quote and a third of another quote, all with the same premium tx.
  const racers = [bind("q_race_a", tx1, undefined, deps), bind("q_race_a", tx1, undefined, deps), bind("q_race_b", tx1, undefined, deps)];
  release();
  const settled = await Promise.allSettled(racers);
  assert.equal(settled.filter((s) => s.status === "fulfilled").length, 1, "exactly one bind wins");
  assert.equal(Object.values(l.bonds).filter((x: any) => x.premiumTx === tx1).length, 1);
  assert.ok(l.usedTx.includes(tx1.toLowerCase()));
  for (const s of settled.filter((s) => s.status === "rejected")) assert.match(String((s as any).reason?.message), /already bound|already used/);

  const after = await bind("q_race_c", tx1, undefined, bindDeps).then(() => null, (e: Error) => e.message);
  assert.match(String(after), /already used/);
});

test("bind: a beneficiary who is not the premium payer is rejected", async () => {
  const l = ledger();
  l.quotes.q_ben = quote("q_ben");
  const tx2 = tx("b");
  const msg = await bind("q_ben", tx2, OTHER, bindDeps).then(() => null, (e: Error) => e.message);
  assert.match(String(msg), /beneficiary must be the premium payer/);
  assert.equal(Object.values(l.bonds).filter((x: any) => x.premiumTx === tx2).length, 0);
  assert.ok(!l.usedTx.includes(tx2.toLowerCase()), "a failed bind does not burn the tx");

  const b = await bind("q_ben", tx2, PAYER, bindDeps);
  assert.equal(b.beneficiary, PAYER);
});

test("bind: a missing or malformed tx is a clean error", async () => {
  const l = ledger();
  l.quotes.q_notx = quote("q_notx");
  for (const bad of [undefined, "", "0x123", { toLowerCase: () => "x" }]) {
    const msg = await bind("q_notx", bad as any, undefined, bindDeps).then(() => null, (e: Error) => e.message);
    assert.match(String(msg), /tx must be a 0x-prefixed 64-hex transaction hash/);
  }
});

test("prototype keys are unknown ids, never Object.prototype members", async () => {
  for (const key of ["constructor", "__proto__", "toString"]) {
    assert.equal(own(ledger().quotes, key), undefined);
    assert.equal(own(ledger().bonds, key), undefined);
    await assert.rejects(() => bind(key, tx("c"), undefined, bindDeps), /unknown quote/);
    await assert.rejects(() => claim(key, "loss", [DOC]), /unknown bond/);
    await assert.rejects(() => recheck(key), /unknown quote or claim/);
  }
});

test("expired bonds stop reserving capital but still reject claims", async () => {
  const l = ledger();
  const baseline = activeCover();
  const later = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
  l.bonds.b_fresh = { id: "b_fresh", quoteId: "q_fresh", status: "active", coverUsd: 100, boundAt: later(1), claims: [] };
  l.bonds.b_old = { id: "b_old", quoteId: "q_old", status: "active", coverUsd: 1000, boundAt: later(40), claims: [] };
  l.bonds.b_paid = { id: "b_paid", quoteId: "q_paid", status: "paid", coverUsd: 500, boundAt: later(1), claims: [] };
  assert.equal(activeCover(), baseline + 100, "only the in-window, unpaid bonds reserve");
  await assert.rejects(() => claim("b_old", "loss", [DOC]), /claim window closed/);
});

test("claim: only a reviewer veto of a judge pay skips a slot; 5 filings in total", async () => {
  const l = ledger();
  l.quotes.q_slot = quote("q_slot");
  l.bonds.b_slot = { id: "b_slot", quoteId: "q_slot", status: "active", coverUsd: 1800, premiumUsd: 2, boundAt: new Date().toISOString(), beneficiary: PAYER, claims: [] };
  const result = (decision: "pay" | "deny", serv: string, multipath: string, reviewVeto?: boolean) => ({
    judgment: { decision, peril: "duplicate" }, decision, payoutUsd: decision === "pay" ? 100 : 0,
    serv: { verdict: serv }, multipath: { verdict: multipath, rulebooks: [], reason: "" }, reviewVeto,
    dolphin: { requestHash: "e".repeat(64) }, body: {},
  });
  const judge = (r: unknown) => (async () => r) as any;

  // A judge denial counts even when Multipath also excluded it (no reviewVeto flag).
  const junk = await claim("b_slot", "loss", [DOC], undefined, { judge: judge(result("deny", "agree", "excluded")) });
  assert.equal(junk.counts, true);
  l.bonds.b_slot.claims = [];

  // Reviewer vetoes of a judge "pay" skip a slot, but filings stop at 5 in total.
  for (let i = 0; i < 5; i++) {
    const v = await claim("b_slot", "loss", [DOC], undefined, { judge: judge(result("deny", "object", "covered", true)) });
    assert.equal(v.counts, false);
  }
  const sixth = await claim("b_slot", "loss", [DOC], undefined, { judge: judge(result("deny", "object", "covered", true)) }).then(() => null, (e: Error) => e.message);
  assert.match(String(sixth), /no claims left/);

  // Two counted denials use both slots.
  l.bonds.b_slot.claims = [];
  for (let i = 0; i < 2; i++) assert.equal((await claim("b_slot", "loss", [DOC], undefined, { judge: judge(result("deny", "agree", "covered")) })).counts, true);
  const third = await claim("b_slot", "loss", [DOC], undefined, { judge: judge(result("deny", "agree", "covered")) }).then(() => null, (e: Error) => e.message);
  assert.match(String(third), /no claims left/);
});

test("claim: a broadcast but unconfirmed payout marks the bond paid; a reverted one does not", async () => {
  const l = ledger();
  const pays = { judgment: { decision: "pay", peril: "duplicate" }, decision: "pay", payoutUsd: 300, dolphin: { requestHash: "f".repeat(64) }, body: {} };
  const judge = (async () => pays) as any;
  for (const id of ["b_unconf", "b_revert"]) {
    l.quotes[`q_${id}`] = quote(`q_${id}`);
    l.bonds[id] = { id, quoteId: `q_${id}`, status: "active", coverUsd: 1800, premiumUsd: 2, boundAt: new Date().toISOString(), beneficiary: PAYER, claims: [] };
  }

  const pending = (async () => { throw Object.assign(new Error("x"), { hash: tx("f") }); }) as any;
  await assert.rejects(() => claim("b_unconf", "paid twice", [DOC], undefined, { judge, pay: pending }), /not yet confirmed/);
  assert.equal(l.bonds.b_unconf.status, "paid");
  const rec = l.claims[l.bonds.b_unconf.claims[0]];
  assert.equal(rec.payoutTx, tx("f"));
  assert.equal(rec.payoutUnconfirmed, true);
  await assert.rejects(() => claim("b_unconf", "paid twice", [DOC], undefined, { judge, pay: pending }), /already paid out/);

  const reverted = (async () => { throw new Error("reverted"); }) as any;
  await assert.rejects(() => claim("b_revert", "paid twice", [DOC], undefined, { judge, pay: reverted }), /reverted/);
  assert.equal(l.bonds.b_revert.status, "active");
});

test("claim: concurrent claims on one bond judge and pay once", async () => {
  const l = ledger();
  l.quotes.q_claim = quote("q_claim");
  l.bonds.b_claim = { id: "b_claim", quoteId: "q_claim", status: "active", coverUsd: 1800, premiumUsd: 2, boundAt: new Date().toISOString(), beneficiary: PAYER, claims: [] };
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let judged = 0, paid = 0;
  const judge = (async () => {
    judged++;
    await gate;
    return {
      judgment: { decision: "pay", peril: "duplicate" }, decision: "pay", payoutUsd: 300,
      dolphin: { requestHash: "d".repeat(64) }, body: {},
    };
  }) as any;
  const pay = (async () => { paid++; return tx("e"); }) as any;
  const deps = { judge, pay };

  const first = claim("b_claim", "paid twice", [DOC], undefined, deps);
  await new Promise((r) => setImmediate(r));
  const second = await claim("b_claim", "paid twice", [DOC], undefined, deps).then(() => null, (e: Error) => e.message);
  assert.match(String(second), /being processed/);

  release();
  const c = await first;
  assert.equal(judged, 1);
  assert.equal(paid, 1);
  assert.equal(c.payoutTx, tx("e"));
  assert.equal(l.bonds.b_claim.status, "paid");
  assert.equal(l.bonds.b_claim.claims.length, 1);

  const third = await claim("b_claim", "paid twice", [DOC], undefined, deps).then(() => null, (e: Error) => e.message);
  assert.match(String(third), /already paid out/);
});
