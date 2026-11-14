/**
 * Caller-provided documents, parsed and validated before they reach the underwriter.
 *
 * The OpenServ runtime relay may hand a capability either an array or a JSON string of
 * documents. Images may only be data:image/… or https://… URLs: any other value (a repo
 * path like "demo/img/inv.png", or "/etc/passwd") would be read from disk by src/case.ts
 * toDataUrl() and shipped to the model — a local-file read through an agent capability —
 * so it is rejected here, mirroring the check the HTTP route already applies.
 */
import type { Doc } from "../src/case";

/** Throw unless every doc's image is absent or a data:image/ / https:// URL. */
export function assertSafeImages(docs: unknown): void {
  for (const d of Array.isArray(docs) ? (docs as Doc[]) : []) {
    const img = (d as Doc | undefined)?.image;
    if (img === undefined) continue;
    if (typeof img !== "string" || !(img.startsWith("data:image/") || img.startsWith("https://"))) {
      throw new Error(
        `document "${(d as Doc)?.name ?? "(unnamed)"}": image must be a "data:image/…" or "https://…" URL; local paths and other values are not accepted (they would read files from this server)`,
      );
    }
  }
}

/** Parse documents given either as an array or as JSON text (x402 form fields are strings). */
export function parseDocs(v: unknown, fallbackText?: string): Doc[] {
  let parsed: unknown = v;
  if (typeof v === "string") {
    const s = v.trim();
    if (s.startsWith("[")) { try { parsed = JSON.parse(s); } catch { /* fall through to plain text */ } }
  }
  const docs: Doc[] = Array.isArray(parsed)
    ? (parsed as Doc[])
    : fallbackText ? [{ name: "case.txt", source: "untrusted", text: fallbackText }] : [];
  assertSafeImages(docs);
  return docs;
}

/**
 * Resolve a caller's `caseId` to a stored demo case, or null. Object.hasOwn keeps inherited
 * keys ("constructor", "__proto__", …) from matching, and the returned case bypasses the
 * image-URL rule on purpose: demo cases legitimately use local demo/img paths that only this
 * server may read. Caller-supplied documents must still go through parseDocs().
 */
export function resolveStoredCase(caseId: unknown, cases: Record<string, unknown>): unknown | null {
  return typeof caseId === "string" && caseId.length > 0 && Object.hasOwn(cases, caseId) ? cases[caseId] : null;
}
