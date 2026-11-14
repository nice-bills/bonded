import "../src/sealed";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { pathToFileURL } from "node:url";
import { judgeClaim } from "../src/claims";
import { CASES, CLAIMS } from "../demo/cases";
import { sendUsdc, pub } from "../src/chain";

type Resp = { status: number; body: any; raw: string };
const args = process.argv.slice(2);
const val = (k: string, d: string) => {
  const i = args.indexOf(k);
  return i < 0 ? d : (args[i + 1] ?? d);
};
const phaseArg = val("--phase", "all");
const repeat = Math.max(0, Number(val("--repeat", "0")) || 0);
const checks: [string, boolean, string][] = [];
const check = (n: string, ok: boolean, d = "") => {
  checks.push([n, ok, d]);
  console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? ` — ${d}` : ""}`);
};
let base = val("--base", "").replace(/\/$/, ""),
  child: ChildProcess | undefined,
  dataDir: string | undefined;
const json = async (path: string, body?: any, headers: Record<string, string> = {}): Promise<Resp> => {
  const r = await fetch(
    base + path,
    body === undefined
      ? { headers }
      : {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(body),
        },
  );
  const raw = await r.text();
  let v: any;
  try {
    v = JSON.parse(raw);
  } catch {
    v = raw;
  }
  return { status: r.status, body: v, raw };
};
const nd = async (path: string, body: any) => {
  const r = await json(path, body);
  const lines = String(r.raw)
    .split("\n")
    .filter(Boolean)
    .map((x) => {
      try {
        return JSON.parse(x);
      } catch {
        return {};
      }
    });
  return {
    status: r.status,
    result: lines.find((x) => x.type === "result")?.result,
    error: lines.find((x) => x.type === "error")?.error ?? (r.status >= 400 ? r.body?.error : undefined),
    raw: r.raw,
  };
};
async function freePort() {
  return await new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as any).port;
      s.close(() => resolve(p));
    });
  });
}
async function start() {
  dataDir = await mkdtemp(join(tmpdir(), "bonded-e2e-"));
  const port = await freePort();
  child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), BONDED_DATA_DIR: dataDir },
    stdio: process.env.E2E_SERVER_LOG ? "inherit" : "ignore",
  });
  base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) throw Error("server exited before ready");
    try {
      const r = await fetch(base + "/api/pool");
      if (r.status === 200) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw Error("server readiness timed out");
}
async function stop() {
  if (child) {
    child.kill("SIGTERM");
    child = undefined;
  }
  if (dataDir) {
    await rm(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  }
}
async function phaseA() {
  const [clean, swap, inj] = await Promise.all(
    ["clean", "wallet-swap", "injection"].map((x) => nd("/api/quote", { caseId: x })),
  );
  for (const [name, q, d] of [
    ["clean", clean, "insure"],
    ["wallet-swap", swap, "decline"],
    ["injection", inj, "decline"],
  ] as const)
    check(`quote ${name} → ${d}`, q.result?.decision === d, q.error ?? q.result?.decision ?? "no result");
  const q = clean.result;
  if (!q) return;
  check("declined quote has no payment", swap.result?.payment == null);
  check(
    "premium math",
    Math.abs(q.premiumUsd - Math.max(0.5, Math.round(q.case.coverUsd * q.pLoss * 1.4 * 100) / 100)) < 0.011,
    String(q.premiumUsd),
  );
  check(
    "public quote omits bodies and base64",
    !JSON.stringify(q).includes("base64,") && !JSON.stringify(q).includes('"body"'),
  );
  for (const [n, r] of [
    ["declined quote", await json("/api/bind", { quoteId: swap.result?.id, tx: "0x" + "a".repeat(64) })],
    ["fake tx", await json("/api/bind", { quoteId: q.id, tx: "0x" + "a".repeat(64) })],
    ["missing tx", await json("/api/bind", { quoteId: q.id })],
  ] as const)
    check(
      `bind ${n} refused cleanly`,
      r.status === 400 && (n !== "missing tx" || !/Cannot read/.test(r.raw)),
      `${r.status} ${r.raw.slice(0, 100)}`,
    );
  check(
    "declined demo payment refused",
    (await json("/api/demo/pay-premium", { quoteId: swap.result?.id })).status === 400,
  );
  const pay = await json("/api/demo/pay-premium", { quoteId: q.id });
  check("premium paid and bound", pay.status === 200 && !!pay.body.bond?.id, pay.raw.slice(0, 100));
  if (!pay.body?.bond) return;
  const receipt = await pub.getTransactionReceipt({ hash: pay.body.tx });
  check("premium receipt successful on chain", receipt.status === "success");
  check("rebind refused", (await json("/api/bind", { quoteId: q.id, tx: pay.body.tx })).status === 400);
  const pool = (await json("/api/pool")).body;
  check(
    "pool reserves cover",
    pool.reservedUsd >= pay.body.bond.coverUsd && pool.bonds === 1,
    `${pool.reservedUsd}`,
  );
  const fake = await nd("/api/claim", { bondId: pay.body.bond.id, claimId: "fake" });
  check("fake claim denied", fake.result?.decision === "deny");
  const before = (await json("/api/pool")).body.capitalUsd,
    dup = await nd("/api/claim", { bondId: pay.body.bond.id, claimId: "duplicate" });
  check(
    "duplicate claim paid",
    dup.result?.decision === "pay" && !!dup.result.payoutTx,
    `${dup.result?.decision ?? dup.error ?? ""} ${dup.result?.reason ?? ""}`.slice(0, 300),
  );
  if (dup.result?.payoutTx) {
    check(
      "payout receipt successful",
      (await pub.getTransactionReceipt({ hash: dup.result.payoutTx })).status === "success",
    );
    const after = (await json("/api/pool")).body.capitalUsd;
    check(
      "pool capital reduced by payout",
      Math.abs(before - after - dup.result.payoutUsd) < 1,
      `${before}→${after}`,
    );
  }
  check(
    "third claim refused",
    !!(await nd("/api/claim", { bondId: pay.body.bond.id, claimId: "duplicate" })).error,
  );
  for (const [n, id] of [
    ["quote", q.id],
    ["claim", fake.result?.id],
    ["declined quote", swap.result?.id],
  ] as const) {
    const r = await nd(`/api/recheck/${id}`, {});
    check(`recheck ${n} same decision`, r.result?.sameDecision === true, r.error ?? "");
    if (n === "quote")
      check(
        "recheck fingerprints exposed",
        !!r.result && "fingerprint" in r.result && "originalFingerprint" in r.result,
      );
  }
  const led = (await json("/api/ledger")).body;
  check(
    "ledger counts 3 quotes, 1 bond, claims",
    led.quotes.length === 3 && led.bonds.length === 1 && led.claims.length >= 2,
    `${led.quotes.length}/${led.bonds.length}/${led.claims.length}`,
  );
  check("ledger omits base64", !JSON.stringify(led).includes("base64,"));
  check("reserve released after payout", (await json("/api/pool")).body.reservedUsd === 0);
}
async function phaseB() {
  for (const kind of ["quotes", "bonds", "claims"])
    for (const id of ["constructor", "__proto__", "toString"]) {
      const r = await fetch(`${base}/api/${kind}/${id}`);
      check(
        `${kind}/${id} → 404 JSON`,
        r.status === 404 && !!r.headers.get("content-type")?.includes("json"),
      );
    }
  const b = {
    insured: "x",
    action: { kind: "pay", description: "Pay x", amountUsd: 100, payee: "x", payTo: "0x1" },
    coverUsd: 100,
    docs: [{ name: "a", source: "untrusted", text: "hi" }],
  };
  for (const img of [
    ".env",
    "deploy/env.sealed",
    "../etc/passwd",
    "/etc/passwd",
    "http://169.254.169.254/x",
    "file:///etc/passwd",
  ])
    check(
      `reject image ${img}`,
      (await json("/api/quote", { case: { ...b, docs: [{ name: "a", source: "untrusted", image: img }] } }))
        .status === 400,
    );
  for (const [name, c, match] of [
    ["cover > amount", { ...b, coverUsd: 500 }, /cannot exceed/i],
    ["no docs", { ...b, docs: [] }, /at least one/i],
    ["negative amount", { ...b, action: { ...b.action, amountUsd: -1 }, coverUsd: -1 }, /.+/],
    ["docs not array", { ...b, docs: "x" }, /.+/],
    ["null doc", { ...b, docs: [null] }, /./],
    ["non-string image", { ...b, docs: [{ name: "a", source: "untrusted", image: { x: 1 } }] }, /.+/],
  ] as const) {
    const r = await nd("/api/quote", { case: c });
    // Early checks answer 400 JSON; checks inside quote() arrive as a type:error line in a 200 NDJSON stream.
    check(
      `${name} validation`,
      !!r.error && !r.result && !/Cannot read/.test(r.error),
      `${r.status} ${r.error ?? ""}`,
    );
  }
  for (const [name, p] of [
    ["claim prototype", () => nd("/api/claim", { bondId: "constructor", statement: "x", evidence: [] })],
    ["recheck prototype", () => nd("/api/recheck/constructor", {})],
  ] as const) {
    const r = await p();
    check(`${name} clean unknown`, /unknown/i.test(r.error ?? ""), r.error ?? "");
  }
  const malformed = await fetch(base + "/api/quote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{bad",
    }),
    txt = await malformed.text();
  check(
    "malformed JSON clean 400",
    malformed.status === 400 && !/node_modules|at /.test(txt),
    txt.slice(0, 100),
  );
  let limited = 0,
    spoof = 0;
  for (let i = 0; i < 12; i++)
    if ((await fetch(base + "/api/recheck/zz", { method: "POST" })).status === 429) limited++;
  for (let i = 0; i < 5; i++)
    if (
      (
        await fetch(base + "/api/recheck/zz", {
          method: "POST",
          headers: { "x-forwarded-for": `9.9.9.${i}` },
        })
      ).status !== 429
    )
      spoof++;
  check(
    "spoofed forwarded IP cannot bypass limit",
    !(limited && spoof),
    `${limited}/12 limited; ${spoof}/5 spoof passed`,
  );
}
async function phaseC() {
  const [a, b] = await Promise.all([
    nd("/api/quote", { caseId: "clean" }),
    nd("/api/quote", { caseId: "clean" }),
  ]);
  if (!a.result?.payment || !b.result?.payment) {
    check("concurrency setup quotes insured", false, [a, b].map((x) => `${x.result?.decision ?? x.error}: ${x.result?.reason ?? ""}`.slice(0, 200)).join(" | "));
    return;
  }
  const units = [a, b].map((x) => BigInt(x.result.payment.units)).sort((x, y) => (x > y ? -1 : 1))[0];
  const tx = await sendUsdc(process.env.DEMO_AGENT_KEY as any, a.result.payment.to, units);
  const bound = await Promise.all(
    [a, b].flatMap((x) => [1, 2].map(() => json("/api/bind", { quoteId: x.result.id, tx }))),
  );
  const successes = bound.filter((x) => x.status === 200);
  check("concurrent binds yield exactly one bond", successes.length === 1, `${successes.length}`);
  if (!successes.length) return;
  const bond = successes[0].body;
  const claims = await Promise.all(
    [1, 2].map(() => nd("/api/claim", { bondId: bond.id, claimId: "duplicate" })),
  );
  const paid = claims.filter((x) => x.result?.decision === "pay");
  check(
    "concurrent claims total ≤ cover",
    paid.reduce((s, x) => s + x.result.payoutUsd, 0) <= bond.coverUsd,
    `${paid.length} paid; ${claims.map((x) => `${x.result?.decision ?? x.error}: ${x.result?.reason ?? ""}`.slice(0, 200)).join(" | ")}`,
  );
}
async function repetitions() {
  // The ledger lives in the spawned server's data dir; read it from disk, not via src/store (bound to ./data).
  if (!dataDir) {
    check("repeat setup insured quote and bond", false, "--repeat needs a local server, not --base");
    return;
  }
  const l = JSON.parse(readFileSync(join(dataDir, "ledger.json"), "utf8"));
  const bond = Object.values(l.bonds)[0] as any;
  const quote = bond && l.quotes[bond.quoteId];
  if (!quote || !bond) {
    check("repeat setup insured quote and bond", false);
    return;
  }
  let duplicatePaid = 0,
    fakePaid = 0,
    errors = 0;
  const reasons = new Map<string, number>();
  for (let i = 0; i < repeat; i++) {
    for (const id of ["duplicate", "fake"]) {
      const c = (CLAIMS as any)[id];
      const out = await judgeClaim(bond, quote, quote.case, c.statement, c.evidence).catch((e) => {
        console.log(`repeat ${id} #${i + 1} errored: ${e?.stack ?? e}`);
        return { decision: "error", reason: String(e) } as any;
      });
      if (id === "duplicate" && out.decision !== "pay") console.log(`repeat duplicate #${i + 1}: ${out.decision} ${out.reason}`);
      if (id === "duplicate" && out.decision === "pay") duplicatePaid++;
      if (out.decision === "error") errors++;
      if (id === "fake" && out.decision === "pay") fakePaid++;
      if (id === "fake" && out.decision === "deny")
        reasons.set(out.reason, (reasons.get(out.reason) ?? 0) + 1);
    }
  }
  // Network errors are reported, not scored: a failed request is neither a payout nor a denial.
  check(`repeat errors (${errors})`, errors <= 1);
  check(`repeat duplicate paid ≥90% (${duplicatePaid}/${repeat})`, duplicatePaid >= Math.ceil(repeat * 0.9));
  check(
    `repeat fake never paid (${fakePaid}/${repeat} paid)`,
    fakePaid === 0,
    [...reasons]
      .map(([k, v]) => `${v}×${k}`)
      .join("; ")
      .slice(0, 240),
  );
}
try {
  if (!base) await start();
  for (const p of phaseArg === "all" ? ["A", "B", "C"] : [phaseArg]) {
    if (!["A", "B", "C"].includes(p)) {
      check("valid phase", false, p);
      continue;
    }
    if (p !== "A" && !val("--base", "")) {
      await stop();
      await start();
    }
    await (p === "A" ? phaseA : p === "B" ? phaseB : phaseC)();
  }
  if (repeat) await repetitions();
} catch (e) {
  check("suite execution", false, String((e as Error)?.stack ?? e));
} finally {
  await stop();
}
console.log(
  `\nSUMMARY ${checks.filter((x) => x[1]).length}/${checks.length} passed, ${checks.filter((x) => !x[1]).length} failed`,
);
process.exitCode = checks.some((x) => !x[1]) ? 1 : 0;
