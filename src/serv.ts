/**
 * SERV Reasoning second line: Prompt Guard screens every untrusted document,
 * the Shadow Agent audits the reviewer's answer against Bonded's rating rules.
 */
const URL = "https://inference-api.openserv.ai/v1/chat/completions";
export const SERV_MODEL = process.env.BONDED_SERV_MODEL ?? "gpt-6-luna";
/** Multipath is a model feature (suffix), not a tool: SERV rewrites the prompt into a branching reasoning graph. */
export const MULTIPATH_MODEL = `${SERV_MODEL}-serv-multipath`;
/** Kronos audits (and repairs) SERV's generated reasoning prompt before inference. Also a model suffix. */
export const KRONOS_MODEL = `${SERV_MODEL}-serv-kronos`;

export interface ServReview {
  guardBlocked: boolean;
  verdict: "agree" | "object" | "blocked";
  reason: string;
  model: string;
  latencyMs: number;
  requestId: string | null;
}

export async function servReview(opts: { system: string; untrusted: string; shadowHint: string }): Promise<ServReview> {
  const key = process.env.SERV_API_KEY;
  if (!key) throw new Error("SERV_API_KEY is not set");
  if (opts.shadowHint.length > 2000) throw new Error("shadow hint over 2000 chars"); // SERV answers 400 above this
  const started = Date.now();
  const body = {
    model: SERV_MODEL,
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: opts.untrusted },
    ],
    max_completion_tokens: 600,
    reasoning_effort: "low",
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "review",
        strict: true,
        schema: { type: "object", additionalProperties: false, required: ["verdict", "reason"], properties: { verdict: { type: "string", enum: ["agree", "object"] }, reason: { type: "string" } } },
      },
    },
    tools: [
      { type: "function", function: { name: "serv_prompt_guard" } },
      { type: "function", function: { name: "serv_shadow_agent", parameters: { type: "object", properties: { hint: { type: "string", default: opts.shadowHint }, max_iterations: { type: "integer", default: 1 } } } } },
    ],
  };
  let json: any, res: Response | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch(URL, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
    json = await res.json().catch(() => null);
    if (res.ok || (res.status < 500 && res.status !== 429)) break;
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
  }
  if (!res?.ok) throw new Error(`SERV ${res?.status}: ${JSON.stringify(json?.error ?? json).slice(0, 300)}`);
  const choice = json.choices?.[0];
  const u = json.usage ?? {};
  // Prompt Guard refuses before the model runs: the only answer with zero tokens billed.
  const guardBlocked = !(u.prompt_tokens > 0 || u.completion_tokens > 0) && (choice?.finish_reason === "content_filter" || !!choice?.message?.refusal);
  const meta = { model: json.model ?? SERV_MODEL, latencyMs: Date.now() - started, requestId: res.headers.get("x-openserv-request-id") };
  if (guardBlocked) return { guardBlocked, verdict: "blocked", reason: "SERV Prompt Guard refused the documents: they carry instructions aimed at the reviewer.", ...meta };
  try {
    const p = JSON.parse(choice?.message?.content ?? "");
    return { guardBlocked, verdict: p.verdict === "agree" ? "agree" : "object", reason: String(p.reason ?? ""), ...meta };
  } catch {
    return { guardBlocked, verdict: "object", reason: `Reviewer reply was not valid JSON: ${String(choice?.message?.content).slice(0, 200)}`, ...meta };
  }
}

/**
 * Multipath: three rulebooks that are allowed to disagree (bond wording, the insured's payment
 * policy, the vendor agreement) are reasoned over in one graph, one branch per rulebook.
 * The model reports per rulebook; code decides what a finding means for the payout.
 */
export const RULEBOOKS = ["bond_wording", "payment_policy", "vendor_contract"] as const;
export type Rulebook = (typeof RULEBOOKS)[number];

export interface RulebookFinding {
  rulebook: Rulebook;
  finding: "covered" | "excluded";
  /** The clause that decides it, quoted from that rulebook. */
  clause: string;
  reason: string;
}

export interface MultipathReview {
  rulebooks: RulebookFinding[];
  verdict: "covered" | "excluded";
  reason: string;
  requestedModel: string;
  model: string;
  latencyMs: number;
  requestId: string | null;
  /** False when the reply named no rulebook at all (refusal, bad JSON, empty answer). */
  answered: boolean;
}

const MULTIPATH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["rulebooks", "verdict", "reason"],
  properties: {
    rulebooks: {
      type: "array",
      minItems: RULEBOOKS.length,
      maxItems: RULEBOOKS.length,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["rulebook", "finding", "clause", "reason"],
        properties: {
          rulebook: { type: "string", enum: [...RULEBOOKS] },
          finding: { type: "string", enum: ["covered", "excluded"] },
          clause: { type: "string" },
          reason: { type: "string" },
        },
      },
    },
    verdict: { type: "string", enum: ["covered", "excluded"] },
    reason: { type: "string" },
  },
};

/** One rulebook missing or a reply that will not parse is an exclusion, never a silent pass. */
function normalizeMultipath(p: any, requestedModel: string, model: string, latencyMs: number, requestId: string | null): MultipathReview {
  const got = Array.isArray(p?.rulebooks) ? p.rulebooks : [];
  const rulebooks: RulebookFinding[] = RULEBOOKS.map((rb) => {
    const hit = got.find((r: any) => r?.rulebook === rb);
    return hit
      ? { rulebook: rb, finding: hit.finding === "covered" ? "covered" : "excluded", clause: String(hit.clause ?? ""), reason: String(hit.reason ?? "") }
      : { rulebook: rb, finding: "excluded", clause: "", reason: "The Multipath review did not address this rulebook." };
  });
  const excluded = rulebooks.filter((r) => r.finding === "excluded");
  const verdict: MultipathReview["verdict"] = p?.verdict === "covered" && !excluded.length ? "covered" : "excluded";
  return { rulebooks, verdict, reason: String(p?.reason ?? (excluded.length ? `${excluded.map((r) => r.rulebook).join(", ")} excluded the claim.` : "")), requestedModel, model, latencyMs, requestId, answered: got.length > 0 };
}

export async function servMultipath(opts: { system: string; facts: string }): Promise<MultipathReview> {
  const key = process.env.SERV_API_KEY;
  if (!key) throw new Error("SERV_API_KEY is not set");
  const started = Date.now();
  const body = {
    model: MULTIPATH_MODEL,
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: opts.facts },
    ],
    max_completion_tokens: 2000,
    reasoning_effort: "low",
    response_format: { type: "json_schema", json_schema: { name: "multipath", strict: true, schema: MULTIPATH_SCHEMA } },
    // The facts carry untrusted claim documents: same inbound screen as every other SERV call.
    // The filter is off because this reviewer's job is to quote the clause it applies, which the
    // always-on system-prompt-leak filter would otherwise redact out of the answer.
    tools: [{ type: "function", function: { name: "serv_prompt_guard" } }, { type: "function", function: { name: "serv_disable_content_filter" } }],
  };
  let json: any, res: Response | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch(URL, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
    json = await res.json().catch(() => null);
    if (res.ok || (res.status < 500 && res.status !== 429)) break;
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
  }
  if (!res?.ok) throw new Error(`SERV multipath ${res?.status}: ${JSON.stringify(json?.error ?? json).slice(0, 300)}`);
  const choice = json.choices?.[0];
  const meta = { requestedModel: MULTIPATH_MODEL, model: json.model ?? SERV_MODEL, latencyMs: Date.now() - started, requestId: res.headers.get("x-openserv-request-id") };
  const u = json.usage ?? {};
  if (!(u.prompt_tokens > 0 || u.completion_tokens > 0) && (choice?.finish_reason === "content_filter" || !!choice?.message?.refusal)) {
    return normalizeMultipath({ rulebooks: [], verdict: "excluded", reason: "SERV Prompt Guard refused the claim documents: they carry instructions aimed at the reviewer." }, meta.requestedModel, meta.model, meta.latencyMs, meta.requestId);
  }
  let parsed: any = null;
  try { parsed = JSON.parse(choice?.message?.content ?? ""); } catch {
    return normalizeMultipath({ rulebooks: [], verdict: "excluded", reason: `Multipath reply was not valid JSON: ${String(choice?.message?.content).slice(0, 200)}` }, meta.requestedModel, meta.model, meta.latencyMs, meta.requestId);
  }
  return normalizeMultipath(parsed, meta.requestedModel, meta.model, meta.latencyMs, meta.requestId);
}
