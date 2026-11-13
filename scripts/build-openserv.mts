/**
 * Build a self-contained package for OpenServ Cloud (adapted from Payrun's build):
 *   openserv/deploy/src/agent.mjs   agent + API + console, bundled into one file
 *   openserv/deploy/src/agent.ts    launcher (OpenServ starts `npx tsx src/agent.ts`)
 *   openserv/deploy/public, demo/img  the console and demo documents
 *   openserv/deploy/.env            ONLY the keys the service needs (testnet keys, API keys)
 *   openserv/deploy/.openserv.json  the provisioned identity, so the container reuses it
 * The folder is git-ignored.
 */
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parse } from "dotenv";

const out = "openserv/deploy";
mkdirSync(`${out}/src`, { recursive: true });
await build({
  entryPoints: ["openserv/agent.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: true,
  outfile: `${out}/src/agent.mjs`,
  external: ["bufferutil", "utf-8-validate"],
  banner: { js: "import{createRequire as __cr}from'module';const require=__cr(import.meta.url);" },
  logLevel: "warning",
});
writeFileSync(
  `${out}/src/agent.ts`,
  `import { spawn } from "node:child_process";\nconst child = spawn(process.execPath, ["src/agent.mjs"], { stdio: "inherit", env: process.env });\nfor (const s of ["SIGINT", "SIGTERM"] as const) process.on(s, () => child.kill(s));\nchild.on("exit", (code) => process.exit(code ?? 1));\n`,
);
cpSync("public", `${out}/public`, { recursive: true });
cpSync("demo/img", `${out}/demo/img`, { recursive: true });
const root = JSON.parse(readFileSync("package.json", "utf8"));
writeFileSync(`${out}/package.json`, JSON.stringify({ name: "bonded", private: true, type: "module", scripts: { start: "tsx src/agent.ts" }, engines: { node: ">=20" }, dependencies: { tsx: root.devDependencies.tsx } }, null, 2) + "\n");
writeFileSync(`${out}/.gitignore`, "node_modules\ndata\n");

const env = parse(readFileSync(".env"));
const keep = ["DOLPHIN_API_KEY", "SERV_API_KEY", "BONDED_SERV_MODEL", "BONDED_POOL_KEY", "DEMO_AGENT_KEY", "BONDED_TESTNET_SCALE", "BASE_SEPOLIA_RPC", "BONDED_PUBLIC_URL", "BONDED_EARNINGS_WALLET", "BONDED_QUOTE_PRICE_USD", "BONDED_CLAIM_PRICE_USD", "WALLET_PRIVATE_KEY", "OPENSERV_USER_API_KEY", "OPENSERV_CONTAINER_ID"];
for (const k of ["DOLPHIN_API_KEY", "SERV_API_KEY", "BONDED_POOL_KEY", "DEMO_AGENT_KEY"]) if (!env[k]) throw new Error(`${k} missing from .env`);
if (!existsSync(".openserv.json")) throw new Error("Run `npm run openserv` once first so the agent is provisioned.");
const state = JSON.parse(readFileSync(".openserv.json", "utf8"));
if (!env.OPENSERV_USER_API_KEY && state.userApiKey) env.OPENSERV_USER_API_KEY = state.userApiKey;
const prev = existsSync(`${out}/.env`) ? parse(readFileSync(`${out}/.env`)) : {};
if (!env.OPENSERV_CONTAINER_ID && prev.OPENSERV_CONTAINER_ID) env.OPENSERV_CONTAINER_ID = prev.OPENSERV_CONTAINER_ID;
const lines = keep.filter((k) => env[k]).map((k) => `${k}=${env[k]}`);
lines.push("BONDED_REQUIRE_OPENSERV_STATE=1");
writeFileSync(`${out}/.env`, lines.join("\n") + "\n", { mode: 0o600 });
cpSync(".openserv.json", `${out}/.openserv.json`);
console.log(`Built ${out}: ${lines.map((l) => l.split("=")[0]).join(", ")}`);
