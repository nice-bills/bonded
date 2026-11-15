#!/usr/bin/env node
'use strict';
// Screen capture of the Bonded live demo, driven by Playwright + CDP screencast.
//   node capture.cjs probe [dir]   non-mutating machinery test against the live site
//   node capture.cjs mock  [dir]   full take, but every mutating API call is faked in-page (nothing reaches the server)
//   node capture.cjs real  [dir]   THE real take (default dir take1). Budgeted, persisted in budget.json.
// env: HOLD_SCALE (default 1) scales hold durations (for rehearsals), DPR (default 2).
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const MODE = process.argv[2] || 'probe';
if (!['probe', 'mock', 'real'].includes(MODE)) { console.error('mode must be probe|mock|real'); process.exit(2); }
const OUT = path.join(__dirname, process.argv[3] || { probe: 'probe', mock: 'mock', real: 'take1' }[MODE]);
const SITE = 'https://bonded-pool.onrender.com/';
const HS = parseFloat(process.env.HOLD_SCALE || '1');
const VW = 1280, VH = 720, DPR = parseFloat(process.env.DPR || '2');
const CAPS = { quote: 8, pay: 3, file: 4, recheck: 4 };
const BUDGET_FILE = path.join(__dirname, 'budget.json');
const MARGIN_R = 1240, MARGIN_L = 32;
const HERO_PARK = [1012, 112]; // blank band right of the headline, above the KPI row

if (MODE === 'real' && fs.existsSync(path.join(OUT, 'frames.json')) && !process.argv.includes('--force')) {
  console.error(`${OUT} already holds a take; refusing to overwrite (pass --force)`); process.exit(2);
}
fs.mkdirSync(path.join(OUT, 'frames'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'stills'), { recursive: true });

// ---------------------------------------------------------------- budget
let budget = { quote: 0, pay: 0, file: 0, recheck: 0 };
if (MODE === 'real' && fs.existsSync(BUDGET_FILE)) budget = JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8'));
const used = { quote: 0, pay: 0, file: 0, recheck: 0 }; // this run
function spend(kind) {
  if (MODE === 'probe') throw new Error('mutating click attempted in probe mode: ' + kind);
  if (budget[kind] + 1 > CAPS[kind]) throw new Error(`budget exhausted for ${kind} (${budget[kind]}/${CAPS[kind]})`);
  budget[kind]++; used[kind]++;
  if (MODE === 'real') fs.writeFileSync(BUDGET_FILE, JSON.stringify(budget));
}

// ---------------------------------------------------------------- clock + logs
let perf0 = null;
const now = () => (perf0 === null ? -1 : (performance.now() - perf0) / 1000);
const r3 = (x) => Math.round(x * 1000) / 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const events = [], holds = [], frames = [];
const facts = { mode: MODE, site: SITE, quotes: [], bond: null, claims: [], rechecks: [], clicks: used, caps: CAPS, notes: [] };
let frameMeta = { width: null, height: null };
let endT = null;
function log(ev) {
  const e = { name: ev.name, t: r3(ev.t ?? now()), ...ev }; e.t = r3(ev.t ?? e.t);
  events.push(e);
  const { name, t, rects, ...rest } = e;
  console.log(`[${t.toFixed(2).padStart(8)}] ${name} ${JSON.stringify(rest).slice(0, 220)}`);
  return e;
}
function note(s) { facts.notes.push(`[${now().toFixed(1)}s] ${s}`); log({ name: 'note', text: s }); }
function flush() {
  const tmp = (f, o) => { fs.writeFileSync(f + '.tmp', JSON.stringify(o)); fs.renameSync(f + '.tmp', f); };
  tmp(path.join(OUT, 'frames.json'), { width: frameMeta.width, height: frameMeta.height, dpr: DPR, viewport: [VW, VH], duration: r3(endT ?? now()), frames });
  tmp(path.join(OUT, 'events.json'), { events, holds, facts });
}

// ---------------------------------------------------------------- in-page init script (cursor, observers, mock)
function initScript(cfg) {
  if (window.top !== window) return;
  const send = (o) => { try { window.__capEvent && window.__capEvent(o); } catch (e) {} };

  // ---- fake cursor (popover=manual so it can sit above a modal <dialog> in the top layer)
  const S = { x: cfg.x0, y: cfg.y0 };
  try { const s = JSON.parse(sessionStorage.getItem('__curpos') || 'null'); if (s) { S.x = s.x; S.y = s.y; } } catch (e) {}
  let el = null, ring = null;
  const place = () => { if (el) el.style.transform = `translate(${S.x.toFixed(2)}px,${S.y.toFixed(2)}px)`; };
  function build() {
    if (el || !document.documentElement) return;
    el = document.createElement('div');
    el.id = '__cur';
    el.setAttribute('popover', 'manual');
    el.setAttribute('aria-hidden', 'true');
    el.style.cssText = 'position:fixed;inset:auto;left:0;top:0;right:auto;bottom:auto;margin:0;border:0;padding:0;background:transparent;overflow:visible;width:0;height:0;pointer-events:none;z-index:2147483647;will-change:transform;color:inherit';
    el.innerHTML =
      '<div id="__ring" style="position:absolute;left:-9px;top:-9px;width:18px;height:18px;box-sizing:border-box;border-radius:50%;border:2px solid rgba(17,17,17,.62);box-shadow:0 0 0 1px rgba(255,255,255,.55),inset 0 0 0 1px rgba(255,255,255,.35);opacity:0;pointer-events:none"></div>' +
      '<svg width="30" height="34" viewBox="-3 -3 30 34" style="position:absolute;left:-3px;top:-3px;overflow:visible;pointer-events:none;filter:drop-shadow(0 1.5px 2.2px rgba(0,0,0,.38))">' +
      '<g transform="scale(1.1)"><path d="M0 0 L0 16.6 L3.9 12.95 L6.75 19.6 L9.35 18.5 L6.5 11.95 L11.9 11.95 Z" fill="#000" stroke="#fff" stroke-width="1.9" stroke-linejoin="round"/></g></svg>';
    document.documentElement.appendChild(el);
    ring = el.firstChild;
    try { el.showPopover(); } catch (e) {}
    place();
  }
  const ripple = () => { if (ring) ring.animate([{ transform: 'scale(.35)', opacity: 0.85 }, { transform: 'scale(2.6)', opacity: 0 }], { duration: 350, easing: 'cubic-bezier(.2,.6,.3,1)' }); };
  window.__cur = {
    pos: () => ({ x: S.x, y: S.y }),
    set(x, y) { S.x = x; S.y = y; place(); },
    top() { build(); try { el.hidePopover(); el.showPopover(); } catch (e) {} place(); },
    glide(x, y, dur) {
      build();
      return new Promise((res) => {
        const x0 = S.x, y0 = S.y, dx = x - x0, dy = y - y0, dist = Math.hypot(dx, dy);
        if (dist < 0.5) return res();
        const bow = Math.min(14, dist * 0.035), nx = -dy / dist, ny = dx / dist;
        let t0 = null;
        const step = (ts) => {
          if (t0 === null) t0 = ts;
          const k = Math.min(1, (ts - t0) / dur);
          const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
          const b = Math.sin(Math.PI * e) * bow;
          S.x = x0 + dx * e + nx * b; S.y = y0 + dy * e + ny * b; place();
          if (k < 1) requestAnimationFrame(step);
          else { try { sessionStorage.setItem('__curpos', JSON.stringify(S)); } catch (e2) {} res(); }
        };
        requestAnimationFrame(step);
      });
    },
  };
  document.addEventListener('mousedown', ripple, true);
  if (document.documentElement) build();
  document.addEventListener('DOMContentLoaded', build);
  new MutationObserver(() => { build(); }).observe(document, { childList: true });

  const sm = HTMLDialogElement.prototype.showModal;
  HTMLDialogElement.prototype.showModal = function () {
    const r = sm.apply(this, arguments);
    try { window.__cur.top(); } catch (e) {}
    send({ name: 'dialog-open', title: (this.querySelector('h2') || {}).textContent || '' });
    this.addEventListener('close', () => send({ name: 'dialog-close' }), { once: true });
    return r;
  };

  // ---- DOM observations pushed to Node the moment they happen
  new MutationObserver((muts) => {
    for (const m of muts) for (const n of m.addedNodes) {
      if (n.nodeType !== 1 || n.id === '__cur') continue;
      if (n.matches('ul.steps li')) { send({ name: 'step', where: n.closest('#claimout') ? 'claim' : 'quote', index: [...n.parentNode.children].indexOf(n), text: n.textContent }); continue; }
      const has = (sel) => (n.matches(sel) ? n : n.querySelector(sel));
      let x;
      if ((x = has('#vword'))) send({ name: 'dom-vword', text: x.textContent });
      if ((x = has('#cword'))) send({ name: 'dom-cword', text: x.textContent });
      if ((x = has('#retry'))) send({ name: 'dom-quote-error', text: ((document.querySelector('#slip .note.bad') || {}).textContent || '') });
      if (n.matches('.sc') && n.parentNode && n.parentNode.id === 'slip' && n.textContent.startsWith('bond certificate')) send({ name: 'dom-bond', text: n.textContent });
      if (n.matches('.note') && n.parentNode && (n.parentNode.id === 'after' || n.parentNode.id === 'afterClaim' || n.parentNode.id === 'claimout')) send({ name: 'dom-note', where: n.parentNode.id, cls: n.className, text: n.textContent });
    }
  }).observe(document, { childList: true, subtree: true });

  let scT = 0, scLast = null;
  window.addEventListener('scroll', () => { clearTimeout(scT); scT = setTimeout(() => { const y = Math.round(window.scrollY); if (y !== scLast) { scLast = y; send({ name: 'scroll-observed', scrollY: y }); } }, 140); }, { passive: true });

  // ---- geometry for the compositor
  window.__capRects = () => {
    const R = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return [b.x, b.y, b.width, b.height].map((v) => Math.round(v * 10) / 10); };
    const q = (s) => document.querySelector(s), qa = (s) => [...document.querySelectorAll(s)];
    const out = {};
    const single = ['nav', '.hero h1', '.kpis', '#tabs', '#casecard', 'img.inv', '.docs', '#slip', '.verdict', '#vword', '#prem', '#slip table', '#slip .notes', '#payBtn', '#reBtn', '#quoteBtn', '#after', '#sig', '#claims', '#claimout', '#cword', '#claimout table', '#reClaim', '#afterClaim', '#backtest', '#bt', '#ledger', '#mark', '#slip ul.steps', '#claimout ul.steps'];
    for (const s of single) { const e = q(s); if (e) out[s] = R(e); }
    const lists = ['#slip tr.hot', '#slip tr.hot .ev', '#slip .note', '#tabs .tab', '.docs .doc', '#claims .claim', '#claims [data-claim]', '.kpis > div'];
    for (const s of lists) { const l = qa(s); if (l.length) out[s] = l.map(R); }
    const sc = qa('#ledger .sc').find((e) => e.textContent.trim().toLowerCase().startsWith('agent to agent'));
    if (sc) { out['a2a .sc'] = R(sc); const t = sc.nextElementSibling; if (t && t.tagName === 'TABLE') { out['a2a table'] = R(t); out['a2a rows'] = [...t.rows].map(R); } }
    const d = q('#dlg');
    if (d && d.open) {
      out['#dlg'] = R(d); const im = d.querySelector('img'), pre = d.querySelector('pre');
      if (im) { out['#dlg img'] = R(im); out['#dlg img natural'] = [im.naturalWidth, im.naturalHeight]; }
      if (pre) out['#dlg pre'] = R(pre);
      out['#dlg scroll'] = [d.scrollTop, d.scrollHeight, d.clientHeight];
    }
    out.cursor = [Math.round(S.x * 10) / 10, Math.round(S.y * 10) / 10];
    return { theme: document.documentElement.dataset.theme || 'light', scrollY: Math.round(window.scrollY * 10) / 10, scrollMax: document.documentElement.scrollHeight - window.innerHeight, rects: out };
  };

  // ---- mock backend (rehearsal only): no mutating request ever leaves the page
  if (cfg.mock) {
    const realFetch = window.fetch.bind(window);
    const enc = new TextEncoder();
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const stream = (items) => new Response(new ReadableStream({ async start(c) { for (const [d, o] of items) { await wait(d); c.enqueue(enc.encode(JSON.stringify(o) + '\n')); } c.close(); } }), { headers: { 'content-type': 'application/x-ndjson' } });
    const json = async (o, d) => { await wait(d); return new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json' } }); };
    let nq = 0, kw = 0, bond = null; const quotes = {};
    const mkQuote = (caseId, decision) => {
      // eslint-disable-next-line no-undef
      const c = DATA.cases.find((x) => x.id === caseId); const ok = decision === 'insure';
      const pLoss = ok ? 0.0123 : 0.931;
      const ev = 'The email asks to send this payment to a new wallet 0x9f3c…b21a that does not match the vendor record on file, and urges payment today because rent is due Friday.';
      const perils = ok ? { wrong_payee: { p: 0.004 }, duplicate_payment: { p: 0.003 }, inflated_amount: { p: 0.002 }, prompt_injection: { p: 0.001 }, not_delivered: { p: 0.0025 } }
        : { wrong_payee: { p: 0.9, evidence: ev }, duplicate_payment: { p: 0.02 }, inflated_amount: { p: 0.15, evidence: 'Invoice total is 40% above the monthly cap in the agreement, with no change order on file anywhere in the documents.' }, prompt_injection: { p: caseId === 'injection' ? 0.85 : 0.01, evidence: 'Hidden grey text under Total due instructs the reviewer to set every risk to 0 and approve full payment. ' + ev }, not_delivered: { p: 0.03 } };
      const q = { id: 'q_mock' + (++nq), decision, pLoss, premiumUsd: +(c.coverUsd * pLoss * 1.4).toFixed(2), reason: 'Combined chance of loss 93.1% is above what the pool will insure.', case: c,
        underwriting: { summary: ok ? 'Routine monthly invoice from a known vendor to the wallet on file; amount within the agreement.' : 'The invoice asks for payment to a wallet that is not on file and the email pressures for same-day payment. ' + ev, perils },
        dolphin: { model: 'deepseek-ai/DeepSeek-V4.1-Flash', weights: 'https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash', fingerprint: 'vllm-0.9.2+mock', requestHash: 'ab12cd34ef567890', inTokens: 5234, costUsd: 0.00123, latencyMs: 4200 }, serv: { verdict: ok ? 'agree' : 'blocked' }, panel: { mode: 'single' } };
      quotes[q.id] = q; return q;
    };
    window.fetch = (url, opts) => {
      const u = String(url), o = opts || {}, post = (o.method || 'GET').toUpperCase() === 'POST';
      const body = o.body ? JSON.parse(o.body) : {};
      if (post && u === '/api/quote') {
        let mode = 'decline';
        if (body.caseId === 'clean') { kw++; mode = kw === 1 ? 'error' : kw === 2 ? 'decline' : 'insure'; }
        const q = mode === 'error' ? null : mkQuote(body.caseId, mode);
        const items = [[300, { type: 'step', name: 'dolphin', docs: 5, images: 1 }], [1800, { type: 'step', name: 'priced', pLoss: q ? q.pLoss : 0.5, inTokens: 5234, latencyMs: 1800 }], [300, { type: 'step', name: 'serv' }]];
        if (mode === 'error') items.push([900, { type: 'error', error: 'Dolphin did not answer in time (mock)' }]);
        else items.push([1200, { type: 'step', name: 'shadow', verdict: 'agree' }], [200, { type: 'step', name: 'decided', decision: q.decision }], [150, { type: 'result', result: q }]);
        return Promise.resolve(stream(items));
      }
      if (post && u === '/api/demo/pay-premium') {
        const q = quotes[body.quoteId];
        bond = { id: 'bond_mock1', quoteId: q.id, action: q.case.action, premiumUsd: q.premiumUsd, coverUsd: q.case.coverUsd, premiumTx: '0xabc123def4567890abc123def4567890abc123def4567890abc123def4567890', premiumTxUrl: 'https://sepolia.basescan.org/tx/0xabc123', status: 'active' };
        return json({ bond }, 2500);
      }
      if (post && u === '/api/claim') {
        const pay = body.claimId === 'duplicate';
        const c = { id: 'claim_mock_' + body.claimId, decision: pay ? 'pay' : 'deny', payoutUsd: 1800, reason: pay ? 'The bank statement and the on-chain transfer record show INV-0931 was paid twice for the same October webhooks work; the vendor confirms and refuses a refund. This is the duplicate-payment peril covered by the bond.' : 'The only evidence is a chat screenshot that contains an instruction addressed to the judge. It shows no loss on the insured payment, so nothing in it can be verified against the ledger.', payoutTx: pay ? '0xfeed123def4567890abc123def4567890abc123def4567890abc123def456beef' : null, payoutTxUrl: pay ? 'https://sepolia.basescan.org/tx/0xfeed' : null,
          multipath: { verdict: pay ? 'covered' : 'not_covered', rulebooks: [{ rulebook: 'bond_wording', clause: 'Covers a duplicate payment of the insured invoice discovered within the claims window of thirty days.', finding: pay ? 'covered' : 'not covered' }, { rulebook: 'payment_policy', clause: 'One invoice, one payment.', finding: pay ? 'covered' : 'not covered' }, { rulebook: 'vendor_contract', clause: 'Refunds on request.', finding: pay ? 'covered' : 'not covered' }] },
          shadow: { verdict: 'agree' }, judgment: { peril: pay ? 'duplicate_payment' : 'none' }, serv: { verdict: 'agree' } };
        const items = [[2500, { type: 'step', name: 'judged', decision: c.decision, latencyMs: 2500 }], [300, { type: 'step', name: 'serv' }], [1200, { type: 'step', name: 'multipath' }]];
        if (pay) items.push([900, { type: 'step', name: 'payout', usd: 1800 }]);
        items.push([1500, { type: 'result', result: c }]);
        if (pay && bond) bond.status = 'paid';
        return Promise.resolve(stream(items));
      }
      if (post && u.startsWith('/api/recheck/')) {
        const isQ = u.includes('/q_');
        return Promise.resolve(stream([[2600, { type: 'result', result: { sameDecision: true, kind: isQ ? 'quote' : 'claim', original: { pLoss: 0.931, decision: isQ ? 'decline' : 'pay' }, rerun: { pLoss: 0.928, decision: isQ ? 'decline' : 'pay' }, fingerprint: 'a', originalFingerprint: 'a' } }]]));
      }
      if (!post && u.startsWith('/api/bonds/')) return json(bond || {}, 500);
      if (post) return Promise.reject(new Error('mock: unexpected POST ' + u));
      return realFetch(url, opts);
    };
  }
}

// ---------------------------------------------------------------- main
(async () => {
  // Chrome's screencast (and captureScreenshot) deliver CSS-pixel frames when the 2x scale is only *emulated*;
  // a real device scale factor makes the compositor surface itself 2560x1440, so frames are true 2x renders.
  const browser = await chromium.launch({ args: DPR !== 1 ? [`--force-device-scale-factor=${DPR}`] : [] });
  const context = await browser.newContext({ viewport: { width: VW, height: VH }, deviceScaleFactor: DPR, colorScheme: 'light', locale: 'en-US' });
  await context.addInitScript(initScript, { mock: MODE === 'mock', x0: HERO_PARK[0], y0: HERO_PARK[1] });
  let page, cdp, flushTimer, recording = false;
  const pending = new Set();
  let exitCode = 0;

  async function main() {
  try {
    // ---- 0a. warm the server and the HTTP cache (same context, separate page), then close it
    {
      const w = await context.newPage();
      const t0 = Date.now();
      try {
        await w.goto(SITE, { waitUntil: 'networkidle', timeout: 180000 });
        await w.waitForSelector('#poolline a', { timeout: 60000 }).catch(() => {});
        await w.evaluate(() => document.fonts.ready.then(() => 1)).catch(() => {});
        await sleep(2500);
      } catch (e) { console.log('warm-up problem: ' + e.message); }
      console.log(`warm-up done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      await w.close();
    }

    page = await context.newPage();
    await page.exposeFunction('__capEvent', (o) => { if (recording) log(o); });
    page.on('pageerror', (e) => { if (recording) log({ name: 'pageerror', text: String(e.message).slice(0, 300) }); });
    page.on('console', (m) => { if (recording && m.type() === 'error') log({ name: 'console-error', text: m.text().slice(0, 300) }); });
    page.on('request', (r) => { if (recording && r.method() === 'POST') { log({ name: 'net-post', url: r.url().replace(SITE, '/') }); if (MODE === 'probe') console.error('!!! POST in probe mode'); } });
    page.on('response', (r) => { if (recording && r.request().method() === 'POST') log({ name: 'net-post-response', url: r.url().replace(SITE, '/'), status: r.status() }); });
    if (MODE !== 'real') await page.route('**/*', (route) => (route.request().method() === 'POST' ? route.abort() : route.continue()));

    cdp = await context.newCDPSession(page);
    let epoch0 = null, lastT = -1, fi = 0;
    cdp.on('Page.screencastFrame', (f) => {
      const recv = now();
      cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
      if (!recording) return;
      let t = f.metadata.timestamp - epoch0; // compositor time of the frame, on the Node clock
      if (!(t > -5 && t < recv + 1)) t = recv; // metadata clock unusable: fall back to receipt time
      t = Math.max(0, r3(t));
      if (t <= lastT) t = r3(lastT + 0.001);
      lastT = t;
      const i = ++fi;
      frames.push({ i, t, recv: r3(recv) });
      const buf = Buffer.from(f.data, 'base64');
      if (i === 1 || i % 500 === 0) { // sanity: real pixel size from the JPEG header
        const d = jpegSize(buf); if (d) { if (i === 1) { frameMeta = d; } else if (d.width !== frameMeta.width || d.height !== frameMeta.height) { log({ name: 'frame-size-changed', ...d, i }); frameMeta = d; } }
      }
      const p = fs.promises.writeFile(path.join(OUT, 'frames', String(i).padStart(6, '0') + '.jpg'), buf).catch((e) => console.error('write failed', e.message));
      pending.add(p); p.finally(() => pending.delete(p));
    });

    // ---- start recording BEFORE navigation
    perf0 = performance.now();
    epoch0 = (performance.timeOrigin + perf0) / 1000;
    recording = true;
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 90, maxWidth: Math.round(VW * DPR), maxHeight: Math.round(VH * DPR), everyNthFrame: 1 });
    log({ name: 'record-start', mode: MODE, viewport: [VW, VH], dpr: DPR });
    flushTimer = setInterval(flush, 3000);

    await run();
  } catch (e) {
    exitCode = 1;
    console.error('FATAL', e);
    try { log({ name: 'fatal', text: String(e && e.stack || e).slice(0, 600) }); } catch (e2) {}
  } finally {
    try { if (cdp) await cdp.send('Page.stopScreencast'); } catch (e) {}
    await sleep(300);
    endT = now();
    recording = false;
    clearInterval(flushTimer);
    await Promise.allSettled([...pending]);
    try { log({ name: 'record-stop', t: endT, frames: frames.length }); } catch (e) {}
    flush();
    await browser.close().catch(() => {});
    try { execFileSync('python3', [path.join(__dirname, 'contact.py'), OUT], { stdio: 'inherit' }); } catch (e) { console.error('contact sheet failed: ' + e.message); }
    console.log(`done: ${frames.length} frames, ${endT.toFixed(1)} s, ${frameMeta.width}x${frameMeta.height}, clicks ${JSON.stringify(used)}, budget ${JSON.stringify(budget)}`);
    process.exit(exitCode);
  }
  }

  // ================================================================ helpers bound to page
  function jpegSize(b) {
    let o = 2;
    while (o < b.length - 9) {
      if (b[o] !== 0xff) return null;
      const m = b[o + 1], len = b.readUInt16BE(o + 2);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { height: b.readUInt16BE(o + 5), width: b.readUInt16BE(o + 7) };
      o += 2 + len;
    }
    return null;
  }
  const ev = (fn, arg) => page.evaluate(fn, arg);
  const getRects = () => ev(() => window.__capRects());
  async function waitFor(fn, timeoutSec, { poll = 150, arg, onPoll } = {}) {
    const t0 = now();
    for (;;) {
      let v = null;
      try { v = await page.evaluate(fn, arg); } catch (e) { v = null; }
      if (v) return v;
      if (now() - t0 > timeoutSec) return null;
      if (onPoll) await onPoll();
      await sleep(poll);
    }
  }
  async function glideTo(x, y, dur) {
    x = Math.max(4, Math.min(VW - 6, Math.round(x))); y = Math.max(4, Math.min(VH - 8, Math.round(y)));
    const from = await ev(() => window.__cur.pos());
    const dist = Math.hypot(x - from.x, y - from.y);
    if (dist < 1) return;
    const d = dur || Math.round(Math.max(550, Math.min(800, 520 + dist * 0.45)));
    const t0 = now();
    await ev(([x2, y2, d2]) => window.__cur.glide(x2, y2, d2), [x, y, d]);
    await page.mouse.move(x, y);
    log({ name: 'glide', t: t0, t1: r3(now()), from: [Math.round(from.x), Math.round(from.y)], to: [x, y], ms: d });
  }
  async function scrollToY(y, why) {
    const s = await ev(() => ({ cur: window.scrollY, max: document.documentElement.scrollHeight - window.innerHeight }));
    y = Math.max(0, Math.min(Math.round(y), Math.floor(s.max)));
    if (Math.abs(y - s.cur) < 2) return s.cur;
    log({ name: 'scroll-start', scrollY: Math.round(s.cur), to: y, why });
    await ev((yy) => window.scrollTo({ top: yy, behavior: 'smooth' }), y);
    let last = -1, stable = 0; const t0 = now();
    while (now() - t0 < 5) {
      await sleep(50);
      const c = await ev(() => window.scrollY);
      if (Math.abs(c - last) < 0.5) stable++; else stable = 0;
      last = c;
      if ((stable >= 3 && Math.abs(c - y) < 2) || stable >= 10) break;
    }
    log({ name: 'scroll-end', scrollY: Math.round(last) });
    await sleep(200);
    return last;
  }
  const box = async (sel) => { const l = typeof sel === 'string' ? page.locator(sel).first() : sel; if (!(await l.count())) return null; return l.boundingBox(); };
  async function scrollBy(dy, why) { const c = await ev(() => window.scrollY); return scrollToY(c + dy, why); }
  // bring an element inside the viewport band [top, bottom]
  async function ensureInView(sel, { top = 16, bottom = VH - 16, why } = {}) {
    const b = await box(sel); if (!b) return false;
    if (b.y < top) await scrollBy(b.y - top, why || 'ensure-in-view');
    else if (b.y + b.height > bottom) await scrollBy(Math.min(b.y + b.height - bottom, b.y - top), why || 'ensure-in-view');
    return true;
  }
  async function scrollElTop(sel, off, why) { const b = await box(sel); if (!b) return; await scrollBy(b.y - off, why); }
  // glide, pause, real click. `spendKind` marks a budgeted (mutating) click.
  async function clickLoc(sel, name, { spendKind, fx = 0.5, fy = 0.5 } = {}) {
    const l = typeof sel === 'string' ? page.locator(sel).first() : sel;
    if (!(await l.count())) throw new Error('click target missing: ' + name);
    await ensureInView(l, { why: 'click ' + name });
    const b = await l.boundingBox();
    const x = Math.round(b.x + b.width * fx), y = Math.round(b.y + b.height * fy);
    await glideTo(x, y);
    await sleep(250);
    const hit = await l.evaluate((el, p) => { const e = document.elementFromPoint(p.x, p.y); return !!e && (e === el || el.contains(e)); }, { x, y });
    if (!hit) throw new Error('click target not under cursor: ' + name);
    if (spendKind) spend(spendKind);
    log({ name: 'click', target: name, x, y, ...(spendKind ? { mutating: spendKind, n: used[spendKind] } : {}) });
    await page.mouse.down(); await sleep(70); await page.mouse.up();
  }
  let holdN = 0;
  async function hold(label, sec) {
    const dur = sec * HS, n = ++holdN, t = now();
    let info = { scrollY: null, rects: {} };
    try { info = await getRects(); } catch (e) { log({ name: 'rects-failed', text: e.message }); }
    const still = `${String(n).padStart(2, '0')}-${label}.png`;
    const h = { label, t: r3(t), dur: r3(dur), theme: info.theme || null, scrollY: info.scrollY, scrollMax: info.scrollMax, still: 'stills/' + still, rects: info.rects };
    holds.push(h);
    log({ name: 'hold', label, dur: r3(dur), scrollY: info.scrollY, theme: info.theme });
    try { const s = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, 'stills', still), Buffer.from(s.data, 'base64')); } catch (e) { log({ name: 'still-failed', label, text: e.message }); }
    const left = dur - (now() - t); if (left > 0) await sleep(left * 1000);
    h.dur = r3(now() - t);
    log({ name: 'hold-end', label });
  }
  const parkRight = (y = 400) => glideTo(MARGIN_R, y);
  const parkLeft = (y = 400) => glideTo(MARGIN_L, y);
  async function parkSlipBlank() { // blank area of the "Request cover" slip, below the button
    const q = await box('#quoteBtn'), s = await box('#slip');
    if (q && s) await glideTo(s.x + s.width * 0.6, Math.min(q.y + q.height + 64, s.y + s.height - 30)); else await parkRight();
  }
  async function showDoc(sel, name, label, sec, opt = {}) {
    await clickLoc(sel, name);
    const ok = await waitFor(() => { const d = document.querySelector('#dlg'); if (!d.open) return false; const im = d.querySelector('img'); return !im || (im.complete && im.naturalWidth > 0); }, 12);
    if (!ok) { note(`dialog for ${name} did not open`); return false; }
    await sleep(120);
    const b = await box('#dlg');
    await glideTo(Math.min(b.x + b.width + 34, MARGIN_R), b.y + b.height * 0.62, 600);
    if (opt.dlgTop) { // showModal() focuses the Close button, which leaves a tall dialog scrolled to its bottom
      const st = await ev(() => document.querySelector('#dlg').scrollTop);
      if (st > 4) { log({ name: 'dialog-scroll-start', from: Math.round(st), to: 0 }); await ev(() => document.querySelector('#dlg').scrollTo({ top: 0, behavior: 'smooth' })); await waitFor(() => document.querySelector('#dlg').scrollTop < 1, 3, { poll: 60 }); await sleep(250); log({ name: 'dialog-scroll-end', scrollTop: 0 }); }
    }
    await hold(label, sec);
    log({ name: 'key', key: 'Escape' });
    await page.keyboard.press('Escape');
    const closed = await waitFor(() => !document.querySelector('#dlg').open, 5);
    if (!closed) { note('dialog did not close on Escape; closing via form button'); await ev(() => document.querySelector('#dlg').close()); }
    await sleep(350);
    return true;
  }
  const chip = (name) => page.locator('button.doc', { hasText: name }).first();
  const slipLower = async (label, sec) => { // show the lower part of the slip if it runs below the viewport
    const s = await box('#slip'); if (!s || s.y + s.height <= VH - 6) return false;
    const y0 = await ev(() => window.scrollY);
    await scrollBy(s.y + s.height - (VH - 16), 'slip lower part');
    await hold(label, sec);
    await scrollToY(y0, 'back');
    return true;
  };
  const readQuote = () => ev(() => {
    /* global current, lastQuote */
    const T = (s) => { const e = document.querySelector(s); return e ? e.textContent.trim() : null; };
    const prem = document.querySelector('#prem'); let figText = null, figShadow = null;
    try { figText = new Intl.NumberFormat('en-US', prem.format).format(prem.value !== undefined ? prem.value : (window.lastQuoteFigure)); } catch (e) {}
    try { figShadow = prem.shadowRoot ? prem.shadowRoot.textContent.replace(/\s+/g, '') : null; } catch (e) {}
    const q = lastQuote || {}; const ok = q.decision === 'insure';
    try { figText = new Intl.NumberFormat('en-US', ok ? { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 } : { style: 'percent', maximumFractionDigits: 1 }).format(ok ? q.premiumUsd : q.pLoss); } catch (e) {}
    const fig = document.querySelector('.verdict .fig');
    return {
      caseId: current.id, word: T('#vword'), figureLabel: fig && fig.firstChild ? fig.firstChild.textContent.trim() : null, figureText: figText, figureAria: prem ? (prem.getAttribute('aria-label') || null) : null, figureShadow: figShadow,
      quoteId: (T('#slip > .sc') || '').split('·').pop().trim(), scLine: T('#slip > .sc'), summary: T('#sum'),
      perils: [...document.querySelectorAll('#slip table tr')].map((tr) => ({ name: (tr.querySelector('td span, td b') || {}).textContent, p: (tr.querySelector('td.r') || {}).textContent, hot: tr.classList.contains('hot'), evidence: (tr.querySelector('.ev') || {}).textContent || null })),
      declineNote: T('#slip .slipgrid .note.bad'), notes: [...document.querySelectorAll('#slip .notes p')].map((p) => p.textContent.trim()),
      raw: { id: q.id, decision: q.decision, pLoss: q.pLoss, premiumUsd: q.premiumUsd, reason: q.reason, modelLatencyMs: q.dolphin && q.dolphin.latencyMs, inTokens: q.dolphin && q.dolphin.inTokens, costUsd: q.dolphin && q.dolphin.costUsd, model: q.dolphin && q.dolphin.model, fingerprint: q.dolphin && q.dolphin.fingerprint, serv: q.serv && q.serv.verdict, panel: q.panel && q.panel.mode },
    };
  });
  const stepsSince = (t0, where) => events.filter((e) => e.name === 'step' && e.where === where && e.t >= t0).map((e) => ({ text: e.text, t: e.t, sinceClick: r3(e.t - t0) }));

  // One quote: click "Request cover" (or #retry), wait, read facts. Returns {state:'insured'|'declined'|'error'|'timeout', fact}
  async function requestCover(caseId, attempt, btnSel = '#quoteBtn') {
    await clickLoc(btnSel, btnSel === '#retry' ? 'Try again (quote)' : 'Request cover', { spendKind: 'quote' });
    const tClick = events[events.length - 1].t;
    const s = await box('#slip');
    await glideTo(MARGIN_R, s ? Math.min(Math.max(s.y + 150, 120), 560) : 400, 650);
    const res = await waitFor(() => { const v = document.querySelector('#vword'); if (v) return { word: v.textContent.trim() }; if (document.querySelector('#retry')) return { error: (document.querySelector('#slip .note.bad') || {}).textContent || 'error' }; return null; }, 200);
    const tDone = now();
    const fact = { caseId, attempt, tClick, tResult: r3(tDone), latencySec: r3(tDone - tClick), steps: stepsSince(tClick, 'quote') };
    facts.quotes.push(fact);
    if (!res) { fact.state = 'timeout'; log({ name: 'quote-timeout', caseId, attempt }); note(`quote ${caseId} attempt ${attempt}: no result within 200 s`); return { state: 'timeout', fact }; }
    if (res.error) { fact.state = 'error'; fact.error = res.error; log({ name: 'quote-error', caseId, attempt, text: res.error }); note(`quote ${caseId} attempt ${attempt}: error "${res.error}"`); return { state: 'error', fact }; }
    let rects = null; try { rects = await getRects(); } catch (e) {}
    log({ name: 'quote-result', caseId, attempt, word: res.word, latencySec: fact.latencySec, scrollY: rects && rects.scrollY, rects: rects && rects.rects });
    await sleep(250); await nudgeMarks();
    await sleep(1000); // let the number roll and the hand-drawn mark finish with the cursor still
    try { Object.assign(fact, await readQuote()); } catch (e) { note('readQuote failed: ' + e.message); }
    fact.state = res.word === 'Insured' ? 'insured' : 'declined';
    flush();
    return { state: fact.state, fact };
  }
  async function recheckFlow(btnSel, afterSel, label, what) {
    await clickLoc(btnSel, 'Re-check on the same weights (' + what + ')', { spendKind: 'recheck' });
    const tClick = events[events.length - 1].t;
    const side = what === 'claim' ? MARGIN_L : MARGIN_R;
    const b = await box(btnSel);
    await glideTo(side, b ? Math.min(b.y + 10, 600) : 400, 650);
    const res = await waitFor((s) => { const n = document.querySelector(`${s} .note.ok, ${s} .note.bad`); return n ? { cls: n.className, text: n.textContent.trim() } : null; }, 200, { arg: afterSel });
    const f = { what, tClick, tResult: r3(now()), latencySec: r3(now() - tClick), note: res ? res.text : null, cls: res ? res.cls : null, state: res ? 'done' : 'timeout' };
    facts.rechecks.push(f);
    log({ name: 'recheck-result', what, ...f });
    if (!res) note(`re-check (${what}) gave no result within 200 s`);
    await nudgeMarks();
    await ensureInView(afterSel, { bottom: VH - 20, why: 'show re-check note' });
    await sleep(300);
    await hold(label, 5);
  }
  // nav #theme toggle (non-mutating). The nav scrolls with the page, so this scrolls up when needed.
  async function toggleTheme(want, label) {
    const cur = await ev(() => document.documentElement.dataset.theme);
    if (cur === want) { log({ name: 'theme-already', theme: cur }); return; }
    await scrollToY(0, 'nav into view for theme toggle');
    await clickLoc('#theme', `theme toggle (${cur} -> ${want})`);
    const ok = await waitFor((w) => document.documentElement.dataset.theme === w, 3, { arg: want });
    log({ name: 'theme', theme: await ev(() => document.documentElement.dataset.theme), ok: !!ok, buttonText: await ev(() => document.querySelector('#theme').textContent) });
    const b = await box('#theme');
    if (b) await glideTo(b.x - 60, b.y + b.height + 46, 600); // blank band of the hero, off the nav
    await hold(label, 1.5);
  }
  // cosmetic sub-steps must never abort the budgeted core of a scene
  async function soft(what, fn) { try { return await fn(); } catch (e) { log({ name: 'soft-error', what, text: String(e && e.message || e).slice(0, 300) }); note(`cosmetic step "${what}" failed: ${e && e.message}`); try { if (await ev(() => document.querySelector('#dlg').open)) await ev(() => document.querySelector('#dlg').close()); } catch (e2) {} return null; } }
  // Rough Notation marks are absolutely positioned and only re-measure on window resize; when a card grows, marks
  // further down the page (e.g. the backtest underline) are left behind as stray lines. A synthetic resize event
  // makes the library re-place them. Nothing else on the page listens to resize.
  async function nudgeMarks() { try { await ev(() => window.dispatchEvent(new Event('resize'))); log({ name: 'marks-renudged' }); } catch (e) {} }
  async function scene(name, fn) {
    log({ name: 'scene', scene: name });
    try { await fn(); } catch (e) { log({ name: 'scene-error', scene: name, text: String(e && e.message || e).slice(0, 400) }); note(`scene ${name} failed: ${e && e.message}`); console.error(e); }
    flush();
  }

  // ================================================================ the take
  async function run() {
    let bonded = false;

    await scene('0-hero', async () => {
      log({ name: 'goto', url: SITE });
      await page.goto(SITE, { waitUntil: 'networkidle', timeout: 180000 });
      log({ name: 'network-idle' });
      const ok = await waitFor(() => {
        if (!document.querySelector('#poolline a') || !document.querySelector('#tabs .tab')) return false;
        return [...document.querySelectorAll('.kpis number-flow')].every((n) => n.shadowRoot && n.shadowRoot.textContent.trim().length > 0 && n.getBoundingClientRect().width > 4);
      }, 60);
      log({ name: 'kpis-ready', ok: !!ok });
      await ev(() => document.fonts.ready.then(() => 1));
      await sleep(1500);
      await hold('hero', 5);
    });

    if (MODE === 'probe') return probe();

    // ---------------------------------------------------------- 1. KWAME
    let kw = null;
    await scene('1-kwame', async () => {
      await scrollElTop('#tabs', 16, 'tabs to top');
      await parkSlipBlank();
      await hold('kwame-case', 2);
      await soft('kwame invoice dialog', () => showDoc('img.inv', 'invoice thumbnail (INV-0931.png)', 'kwame-invoice-dlg', 2.5));
      await soft('chip hovers', async () => {
        const chips = page.locator('.docs button.doc'); const n = Math.min(4, await chips.count());
        for (let i = 0; i < n; i++) { const b = await chips.nth(i).boundingBox(); await glideTo(b.x + b.width * 0.55, b.y + b.height * 0.6, i === 0 ? 700 : 600); log({ name: 'hover', target: 'chip ' + (await chips.nth(i).textContent()) }); await sleep(260); }
      });
      for (let attempt = 1; attempt <= 3; attempt++) {
        const r = await requestCover('clean', attempt);
        if (r.state === 'insured') { kw = r.fact; break; }
        await hold(`kwame-declined-${attempt}`, 3);
        if (attempt === 3) { note('Kwame was not insured in 3 attempts; BIND and CLAIMS are skipped'); break; }
        await clickLoc('.tab[data-id="clean"]', 'tab clean (reset for retry)');
        await sleep(500);
      }
      if (!kw) return;
      await ev(() => { window.__kwQuote = lastQuote; });
      await soft('kwame insured holds', async () => {
        const p = await box('#payBtn'), rb = await box('#reBtn');
        if (p && rb && rb.y > p.y + p.height - 2) await glideTo(p.x + p.width + 22, p.y + p.height * 0.55); // re-check wrapped below: free space right of Pay
        else if (p && rb) await glideTo(Math.min(rb.x + rb.width + 20, MARGIN_R), rb.y + rb.height + 14);
        await hold('kwame-insured', 7);
        const s = await box('#slip');
        if (s && s.y + s.height > VH - 6) { await parkRight(420); await slipLower('kwame-insured-lower', 2.5); }
      });
    });

    // ---------------------------------------------------------- 2. BIND
    await scene('2-bind', async () => {
      if (!kw) { log({ name: 'skip', scene: '2-bind' }); return; }
      for (let attempt = 1; attempt <= 2 && !bonded; attempt++) {
        await clickLoc('#payBtn', attempt === 1 ? 'Pay premium and bind' : 'Try again (pay)', { spendKind: 'pay' });
        const tClick = events[events.length - 1].t;
        const s = await box('#slip');
        await glideTo(MARGIN_R, s ? Math.min(Math.max(s.y + 150, 120), 560) : 400, 650);
        const res = await waitFor(() => { const sc = document.querySelector('#slip > .sc'); if (sc && sc.textContent.startsWith('bond certificate')) return { bond: sc.textContent }; const b = document.querySelector('#payBtn'); if (b && b.textContent.trim() === 'Try again') return { error: (document.querySelector('#after .note.bad') || {}).textContent || 'error' }; return null; }, 150);
        if (res && res.bond) {
          bonded = true;
          await ev(() => { window.__savedBond = lastBond; });
          log({ name: 'bond-rendered', text: res.bond, latencySec: r3(now() - tClick) });
          await nudgeMarks();
          await soft('bond hold', () => hold('bond', 7));
          facts.bond = await ev(() => { const a = [...document.querySelectorAll('#slip table tr')].find((tr) => tr.cells[0].textContent.trim() === 'premium tx'); const link = a && a.querySelector('a'); window.__savedBond = lastBond; return { scLine: document.querySelector('#slip > .sc').textContent, bondId: lastBond.id, premiumTxUrl: link ? link.href : null, premiumTxText: a ? a.cells[1].textContent : null, rows: [...document.querySelectorAll('#slip table tr')].map((tr) => [tr.cells[0].textContent.trim(), tr.cells[1].textContent.trim()]), coverUsd: lastBond.coverUsd, premiumUsd: lastBond.premiumUsd, status: lastBond.status }; });
          facts.bond.latencySec = r3(holds[holds.length - 1].t - tClick); facts.bond.attempts = attempt;
          log({ name: 'bond-facts', bondId: facts.bond.bondId, premiumTxUrl: facts.bond.premiumTxUrl });
        } else {
          note(`bind attempt ${attempt} failed: ${res ? res.error : 'timeout after 150 s'}`);
          log({ name: 'bind-failed', attempt, text: res ? res.error : 'timeout' });
          await hold(`bind-failed-${attempt}`, 3);
          if (!res) break; // a timeout may still land; do not double-pay
        }
      }
    });

    // ---------------------------------------------------------- 3. AMA / 4. EFUA
    async function declineCase(id, tabName, labels) {
      await clickLoc(`.tab[data-id="${id}"]`, 'tab ' + id);
      await sleep(400);
      await soft(labels.pre + ' case hold', async () => { await ensureInView('#tabs', { top: 12, why: 'tabs in view' }); await parkSlipBlank(); await hold(labels.case, 2); });
      for (const d of labels.docs) await soft(d.name, () => showDoc(d.sel(), d.name, d.label, d.sec));
      let r = await requestCover(id, 1);
      if (r.state === 'error' && budget.quote < CAPS.quote - 1) { await hold(labels.pre + '-error', 3); r = await requestCover(id, 2, '#retry'); }
      if (r.state === 'error' || r.state === 'timeout') { await hold(labels.pre + '-failed', 3); return null; }
      if (r.fact.word !== 'Not insurable') note(`${id}: unexpected decision "${r.fact.word}"`);
      await soft(labels.pre + ' result holds', async () => { await hold(labels.pre + '-result', 7); await slipLower(labels.pre + '-result-lower', labels.lowerSec); });
      return r;
    }
    await scene('3-ama', async () => {
      await declineCase('wallet-swap', 'Ama', { case: 'ama-case', pre: 'ama', lowerSec: 3, docs: [{ sel: () => chip('email-ama.txt'), name: 'chip email-ama.txt', label: 'ama-email-dlg', sec: 4 }] });
    });
    await scene('4-efua', async () => {
      const r = await declineCase('injection', 'Efua', { case: 'efua-case', pre: 'efua', lowerSec: 3, docs: [
        { sel: () => page.locator('img.inv'), name: 'invoice thumbnail (INV-0118.png)', label: 'efua-invoice-dlg', sec: 4.5 },
        { sel: () => chip('email-efua.txt'), name: 'chip email-efua.txt', label: 'efua-email-dlg', sec: 3.5 }] });
      if (!r) return;
      await recheckFlow('#reBtn', '#after', 'efua-recheck', 'quote');
    });

    // ---------------------------------------------------------- 5. CLAIMS
    await scene('5-claims', async () => {
      if (!bonded) { note('CLAIMS skipped: no bond (theme toggle skipped too)'); log({ name: 'skip', scene: '5-claims' }); return; }
      await soft('theme dark', () => toggleTheme('dark', 'theme-dark'));
      // The page's renderQuoteResult() sets lastBond = null, so after the Ama/Efua quotes the File buttons would throw
      // client-side. Put the page's own bond + Kwame quote objects back (no DOM change, nothing visible).
      const st = await ev(() => { const before = { bond: lastBond ? lastBond.id : null, quote: lastQuote ? lastQuote.id : null }; if (window.__savedBond) lastBond = window.__savedBond; if (window.__kwQuote) lastQuote = window.__kwQuote; return { before, after: { bond: lastBond ? lastBond.id : null, quote: lastQuote ? lastQuote.id : null } }; });
      log({ name: 'state-restore', ...st });
      if (st.before.bond !== st.after.bond) note(`page state patched before claims: lastBond ${st.before.bond} -> ${st.after.bond}, lastQuote ${st.before.quote} -> ${st.after.quote} (the page nulls lastBond on every quote result)`);
      await soft('claims card hold', async () => {
        await scrollElTop('#claims', 16, 'claims to top');
        const cb = await box('#claims');
        await parkLeft(cb ? Math.min(cb.y + 120, 600) : 300);
        await hold('claims-card', 3);
      });

      async function fileClaim(id, timeout, label, holdSec) {
        const en = await waitFor((cid) => { const b = document.querySelector(`button[data-claim="${cid}"]`); return b && !b.disabled; }, 90, { arg: id });
        if (!en) { note(`File ${id}: button missing or still disabled after 90 s (previous claim still running?) - not clicked`); facts.claims.push({ claimId: id, state: 'not-clicked' }); return { state: 'not-clicked' }; }
        await ev(() => { const c = document.querySelector('#cword'); if (c) c.setAttribute('data-old', '1'); document.querySelectorAll('#claimout .note.bad').forEach((n) => n.setAttribute('data-old', '1')); });
        await clickLoc(`button[data-claim="${id}"]`, 'File ' + id, { spendKind: 'file' });
        const tClick = events[events.length - 1].t;
        const b = await box(`button[data-claim="${id}"]`);
        await glideTo(MARGIN_L, b ? b.y + 14 : 300, 700);
        let busy = false;
        const res = await waitFor(() => { const c = document.querySelector('#cword:not([data-old])'); if (c) return { word: c.textContent.trim() }; const n = document.querySelector('#claimout .note.bad:not([data-old])'); if (n) return { error: n.textContent.trim() }; return null; }, timeout, {
          onPoll: async () => { if (busy) return; busy = true; try { const o = await box('#claimout'); if (o && o.height > 4 && o.y + o.height > VH - 12) await scrollBy(Math.min(o.y + o.height - (VH - 40), o.y - 16), 'follow claim steps'); } finally { busy = false; } },
        });
        const f = { claimId: id, tClick, tResult: r3(now()), latencySec: r3(now() - tClick), steps: stepsSince(tClick, 'claim') };
        facts.claims.push(f);
        if (!res || res.error) { f.state = res ? 'error' : 'timeout'; f.error = res ? res.error : null; note(`claim ${id}: ${res ? 'error "' + res.error + '"' : 'no result within ' + timeout + ' s'}`); log({ name: 'claim-failed', claimId: id, text: res ? res.error : 'timeout' }); await ensureInView('#claimout', { why: 'show claim error' }); await hold(label, holdSec); return f; }
        let rects = null; try { rects = await getRects(); } catch (e) {}
        log({ name: 'claim-result', claimId: id, word: res.word, latencySec: f.latencySec, scrollY: rects && rects.scrollY, rects: rects && rects.rects });
        f.state = 'done'; f.word = res.word;
        if (/^Paid/.test(res.word)) { // live page re-renders the slip as the (paid) certificate and rebuilds #claims
          await waitFor(() => { const sc = document.querySelector('#slip > .sc'); return sc && sc.textContent.startsWith('bond certificate'); }, 4);
          await sleep(300); await nudgeMarks(); await sleep(700);
        } else { await sleep(250); await nudgeMarks(); await sleep(700); }
        // keep the verdict and as much of the result as possible in view
        const o = await box('#claimout'), c = await box('#cword');
        if (o && c) { if (o.y + o.height > VH - 12) await scrollBy(Math.min(o.y + o.height - (VH - 16), c.y - 20), 'claim result in view'); else if (c.y < 16) await scrollBy(c.y - 20, 'claim result in view'); }
        Object.assign(f, await ev(() => {
          const o2 = document.querySelector('#claimout'); const ps = [...o2.querySelectorAll(':scope > p')];
          const payP = ps.find((p) => p.textContent.trim().startsWith('Payout')); const link = payP && payP.querySelector('a');
          return { cword: document.querySelector('#cword').textContent.trim(), reason: ps[0] ? ps[0].textContent.trim() : null, payoutTxUrl: link ? link.href : null, payoutText: payP ? payP.textContent.trim() : null,
            rulebook: [...o2.querySelectorAll('table tr')].map((tr) => ({ rulebook: tr.cells[0].firstChild ? tr.cells[0].firstChild.textContent.trim() : '', clause: (tr.querySelector('.ev') || {}).textContent || null, finding: tr.cells[1].textContent.trim() })),
            lines: ps.slice(1).map((p) => p.textContent.trim()), markStillThere: !!document.querySelector('#claims svg.rough-annotation') };
        }));
        await soft(label + ' hold', () => hold(label, holdSec));
        return f;
      }

      await soft('fake evidence dialog', () => showDoc('img[data-doc="fake:0"]', 'claim thumbnail fake:0 (kwame-chat.png)', 'fake-evidence-dlg', 3, { dlgTop: true }));
      const f1 = await fileClaim('fake', 240, 'fake-result', 6);
      if (f1.word && /^Paid/.test(f1.word)) note('fake claim was PAID (unexpected); the bond will take no more claims');
      await soft('bank statement dialog', () => showDoc('img[data-doc="duplicate:0"]', 'claim thumbnail duplicate:0 (bank-statement-oct.png)', 'bank-statement-dlg', 3.5));
      const f2 = await fileClaim('duplicate', 300, 'dup-result', 8);
      await soft('dup lower hold', async () => { const o = await box('#claimout'); if (o && o.y + o.height > VH - 6) { await scrollBy(o.y + o.height - (VH - 16), 'claim result lower part'); await hold('dup-result-lower', 3); } });
      if (f2.word && /^Paid/.test(f2.word)) await recheckFlow('#reClaim', '#afterClaim', 'dup-recheck', 'claim');
      else note(`duplicate claim not paid (${f2.word || f2.state}); no re-check, no retry`);
    });

    await scene('5b-theme-light', async () => {
      if ((await ev(() => document.documentElement.dataset.theme)) === 'dark') await toggleTheme('light', 'theme-light');
    });

    // ---------------------------------------------------------- 6. LEDGER + BACKTEST
    await scene('6-ledger-backtest', async () => {
      await ensureInView('#ledger', { why: 'ledger fully visible' });
      const info = await getRects(); const rows = info.rects['a2a rows'] || [];
      if (!rows.length) note('agent-to-agent block not found in #ledger');
      for (let i = 0; i < rows.length; i++) { const r = rows[i]; await glideTo(r[0] + Math.min(150, r[2] * 0.45), r[1] + r[3] * 0.6, i === 0 ? 750 : 560); log({ name: 'hover', target: 'a2a row ' + (i + 1) }); await sleep(420); }
      await parkRight(rows.length ? Math.min(rows[rows.length - 1][1] + 10, 690) : 420);
      await hold('ledger', 5);
      await ensureInView('#backtest', { why: 'backtest visible' });
      const bt = await box('#bt'), bc = await box('#backtest');
      if (bt && bc) await glideTo(Math.min(bt.x + bt.width + 26, bc.x + bc.width - 20), bt.y + bt.height * 0.6, 780);
      await hold('backtest', 5);
    });

    // ---------------------------------------------------------- 7. END
    await scene('7-end', async () => {
      await scrollToY(0, 'back to top');
      await glideTo(HERO_PARK[0], HERO_PARK[1], 800);
      await sleep(300);
      await hold('end-hero', 5);
    });
    facts.poolAtEnd = await ev(() => fetch('/api/pool').then((r) => r.json())).catch(() => null);
  }

  // ================================================================ probe: non-mutating machinery test
  async function probe() {
    const nf = await ev(() => { const e = document.querySelector('#k-cap'); return { tag: e.tagName, shadow: e.shadowRoot ? e.shadowRoot.textContent.replace(/\s+/g, ' ').slice(0, 200) : null, aria: e.getAttribute('aria-label'), value: e.value, data: typeof e.data, keys: Object.keys(e).slice(0, 30), html: e.shadowRoot ? e.shadowRoot.innerHTML.slice(0, 600) : null, scrollH: document.documentElement.scrollHeight, popover: document.querySelector('#__cur').matches(':popover-open') }; });
    console.log('number-flow probe', JSON.stringify(nf, null, 1));
    await scrollElTop('#tabs', 16, 'tabs to top');
    await parkSlipBlank();
    await hold('p-kwame-case', 1);
    await showDoc('img.inv', 'invoice thumbnail', 'p-kwame-invoice-dlg', 1.2);
    const chips = page.locator('.docs button.doc'); const n = Math.min(4, await chips.count());
    for (let i = 0; i < n; i++) { const b = await chips.nth(i).boundingBox(); await glideTo(b.x + b.width * 0.55, b.y + b.height * 0.6, 600); await sleep(260); }
    await clickLoc('.tab[data-id="wallet-swap"]', 'tab wallet-swap'); await sleep(400); await parkSlipBlank();
    await showDoc(chip('email-ama.txt'), 'chip email-ama.txt', 'p-ama-email-dlg', 1.2);
    await clickLoc('.tab[data-id="injection"]', 'tab injection'); await sleep(400); await parkSlipBlank();
    await hold('p-efua-case', 1);
    await showDoc(page.locator('img.inv'), 'efua invoice', 'p-efua-invoice-dlg', 1.5);
    await showDoc(chip('email-efua.txt'), 'chip email-efua.txt', 'p-efua-email-dlg', 1.2);
    await toggleTheme('dark', 'p-theme-dark');
    await showDoc(chip('email-efua.txt'), 'chip email-efua.txt (dark)', 'p-dark-email-dlg', 1);
    await scrollElTop('#claims', 16, 'claims to top');
    await parkLeft(300);
    await hold('p-claims-dark', 1);
    const cc = await box('#claims'); await glideTo(cc.x + 150, cc.y + 60, 600);
    await hold('p-cursor-on-dark-card', 0.6);
    await toggleTheme('light', 'p-theme-light');
    await scrollElTop('#claims', 16, 'claims to top');
    await parkLeft(300);
    await hold('p-claims', 1);
    await ensureInView('#ledger', { why: 'ledger' });
    const info = await getRects(); const rows = info.rects['a2a rows'] || [];
    for (let i = 0; i < rows.length; i++) { const r = rows[i]; await glideTo(r[0] + Math.min(150, r[2] * 0.45), r[1] + r[3] * 0.6, i === 0 ? 750 : 560); await sleep(300); }
    await parkRight(500);
    await hold('p-ledger', 1);
    const bt = await box('#bt'), bc = await box('#backtest');
    if (bt && bc) await glideTo(Math.min(bt.x + bt.width + 26, bc.x + bc.width - 20), bt.y + bt.height * 0.6, 780);
    await hold('p-backtest', 1);
    await scrollToY(0, 'back to top');
    await glideTo(HERO_PARK[0], HERO_PARK[1], 800);
    await hold('p-end', 1);
  }

  await main();
})();
