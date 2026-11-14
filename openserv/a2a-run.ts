/**
 * Run the Payrun Lite x Bonded workflow end to end on the OpenServ platform for a demo case.
 *
 * Usage: npx tsx openserv/a2a-run.ts <clean|wallet-swap|injection|all>
 *
 * Fires the "Payrun Lite: guaranteed payrun" trigger with the stored case's ID (Bonded
 * underwrites the full stored case server-side — relaying the documents JSON through the
 * runtime's LLM truncated it and once made Bonded decline the clean case on ledger
 * excerpts); the platform runs Bonded (quote) -> Payrun Lite (decide + pay premium) ->
 * Bonded (bind) in one workspace, and this script polls the tasks and records the run in
 * data/a2a-runs.json for GET /api/a2a/runs.
 */
import "../src/sealed";
import { readFileSync } from "node:fs";
import { PlatformClient } from "@openserv-labs/client";
import { CASES } from "../demo/cases";
import { EXPLORER } from "../src/chain";
import { newRunId, recordRun, type A2aRun } from "../src/a2a";

const WORKFLOW = "Payrun Lite: guaranteed payrun";
const PUBLIC_URL = process.env.BONDED_PUBLIC_URL ?? "https://bonded-pool.onrender.com";
const PLATFORM = "https://platform.openserv.ai";

const caseId = process.argv[2] ?? "";
const ids = caseId === "all" ? ["clean", "wallet-swap", "injection"] : [caseId];
if (!ids.every((id) => id in CASES)) {
  console.error("usage: npx tsx openserv/a2a-run.ts <clean|wallet-swap|injection|all>");
  process.exit(1);
}

const state = JSON.parse(readFileSync(".openserv.json", "utf8"));
const wf = state.workflows?.["payrun-lite"]?.[WORKFLOW];
if (!wf?.workspaceId || !wf?.triggerId) throw new Error(`workflow not provisioned (state.workflows["payrun-lite"]["${WORKFLOW}"])`);
const client = new PlatformClient({ apiKey: process.env.OPENSERV_USER_API_KEY });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** This box's route to api.openserv.ai (Cloudflare) flaps; retry connect failures. */
async function retry<T>(work: () => Promise<T>, label: string): Promise<T> {
  let last: unknown;
  for (let i = 0; i < 6; i++) {
    try { return await work(); } catch (e: any) {
      last = e;
      if (!["ECONNRESET", "ETIMEDOUT", "ENETUNREACH", "EAI_AGAIN", "ECONNREFUSED"].includes(e?.code) && !e?.errors?.length) throw e;
      console.log(`  (${label} network retry ${i + 1}: ${e?.code ?? e?.message})`);
      await sleep(3000 * (i + 1));
    }
  }
  throw last;
}

/** Tasks are identified by the first words of their (stable) description. */
const taskKind = (t: any) => t.description?.startsWith("Payrun Lite is about to pay") ? "quote"
  : t.description?.startsWith("You are Payrun Lite") ? "decide"
  : t.description?.startsWith("Payrun Lite has paid") ? "bind" : null;
const outputText = (t: any) => {
  const o = t.output ?? t.latest_task_execution_record?.output;
  return o?.type === "text" ? o.value : typeof o === "string" ? o : null;
};
/** Every JSON object found in a task output (the runtime may narrate around them). */
const allJson = (t: unknown): any[] => {
  if (typeof t !== "string") return [];
  const out: any[] = [];
  const s = t.indexOf("{");
  if (s < 0) return out;
  let depth = 0, inStr = false, esc = false, start = s;
  for (let i = s; i < t.length; i++) {
    const c = t[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{") { if (depth === 0) start = i; depth++; }
    else if (c === "}") {
      if (--depth === 0) {
        try { out.push(JSON.parse(t.slice(start, i + 1))); } catch { /* skip malformed blob */ }
      }
    }
  }
  return out;
};
const mergedJson = (t: unknown) => Object.assign({}, ...allJson(t));

async function runOne(id: string) {
  const c = CASES[id];
  // caseId, not a documents blob: Bonded resolves the full stored case server-side, so the
  // platform runtime cannot truncate it on the way through.
  const input = { caseId: id, action: c.action.description, amountUsd: c.action.amountUsd, payee: c.action.payee, payTo: c.action.payTo };
  console.log(`\n=== ${id}: firing trigger (workflow ${wf.workspaceId}) ===`);
  await retry(() => client.put(`/workspaces/${wf.workspaceId}/triggers/${wf.triggerId}/trigger`, { input: JSON.stringify(input) }), "fire");

  const deadline = Date.now() + 12 * 60_000;
  let tasks: any[] = [];
  while (Date.now() < deadline) {
    await sleep(5000);
    tasks = (await retry(() => client.get(`/workspaces/${wf.workspaceId}/tasks`), "poll")) as any[];
    const mine = tasks.filter((t) => taskKind(t));
    const open = mine.filter((t) => !["done", "error", "cancelled"].includes(t.status));
    if (mine.length === 3 && open.length === 0) break;
    if (mine.some((t) => t.status === "error" || t.status === "human-assistance-required")) break;
  }
  const byName = Object.fromEntries(tasks.filter((t) => taskKind(t)).map((t) => [taskKind(t), t]));
  const decideText = outputText(byName.decide) ?? "";
  const bindText = outputText(byName.bind) ?? "";
  const decideOut = mergedJson(decideText);
  const bindOut = mergedJson(bindText);
  const quoteOut = mergedJson(outputText(byName.quote));
  const quoteId = decideOut?.quoteId ?? quoteOut?.quoteId ?? "";
  // The runtime may re-summarize the capability result as prose instead of echoing the JSON,
  // so fall back to the transaction hash and "paid" wording found in the text itself.
  const payTx = decideOut?.payTx ?? bindOut?.tx ?? decideText.match(/0x[0-9a-fA-F]{64}/)?.[0];
  const paid = decideOut?.decision === "pay" || decideOut?.paid === true || /paid\s*true|call result:\s*paid/i.test(decideText);

  // Verify the quote exists in Bonded's production ledger and matches THIS run's invoice.
  // Guards against a reused task replaying a quote from a previous execution's history.
  let quoteVerified: boolean | undefined;
  if (quoteId && quoteId !== "(none)") {
    try {
      const r = await fetch(`${PUBLIC_URL}/api/quotes/${quoteId}`, { signal: AbortSignal.timeout(15_000) });
      if (r.ok) {
        const q: any = await r.json();
        const a = q?.case?.action ?? {};
        quoteVerified = a.payTo === input.payTo && a.amountUsd === input.amountUsd;
      } else if (r.status === 404) quoteVerified = false;
    } catch { /* leave undefined on network trouble */ }
  }

  const run: A2aRun = {
    id: decideOut?.runId ?? newRunId(),
    at: new Date().toISOString(),
    invoice: { action: input.action, payee: input.payee, payTo: input.payTo, amountUsd: input.amountUsd, title: c.title },
    openserv: {
      workflowId: wf.workspaceId,
      quoteTaskId: byName.quote?.id,
      decideTaskId: byName.decide?.id,
      bindTaskId: byName.bind?.id,
    },
    bonded: {
      quoteId: quoteId || "(none)",
      decision: quoteOut?.decision ?? decideOut?.bonded?.decision,
      reason: quoteOut?.reason,
      premiumUsd: quoteOut?.premiumUsd,
      pLoss: quoteOut?.pLoss,
      console: quoteOut?.console,
      verified: quoteVerified,
    },
    outcome: bindOut?.id ? "bound" : bindOut?.bind === "skipped" ? "refused" : paid ? "paid-unbound" : "refused",
    payTx,
    payTxUrl: payTx ? `${EXPLORER}/tx/${payTx}` : undefined,
    bondId: bindOut?.id,
    bondUrl: bindOut?.id ? `${PUBLIC_URL}/#${bindOut.id}` : undefined,
  };
  recordRun(run);
  console.log(JSON.stringify(run, null, 2));
  console.log(`workspace: ${PLATFORM}/workspace/${wf.workspaceId}`);
}

for (const id of ids) await runOne(id);
