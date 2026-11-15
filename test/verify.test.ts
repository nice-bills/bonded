import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

// Point the ledger at a scratch dir before src/store is loaded.
process.env.BONDED_DATA_DIR = mkdtempSync(join(tmpdir(), "bonded-verify-"));
const { ledger, saveRequest } = await import("../src/store");
const { hashBody } = await import("../src/dolphin");
const { mount } = await import("../src/routes");
const express = (await import("express")).default;

const app = express();
mount(app);
const server = app.listen(0);
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => server.close());

const stored = (text: string) => {
  const body = { model: "m", messages: [{ role: "user", content: text }], temperature: 0, seed: 7, note: "é ✓ 0.1" };
  const h = hashBody(body);
  saveRequest(h, body);
  return h;
};

test("requests route serves only bodies referenced by a quote or claim", async () => {
  const quoteHash = stored("quote"), panelHash = stored("panel"), claimHash = stored("claim"), loose = stored("loose");
  const l = ledger();
  l.quotes.q_v = { id: "q_v", dolphin: { requestHash: quoteHash }, panel: { members: [{ requestHash: quoteHash }, { requestHash: panelHash }] } };
  l.claims.claim_v = { id: "claim_v", dolphin: { requestHash: claimHash } };

  for (const h of [quoteHash, panelHash, claimHash]) {
    const res = await fetch(`${base}/api/requests/${h}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("cache-control") ?? "", /immutable/);
    assert.equal(hashBody(JSON.parse(await res.text())), h, "served body hashes to the requested hash");
  }
  for (const h of [loose, "f".repeat(64), "../ledger", "ABC"]) {
    const res = await fetch(`${base}/api/requests/${encodeURIComponent(h)}`);
    assert.equal(res.status, 404, h);
    assert.deepEqual(await res.json(), { error: "not found" });
  }
});
