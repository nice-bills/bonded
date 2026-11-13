/**
 * Long vendor history for the demo cases: about two years of invoices, line items,
 * payments and prior email threads for the three contractors Payrun pays, as the
 * insured's own records. Deterministic (seeded PRNG), so every run sees the same
 * file and a re-check on the same weights sees the same request.
 *
 * It is a superset of the 6 rows that used to be quoted directly in cases.ts:
 * the recent rows (kwame INV-0924/0926/0928, ama INV-2204/2206, efua INV-0117)
 * are anchors and appear verbatim, so duplicate/overbilling judgements are made
 * against the full history, not a 6-row excerpt.
 */
import type { Doc } from "../src/case";

const KWAME_WALLET = "0x5a3B9e0C1f2d4E6a7B8c9D0e1F2a3b4C5d6E7f81";
const AMA_WALLET = "0x7cE21b0A9d8F3e4C5b6A7d8E9f0A1b2C3d4E5f62";
const EFUA_WALLET = "0x3D4e5F6a7B8c9D0e1F2a3B4c5D6e7F8a9B0c1D23";

const LAST_HISTORY_MONTH = "2026-09"; // the month before every demo invoice

interface VendorSpec {
  id: string;
  name: string;
  email: string;
  wallet: string;
  rate: number;
  cap: number;
  /** First month with an invoice (the `since` date in vendor-records.csv). */
  firstMonth: string;
  /** Invoice number of the LAST_HISTORY_MONTH invoice; earlier months step back by 2. */
  lastInvoiceNo: number;
  tasks: string[];
  /** Fixed rows that must match payment-history.csv exactly: month -> [days, work, paidOn]. */
  fixed: Record<string, [days: number, work: string, paidOn: string]>;
}

const VENDOR_SPECS: VendorSpec[] = [
  {
    id: "kwame", name: "Kwame Mensah", email: "kwame@mensah.dev", wallet: KWAME_WALLET,
    rate: 300, cap: 10, firstMonth: "2025-03", lastInvoiceNo: 928,
    tasks: ["Payments API webhooks", "Postgres migration", "Rate limiter service", "Background jobs", "Cache layer", "Payments API"],
    fixed: { "2026-07": [8, "Rate limiter service", "2026-08-04"], "2026-08": [7, "Postgres migration", "2026-09-03"], "2026-09": [5, "Payments API webhooks (phase 1)", "2026-10-02"] },
  },
  {
    id: "ama", name: "Ama Owusu", email: "ama@owusu.studio", wallet: AMA_WALLET,
    rate: 400, cap: 8, firstMonth: "2024-11", lastInvoiceNo: 2206,
    tasks: ["Onboarding flow redesign", "Design system tokens", "Checkout screens", "Marketing site refresh", "Icon set"],
    fixed: { "2026-08": [7, "Design system tokens", "2026-09-01"], "2026-09": [8, "Checkout screens", "2026-10-01"] },
  },
  {
    id: "efua", name: "Efua Asante", email: "efua@asante.write", wallet: EFUA_WALLET,
    rate: 150, cap: 8, firstMonth: "2025-06", lastInvoiceNo: 117,
    tasks: ["Help-centre articles", "Release notes", "Blog posts", "API docs", "Changelog"],
    fixed: { "2026-09": [5, "Help-centre articles", "2026-10-06"] },
  },
];

/** Small deterministic PRNG (same family as backtest/payrun-cases.ts). */
function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32);
}
const r = rng(11);
const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
const money = (n: number) => n.toFixed(2); // no thousands separators: this goes into CSV fields

const monthId = (m: string) => { const [y, mo] = m.split("-").map(Number); return y * 12 + mo - 1; };
const monthStr = (id: number) => `${Math.floor(id / 12)}-${String((id % 12) + 1).padStart(2, "0")}`;
const monthEnd = (m: string) => { const [y, mo] = m.split("-").map(Number); return `${y}-${String(mo).padStart(2, "0")}-${new Date(y, mo, 0).getDate()}`; };
const addDays = (iso: string, d: number) => { const t = new Date(iso + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + d); return t.toISOString().slice(0, 10); };
const invoiceNo = (v: VendorSpec, m: string) => "INV-" + String(v.lastInvoiceNo - 2 * (monthId(LAST_HISTORY_MONTH) - monthId(m))).padStart(4, "0");
const tx = () => `0x${[...Array(4)].map(() => "0123456789abcdef"[int(0, 15)]).join("")}…${[...Array(4)].map(() => "0123456789abcdef"[int(0, 15)]).join("")}`;

interface Line { date: string; vendor: string; invoice: string; period: string; work: string; days: number; amountUsd: number; status: string }

/** One row per line item; a 1-item invoice appears once, a 3-item invoice three times. */
const lines: Line[] = [];
const payments: { date: string; vendor: string; invoice: string; amountUsd: number; paidTo: string; tx: string }[] = [];
const voided: { invoice: string; vendor: string; replacedBy: string; date: string }[] = [];

for (const v of VENDOR_SPECS) {
  const start = monthId(v.firstMonth), end = monthId(LAST_HISTORY_MONTH);
  for (let m = start; m <= end; m++) {
    const month = monthStr(m);
    const inv = invoiceNo(v, month);
    // A contractor on holiday or with no booked work skips a month (~1 in 12, never the fixed months).
    if (!v.fixed[month] && r() < 0.08) continue;
    const [days, work] = v.fixed[month] ?? [int(3, v.cap), ""];
    const total = days * v.rate;
    const date = addDays(monthEnd(month), -int(1, 4)); // issued a day or two before period end
    // Split into 1-3 line items inside the same invoice (the split always sums to the total).
    const parts: [string, number][] = [];
    if (work) {
      parts.push([work, days]);
    } else {
      const n = days >= 7 ? 3 : days >= 3 ? 2 : 1;
      const base = Math.floor(days / n), rem = days % n;
      const first = pick(v.tasks);
      for (let i = 0; i < n; i++) {
        const d = base + (i < rem ? 1 : 0);
        if (i === 0) parts.push([first, d]);
        else { const t = pick(v.tasks); parts.push([t === first ? `${first} (cont.)` : t, d]); }
      }
    }
    for (const [w, d] of parts) lines.push({ date, vendor: v.id, invoice: inv, period: month, work: w, days: d, amountUsd: d * v.rate, status: "issued" });
    payments.push({ date: v.fixed[month]?.[2] ?? addDays(monthEnd(month), int(4, 12)), vendor: v.id, invoice: inv, amountUsd: total, paidTo: v.wallet, tx: tx() });
    // Occasionally the first draft was voided and reissued under the next number (the gap in the series).
    if (!v.fixed[month] && r() < 0.06) {
      const bad = "INV-" + String(Number(inv.slice(4)) - 1).padStart(4, "0");
      lines.push({ date: addDays(date, -1), vendor: v.id, invoice: bad, period: month, work: "draft issued in error", days: 0, amountUsd: 0, status: "voided" });
      voided.push({ invoice: bad, vendor: v.id, replacedBy: inv, date: addDays(date, -1) });
    }
  }
}

const invoiceLedger: Doc = {
  name: "vendor-invoice-ledger.csv",
  source: "records",
  text: `# Every invoice line item Payrun has received since each vendor's start date. status=voided rows were never paid.
date_issued,vendor,invoice,period,work,days,amount_usd,status
${lines.map((l) => `${l.date},${l.vendor},${l.invoice},${l.period},${l.work},${l.days},${money(l.amountUsd)},${l.status}`).join("\n")}`,
};

const paymentLedger: Doc = {
  name: "vendor-payment-ledger.csv",
  source: "records",
  text: `# Every payment Payrun has made to these vendors (USDC on Base). One row per settled invoice.
date,vendor,invoice,amount_usd,paid_to,tx
${payments.map((p) => `${p.date},${p.vendor},${p.invoice},${money(p.amountUsd)},${p.paidTo},${p.tx}`).join("\n")}`,
};

/** Prior email threads from the insured's own mailbox (Payrun's inbox export). */
const EMAILS: string[] = [
  `From: Kwame Mensah <kwame@mensah.dev>
Date: 2025-03-01
Subject: Welcome / start date

Hi Payrun team, excited to start on the backend work this month. Contract signed: $300/day, up to 10 days a month, payments API + database + infra. My wallet for payouts is ${KWAME_WALLET} — please use that one for every invoice. Kwame`,
  `From: Kwame Mensah <kwame@mensah.dev>
Date: 2025-08-14
Subject: Duplicate invoice — please ignore INV-0903

Sorry, I sent INV-0903 twice by mistake last night (same file, same period). Please disregard the first copy; INV-0904 is the correct one for August. Kwame`,
  `From: Kwame Mensah <kwame@mensah.dev>
Date: 2026-08-20
Subject: Wallet check-in

Routine check: my payout wallet is still ${KWAME_WALLET} (unchanged since we started in March 2025). If you ever get an email asking to change it, please call me on the number on file. Kwame`,
  `From: Kwame Mensah <kwame@mensah.dev>
Date: 2026-08-25
Subject: Webhooks phase 1 in September

Plan for next month: build the webhook sender for the payments API (phase 1) — delivery, retries skeleton, logging. Phase 2 (retries + request signing) would follow in October if phase 1 lands well. Kwame`,
  `From: Kwame Mensah <kwame@mensah.dev>
Date: 2026-09-29
Subject: Phase 1 done, phase 2 next

Phase 1 shipped. For October I'd continue with phase 2: retry queue with backoff and request signing — same payments API scope, same rate. I'll send INV-0931 at the start of November. Kwame`,
  `From: Ama Owusu <ama@owusu.studio>
Date: 2024-11-15
Subject: Contractor agreement signed

Hi! Signing today — $400/day, up to 8 days/month, product design (onboarding, design system, checkout). First invoice will cover the second half of November. Wallet on file: ${AMA_WALLET}. Ama`,
  `From: Ama Owusu <ama@owusu.studio>
Date: 2025-09-02
Subject: Reduced days in September

I'm travelling for a conference most of September, so only a few days of design work this month — invoice will be smaller than usual. Ama`,
  `From: Ama Owusu <ama@owusu.studio>
Date: 2026-02-10
Subject: Design tokens licence

Quick note: the tokens I ship are yours to use, no extra licence fee — I only bill days. Ama`,
  `From: Ama Owusu <ama@owusu.studio>
Date: 2026-09-28
Subject: Wallet still the same

Heads up: I've seen scam emails going around studios pretending to be contractors with "new wallets". To be clear: my only wallet is ${AMA_WALLET}, on file since November 2024. I will never ask you to change it by email alone — any real change needs the signed form and a call-back. Ama`,
  `From: Ama Owusu <ama@owusu.studio>
Date: 2026-10-19
Subject: Onboarding redesign — October

Continuing the onboarding flow redesign through October, roughly 6 days. Invoice INV-2207 to follow at month end. Ama`,
  `From: Efua Asante <efua@asante.write>
Date: 2025-06-01
Subject: Starting on content

Delighted to start. $150/day, up to 8 days a month: release notes, help-centre articles, blog posts. Payout wallet ${EFUA_WALLET}. Efua`,
  `From: Efua Asante <efua@asante.write>
Date: 2025-11-06
Subject: December content calendar

Drafting the December calendar now — release notes plus two help-centre deep dives. Efua`,
  `From: Efua Asante <efua@asante.write>
Date: 2026-06-11
Subject: Wallet unchanged

Confirming my payout wallet is still ${EFUA_WALLET} (same since I started). Efua`,
  `From: Efua Asante <efua@asante.write>
Date: 2026-09-15
Subject: October plan

October: blog posts (about 6 days). Will invoice INV-0118 as usual at month end. Efua`,
];
// Interleave routine "invoice sent" notes so the mailbox reads like 2 years of traffic.
for (const v of VENDOR_SPECS) {
  const months = lines.filter((l) => l.vendor === v.id && l.status === "issued").map((l) => l.period);
  for (const m of [...new Set(months)]) {
    if (r() < 0.35) {
      const inv = invoiceNo(v, m);
      EMAILS.push(`From: ${v.name} <${v.email}>\nDate: ${addDays(monthEnd(m), int(-2, 2))}\nSubject: Invoice ${inv} sent\n\nMonthly invoice ${inv} for ${m} is in your inbox. Same wallet as always. ${v.name.split(" ")[0]}`);
    }
  }
}
// Sort by Date: line so the export reads chronologically.
EMAILS.sort((a, b) => (/Date: (\S+)/.exec(a)?.[1] ?? "").localeCompare(/Date: (\S+)/.exec(b)?.[1] ?? ""));

const mailbox: Doc = {
  name: "vendor-mailbox-export.txt",
  source: "records",
  text: `# Payrun's inbox export: every email from the three contractors, ${EMAILS[0] ? (/Date: (\S+)/.exec(EMAILS[0])?.[1] ?? "2024-11") : "2024-11"} to 2026-11-04.\n\n${EMAILS.join("\n\n")}`,
};

export const LONG_HISTORY_DOCS: Doc[] = [invoiceLedger, paymentLedger, mailbox];
export const LONG_HISTORY_ROW_COUNT = lines.length + payments.length + EMAILS.length;
