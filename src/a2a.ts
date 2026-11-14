/**
 * Agent-to-agent runs: what Payrun Lite (the payables agent on OpenServ) did with Bonded.
 *
 * Payrun Lite records every run from its "pay-invoice" capability (its decision comes only
 * from Bonded's quote result); Bonded's bind capability adds the bond to the matching run.
 * Same JSON-file ledger style as src/store.ts, in its own file.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { Express } from "express";
import { newId } from "./store";

const DIR = process.env.BONDED_DATA_DIR ?? "data";
const FILE = join(DIR, "a2a-runs.json");

export interface A2aRun {
  id: string;
  at: string;
  /** What Payrun Lite was asked to pay. */
  invoice: { action?: string; payee?: string; payTo?: string; amountUsd?: number; title?: string };
  /** OpenServ platform objects this run went through. */
  openserv?: { workflowId?: number | string; quoteTaskId?: number | string; decideTaskId?: number | string; bindTaskId?: number | string; executionId?: number | string };
  /** Bonded's underwriting decision, the only input to Payrun Lite's decision. */
  bonded: { quoteId: string; decision?: string; reason?: string; premiumUsd?: number; pLoss?: number; console?: string; verified?: boolean };
  /** bound = insured, premium paid, bond issued; refused = Bonded declined, no payment. */
  outcome: "bound" | "refused" | "paid-unbound" | "error";
  payTx?: string;
  payTxUrl?: string;
  bondId?: string;
  bondUrl?: string;
  error?: string;
}

type Store = { runs: Record<string, A2aRun> };

let cache: Store | null = null;
function file(): Store {
  if (cache) return cache;
  mkdirSync(DIR, { recursive: true });
  // Render's disk resets on deploy, so seed from the committed proof runs.
  const src = existsSync(FILE) ? FILE : "public/a2a-proof.json";
  cache = existsSync(src) ? JSON.parse(readFileSync(src, "utf8")) : { runs: {} };
  return cache!;
}
function flush() {
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(file(), null, 1));
  renameSync(tmp, FILE); // atomic replace, like src/store.ts
}

/** Upsert a run by id. */
export function recordRun(run: A2aRun) {
  file().runs[run.id] = run;
  flush();
  return run;
}

export const newRunId = () => newId("a2a");

/** Bonded's bind capability calls this after a bond is issued, so the run shows the bond. */
export function attachBond(quoteId: string, bond: { id: string; consoleUrl?: string }) {
  const s = file();
  const run = Object.values(s.runs).reverse().find((r) => r.bonded?.quoteId === quoteId);
  if (!run) return false;
  run.bondId = bond.id;
  run.bondUrl = bond.consoleUrl;
  run.outcome = "bound";
  flush();
  return true;
}

/** Latest runs, newest first. */
export function latestRuns(limit = 30): A2aRun[] {
  return Object.values(file().runs).sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, limit);
}

export function mountA2a(app: Express) {
  app.get("/api/a2a/runs", (_req, res) => {
    try { res.json({ runs: latestRuns() }); } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });
}
