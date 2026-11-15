/* core.js — pure story logic shared by Node (render.cjs: validation, --timeline) and the browser stage.
   No DOM, no I/O. Everything here is a pure function of (story, format, sources, time). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StoryCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Canonical layouts (CSS px). `body` = the browser-window body where footage shows (stage coordinates).
  const CANON = {
    wide: { w: 1920, h: 1080, bar: 44, body: { x: 708, y: 205, w: 1140, h: 713 } },
    tall: { w: 1080, h: 1350, bar: 44, body: { x: 48, y: 426, w: 984, h: 840 } },
  };
  const EPS = 1e-6;
  const T = {
    capIn: 0.45, capStagger: 0.08, capOut: 0.25, capRise: 24,
    theme: 0.5, device: 0.4, progress: 0.3,
    calloutIn: 0.25, calloutOut: 0.2, calloutRing: 0.7, calloutMin: 1.0,
    chipFade: 0.15, dissolve: 0.2,
  };
  const EASE = {
    linear: (u) => u,
    inout: (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2),
    out: (u) => 1 - Math.pow(1 - u, 3),
  };

  const isNum = (v) => typeof v === 'number' && isFinite(v);
  const isStr = (v) => typeof v === 'string';
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const f3 = (v) => Number(v).toFixed(3);

  function suggest(k, allowed) {
    let best = null, bd = 3;
    for (const a of allowed) {
      const d = lev(k.toLowerCase(), a.toLowerCase());
      if (d < bd) { bd = d; best = a; }
    }
    return best ? ` (did you mean "${best}"?)` : '';
  }
  function lev(a, b) {
    const m = [];
    for (let i = 0; i <= a.length; i++) { m[i] = [i]; }
    for (let j = 0; j <= b.length; j++) m[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
      m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return m[a.length][b.length];
  }
  // Keys starting with "_" are treated as comments and ignored.
  function checkKeys(obj, where, required, optional, errs) {
    if (!isObj(obj)) { errs.push(`${where}: expected an object`); return false; }
    const allowed = required.concat(optional);
    for (const k of Object.keys(obj)) {
      if (k[0] === '_') continue;
      if (!allowed.includes(k)) errs.push(`${where}: unknown key "${k}"${suggest(k, allowed)}; allowed: ${allowed.join(', ')}`);
    }
    for (const k of required) if (!(k in obj)) errs.push(`${where}: missing required key "${k}"`);
    return true;
  }

  function fitRect(rect, sw, sh, aspect) {
    let [x, y, w, h] = rect;
    const cx = x + w / 2, cy = y + h / 2;
    if (w / h < aspect) w = h * aspect; else h = w / aspect;
    const k = Math.min(1, sw / w, sh / h);
    w *= k; h *= k;
    x = Math.min(Math.max(cx - w / 2, 0), sw - w);
    y = Math.min(Math.max(cy - h / 2, 0), sh - h);
    return [x, y, w, h];
  }
  const rectStr = (r) => '[' + r.map((v) => +v.toFixed(1)).join(',') + ']';
  const sameRect = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-6);

  function speedLabel(s) {
    return (s < 4 ? String(+s.toFixed(1)) : String(Math.round(s))) + '× speed';
  }

  function frameIndexAt(times, t) {
    let lo = 0, hi = times.length - 1, ans = 0;
    const tt = t + EPS;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] <= tt) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  /* compile(story, formatName, sources) -> {model, errors, warnings}
     sources = { capture: <frames.json object>|null, stills: { "/abs/img.png": {w,h} } } */
  function compile(story, fmt, sources) {
    const errs = [], warns = [];
    const done = (model) => ({ model: errs.length ? null : model, errors: errs, warnings: [...new Set(warns)] });
    if (!checkKeys(story, 'story', ['bpm', 'output_dir', 'formats', 'scenes'], ['fps', 'capture_dir', 'brand'], errs)) return done(null);
    const fps = story.fps === undefined ? 30 : story.fps;
    if (!isNum(fps) || fps <= 0) errs.push('story.fps: must be a positive number');
    if (!isNum(story.bpm) || story.bpm <= 0) errs.push('story.bpm: must be a positive number');
    if (!isStr(story.output_dir)) errs.push('story.output_dir: must be a path string');
    if (story.capture_dir !== undefined && !isStr(story.capture_dir)) errs.push('story.capture_dir: must be a path string');
    const brand = { url: '', name: '', credit: '' };
    if (story.brand !== undefined && checkKeys(story.brand, 'story.brand', [], ['url', 'name', 'credit'], errs)) {
      for (const k of ['url', 'name', 'credit']) if (story.brand[k] !== undefined) {
        if (!isStr(story.brand[k])) errs.push(`story.brand.${k}: must be a string`); else brand[k] = story.brand[k];
      }
    }
    let size = null;
    if (checkKeys(story.formats, 'story.formats', [], ['wide', 'tall'], errs)) {
      if (!CANON[fmt]) errs.push(`format "${fmt}": must be one of ${Object.keys(CANON).join(', ')}`);
      else if (!story.formats[fmt]) errs.push(`story.formats: no "${fmt}" entry`);
      else if (checkKeys(story.formats[fmt], `story.formats.${fmt}`, ['w', 'h'], [], errs)) {
        const { w, h } = story.formats[fmt], c = CANON[fmt];
        if (!Number.isInteger(w) || !Number.isInteger(h) || w % 2 || h % 2 || w <= 0) errs.push(`story.formats.${fmt}: w and h must be positive even integers`);
        else if (Math.abs(w / h - c.w / c.h) > 1e-3) errs.push(`story.formats.${fmt}: ${w}x${h} must keep the ${fmt} layout aspect ${c.w}:${c.h} (e.g. ${c.w}x${c.h})`);
        else size = { w, h };
      }
    }
    if (!Array.isArray(story.scenes) || !story.scenes.length) { errs.push('story.scenes: must be a non-empty array'); return done(null); }
    if (errs.length) return done(null);

    const canon = CANON[fmt], other = fmt === 'wide' ? 'tall' : 'wide';
    const aspect = canon.body.w / canon.body.h;
    const bar = 240 / story.bpm;
    const cap = sources && sources.capture;
    let capSrc = null, times = null, ids = null;
    if (cap) {
      const frames = (cap.frames || []).slice().sort((a, b) => a.t - b.t);
      if (!frames.length) errs.push('capture frames.json: no frames');
      const vw = cap.viewport ? cap.viewport[0] : cap.width / (cap.dpr || 1);
      const vh = cap.viewport ? cap.viewport[1] : cap.height / (cap.dpr || 1);
      capSrc = { kind: 'capture', w: vw, h: vh, scale: cap.width / vw };
      times = frames.map((f) => f.t); ids = frames.map((f) => f.i);
    }

    const scenes = [], seen = new Set();
    let start = 0;
    story.scenes.forEach((sc, i) => {
      const W = `scenes[${i}]` + (sc && isStr(sc.id) ? ` (${sc.id})` : '');
      if (!checkKeys(sc, W, ['id', 'bars'], ['theme', 'number', 'name', 'caption', 'footage', 'still', 'camera', 'callouts', 'sfx', 'footage_cut'], errs)) return;
      if (!isStr(sc.id) || !/^[A-Za-z0-9_.-]+$/.test(sc.id)) errs.push(`${W}.id: must be a string of letters, digits, _ . -`);
      else if (seen.has(sc.id)) errs.push(`${W}.id: duplicate scene id`);
      seen.add(sc.id);
      if (!isNum(sc.bars) || sc.bars <= 0) { errs.push(`${W}.bars: must be a positive number`); return; }
      if (!Number.isInteger(sc.bars)) warns.push(`${W}.bars: ${sc.bars} is not a whole number of bars; later scenes will not start on a bar`);
      const theme = sc.theme === undefined ? 'light' : sc.theme;
      if (theme !== 'light' && theme !== 'dark') errs.push(`${W}.theme: must be "light" or "dark"`);
      for (const k of ['number', 'name']) if (sc[k] !== undefined && !isStr(sc[k])) errs.push(`${W}.${k}: must be a string`);
      const cut = sc.footage_cut === undefined ? 'cut' : sc.footage_cut;
      if (cut !== 'cut' && cut !== 'dissolve') errs.push(`${W}.footage_cut: must be "cut" or "dissolve"`);
      const dur = sc.bars * bar;
      const S = { i, id: sc.id, bars: sc.bars, start, end: start + dur, dur, theme, number: sc.number || '', name: sc.name || '',
        caption: null, src: null, segs: [], chips: [], cam: null, moving: [], callouts: [], sfx: [], cut, hasDevice: false };
      start += dur;

      // caption
      if (sc.caption !== undefined && checkKeys(sc.caption, `${W}.caption`, [], ['light', 'bold', 'sentence'], errs)) {
        const c = {};
        for (const k of ['light', 'bold', 'sentence']) {
          if (sc.caption[k] === undefined) continue;
          if (!isStr(sc.caption[k])) { errs.push(`${W}.caption.${k}: must be a string`); continue; }
          c[k] = sc.caption[k];
          if (k === 'sentence' && c[k].length > 80) warns.push(`${W}.caption.sentence: ${c[k].length} chars (> 80)`);
          if (k !== 'sentence' && c[k].length > 22) warns.push(`${W}.caption.${k}: ${c[k].length} chars (> 22) — the headline line will shrink or wrap`);
        }
        S.caption = c;
      }

      // source: footage | still | none
      if (sc.footage !== undefined && sc.still !== undefined) errs.push(`${W}: use either "footage" or "still", not both`);
      else if (sc.footage !== undefined) {
        if (!Array.isArray(sc.footage) || !sc.footage.length) errs.push(`${W}.footage: must be a non-empty array of segments`);
        else if (!capSrc) errs.push(`${W}.footage: needs story.capture_dir with a readable frames.json`);
        else {
          S.src = capSrc; S.hasDevice = true;
          let o = 0;
          sc.footage.forEach((g, j) => {
            const G = `${W}.footage[${j}]`;
            if (!checkKeys(g, G, ['in'], ['out', 'dur', 'hold'], errs)) return;
            if (!isNum(g.in) || g.in < 0) { errs.push(`${G}.in: must be a number >= 0`); return; }
            let seg;
            if (g.hold !== undefined) {
              if (g.out !== undefined || g.dur !== undefined) { errs.push(`${G}: "hold" cannot be combined with "out"/"dur"`); return; }
              if (!isNum(g.hold) || g.hold <= 0) { errs.push(`${G}.hold: must be a positive number`); return; }
              seg = { kind: 'hold', in: g.in, out: g.in, o0: o, o1: o + g.hold, speed: 0 };
            } else {
              if (!isNum(g.out) || g.out <= g.in) { errs.push(`${G}.out: must be a number > in`); return; }
              if (g.dur !== undefined && (!isNum(g.dur) || g.dur <= 0)) { errs.push(`${G}.dur: must be a positive number`); return; }
              const d = g.dur === undefined ? g.out - g.in : g.dur;
              seg = { kind: g.dur === undefined ? 'real' : 'remap', in: g.in, out: g.out, o0: o, o1: o + d, speed: (g.out - g.in) / d };
              if (seg.kind === 'remap' && seg.speed >= 1.5) S.chips.push({ t0: seg.o0, t1: Math.min(seg.o1, dur), text: speedLabel(seg.speed) });
            }
            const last = times[times.length - 1];
            if (seg.in > last + EPS || seg.out > last + 1.0) warns.push(`${G}: source time ${f3(seg.in)}–${f3(seg.out)} runs past the last captured frame (t=${f3(last)})`);
            if (seg.in < times[0] - EPS) warns.push(`${G}: in=${f3(seg.in)} is before the first captured frame (t=${f3(times[0])})`);
            o = seg.o1; S.segs.push(seg);
          });
          if (o > dur + EPS) errs.push(`${W}.footage: segments total ${f3(o)} s but the scene is ${f3(dur)} s (${sc.bars} bars) — ${f3(o - dur)} s too long`);
          else if (o < dur - EPS) warns.push(`${W}.footage: segments total ${f3(o)} s, scene is ${f3(dur)} s — last frame held for ${f3(dur - o)} s`);
        }
      } else if (sc.still !== undefined) {
        const info = isStr(sc.still) && sources && sources.stills && sources.stills[sc.still];
        if (!isStr(sc.still)) errs.push(`${W}.still: must be a path string`);
        else if (!info) errs.push(`${W}.still: cannot read image ${sc.still}`);
        else { S.src = { kind: 'still', w: info.w, h: info.h, scale: 1, path: sc.still }; S.hasDevice = true; }
      }

      // camera
      if (sc.camera !== undefined) checkKeys(sc.camera, `${W}.camera`, [], ['wide', 'tall'], errs);
      if (S.src) {
        let kfs = isObj(sc.camera) ? (sc.camera[fmt] || sc.camera[other]) : null;
        const usedFmt = isObj(sc.camera) && sc.camera[fmt] ? fmt : other;
        if (kfs !== null && kfs !== undefined && (!Array.isArray(kfs) || !kfs.length)) { errs.push(`${W}.camera.${usedFmt}: must be a non-empty array of keyframes`); kfs = null; }
        const user = !!kfs;
        if (!kfs) kfs = [{ t: 0, rect: [0, 0, S.src.w, S.src.h] }];
        const cam = [];
        kfs.forEach((kf, j) => {
          const K = `${W}.camera.${usedFmt}[${j}]`;
          if (!checkKeys(kf, K, ['t', 'rect'], ['ease', 'move'], errs)) return;
          if (!isNum(kf.t) || kf.t < 0) { errs.push(`${K}.t: must be a number >= 0`); return; }
          if (!Array.isArray(kf.rect) || kf.rect.length !== 4 || !kf.rect.every(isNum) || kf.rect[2] <= 0 || kf.rect[3] <= 0) { errs.push(`${K}.rect: must be [x,y,w,h] with w,h > 0`); return; }
          const ease = kf.ease === undefined ? 'linear' : kf.ease;
          if (!EASE[ease]) { errs.push(`${K}.ease: must be one of ${Object.keys(EASE).join(', ')}`); return; }
          const rect = fitRect(kf.rect, S.src.w, S.src.h, aspect);
          const [x, y, w, h] = kf.rect;
          if (user && (x < rect[0] - 0.01 || y < rect[1] - 0.01 || x + w > rect[0] + rect[2] + 0.01 || y + h > rect[1] + rect[3] + 0.01))
            warns.push(`[${fmt}] camera rect ${rectStr(kf.rect)} does not fit the ${fmt} device (aspect ${aspect.toFixed(3)}) inside the ${S.src.w}x${S.src.h} source; showing ${rectStr(rect)} instead`);
          const prev = cam[cam.length - 1];
          let t0 = kf.t;
          if (!prev) { if (kf.move !== undefined) warns.push(`${K}.move: ignored on the first keyframe`); }
          else {
            if (kf.t < prev.t1 - EPS) { errs.push(`${K}.t: keyframes must be in ascending time order`); return; }
            const gap = kf.t - prev.t1;
            let m = kf.move === undefined ? gap : kf.move;
            if (!isNum(m) || m < 0) { errs.push(`${K}.move: must be a number >= 0`); return; }
            if (m > gap + EPS) { errs.push(`${K}.move: ${m} s is longer than the gap to the previous keyframe (${f3(gap)} s)`); return; }
            t0 = kf.t - m;
            if (m > EPS && !sameRect(prev.rect, rect)) S.moving.push([t0, kf.t]);
          }
          if (kf.t > dur + EPS) warns.push(`${K}.t: ${kf.t} is after the scene end (${f3(dur)} s)`);
          cam.push({ t0, t1: kf.t, rect, ease, req: kf.rect });
        });
        S.cam = cam.length ? cam : [{ t0: 0, t1: 0, rect: fitRect([0, 0, S.src.w, S.src.h], S.src.w, S.src.h, aspect), ease: 'linear' }];
      } else if (sc.camera !== undefined) warns.push(`${W}.camera: ignored (scene has no footage/still)`);

      // callouts
      if (sc.callouts !== undefined) {
        if (!Array.isArray(sc.callouts)) errs.push(`${W}.callouts: must be an array`);
        else if (!S.src) errs.push(`${W}.callouts: scene has no footage/still to point at`);
        else sc.callouts.forEach((c, j) => {
          const K = `${W}.callouts[${j}]`;
          if (!checkKeys(c, K, ['t', 'end', 'at', 'label'], ['side'], errs)) return;
          const side = c.side === undefined ? 'right' : c.side;
          if (!['left', 'right', 'top', 'bottom'].includes(side)) { errs.push(`${K}.side: must be left, right, top or bottom`); return; }
          if (!isNum(c.t) || c.t < 0 || !isNum(c.end)) { errs.push(`${K}: t and end must be numbers, t >= 0`); return; }
          if (!Array.isArray(c.at) || c.at.length !== 2 || !c.at.every(isNum)) { errs.push(`${K}.at: must be [x,y] in source CSS px`); return; }
          if (!isStr(c.label) || !c.label) { errs.push(`${K}.label: must be a non-empty string`); return; }
          if (c.end > dur + EPS) { errs.push(`${K}.end: ${c.end} is after the scene end (${f3(dur)} s)`); return; }
          if (c.end - c.t < T.calloutMin - EPS) { errs.push(`${K}: visible for ${f3(c.end - c.t)} s — callouts must be visible for at least ${T.calloutMin.toFixed(1)} s`); return; }
          for (const [a, b] of S.moving) if (c.t < b - EPS && c.end > a + EPS)
            errs.push(`[${fmt}] ${K}: visible ${f3(c.t)}–${f3(c.end)} while the camera is moving (${f3(a)}–${f3(b)})`);
          const r = cameraAt(S, (c.t + c.end) / 2);
          const px = (c.at[0] - r[0]) * canon.body.w / r[2], py = (c.at[1] - r[1]) * canon.body.h / r[3];
          if (px < 0 || py < 0 || px > canon.body.w || py > canon.body.h)
            errs.push(`[${fmt}] ${K}.at: point [${c.at}] is outside the visible camera rect ${rectStr(r)}`);
          else {
            const lw = c.label.length * 9.6 + 30, reach = 56;
            const over = side === 'left' ? px - reach - lw < 0 : side === 'right' ? px + reach + lw > canon.body.w
              : side === 'top' ? py - reach - 40 < 0 || px - lw / 2 < 0 || px + lw / 2 > canon.body.w
              : py + reach + 40 > canon.body.h || px - lw / 2 < 0 || px + lw / 2 > canon.body.w;
            if (over) warns.push(`[${fmt}] ${K}: label on side "${side}" probably extends beyond the device body (dot at ${px.toFixed(0)},${py.toFixed(0)} of ${canon.body.w}x${canon.body.h}) — check with --frame-at`);
          }
          S.callouts.push({ t: c.t, end: c.end, at: c.at, label: c.label, side });
        });
      }
      // sfx
      if (sc.sfx !== undefined) {
        if (!Array.isArray(sc.sfx)) errs.push(`${W}.sfx: must be an array`);
        else sc.sfx.forEach((x, j) => {
          const K = `${W}.sfx[${j}]`;
          if (!checkKeys(x, K, ['t', 'name'], [], errs)) return;
          if (!isNum(x.t) || x.t < 0 || !isStr(x.name) || !x.name) { errs.push(`${K}: needs t >= 0 and a name string`); return; }
          if (x.t > dur + EPS) warns.push(`${K}.t: ${x.t} is after the scene end (${f3(dur)} s)`);
          S.sfx.push({ t: x.t, name: x.name });
        });
      }
      scenes.push(S);
    });
    const total = start;
    const nframes = Math.round(total * fps);
    scenes.forEach((s) => { s.f0 = Math.ceil(s.start * fps - 1e-6); });
    scenes.forEach((s, i) => { s.f1 = i + 1 < scenes.length ? scenes[i + 1].f0 : nframes; });
    return done({ fps, bpm: story.bpm, bar, total, nframes, format: fmt, size, canon, aspect, brand, scenes, times, ids,
      capture: capSrc, numbered: scenes.filter((s) => s.number).map((s) => s.i) });
  }

  function sceneAt(model, t) {
    const sc = model.scenes;
    let s = sc[0];
    for (let i = 1; i < sc.length; i++) { if (sc[i].start <= t + EPS) s = sc[i]; else break; }
    return s;
  }

  // Source time shown at scene-local time lt (seconds), or null if the scene has no footage.
  function sourceTimeAt(scene, lt) {
    const segs = scene.segs;
    if (!segs.length) return null;
    let s = segs[0];
    for (const g of segs) { if (g.o0 <= lt + EPS) s = g; else break; }
    if (s.kind === 'hold') return s.in;
    if (lt >= s.o1 - EPS) return s.out;                  // past the last segment: hold the frame at `out`
    return s.in + Math.max(lt - s.o0, 0) * s.speed;
  }

  function cameraAt(scene, lt) {
    const cam = scene.cam;
    let rect = cam[0].rect;
    for (let k = 1; k < cam.length; k++) {
      const kf = cam[k];
      if (lt >= kf.t1 - EPS) { rect = kf.rect; continue; }
      if (lt > kf.t0) {
        const e = EASE[kf.ease]((lt - kf.t0) / (kf.t1 - kf.t0));
        rect = rect.map((v, j) => v + (kf.rect[j] - v) * e);
      }
      break;
    }
    return rect;
  }

  return { CANON, T, EASE, compile, sceneAt, sourceTimeAt, cameraAt, frameIndexAt, fitRect, speedLabel, rectStr };
});
