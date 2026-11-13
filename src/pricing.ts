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
  // Underwriting panel (two open models on the same rating guide and documents).
  panel: {
    /** Combined p(loss) differs from a model's p(loss) by more than this → extra loading. */
    disagreeDelta: 0.05,
    /** Extra premium loading while the panel disagrees (charged on top of `loading`). */
    disagreementLoading: 0.25,
  },
};

export const clamp = (p: number) => (Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : 1);

/** p(any peril) assuming independence: 1 - product of (1 - p_i). */
export function combine(perils: Partial<Record<Peril, number>>): number {
  let survive = 1;
  for (const k of PERILS) survive = survive * (1 - clamp(perils[k] ?? 0));
  return 1 - survive;
}

export type PerilMap = Record<Peril, number>;

/**
 * Panel combination: per peril, take the HIGHER of the two models' probabilities
 * (conservative: a peril either model is worried about stays priced in).
 */
export function combinePanel(perilsList: Partial<PerilMap>[]): PerilMap {
  const out = {} as PerilMap;
  for (const k of PERILS) out[k] = clamp(Math.max(...perilsList.map((m) => m[k] ?? 0)));
  return out;
}

export interface PanelVerdict {
  /** Per-model p(loss), in the order the models were run. */
  pLossList: number[];
  /** Combined (per-peril max) p(loss) the premium is priced on. */
  pLoss: number;
  /** Extra premium loading because the models disagree. */
  disagreementLoading: number;
  /** True when one model calls it insurable (≤ declineAbove) and the other does not. */
  conflict: boolean;
}

/**
 * Turn two or more per-model p(loss) numbers into the panel verdict:
 * an insurability conflict vetoes the action; a smaller disagreement adds
 * an extra loading to the premium instead of pretending the models agree.
 */
export function panelVerdict(perilsList: Partial<PerilMap>[]): PanelVerdict {
  const perils = combinePanel(perilsList);
  const pLossList = perilsList.map((m) => combine(m));
  const insurable = pLossList.map((p) => p <= RULES.declineAbove);
  const conflict = insurable.some((x) => x) && insurable.some((x) => !x);
  const delta = pLossList.length >= 2 ? Math.abs(Math.max(...pLossList) - Math.min(...pLossList)) : 0;
  const disagreementLoading = !conflict && delta > RULES.panel.disagreeDelta ? RULES.panel.disagreementLoading : 0;
  return { pLossList, pLoss: combine(perils), disagreementLoading, conflict };
}

export interface Price {
  pLoss: number;
  premiumUsd: number;
  decision: "insure" | "decline";
  reason: string | null;
}

/** freeCapitalUsd: pool balance minus the cover of every active bond (fully reserved pool).
 *  extraLoading: added on top of RULES.loading (the panel's disagreement loading). */
export function price(coverUsd: number, pLoss: number, freeCapitalUsd: number, extraLoading = 0): Price {
  const p = clamp(pLoss);
  const premiumUsd = round2(Math.max(RULES.minPremiumUsd, coverUsd * p * (1 + RULES.loading + Math.max(0, extraLoading))));
  if (!(coverUsd > 0)) return { pLoss: p, premiumUsd: 0, decision: "decline", reason: "Cover must be above zero." };
  if (p > RULES.declineAbove) return { pLoss: p, premiumUsd, decision: "decline", reason: `Estimated chance of loss ${pct(p)} is above the ${pct(RULES.declineAbove)} limit: uninsurable, do not act.` };
  if (coverUsd > freeCapitalUsd * RULES.maxShareOfFreeCapital) return { pLoss: p, premiumUsd, decision: "decline", reason: `Cover $${coverUsd} is above ${pct(RULES.maxShareOfFreeCapital)} of the pool's free capital ($${round2(freeCapitalUsd)}).` };
  return { pLoss: p, premiumUsd, decision: "insure", reason: null };
}

export const round2 = (n: number) => Math.round(n * 100) / 100;
export const pct = (p: number) => `${(p * 100).toFixed(p < 0.01 ? 2 : 1)}%`;

/** Brier score of probability forecasts against 0/1 outcomes (lower is better). */
export const brier = (ps: number[], ys: number[]) => ps.reduce((s, p, i) => s + (p - ys[i]) ** 2, 0) / ps.length;

export interface InvoiceLine { qty: number; rate: number; amount: number }
export interface InvoiceFigures { lines: InvoiceLine[]; total: number | null }

/** Recompute the invoice in code: qty × rate per line, and the lines against the stated total.
 *  The model only reads the numbers off the documents; it never does the multiplication. */
export function checkArithmetic(inv: InvoiceFigures | null | undefined): string | null {
  if (!inv || !inv.lines.length) return null;
  const bad: string[] = [];
  for (const l of inv.lines) if (Math.abs(l.qty * l.rate - l.amount) > 0.01) bad.push(`${l.qty} × ${l.rate} is ${round2(l.qty * l.rate)}, not ${l.amount}`);
  const sum = round2(inv.lines.reduce((s, l) => s + l.amount, 0));
  if (inv.total != null && Math.abs(sum - inv.total) > 0.01) bad.push(`lines add up to ${sum}, not the stated total ${inv.total}`);
  return bad.length ? `Code check: ${bad.join("; ")}.` : null;
}
