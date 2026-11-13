/**
 * Load deploy secrets from deploy/env.sealed (AES-256-GCM), unsealed with BONDED_ENV_KEY.
 * The host only holds the unseal key; the sealed file is written by `npm run seal`.
 * Values already in the environment win.
 */
import "dotenv/config";
import { createDecipheriv } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

const file = new URL("../deploy/env.sealed", import.meta.url);
const key = process.env.BONDED_ENV_KEY;
if (key && existsSync(file)) {
  const { iv, tag, data } = JSON.parse(readFileSync(file, "utf8"));
  const d = createDecipheriv("aes-256-gcm", Buffer.from(key, "hex"), Buffer.from(iv, "hex"));
  d.setAuthTag(Buffer.from(tag, "hex"));
  const env = JSON.parse(Buffer.concat([d.update(Buffer.from(data, "base64")), d.final()]).toString("utf8"));
  for (const [k, v] of Object.entries(env)) if (!process.env[k]) process.env[k] = String(v);
}
