import type { Hex } from "viem";
import { validateCase, type Case, type Doc } from "./case";
import { callDolphin } from "./dolphin";
import { ledger, loadRequest, newId, save, saveRequest } from "./store";
import { readUnderwriting, underwrite, type Step, RATING_GUIDE_HASH } from "./underwrite";
import { judgeClaim, readJudgment } from "./claims";
import { combine, PERILS, price, RULES } from "./pricing";
import { EXPLORER, payout, poolAddress, poolUsd, SCALE, toUnits, verifyPremium } from "./chain";

const activeCover = () => Object.values(ledger().bonds).filter((b: any) => b.status === "active").reduce((s: number, b: any) => s + b.coverUsd, 0);

export async function poolStatus() {
  const capital = await poolUsd();
  const l = ledger();
  const bonds = Object.values(l.bonds) as any[];
  const claims = Object.values(l.claims) as any[];
  const premiums = bonds.reduce((s, b) => s + b.premiumUsd, 0);
  const paid = claims.filter((c) => c.decision === "pay").reduce((s, c) => s + c.payoutUsd, 0);
  return {
    address: poolAddress(), explorer: `${EXPLORER}/address/${poolAddress()}`, scale: SCALE,
    capitalUsd: capital, reservedUsd: activeCover(), freeUsd: capital - activeCover(),
    quotes: Object.keys(l.quotes).length, declined: Object.values(l.quotes).filter((q: any) => q.decision === "decline").length,
    bonds: bonds.length, premiumsUsd: premiums, claims: claims.length, paidUsd: paid, lossRatio: premiums ? paid / premiums : null,
    rules: RULES, ratingGuideHash: RATING_GUIDE_HASH,
  };
}

export async function quote(c: Case, step?: Step) {
  const bad = validateCase(c);
  if (bad) throw new Error(bad);
  const freeCapitalUsd = (await poolUsd()) - activeCover();
  const r = await underwrite(c, freeCapitalUsd, step);
  saveRequest(r.dolphin.requestHash, r.body);
  const { body, ...rest } = r;
  const now = new Date();
  const q = {
    id: newId("q"), createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + RULES.quoteTtlMinutes * 60_000).toISOString(),
    case: c, freeCapitalUsd, ...rest,
    payment: r.decision === "insure" ? { to: poolAddress(), token: "USDC (Base Sepolia)", units: toUnits(r.premiumUsd).toString(), amount: Number(toUnits(r.premiumUsd)) / 1e6 } : null,
  };
  ledger().quotes[q.id] = q;
  save();
  return q;
}

export async function bind(quoteId: string, tx: Hex, beneficiary?: Hex) {
  const l = ledger();
  const q = l.quotes[quoteId];
  if (!q) throw new Error("unknown quote");
  if (q.decision !== "insure") throw new Error("this action was declined: it cannot be bonded");
  if (Date.now() > Date.parse(q.expiresAt)) throw new Error("quote expired: request a new one");
  if (Object.values(l.bonds).some((b: any) => b.quoteId === quoteId)) throw new Error("quote already bound");
  if (l.usedTx.includes(tx.toLowerCase())) throw new Error("this premium transaction was already used");
  if (q.case.coverUsd > (await poolUsd()) - activeCover()) throw new Error("pool capacity changed: request a new quote");
  const v = await verifyPremium(tx, BigInt(q.payment.units), new Date(q.createdAt));
  if (!v.ok) throw new Error(`premium not accepted: ${v.reason}`);
  if (beneficiary && !/^0x[0-9a-fA-F]{40}$/.test(beneficiary)) throw new Error("beneficiary must be an address");
  const b = {
    id: newId("bond"), quoteId, boundAt: new Date().toISOString(), coverUsd: q.case.coverUsd, premiumUsd: q.premiumUsd,
    premiumTx: tx, premiumTxUrl: `${EXPLORER}/tx/${tx}`, beneficiary: beneficiary ?? v.from, action: q.case.action, insured: q.case.insured,
    status: "active", claims: [] as string[],
  };
  l.usedTx.push(tx.toLowerCase());
  l.bonds[b.id] = b;
  save();
  return b;
}

let payQueue: Promise<unknown> = Promise.resolve();
/** One payout at a time: a single pool key, so transfers never race for a nonce. */
const serial = <T,>(work: () => Promise<T>) => { const next = payQueue.then(work, work); payQueue = next.catch(() => undefined); return next; };

export async function claim(bondId: string, statement: string, evidence: Doc[], step?: Step) {
  const l = ledger();
  const b = l.bonds[bondId];
  if (!b) throw new Error("unknown bond");
  if (b.status === "paid") throw new Error("this bond has already paid out");
  if (b.claims.length >= 2) throw new Error("this bond has no claims left");
  if (Date.now() - Date.parse(b.boundAt) > RULES.claimWindowDays * 86_400_000) throw new Error("claim window closed");
  if (!evidence?.length || evidence.length > 20) throw new Error("send 1 to 20 evidence documents");
  if (typeof statement !== "string" || !statement.trim()) throw new Error("a claim statement is required");
  const q = l.quotes[b.quoteId];
  const r = await judgeClaim(b, q, q.case, statement, evidence, step);
  saveRequest(r.dolphin.requestHash, r.body);
  const { body, ...rest } = r;
  const c: any = { id: newId("claim"), bondId, filedAt: new Date().toISOString(), statement, evidence, ...rest, payoutTx: null };
  if (r.decision === "pay") {
    step?.("payout", { usd: r.payoutUsd });
    const tx = await serial(() => payout(b.beneficiary, toUnits(r.payoutUsd)));
    c.payoutTx = tx;
    c.payoutTxUrl = `${EXPLORER}/tx/${tx}`;
    b.status = "paid";
  }
  b.claims.push(c.id);
  l.claims[c.id] = c;
  save();
  return c;
}

/** Re-run a stored decision on the same open weights, byte-identical request, and compare. */
export async function recheck(id: string) {
  const l = ledger();
  const q = l.quotes[id], c = l.claims[id];
  const rec = q ?? c;
  if (!rec) throw new Error("unknown quote or claim");
  const body = loadRequest(rec.dolphin.requestHash);
  if (!body) throw new Error("stored request not found");
  const run = await callDolphin(body);
  if (q) {
    const uw = readUnderwriting(run.content);
    const pLoss = combine(Object.fromEntries(PERILS.map((k) => [k, uw.perils[k].p])));
    const p = price(q.case.coverUsd, pLoss, q.freeCapitalUsd);
    const original = q.serv.verdict === "agree" ? q.decision : "decline"; // compare the model's price decision, before SERV's veto
    const priced = price(q.case.coverUsd, q.pLoss, q.freeCapitalUsd).decision;
    return { id, kind: "quote", requestHash: rec.dolphin.requestHash, fingerprint: run.fingerprint, originalFingerprint: q.dolphin.fingerprint, original: { pLoss: q.pLoss, decision: priced, final: original }, rerun: { pLoss, decision: p.decision }, sameDecision: p.decision === priced, pLossDelta: pLoss - q.pLoss, latencyMs: run.latencyMs };
  }
  const j = readJudgment(run.content);
  return { id, kind: "claim", requestHash: rec.dolphin.requestHash, fingerprint: run.fingerprint, originalFingerprint: c.dolphin.fingerprint, original: { decision: c.judgment.decision, peril: c.judgment.peril }, rerun: { decision: j.decision, peril: j.peril }, sameDecision: j.decision === c.judgment.decision, latencyMs: run.latencyMs };
}

/** Public view: images are dropped (they can be large); everything else is shown. */
export function publicView(x: any) {
  const strip = (docs: Doc[]) => docs?.map((d) => ({ ...d, image: d.image && !d.image.startsWith("data:") ? d.image : d.image ? "(inline image)" : undefined }));
  if (!x) return x;
  const y = structuredClone(x);
  if (y.case) y.case.docs = strip(y.case.docs);
  if (y.evidence) y.evidence = strip(y.evidence);
  return y;
}
