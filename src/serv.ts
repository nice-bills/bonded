/**
 * SERV Reasoning second line: Prompt Guard screens every untrusted document,
 * the Shadow Agent audits the reviewer's answer against Bonded's rating rules.
 */
const URL = "https://inference-api.openserv.ai/v1/chat/completions";
export const SERV_MODEL = process.env.BONDED_SERV_MODEL ?? "gpt-6-luna";

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
