/**
 * Provision (or reuse) the Payrun Lite agent and the shared multi-agent workflow, then run
 * Payrun Lite locally against the OpenServ agents proxy.
 *
 * Bonded itself is NOT started here: its production agent (4958) is already tunnelled from
 * Render, and a second local tunnel with the same API key would hijack it. Bonded's quote and
 * bind tasks keep routing to production; only Payrun Lite is served from this process.
 *
 * Usage: npx tsx openserv/payrun-provision.ts          # provision only
 *        npx tsx openserv/payrun-provision.ts --run    # provision, then keep the tunnel up
 */
import "../src/sealed";
import { provisionPayrun } from "./payrun";
import { run } from "@openserv-labs/sdk";

const info = await provisionPayrun();
console.log(`Payrun Lite agent: ${info.agentId} · workflow: ${info.workflowId ?? "(see platform)"}`);
if (process.argv.includes("--run")) {
  console.log("Payrun Lite tunnel up — waiting for platform tasks (Ctrl-C to stop)");
  const { stop } = await run(info.agent);
  process.on("SIGINT", () => { void stop().then(() => process.exit(0)); });
} else process.exit(0);
