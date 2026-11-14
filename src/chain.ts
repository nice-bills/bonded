import { createPublicClient, createWalletClient, http, parseAbi, parseEventLogs, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

/** Circle's test USDC on Base Sepolia. */
export const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
const ABI = parseAbi(["function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)", "event Transfer(address indexed from, address indexed to, uint256 value)"]);
/** Testnet scale: $10,000 of cover is 1 test USDC, so a small faucet balance backs a realistic pool. */
export const SCALE = Number(process.env.BONDED_TESTNET_SCALE ?? "0.0001");
export const EXPLORER = "https://sepolia.basescan.org";

const rpc = http(process.env.BASE_SEPOLIA_RPC ?? "https://sepolia.base.org");
export const pub = createPublicClient({ chain: baseSepolia, transport: rpc });

export const toUnits = (usd: number) => BigInt(Math.round(usd * SCALE * 1e6));
export const fromUnits = (u: bigint) => Number(u) / 1e6 / SCALE;

function poolAccount() {
  const k = process.env.BONDED_POOL_KEY;
  if (!k) throw new Error("BONDED_POOL_KEY is not set");
  return privateKeyToAccount(k as Hex);
}
export const poolAddress = () => (process.env.BONDED_POOL_ADDRESS as Hex | undefined) ?? poolAccount().address;

export async function usdcBalance(addr: Hex): Promise<bigint> {
  return pub.readContract({ address: USDC, abi: ABI, functionName: "balanceOf", args: [addr] });
}

/** Pool capital in cover dollars (testnet units / scale). */
export async function poolUsd(): Promise<number> {
  return fromUnits(await usdcBalance(poolAddress()));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The public RPC can lag a mined tx; retry with backoff (under ~45 s total) before calling it missing. */
async function receipt(hash: Hex) {
  for (const wait of [0, 1_000, 2_500, 5_000, 9_000]) {
    if (wait) await sleep(wait);
    const r = await pub.waitForTransactionReceipt({ hash, timeout: 5_000 }).catch(() => null);
    if (r) return r;
  }
  return null;
}

/** Send USDC from a key (the pool for payouts, the demo agent for premiums). */
export async function sendUsdc(key: Hex, to: Hex, units: bigint): Promise<Hex> {
  const account = privateKeyToAccount(key);
  const wallet = createWalletClient({ account, chain: baseSepolia, transport: rpc });
  const hash = await wallet.writeContract({ address: USDC, abi: ABI, functionName: "transfer", args: [to, units] });
  const r = await receipt(hash);
  // Broadcast but unconfirmed: money may still move, so the hash travels with the error.
  if (!r) throw Object.assign(new Error(`transfer ${hash} not confirmed on Base Sepolia`), { hash });
  if (r.status !== "success") throw new Error(`transfer ${hash} reverted`);
  return hash;
}

export const payout = (to: Hex, units: bigint) => sendUsdc(process.env.BONDED_POOL_KEY as Hex, to, units);

/**
 * A premium counts only if the tx succeeded, moved at least `units` USDC to the pool,
 * and was mined after the quote was issued. Returns the payer, or a reason it failed.
 */
export async function verifyPremium(tx: Hex, units: bigint, notBefore: Date): Promise<{ ok: true; from: Hex } | { ok: false; reason: string }> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(tx)) return { ok: false, reason: "not a transaction hash" };
  const r = await receipt(tx);
  if (!r) return { ok: false, reason: "transaction not found on Base Sepolia" };
  if (r.status !== "success") return { ok: false, reason: "transaction reverted" };
  const block = await pub.getBlock({ blockNumber: r.blockNumber });
  if (Number(block.timestamp) * 1000 < notBefore.getTime() - 60_000) return { ok: false, reason: "transaction is older than the quote" };
  const pool = poolAddress().toLowerCase();
  const logs = parseEventLogs({ abi: ABI, logs: r.logs.filter((l) => l.address.toLowerCase() === USDC.toLowerCase()), eventName: "Transfer" });
  const hit = logs.find((l) => l.args.to.toLowerCase() === pool && l.args.value >= units);
  if (!hit) return { ok: false, reason: `no USDC transfer of at least ${Number(units) / 1e6} to the pool in this transaction` };
  return { ok: true, from: hit.args.from };
}
