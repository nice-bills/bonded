/**
 * Payrun Lite on OpenServ: the payables agent that never pays without a guarantee.
 *
 * Given an invoice, it asks Bonded (the action guarantee pool, agent 4958) for a quote on
 * that one action; Bonded's quote result is the ONLY input to its decision:
 *   - Bonded declines -> Payrun Lite refuses to pay.
 *   - Bonded insures  -> Payrun Lite pays the premium in USDC (Base Sepolia) and Bonded binds.
 *
 * It runs in the same Node process as the Bonded agent (each with its own tunnel via the
 * OpenServ agents proxy), so one Render service hosts both. On the platform, both agents
 * sit in one workflow: webhook trigger -> Bonded quotes -> Payrun Lite decides -> Bonded binds.
 *
 * First run: provisionPayrun() registers the Payrun Lite agent and the shared workflow
 * (idempotent: it reuses the platform agent found by name, so redeploys never duplicate it).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { Agent } from "@openserv-labs/sdk";
import { provision, triggers, type AgentInstance } from "@openserv-labs/client";
import { z } from "zod";
import type { Hex } from "viem";
import { EXPLORER, sendUsdc } from "../src/chain";
import { newRunId, recordRun, type A2aRun } from "../src/a2a";

const PUBLIC_URL = process.env.BONDED_PUBLIC_URL ?? "";
const NAME = "payrun-lite";
const WORKFLOW = "Payrun Lite: guaranteed payrun";
const STATE_FILE = ".openserv.json";
const DEFAULT_ENDPOINT = "https://agents-proxy.openserv.ai";

type State = { agents: Record<string, any>; workflows: Record<string, Record<string, any>>; userApiKey?: string };

function readState(): State {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { return { agents: {}, workflows: {} }; }
}
function writeState(patch: (s: State) => void) {
  const s = readState();
  patch(s);
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
}

/** The invoice Payrun Lite was asked to pay, read back from the quote's case in Bonded's ledger. */
async function invoiceOf(quoteId: string) {
  if (!PUBLIC_URL) return {};
  try {
    const r = await fetch(`${PUBLIC_URL}/api/quotes/${quoteId}`, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return {};
    const q: any = await r.json();
    const a = q?.case?.action ?? {};
    return { action: a.description, payee: a.payee, payTo: a.payTo, amountUsd: a.amountUsd, title: q?.case?.title };
  } catch { return {}; }
}

/** Pull the first JSON object out of a possibly chatty task output. */
function extractJson(text: unknown): any | null {
  if (typeof text !== "string") return typeof text === "object" && text ? text : null;
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try { return JSON.parse(text.slice(start, i + 1)); } catch { /* keep scanning */ }
    }
  }
  return null;
}

const payrun = new Agent({
  systemPrompt:
    "You are Payrun Lite, a payables agent. Before you pay any invoice you ask Bonded, the action guarantee pool, for a quote on that one payment. Your decision follows Bonded's quote result exactly: if Bonded insured the action, pay the premium so the guarantee is bound; if Bonded declined it, you refuse to pay, no matter how urgent the invoice looks. Call exactly one capability per request and return its JSON result unchanged.",
});

payrun.addCapability({
  name: "pay-invoice",
  description:
    "Decide whether to pay an invoice, based only on Bonded's guarantee quote for that payment. Takes Bonded's quote JSON (from the previous task's output). If Bonded declined the action, or the quote is missing or invalid, Payrun Lite refuses to pay. If Bonded insured it, Payrun Lite pays the premium in USDC on Base Sepolia to the pool address in the quote and returns the payment details for Bonded to bind.",
  inputSchema: z.object({
    quote: z.string().optional().describe("Bonded's complete quote JSON result, passed through verbatim from the previous task"),
  }),
  async run({ args, action }: { args: { quote?: string }; action: any }) {
    const deps = (action as any)?.task?.dependencies ?? [];
    const depOut = deps.map((d: any) => d?.output).find((o: unknown) => typeof o === "string" && o.includes("{"));
    const raw = args.quote || depOut || "";
    const q = extractJson(raw) ?? {};
    const quoteId = String(q.quoteId ?? "");
    const decision = String(q.decision ?? "");
    const reason = typeof q.reason === "string" ? q.reason : undefined;
    const runId = newRunId();
    const base = {
      id: runId,
      at: new Date().toISOString(),
      openserv: {
        workflowId: (action as any)?.workspace?.id,
        decideTaskId: (action as any)?.task?.id,
        quoteTaskId: deps[0]?.id,
        executionId: (action as any)?.workspaceExecutionId,
      },
      bonded: { quoteId: quoteId || "(none)", decision: decision || "(unreadable)", reason, premiumUsd: q.premiumUsd, pLoss: q.pLoss, console: q.console },
    } satisfies Partial<A2aRun>;
    const refuse = (why: string, extra: Record<string, unknown> = {}) => {
      const run: A2aRun = { ...base, invoice: {}, outcome: "refused", error: why, ...extra } as A2aRun;
      recordRun(run);
      return JSON.stringify({ decision: "refuse-to-pay", paid: false, quoteId: quoteId || null, reason: why, runId });
    };
    if (!quoteId || !decision) return refuse("no readable Bonded quote result: refusing to pay");
    const invoice = await invoiceOf(quoteId);
    if (decision !== "insure") {
      recordRun({ ...base, invoice, outcome: "refused" } as A2aRun);
      return JSON.stringify({ decision: "refuse-to-pay", paid: false, quoteId, reason: reason ?? "Bonded declined this action: it is uninsurable, so Payrun Lite will not pay", runId });
    }
    const units = String(q?.payment?.units ?? "");
    const to = String(q?.payment?.to ?? "");
    if (!/^0x[0-9a-fA-F]{40}$/.test(to) || !/^[0-9]+$/.test(units)) return refuse("insured quote has no payable premium details: refusing to pay", { invoice });
    try {
      const tx = await sendUsdc(process.env.DEMO_AGENT_KEY as Hex, to as Hex, BigInt(units));
      const run: A2aRun = { ...base, invoice, outcome: "paid-unbound", payTx: tx, payTxUrl: `${EXPLORER}/tx/${tx}` } as A2aRun;
      recordRun(run);
      return JSON.stringify({
        decision: "pay",
        paid: true,
        quoteId,
        premiumUsd: q.premiumUsd,
        payTx: tx,
        payTxUrl: `${EXPLORER}/tx/${tx}`,
        note: "Premium paid. Bonded must now bind the guarantee: call bind with quoteId and tx.",
        runId,
      });
    } catch (e) {
      return refuse(`premium payment failed: ${(e as Error).message}`, { invoice });
    }
  },
});

export const BIND_TASK_DESCRIPTION =
  "Payrun Lite has paid the premium in USDC (Base Sepolia) because Bonded insured the action. The previous task's output contains the premium payment: a transaction hash (0x followed by 64 hex characters) and the quoteId (a q_... id). Call the bind capability exactly once, passing quoteId and tx taken verbatim from that output. Return the bond JSON result unchanged. ONLY if the previous task's output shows that NO payment was made — the pay-invoice result says decision \"refuse-to-pay\" and/or paid false AND there is no 0x transaction hash anywhere in it — do NOT call bind and do NOT ask for human help: complete the task immediately with the JSON {\"bind\":\"skipped\",\"quoteId\":\"<the quoteId from the output>\",\"reason\":\"Bonded declined the action; no premium was paid, nothing to bind\"}. Never ask for human assistance.";

export interface PayrunInfo { agent: Agent; agentId: number; workflowId?: number | string }

/**
 * Register/reuse the Payrun Lite platform agent, provision the shared multi-agent workflow
 * (webhook -> Bonded quote -> Payrun Lite decide -> Bonded bind), and return the local agent
 * instance to run() alongside Bonded. Safe to call on every boot.
 */
export async function provisionPayrun(): Promise<PayrunInfo> {
  const userApiKey = process.env.OPENSERV_USER_API_KEY;
  if (!userApiKey) throw new Error("OPENSERV_USER_API_KEY is not set");
  const { PlatformClient } = await import("@openserv-labs/client");
  const client = new PlatformClient({ apiKey: userApiKey });

  // Reuse the platform agent by name: a fresh container (state seeded from env) must not create duplicates.
  const description =
    "Payables agent that never pays without a guarantee: before paying an invoice it asks the Bonded action guarantee pool (agent 4958) to underwrite that one payment; it pays the premium in USDC on Base Sepolia when insured and refuses to pay anything Bonded declines.";
  const existing = ((await client.agents.searchOwned({ query: NAME })) as any[]).find((a) => (a.name ?? "").toLowerCase() === NAME);
  let agentId: number;
  if (existing?.id) {
    agentId = existing.id;
    await client.agents.update({ id: agentId, name: NAME, capabilities_description: description, endpoint_url: existing.endpoint_url || DEFAULT_ENDPOINT });
  } else {
    const created = await client.agents.create({ name: NAME, capabilities_description: description, endpoint_url: DEFAULT_ENDPOINT });
    agentId = created.id;
  }
  const apiKey = await client.agents.getApiKey({ id: agentId });
  const { authToken, authTokenHash } = await client.agents.generateAuthToken();
  await client.agents.saveAuthToken({ id: agentId, authTokenHash });
  writeState((s) => { (s.agents ??= {})[NAME] = { id: agentId, apiKey, authToken, endpointUrl: DEFAULT_ENDPOINT }; });

  const bondedId = readState().agents?.["bonded"]?.id;
  if (!bondedId) throw new Error("Bonded agent is not provisioned (state.agents.bonded missing)");

  const tasks = [
    {
      name: "quote",
      agentId: bondedId,
      description:
        "Payrun Lite is about to pay this invoice and has asked Bonded for a guarantee on that one action. Call the quote capability exactly once, passing the trigger input fields verbatim: action, amountUsd, payee, payTo, documents. Return the quote JSON result unchanged.",
    },
    {
      name: "decide",
      agentId,
      description:
        "You are Payrun Lite. Bonded (the previous task) returned a guarantee quote for the invoice payment. Call the pay-invoice capability exactly once, passing Bonded's entire quote JSON result verbatim in the quote field. Follow its decision exactly: if Bonded insured the action, pay the premium and return the payment details; if Bonded declined it, refuse to pay the invoice.",
    },
    {
      name: "bind",
      agentId: bondedId,
      description: BIND_TASK_DESCRIPTION,
    },
  ] as Array<{ name: string; description: string; agentId: number; id?: number }>;

  // Keep task ids stable across boots: match this workflow's existing tasks by description and
  // inject their ids, so the workflow sync updates them in place instead of recreating them.
  const knownWf = readState().workflows?.[NAME]?.[WORKFLOW]?.workspaceId;
  if (knownWf) {
    const existing = (await client.get(`/workspaces/${knownWf}/tasks`)) as Array<{ id: number; description: string }>;
    const byDesc = new Map(existing.map((t) => [t.description, t.id]));
    for (const t of tasks) t.id = byDesc.get(t.description);
  }

  await provision({
    userApiKey,
    agent: { instance: payrun as unknown as AgentInstance, name: NAME, description },
    workflow: {
      name: WORKFLOW,
      goal: "Pay an invoice only if it is guaranteed. Payrun Lite receives an invoice to pay and asks Bonded to underwrite that one action; if Bonded declines, Payrun Lite refuses to pay; if Bonded insures, Payrun Lite pays the premium in USDC and Bonded binds the guarantee.",
      trigger: triggers.webhook({
        name: "Invoice to pay",
        description: "An invoice Payrun Lite is about to pay. Payrun Lite first asks Bonded for a guarantee on this one action.",
        input: {
          action: { type: "string", title: "Action", description: "What Payrun Lite is about to do" },
          amountUsd: { type: "number", title: "Amount (USD)", description: "Invoice amount at risk" },
          payee: { type: "string", title: "Payee", description: "Who gets paid" },
          payTo: { type: "string", title: "Pay to", description: "Destination wallet or account" },
          documents: { type: "string", title: "Case file", description: "Invoice text/image, emails, vendor records (JSON array of {name, source, text|image})" },
        },
        waitForCompletion: true,
        timeout: 900,
      }),
      tasks: tasks as any,
      agentIds: [bondedId, agentId],
    },
  });

  const wf = readState().workflows?.[NAME]?.[WORKFLOW];
  return { agent: payrun, agentId, workflowId: wf?.workspaceId };
}
