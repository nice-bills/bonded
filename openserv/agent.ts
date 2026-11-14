/**
 * Bonded on OpenServ: an action guarantee pool any agent can call before it acts.
 *
 * Capabilities: quote (Dolphin underwrites the whole case, SERV Reasoning clears it),
 * bind (premium paid in USDC to the pool, verified on chain), claim (Dolphin judges,
 * SERV audits, the pool pays out). Two x402 workflows list Bonded on the Agent Market.
 * The same container also serves the public console and JSON API.
 *
 * First run: `npm run openserv` (provision() registers the agent and workflows, writes .openserv.json).
 */
import "../src/sealed";
import { existsSync, writeFileSync } from "node:fs";
import { Agent, run } from "@openserv-labs/sdk";
import { provision, triggers } from "@openserv-labs/client";
import { provisionPayrun } from "./payrun";
import { z } from "zod";
import type { Hex } from "viem";
import { mount } from "../src/routes";
import { attachBond } from "../src/a2a";
import { bind, claim, quote } from "../src/service";
import { publicView } from "../src/service";
import type { Doc } from "../src/case";

const PUBLIC_URL = process.env.BONDED_PUBLIC_URL ?? "";
const EARNINGS = process.env.BONDED_EARNINGS_WALLET?.trim();
const payTo = EARNINGS && /^0x[a-fA-F0-9]{40}$/.test(EARNINGS) ? { walletAddress: EARNINGS } : {};

const agent = new Agent({
  systemPrompt:
    "You are Bonded, an action guarantee pool for AI agents. Call exactly one capability per request with the caller's fields passed through verbatim, and return its JSON result unchanged.",
});

const docSchema = z.object({
  name: z.string(),
  source: z.enum(["untrusted", "records"]).describe("untrusted = received from outside (invoice, email); records = the caller's own systems"),
  text: z.string().optional(),
  image: z.string().optional().describe("https URL or data: URL of an image"),
});

/** Parse documents given either as an array or as JSON text (x402 form fields are strings). */
function docs(v: unknown, fallbackText?: string): Doc[] {
  if (Array.isArray(v)) return v as Doc[];
  if (typeof v === "string" && v.trim().startsWith("[")) { try { return JSON.parse(v); } catch { /* fall through */ } }
  return fallbackText ? [{ name: "case.txt", source: "untrusted", text: fallbackText }] : [];
}
const out = (x: unknown) => JSON.stringify(publicView(x), null, 2);

agent.addCapability({
  name: "quote",
  description:
    "Before your agent acts (e.g. pays an invoice), get a guarantee quote for that one action. Bonded's open-weight underwriter (DeepSeek-V4.1-Flash on Dolphin) reads the whole case, including images, and returns a premium, or declines: a decline means the action is uninsurable and should not happen.",
  inputSchema: z.object({
    action: z.string().describe("What the agent is about to do, e.g. 'Pay invoice INV-0931 from Kwame Mensah'"),
    amountUsd: z.coerce.number().describe("Amount at risk in USD"),
    payee: z.string().describe("Who receives the money"),
    payTo: z.string().describe("Destination address or account"),
    coverUsd: z.coerce.number().optional().describe("Cover wanted, up to the amount; defaults to the amount"),
    documents: z.union([z.array(docSchema), z.string()]).describe("The case file: invoice, emails, vendor records, contract, policy. JSON array of {name, source, text|image}, or plain text."),
    insured: z.string().optional(),
  }),
  async run({ args }) {
    const q = await quote({
      insured: args.insured ?? "OpenServ caller",
      action: { kind: "pay", description: args.action, amountUsd: args.amountUsd, payee: args.payee, payTo: args.payTo },
      coverUsd: args.coverUsd ?? args.amountUsd,
      docs: docs(args.documents, typeof args.documents === "string" ? args.documents : undefined),
    });
    return out({ quoteId: q.id, decision: q.decision, reason: q.reason, premiumUsd: q.premiumUsd, pLoss: q.pLoss, payment: q.payment, expiresAt: q.expiresAt, summary: q.underwriting.summary, perils: q.underwriting.perils, serv: q.serv, dolphin: q.dolphin, console: PUBLIC_URL ? `${PUBLIC_URL}/#${q.id}` : undefined });
  },
});

agent.addCapability({
  name: "bind",
  description: "Bind a quote: after paying the premium in USDC (Base Sepolia) to the pool address in the quote, send the quote id and the transaction hash. Returns the bond.",
  inputSchema: z.object({ quoteId: z.string(), tx: z.string(), beneficiary: z.string().optional() }),
  async run({ args }) {
    const b = await bind(args.quoteId, args.tx as Hex, args.beneficiary as Hex | undefined);
    // If this quote came from an agent-to-agent run (Payrun Lite), complete that run's record with the bond.
    attachBond(args.quoteId, { id: b.id, consoleUrl: PUBLIC_URL ? `${PUBLIC_URL}/#${b.id}` : undefined });
    return out(b);
  },
});

agent.addCapability({
  name: "claim",
  description: "File a claim on a bond. Bonded's claims judge (DeepSeek-V4.1-Flash on Dolphin) reads the original case, the quote and your evidence together; SERV Reasoning audits the decision; approved claims are paid from the pool in USDC.",
  inputSchema: z.object({ bondId: z.string(), statement: z.string(), evidence: z.union([z.array(docSchema), z.string()]) }),
  async run({ args }) {
    return out(await claim(args.bondId, args.statement, docs(args.evidence, typeof args.evidence === "string" ? args.evidence : undefined)));
  },
});

mount((agent as unknown as { app: any }).app);

async function main() {
  // Hosted copy: the provisioned identity arrives sealed in the env, so the host never signs up a new account.
  if (process.env.BONDED_OPENSERV_STATE && !existsSync(".openserv.json")) writeFileSync(".openserv.json", process.env.BONDED_OPENSERV_STATE, { mode: 0o600 });
  if (process.env.BONDED_REQUIRE_OPENSERV_STATE === "1" && !existsSync(".openserv.json")) {
    throw new Error(".openserv.json is missing, so provision() would create a new OpenServ account.");
  }
  const base = { instance: agent, name: "bonded", description: "Action guarantee pool for AI agents: an open-weight underwriter prices each action before it happens; claims judged on the same pinned weights." };
  const quoteWf = await provision({
    agent: base,
    workflow: {
      name: "Bonded Quote",
      goal: "Underwrite one AI agent action before it happens: read the full case file (invoice images, emails, vendor records, contract, policy) with Bonded's pinned open-weight underwriter, screen untrusted documents with SERV Prompt Guard, audit the estimate with a SERV Shadow Agent, and return a premium or a decline.",
      trigger: triggers.x402({
        name: "Bonded: guarantee an agent action",
        description: "About to pay an invoice? Get a per-action guarantee quote. Open-weight underwriter reads the whole case incl. images; decline = don't act.",
        price: process.env.BONDED_QUOTE_PRICE_USD ?? "0.02",
        timeout: 600,
        ...payTo,
        input: {
          action: { type: "string", title: "Action", description: "What your agent is about to do" },
          amountUsd: { type: "number", title: "Amount (USD)", description: "Money at risk" },
          payee: { type: "string", title: "Payee", description: "Who gets paid" },
          payTo: { type: "string", title: "Pay to", description: "Destination wallet or account" },
          documents: { type: "string", title: "Case file", description: "Invoice text, emails, vendor records (or a JSON array of {name, source, text|image})" },
        },
      }),
      task: { description: "Call quote with the caller's fields and return its JSON result unchanged." },
    },
  });
  const claimWf = await provision({
    agent: base,
    workflow: {
      name: "Bonded Claim",
      goal: "Judge a claim on a Bonded guarantee: read the original case, the quote and the claim evidence together with the pinned open-weight claims judge, audit with SERV Reasoning, and pay approved claims from the pool in USDC.",
      trigger: triggers.x402({
        name: "Bonded: file a claim",
        description: "File a claim on a Bonded guarantee. Judged on the same pinned open weights that priced it; approved claims paid in USDC.",
        price: process.env.BONDED_CLAIM_PRICE_USD ?? "0.01",
        timeout: 600,
        ...payTo,
        input: {
          bondId: { type: "string", title: "Bond id" },
          statement: { type: "string", title: "What happened" },
          evidence: { type: "string", title: "Evidence", description: "Third-party documents (text, or JSON array of {name, source, text|image})" },
        },
      }),
      task: { description: "Call claim with the caller's fields and return its JSON result unchanged." },
    },
  });
  console.log(`Quote paywall: ${quoteWf.paywallUrl ?? "(see platform)"}\nClaim paywall: ${claimWf.paywallUrl ?? "(see platform)"}`);
  // Payrun Lite: the payables agent, in the same process. It asks Bonded for a guarantee before
  // it pays an invoice, pays the premium if insured, and refuses to pay what Bonded declines.
  try {
    const payrunInfo = await provisionPayrun();
    run(payrunInfo.agent).catch((e) => console.error("Payrun Lite failed to start:", e.message));
    console.log(`Payrun Lite agent: ${payrunInfo.agentId}${payrunInfo.workflowId ? ` · payrun workflow: ${payrunInfo.workflowId}` : ""}`);
  } catch (e) {
    console.error(`Payrun Lite not started: ${(e as Error).message}`);
  }
  await run(agent);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
