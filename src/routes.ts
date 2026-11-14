import express, { type Express, type NextFunction, type Request, type Response } from "express";
import type { Hex } from "viem";
import { bind, claim, poolStatus, publicView, quote, recheck } from "./service";
import { ledger, own } from "./store";
import { CASES, CLAIMS } from "../demo/cases";
import { sendUsdc } from "./chain";
import { mountA2a } from "./a2a";

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
/** Render's proxy appends the address it saw to X-Forwarded-For, so the LAST hop is the client;
 *  the first value is caller-controlled. A loopback peer is a direct local/test client: ignore its header. */
const ip = (req: Request) => {
  const peer = String(req.socket.remoteAddress ?? "?");
  if (/^(127\.|::1$|::ffff:127\.)/.test(peer)) return peer;
  // Render sits behind Cloudflare, which sets CF-Connecting-IP to the client on every request.
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string" && cf.trim()) return cf.trim();
  const hops = String(req.headers["x-forwarded-for"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return hops.length ? hops[hops.length - 1] : peer;
};
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
  mountA2a(app); // GET /api/a2a/runs (agent-to-agent runs)
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
    const x = own((ledger() as any)[String((req.params as any).kind)], req.params.id);
    x ? res.json(publicView(x)) : res.status(404).json({ error: "not found" });
  });

  app.post("/api/quote", (req, res) => {
    const caseId = req.body?.caseId;
    const c = caseId ? own(CASES, String(caseId)) : req.body?.case;
    if (!c) return void res.status(400).json({ error: caseId ? "unknown case" : "send {caseId} or {case}" });
    // Images in a caller's own case must be data: or https URLs, never local paths.
    if (!caseId) {
      if (!Array.isArray(c.docs)) return void res.status(400).json({ error: "docs must be an array" });
      if (c.docs.some((d: any) => d?.image !== undefined && typeof d.image !== "string")) return void res.status(400).json({ error: "image must be a string" });
      if (c.docs.some((d: any) => d?.image && !/^(data:image\/|https:\/\/)/.test(d.image))) return void res.status(400).json({ error: "images must be data: or https URLs" });
    }
    if (guard(req, res, "quote", 12, 200)) return; // only work that reaches the underwriting panel counts
    stream(res, (step) => quote(c, step));
  });

  app.post("/api/bind", async (req, res) => {
    const tx = req.body?.tx;
    if (typeof tx !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(tx)) return void res.status(400).json({ error: "tx must be a 0x-prefixed 64-hex transaction hash" });
    try { res.json(await bind(String(req.body?.quoteId), tx as Hex, req.body?.beneficiary)); }
    catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });

  // Demo only: the insured agent's wallet pays the premium, so a visitor can watch the whole flow.
  app.post("/api/demo/pay-premium", async (req, res) => {
    if (guard(req, res, "premium", 6, 40)) return;
    try {
      const q = own(ledger().quotes, String(req.body?.quoteId));
      if (!q?.payment) throw new Error("no payable quote");
      // Refuse before moving money: a stale or already-bound quote would only fail in bind().
      if (Date.now() > Date.parse(q.expiresAt)) throw new Error("quote expired: request a new one");
      if (Object.values(ledger().bonds).some((b: any) => b.quoteId === q.id)) throw new Error("quote already bound");
      if (!q.case.id || !own(CASES, q.case.id)) throw new Error("only demo cases are paid by the demo agent");
      const tx = await sendUsdc(process.env.DEMO_AGENT_KEY as Hex, q.payment.to, BigInt(q.payment.units));
      res.json({ tx, bond: await bind(q.id, tx) });
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });

  app.post("/api/claim", (req, res) => {
    const claimId = req.body?.claimId;
    const demo = claimId != null ? own(CLAIMS as Record<string, any>, String(claimId)) : null;
    if (claimId != null && !demo) return void res.status(400).json({ error: "unknown claim" });
    const evidence = demo ? demo.evidence : req.body?.evidence;
    if (!demo) {
      if (!Array.isArray(evidence)) return void res.status(400).json({ error: "evidence must be an array" });
      if (evidence.some((d: any) => d?.image !== undefined && typeof d.image !== "string")) return void res.status(400).json({ error: "image must be a string" });
      if (evidence.some((d: any) => d?.image && !/^(data:image\/|https:\/\/)/.test(d.image))) return void res.status(400).json({ error: "images must be data: or https URLs" });
    }
    if (guard(req, res, "claim", demo ? 6 : 10, 40)) return; // only work that reaches the claims judge counts
    stream(res, (step) => claim(String(req.body?.bondId), demo ? demo.statement : req.body?.statement, evidence, step));
  });

  app.post("/api/recheck/:id", (req, res) => {
    if (guard(req, res, "recheck", 10, 150)) return;
    stream(res, () => recheck(req.params.id));
  });

  app.use("/demo/img", express.static(`${ROOT}demo/img`, { maxAge: "1h" }));
  app.use(express.static(`${ROOT}public`, { extensions: ["html"] }));

  // Always JSON, never Express's HTML stack trace: body-parser errors land here too.
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return void res.end();
    const status = Number(err?.status ?? err?.statusCode) || 500;
    res.status(status).json({ error: err?.type === "entity.parse.failed" ? "invalid JSON body" : String(err?.message ?? "request failed") });
  });
}
