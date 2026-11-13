import { test } from "node:test";
import assert from "node:assert/strict";
import { brier, combine, price, RULES } from "../src/pricing";

test("combine treats perils as independent", () => {
  assert.equal(combine({}), 0);
  assert.ok(Math.abs(combine({ duplicate: 0.1, tampered: 0.1 }) - 0.19) < 1e-9);
  assert.equal(combine({ duplicate: 7 }), 1); // out-of-range clamps to certain loss
});

test("price: insure, decline on risk, decline on capacity, minimum premium", () => {
  const ok = price(1800, 0.01, 12000);
  assert.equal(ok.decision, "insure");
  assert.equal(ok.premiumUsd, 25.2);
  assert.equal(price(1800, RULES.declineAbove + 0.01, 12000).decision, "decline");
  assert.equal(price(1800, 0.01, 4000).decision, "decline"); // 1800 > 25% of 4000
  assert.equal(price(10, 0.001, 12000).premiumUsd, RULES.minPremiumUsd);
  assert.equal(price(0, 0.01, 12000).decision, "decline");
  assert.equal(price(100, NaN, 12000).decision, "decline");
});

test("brier", () => assert.equal(brier([1, 0], [1, 0]), 0));

import { checkArithmetic } from "../src/pricing";
test("code check catches invoice arithmetic the model misses", () => {
  assert.equal(checkArithmetic({ lines: [{ qty: 3, rate: 300, amount: 900 }, { qty: 3, rate: 300, amount: 900 }], total: 1800 }), null);
  assert.match(checkArithmetic({ lines: [{ qty: 20, rate: 300, amount: 6300 }], total: 6300 })!, /20 × 300 is 6000/);
  assert.match(checkArithmetic({ lines: [{ qty: 6, rate: 300, amount: 1800 }], total: 2100 })!, /not the stated total 2100/);
  assert.equal(checkArithmetic({ lines: [], total: null }), null);
});
