import { createHash } from "node:crypto";

export const DOLPHIN_URL = "https://lighthouse.dphn.ai/run/text-v/v1/chat/completions";
export const DOLPHIN_MODEL = "deepseek-ai/DeepSeek-V4.1-Flash";
/** Open weights the underwriter is pinned to (MIT licence). */
export const WEIGHTS_URL = "https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash";
const PRICE = { in: 0.01, out: 0.07 }; // $/M tokens, dphn.ai pricing

export type Part = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
export interface Message { role: "system" | "user" | "assistant"; content: string | Part[] }

export interface DolphinRun {
  /** sha256 of the exact request body: anyone holding the case can rebuild and re-run it. */
  requestHash: string;
  body: Record<string, unknown>;
  content: string;
  model: string;
  fingerprint: string;
  inTokens: number;
  outTokens: number;
  costUsd: number;
  latencyMs: number;
  fallbackSuspect: boolean;
}

export function buildBody(messages: Message[], maxTokens: number) {
  // Fixed decoding so a re-run on the same weights should land on the same decision.
  return { model: DOLPHIN_MODEL, messages, max_tokens: maxTokens, temperature: 0, seed: 7, reasoning_effort: "low", response_format: { type: "json_object" } };
}

export const hashBody = (body: unknown) => createHash("sha256").update(JSON.stringify(body)).digest("hex");

/** One streamed Dolphin call (streaming keeps long calls alive past Cloudflare's ~125 s idle limit). */
export async function callDolphin(body: Record<string, unknown>, timeoutMs = 150_000): Promise<DolphinRun> {
  const key = process.env.DOLPHIN_API_KEY;
  if (!key) throw new Error("DOLPHIN_API_KEY is not set");
  const started = Date.now();
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(DOLPHIN_URL, {
        method: "POST",
        signal: ctrl.signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ ...body, stream: true, stream_options: { include_usage: true } }),
      });
      if (res.status === 429 || res.status >= 500) {
        const wait = Number(res.headers.get("retry-after") ?? 2 + attempt * 3);
        lastErr = new Error(`Dolphin ${res.status}: ${(await res.text()).slice(0, 200)}`);
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }
      if (!res.ok || !res.body) throw new Error(`Dolphin ${res.status}: ${(await res.text()).slice(0, 300)}`);
      let content = "", model = "", fingerprint = "", buf = "";
      let usage: any = {};
      for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
        buf += chunk;
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data:") || line.includes("[DONE]")) continue;
          let ev: any;
          try { ev = JSON.parse(line.slice(5)); } catch { continue; }
          if (ev.error) throw new Error(ev.error.message || JSON.stringify(ev.error));
          content += ev.choices?.[0]?.delta?.content ?? "";
          if (ev.model) model = ev.model;
          if (ev.system_fingerprint) fingerprint = ev.system_fingerprint;
          if (ev.usage) usage = ev.usage;
        }
      }
      const inTokens = usage.prompt_tokens ?? 0, outTokens = usage.completion_tokens ?? 0;
      const headers = JSON.stringify(Object.fromEntries(res.headers.entries())).toLowerCase();
      return {
        requestHash: hashBody(body), body, content, model, fingerprint, inTokens, outTokens,
        costUsd: (inTokens * PRICE.in + outTokens * PRICE.out) / 1e6,
        latencyMs: Date.now() - started,
        // Dolphin may fall back to OpenRouter; a decision served elsewhere is flagged, not hidden.
        fallbackSuspect: (!!model && model !== DOLPHIN_MODEL) || headers.includes("openrouter"),
      };
    } catch (e) {
      lastErr = e;
      if ((e as Error).name !== "AbortError" && !String(e).includes("fetch failed")) throw e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export function parseJson<T>(text: string): T {
  const s = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  return JSON.parse(a >= 0 && b > a ? s.slice(a, b + 1) : s) as T;
}
