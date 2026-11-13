/** Bonded's money rules. The model estimates probabilities; only this code turns them into prices. */
export const PERILS = ["payee_not_vendor", "duplicate", "overbilling", "unauthorized", "tampered"] as const;
export type Peril = (typeof PERILS)[number];

export const RULES = {
  /** Above this estimated chance of loss the action is uninsurable, so the agent must not act. */
  declineAbove: 0.1,
  /** Premium = cover × p(loss) × (1 + loading), never below the minimum. */
  loading: 0.4,
  minPremiumUsd: 0.5,
  /** One bond may use at most this share of the pool's free capital. */
  maxShareOfFreeCapital: 0.25,
  quoteTtlMinutes: 30,
  claimWindowDays: 30,
};

export const clamp = (p: number) => (Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : 1);

/** p(any peril) assuming independence: 1 - product of (1 - p_i). */
export function combine(perils: Partial<Record<Peril, number>>): number {
  let survive = 1;
  for (const k of PERILS) survive = survive * (1 - clamp(perils[k] ?? 0));
  return 1 - survive;
}

export interface Price {
  pLoss: number;
  premiumUsd: number;
  decision: "insure" | "decline";
  reason: string | null;
}

/** freeCapitalUsd: pool balance minus the cover of every active bond (fully reserved pool). */
export function price(coverUsd: number, pLoss: number, freeCapitalUsd: number): Price {
  const p = clamp(pLoss);
  const premiumUsd = round2(Math.max(RULES.minPremiumUsd, coverUsd * p * (1 + RULES.loading)));
  if (!(coverUsd > 0)) return { pLoss: p, premiumUsd: 0, decision: "decline", reason: "Cover must be above zero." };
  if (p > RULES.declineAbove) return { pLoss: p, premiumUsd, decision: "decline", reason: `Estimated chance of loss ${pct(p)} is above the ${pct(RULES.declineAbove)} limit: uninsurable, do not act.` };
  if (coverUsd > freeCapitalUsd * RULES.maxShareOfFreeCapital) return { pLoss: p, premiumUsd, decision: "decline", reason: `Cover $${coverUsd} is above ${pct(RULES.maxShareOfFreeCapital)} of the pool's free capital ($${round2(freeCapitalUsd)}).` };
  return { pLoss: p, premiumUsd, decision: "insure", reason: null };
}

export const round2 = (n: number) => Math.round(n * 100) / 100;
export const pct = (p: number) => `${(p * 100).toFixed(p < 0.01 ? 2 : 1)}%`;

/** Brier score of probability forecasts against 0/1 outcomes (lower is better). */
export const brier = (ps: number[], ys: number[]) => ps.reduce((s, p, i) => s + (p - ys[i]) ** 2, 0) / ps.length;
