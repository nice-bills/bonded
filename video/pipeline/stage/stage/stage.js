/* stage.js — window.stage.load(story, format) / await window.stage.seek(tSeconds)
   Every pixel is a pure function of t:  t -> view (plain data) -> DOM/canvas.
   anime.js timelines are built paused and only ever .seek()ed; they tween numbers on a plain object S
   (one property per tween, so the result never depends on seek history). No CSS transitions, no rAF. */
(function () {
  'use strict';
  const C = StoryCore, T = C.T;
  const THEME = {
    light: { bg: [255, 255, 248, 1], ink: [17, 17, 17, 1], soft: [61, 58, 51, 1], dim: [107, 103, 92, 1], hair: [228, 223, 207, 1],
      accent: [47, 93, 58, 1], red: [138, 59, 42, 1], chrome: [251, 249, 240, 1], pill: [241, 237, 224, 1], dot: [218, 213, 197, 1],
      shadow: [78, 66, 34, 0.22], shadow2: [78, 66, 34, 0.08] },
    dark: { bg: [15, 14, 12, 1], ink: [236, 230, 214, 1], soft: [201, 194, 176, 1], dim: [154, 147, 129, 1], hair: [52, 49, 42, 1],
      accent: [140, 197, 155, 1], red: [229, 154, 134, 1], chrome: [27, 25, 22, 1], pill: [38, 36, 31, 1], dot: [62, 58, 50, 1],
      shadow: [0, 0, 0, 0.6], shadow2: [0, 0, 0, 0.35] },
  };
  const KEYS = Object.keys(THEME.light);
  const MAX_BITMAPS = 5;
  const $ = (id) => document.getElementById(id);
  const r4 = (v) => Math.round(v * 1e4) / 1e4;
  const r2 = (v) => Math.round(v * 100) / 100;
  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  const mix = (a, b, u) => a.map((v, i) => v + (b[i] - v) * u);
  const css = (c) => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${r4(c[3])})`;

  let M = null, S = null, tl = null, lastSig = null, footSig = null, lastD = null, ctx = null, cw = 0, ch = 0;
  let caps = [], pns = [], cos = [], themeCuts = [], devCuts = [];
  const bitmaps = new Map(), stills = new Map();

  function loadBitmap(url) {
    return fetch(url).then((r) => { if (!r.ok) throw new Error(`cannot load ${url} (HTTP ${r.status})`); return r.blob(); })
      .then((b) => createImageBitmap(b, { colorSpaceConversion: 'none' }));
  }
  function getBitmap(url) {
    if (stills.has(url)) return stills.get(url);
    let p = bitmaps.get(url);
    if (p) { bitmaps.delete(url); bitmaps.set(url, p); return p; }   // LRU bump
    p = loadBitmap(url);
    bitmaps.set(url, p);
    while (bitmaps.size > MAX_BITMAPS) {
      const [k, old] = bitmaps.entries().next().value;
      bitmaps.delete(k); old.then((b) => b.close()).catch(() => {});
    }
    return p;
  }
  const stillUrl = (p) => '/file?path=' + encodeURIComponent(p);
  const frameUrl = (id) => '/capture/frames/' + String(id).padStart(6, '0') + '.jpg';

  function h(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }

  async function load(story, format) {
    const sources = { capture: null, stills: {} };
    if (story && story.capture_dir) {
      const r = await fetch('/capture/frames.json');
      if (r.ok) sources.capture = await r.json();
    }
    for (const sc of (story && story.scenes) || []) {
      if (sc && typeof sc.still === 'string' && !stills.has(stillUrl(sc.still))) {
        try { const b = await loadBitmap(stillUrl(sc.still)); stills.set(stillUrl(sc.still), Promise.resolve(b)); sources.stills[sc.still] = { w: b.width, h: b.height }; } catch (e) { /* reported by compile */ }
      } else if (sc && typeof sc.still === 'string') { const b = await stills.get(stillUrl(sc.still)); sources.stills[sc.still] = { w: b.width, h: b.height }; }
    }
    const res = C.compile(story, format, sources);
    if (res.errors.length) throw new Error('story errors:\n' + res.errors.join('\n'));
    M = res.model;
    build();
    await document.fonts.ready;
    fitHeadlines();
    buildTimeline();
    lastSig = footSig = lastD = null;
    await seek(0);
    return { nframes: M.nframes, fps: M.fps, total: M.total, body: M.canon.body, dpr: window.devicePixelRatio };
  }

  function build() {
    const stage = $('stage'), L = M.canon;
    stage.className = M.format;
    $('brand').textContent = M.brand.name;
    $('credit').innerHTML = M.brand.credit || '';
    $('url').textContent = M.brand.url;
    $('url').style.visibility = M.brand.url ? 'visible' : 'hidden';
    const dev = $('device');
    dev.style.left = (L.body.x - 1) + 'px'; dev.style.top = (L.body.y - L.bar - 1) + 'px';
    dev.style.width = L.body.w + 'px'; dev.style.height = (L.bar + L.body.h) + 'px';
    const body = $('body'); body.style.width = L.body.w + 'px'; body.style.height = L.body.h + 'px';
    const cv = $('footage');
    cw = cv.width = Math.round(L.body.w * window.devicePixelRatio); ch = cv.height = Math.round(L.body.h * window.devicePixelRatio);
    ctx = cv.getContext('2d', { alpha: false });
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';

    const capRoot = $('captions'), coRoot = $('callouts'), pg = $('progress');
    capRoot.textContent = ''; coRoot.textContent = ''; pg.textContent = '';
    caps = []; cos = []; pns = [];
    M.scenes.forEach((sc) => {
      const c = sc.caption || {}, parts = [];
      const root = h('div', 'cap' + (sc.hasDevice ? '' : ' solo'));
      if (sc.number || sc.name) {
        const e = h('div', 'eyebrow');
        if (sc.number) e.appendChild(h('span', 'num', sc.number));
        if (sc.name) e.appendChild(h('span', 'nm', sc.name));
        root.appendChild(e); parts.push(e);
      }
      let hl = null; const lines = [];
      if (c.light || c.bold) {
        hl = h('div', 'hl');
        for (const [k, cls] of [['light', 'l1'], ['bold', 'l2']]) if (c[k]) {
          const d = h('div', cls); d.appendChild(h('span', '', c[k])); hl.appendChild(d); parts.push(d); lines.push(d);
        }
        root.appendChild(hl);
      }
      if (c.sentence) { const p = h('div', 'sentence', c.sentence); root.appendChild(p); parts.push(p); }
      if (parts.length) capRoot.appendChild(root);
      caps.push(parts.length ? { root, parts, hl, lines, solo: !sc.hasDevice } : null);
      cos.push(sc.callouts.map((co) => {
        const r = h('div', 'callout ' + co.side), ring = h('div', 'ring'), arm = h('div', 'arm');
        arm.appendChild(h('div', 'leader')); arm.appendChild(h('div', 'label', co.label));
        r.appendChild(ring); r.appendChild(arm); r.appendChild(h('div', 'dot'));
        coRoot.appendChild(r);
        return { root: r, ring, arm };
      }));
    });
    M.numbered.forEach((i) => {
      const s = h('span', 'pn'); s.appendChild(h('b', '', M.scenes[i].number)); const u = h('i'); s.appendChild(u);
      s.firstChild.style.fontWeight = '500';
      pg.appendChild(s); pns.push({ root: s, bar: u });
    });
  }

  function fitHeadlines() {
    const wide = M.format === 'wide';
    caps.forEach((c) => {
      if (!c || !c.hl) return;
      const P = wide ? (c.solo ? [132, 96, 112] : [80, 62, 72]) : (c.solo ? [100, 72, 84] : [72, 58, 64]);
      c.root.style.display = 'flex'; c.root.style.visibility = 'hidden';
      c.hl.classList.add('nowrap'); c.hl.style.fontSize = P[0] + 'px';
      const colW = c.root.clientWidth;
      let w = 0; c.lines.forEach((l) => { w = Math.max(w, l.firstChild.getBoundingClientRect().width); });
      let size = P[0];
      if (w > colW) {
        const s = P[0] * colW / w;
        if (s >= P[1]) size = Math.floor(s * 0.995); else { size = P[2]; c.hl.classList.remove('nowrap'); }
      }
      c.hl.style.fontSize = size + 'px';
      c.root.style.display = ''; c.root.style.visibility = '';
    });
  }

  function buildTimeline() {
    S = {};
    tl = anime.timeline({ autoplay: false, easing: 'linear' });
    const tween = (key, start, dur, easing) => {
      S[key] = 0;
      tl.add({ targets: S, [key]: [0, 1], duration: dur * 1000, easing: easing || 'linear' }, start * 1000);
    };
    const sc = M.scenes, last = sc.length - 1;
    themeCuts = []; devCuts = [];
    sc.forEach((s, i) => {
      const c = caps[i];
      if (c) {
        // first scene: fully formed at t=0 (thumbnail). last scene: never animates out.
        c.parts.forEach((_, k) => { if (i === 0) S[`c${i}p${k}`] = 1; else tween(`c${i}p${k}`, s.start + k * T.capStagger, T.capIn, 'easeOutCubic'); });
        if (i === last) S[`c${i}o`] = 0; else tween(`c${i}o`, s.end - T.capOut, T.capOut, 'easeInQuad');
      }
      if (i > 0 && s.theme !== sc[i - 1].theme) { tween(`th${i}`, s.start, T.theme, 'easeInOutSine'); themeCuts.push({ key: `th${i}`, sign: s.theme === 'dark' ? 1 : -1 }); }
      if (i > 0 && s.hasDevice !== sc[i - 1].hasDevice) { tween(`dv${i}`, s.start, T.device, 'easeInOutSine'); devCuts.push({ key: `dv${i}`, sign: s.hasDevice ? 1 : -1 }); }
      if (s.number) {
        if (i === 0) S[`g${i}i`] = 1; else tween(`g${i}i`, s.start, T.progress, 'easeOutQuad');
        if (i === last) S[`g${i}o`] = 0; else tween(`g${i}o`, s.end, T.progress, 'easeOutQuad');
      }
      s.callouts.forEach((co, j) => {
        tween(`k${i}_${j}i`, s.start + co.t, T.calloutIn, 'easeOutCubic');
        tween(`k${i}_${j}o`, s.start + co.end - T.calloutOut, T.calloutOut, 'easeInQuad');
        tween(`k${i}_${j}r`, s.start + co.t, T.calloutRing, 'easeOutCubic');
      });
    });
  }

  function footLayer(sc, lt, a) {
    const r = C.cameraAt(sc, lt).map(r4);
    if (sc.src.kind === 'still') return { u: stillUrl(sc.src.path), r, k: 1, a };
    const idx = C.frameIndexAt(M.times, C.sourceTimeAt(sc, lt));
    return { u: frameUrl(M.ids[idx]), r, k: sc.src.scale, a };
  }

  // t -> plain-data description of the frame. Everything applyDom/drawFootage do comes from this object.
  function viewAt(t) {
    t = Math.min(Math.max(t, 0), Math.max(0, (M.nframes - 1) / M.fps));
    tl.seek(t * 1000);
    const sc = C.sceneAt(M, t), i = sc.i, lt = t - sc.start, L = M.canon;
    let D = M.scenes[0].theme === 'dark' ? 1 : 0, dev = M.scenes[0].hasDevice ? 1 : 0;
    for (const b of themeCuts) D += b.sign * S[b.key];
    for (const b of devCuts) dev += b.sign * S[b.key];
    const v = { si: i, D: r4(clamp01(D)), dev: r4(clamp01(dev)), cap: null, prog: [], foot: [], chip: null, co: [] };
    if (caps[i]) v.cap = { i, p: caps[i].parts.map((_, k) => r4(S[`c${i}p${k}`])), o: r4(1 - S[`c${i}o`]) };
    v.prog = M.numbered.map((n) => r4(S[`g${n}i`] * (1 - S[`g${n}o`])));
    const prev = i > 0 ? M.scenes[i - 1] : null;
    const prevLt = prev ? (sc.f0 - 1) / M.fps - prev.start : 0;
    if (sc.src) {
      if (sc.cut === 'dissolve' && prev && prev.src && lt < T.dissolve - 1e-6) {
        v.foot.push(footLayer(prev, prevLt, 1));
        v.foot.push(footLayer(sc, lt, r4((lt + 1 / M.fps) / (T.dissolve + 1 / M.fps))));
      } else v.foot.push(footLayer(sc, lt, 1));
      for (const c of sc.chips) {
        const op = clamp01(Math.min((lt - c.t0 + 1 / M.fps) / T.chipFade, (c.t1 - lt) / T.chipFade));
        if (lt >= c.t0 - 1e-6 && lt < c.t1 - 1e-6 && op > 0) v.chip = { text: c.text, op: r4(op) };
      }
      const rect = C.cameraAt(sc, lt);
      sc.callouts.forEach((co, j) => {
        const a = S[`k${i}_${j}i`], op = a * (1 - S[`k${i}_${j}o`]);
        if (op <= 0) return;
        v.co.push({ j, x: r2((co.at[0] - rect[0]) * L.body.w / rect[2]), y: r2((co.at[1] - rect[1]) * L.body.h / rect[3]),
          op: r4(op), s: r2((1 - a) * 10), ring: r4(S[`k${i}_${j}r`]) });
      });
    } else if (prev && prev.src && v.dev > 0) v.foot.push(footLayer(prev, prevLt, 1));   // device fading out keeps its last frame
    return v;
  }

  async function drawFootage(layers) {
    const sig = JSON.stringify(layers);
    if (sig === footSig) return;
    const bmps = await Promise.all(layers.map((l) => getBitmap(l.u)));
    ctx.globalAlpha = 1; ctx.fillStyle = '#fffff8'; ctx.fillRect(0, 0, cw, ch);
    layers.forEach((l, n) => {
      ctx.globalAlpha = l.a;
      ctx.drawImage(bmps[n], l.r[0] * l.k, l.r[1] * l.k, l.r[2] * l.k, l.r[3] * l.k, 0, 0, cw, ch);
    });
    ctx.globalAlpha = 1;
    footSig = sig;
  }

  function applyDom(v) {
    const stage = $('stage');
    const col = {};
    for (const k of KEYS) col[k] = mix(THEME.light[k], THEME.dark[k], v.D);
    if (v.D !== lastD) {
      for (const k of KEYS) stage.style.setProperty('--' + k, css(col[k]));
      $('glow-light').style.opacity = r4(1 - v.D); $('glow-dark').style.opacity = v.D;
      document.body.style.background = css(col.bg);
      lastD = v.D;
    }
    const dev = $('device');
    dev.style.visibility = v.dev > 0 ? 'visible' : 'hidden'; dev.style.opacity = v.dev;
    caps.forEach((c, i) => {
      if (!c) return;
      if (!v.cap || v.cap.i !== i) { c.root.style.display = 'none'; return; }
      c.root.style.display = 'flex';
      c.parts.forEach((p, k) => {
        const a = v.cap.p[k];
        p.style.opacity = r4(a * v.cap.o);
        p.style.transform = a < 1 ? `translateY(${r2((1 - a) * T.capRise)}px)` : 'none';
      });
    });
    pns.forEach((p, n) => {
      const a = v.prog[n];
      p.root.style.color = css(mix([col.dim[0], col.dim[1], col.dim[2], 0.5], col.ink, a));
      p.bar.style.opacity = a;
    });
    const chip = $('chip');
    if (v.chip) { chip.textContent = v.chip.text; chip.style.visibility = 'visible'; chip.style.opacity = v.chip.op; }
    else chip.style.visibility = 'hidden';
    cos.forEach((list, si) => list.forEach((c, j) => {
      const o = v.si === si ? v.co.find((x) => x.j === j) : null;
      if (!o) { c.root.style.display = 'none'; return; }
      c.root.style.display = 'block';
      c.root.style.left = o.x + 'px'; c.root.style.top = o.y + 'px'; c.root.style.opacity = o.op;
      const side = M.scenes[si].callouts[j].side;
      const d = side === 'left' ? [o.s, 0] : side === 'right' ? [-o.s, 0] : side === 'top' ? [0, o.s] : [0, -o.s];
      c.arm.style.transform = o.s ? `translate(${d[0]}px,${d[1]}px)` : 'none';
      c.ring.style.transform = `scale(${r4(1 + 2.4 * o.ring)})`; c.ring.style.opacity = r4(0.75 * (1 - o.ring));
    }));
  }

  async function seek(t) {
    if (!M) throw new Error('stage.load() first');
    const v = viewAt(t);
    const sig = JSON.stringify(v);
    if (sig !== lastSig) {
      await drawFootage(v.foot);
      applyDom(v);
      lastSig = sig;
    }
    void $('stage').offsetHeight;            // flush style + layout before the caller screenshots
    // warm the decoder for the next frame (does not affect what is drawn now)
    const nt = t + 1 / M.fps;
    if (nt < M.total) { const ns = C.sceneAt(M, nt); if (ns.src && ns.src.kind === 'capture') getBitmap(footLayer(ns, nt - ns.start, 1).u).catch(() => {}); }
    return sig;
  }

  // Debug helper for --frame-at: what is on screen at t.
  function describe(t) {
    const sc = C.sceneAt(M, t), lt = t - sc.start, o = { scene: sc.id, local: r4(lt) };
    if (sc.src) {
      o.camera = C.cameraAt(sc, lt).map(r2);
      if (sc.src.kind === 'capture') { const st = C.sourceTimeAt(sc, lt), idx = C.frameIndexAt(M.times, st); o.source_t = r4(st); o.frame = M.ids[idx]; o.frame_t = M.times[idx]; }
    }
    return o;
  }

  window.stage = { load, seek, describe };
})();
