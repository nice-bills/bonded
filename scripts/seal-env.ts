/**
 * Seal the keys the hosted service needs into deploy/env.sealed (AES-256-GCM).
 * The unseal key is kept in .env as BONDED_ENV_KEY (created on first run) and set on the host.
 */
import { createCipheriv, randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parse } from "dotenv";

const env = parse(readFileSync(".env"));
const KEEP = ["DOLPHIN_API_KEY", "SERV_API_KEY", "BONDED_POOL_KEY", "DEMO_AGENT_KEY", "WALLET_PRIVATE_KEY", "OPENSERV_USER_API_KEY", "BONDED_EARNINGS_WALLET", "BONDED_PUBLIC_URL"];
let key = env.BONDED_ENV_KEY;
if (!key) {
  key = randomBytes(32).toString("hex");
  appendFileSync(".env", `BONDED_ENV_KEY=${key}\n`);
}
const payload = Object.fromEntries(KEEP.filter((k) => env[k]).map((k) => [k, env[k]]));
const iv = randomBytes(12);
const c = createCipheriv("aes-256-gcm", Buffer.from(key, "hex"), iv);
const data = Buffer.concat([c.update(JSON.stringify(payload), "utf8"), c.final()]);
mkdirSync("deploy", { recursive: true });
writeFileSync("deploy/env.sealed", JSON.stringify({ iv: iv.toString("hex"), tag: c.getAuthTag().toString("hex"), data: data.toString("base64") }) + "\n");
console.log(`Sealed ${Object.keys(payload).join(", ")} into deploy/env.sealed`);
