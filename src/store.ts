import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

// shortcut: one JSON file on local disk, lost on container redeploy; move to a hosted KV if real bonds are written.
const DIR = process.env.BONDED_DATA_DIR ?? "data";
const FILE = join(DIR, "ledger.json");

export interface Ledger {
  quotes: Record<string, any>;
  bonds: Record<string, any>;
  claims: Record<string, any>;
  usedTx: string[];
}

let cache: Ledger | null = null;

export function ledger(): Ledger {
  if (cache) return cache;
  mkdirSync(join(DIR, "requests"), { recursive: true });
  cache = existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : { quotes: {}, bonds: {}, claims: {}, usedTx: [] };
  return cache!;
}

export function save() {
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(ledger(), null, 1));
  renameSync(tmp, FILE); // atomic replace: a crash mid-write never leaves half a ledger
}

/** The exact Dolphin request, kept so anyone can re-run the decision. */
export function saveRequest(hash: string, body: unknown) {
  ledger();
  const f = join(DIR, "requests", `${hash}.json`);
  if (!existsSync(f)) writeFileSync(f, JSON.stringify(body));
}

export function loadRequest(hash: string): Record<string, unknown> | null {
  if (!/^[a-f0-9]{64}$/.test(hash)) return null;
  const f = join(DIR, "requests", `${hash}.json`);
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
}

export const newId = (prefix: string) => `${prefix}_${randomBytes(5).toString("hex")}`;
