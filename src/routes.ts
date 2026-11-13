import express, { type Express, type Request, type Response } from "express";
import type { Hex } from "viem";
import { bind, claim, poolStatus, publicView, quote, recheck } from "./service";
import { ledger } from "./store";
import { CASES, CLAIMS } from "../demo/cases";
import { sendUsdc } from "./chain";

const ROOT = new URL("..", import.meta.url).pathname;

// shortcut: in-memory limits per process; fine for one container, use a shared store if scaled out.
const hits = new Map<string, number[]>();
function limited(key: string, max: number, windowMs: number) {
  const now = Date.now();
  const list = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (list.length >= max) return true;
  list.push(now);
  hits.set(key, list);
  return false;
}
const ip = (req: Request) => String(req.headers["fly-client-ip"] ?? req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "?").split(",")[0];
const guard = (req: Request, res: Response, kind: string, perIp: number, perDay: number) => {
  if (limited(`${kind}:${ip(req)}`, perIp, 3_600_000) || limited(`${kind}:all`, perDay, 86_400_000)) {
    res.status(429).json({ error: `Demo limit reached for ${kind}. Try again later.` });
    return true;
  }
  return false;
};

/** Stream progress steps as NDJSON, then the result. */
async function stream(res: Response, work: (step: (name: string, detail?: Record<string, unknown>) => void) => Promise<unknown>) {
  res.setHeader("content-type", "application/x-ndjson");
  res.setHeader("cache-control", "no-store");
  const write = (o: unknown) => res.write(JSON.stringify(o) + "\n");
  const ping = setInterval(() => write({ type: "ping" }), 10_000);
  try {
    const out = await work((name, detail) => write({ type: "step", name, ...detail, at: Date.now() }));
    write({ type: "result", result: publicView(out) });
  } catch (e) {
    write({ type: "error", error: e instanceof Error ? e.message : String(e) });
  } finally {
    clearInterval(ping);
    res.end();
  }
}

const caseView = (c: any) => ({ ...c, docs: c.docs.map((d: any) => ({ ...d, image: d.image ? `/${d.image}` : undefined })) });

export function mount(app: Express) {
  app.use("/api", express.json({ limit: "8mb" }));
  app.use((req, res, next) => {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "content-type");
    if (req.method === "OPTIONS") return void res.sendStatus(204);
    next();
  });

  app.get("/api/pool", async (_req, res) => {
    try { res.json(await poolStatus()); } catch (e) { res.status(502).json({ error: String((e as Error).message) }); }
  });
  app.get("/api/cases", (_req, res) => res.json({
    cases: Object.values(CASES).map(caseView),
    claims: Object.fromEntries(Object.entries(CLAIMS).map(([k, v]) => [k, { ...v, evidence: v.evidence.map((d) => ({ ...d, image: d.image ? `/${d.image}` : undefined })) }])),
  }));
  app.get("/api/kronos", (_req, res) => res.sendFile(`${ROOT}public/kronos.json`));
  app.get("/api/ledger", (_req, res) => {
    const l = ledger();
    const last = (o: Record<string, any>) => Object.values(o).slice(-30).reverse().map(publicView);
    res.json({ quotes: last(l.quotes).map((q: any) => ({ ...q, case: { ...q.case, docs: q.case.docs.map((d: any) => ({ name: d.name, source: d.source })) } })), bonds: last(l.bonds), claims: last(l.claims) });
  });
  app.get("/api/:kind(quotes|bonds|claims)/:id", (req, res) => {
    const x = (ledger() as any)[req.params.kind][req.params.id];
    x ? res.json(publicView(x)) : res.status(404).json({ error: "not found" });
  });

  app.post("/api/quote", (req, res) => {
    if (guard(req, res, "quote", 12, 200)) return;
    const c = req.body?.caseId ? CASES[req.body.caseId] : req.body?.case;
    if (!c) return void res.status(400).json({ error: "send {caseId} or {case}" });
    // Images in a caller's own case must be data: or https URLs, never local paths.
    if (!req.body?.caseId && c.docs?.some((d: any) => d?.image && !/^(data:image\/|https:\/\/)/.test(d.image))) return void res.status(400).json({ error: "images must be data: or https URLs" });
    stream(res, (step) => quote(c, step));
  });

  app.post("/api/bind", async (req, res) => {
    try { res.json(await bind(String(req.body?.quoteId), req.body?.tx as Hex, req.body?.beneficiary)); }
    catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });

  // Demo only: the insured agent's wallet pays the premium, so a visitor can watch the whole flow.
  app.post("/api/demo/pay-premium", async (req, res) => {
    if (guard(req, res, "premium", 6, 40)) return;
    try {
      const q = ledger().quotes[String(req.body?.quoteId)];
      if (!q?.payment) throw new Error("no payable quote");
      if (!q.case.id || !CASES[q.case.id]) throw new Error("only demo cases are paid by the demo agent");
      const tx = await sendUsdc(process.env.DEMO_AGENT_KEY as Hex, q.payment.to, BigInt(q.payment.units));
      res.json({ tx, bond: await bind(q.id, tx) });
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });

  app.post("/api/claim", (req, res) => {
    const demo = req.body?.claimId ? (CLAIMS as any)[req.body.claimId] : null;
    if (guard(req, res, "claim", demo ? 6 : 10, 40)) return;
    const evidence = demo ? demo.evidence : req.body?.evidence;
    if (!demo && evidence?.some((d: any) => d?.image && !/^(data:image\/|https:\/\/)/.test(d.image))) return void res.status(400).json({ error: "images must be data: or https URLs" });
    stream(res, (step) => claim(String(req.body?.bondId), demo ? demo.statement : req.body?.statement, evidence, step));
  });

  app.post("/api/recheck/:id", (req, res) => {
    if (guard(req, res, "recheck", 10, 150)) return;
    stream(res, () => recheck(req.params.id));
  });

  app.use("/demo/img", express.static(`${ROOT}demo/img`, { maxAge: "1h" }));
  app.use(express.static(`${ROOT}public`, { extensions: ["html"] }));
}
