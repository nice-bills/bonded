#!/usr/bin/env node
/* render.cjs — render a story.json through the HTML stage (headless Chromium) into a video-only H.264 MP4.

   node render.cjs story.json --format wide|tall [--scenes id1,id2] [--draft] [--timeline]
                              [--frame-at T out.png]... [--workers N]
   T = absolute seconds, or "sceneid" / "sceneid+1.25" (seconds from that scene's start).
   Output: <output_dir>/<format>[.draft][.<scene ids>].mp4   (+ <output_dir>/cues.json) */
'use strict';
const fs = require('fs'), path = require('path'), http = require('http');
const { spawn, spawnSync } = require('child_process');
const core = require('./stage/core.js');
const EDIT = __dirname;

function die(msg) { console.error(msg); process.exit(1); }

// ---------- story loading ----------
function imageSize(file) {
  const b = fs.readFileSync(file);
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (b[0] === 0xff && b[1] === 0xd8) {
    let p = 2;
    while (p + 9 < b.length) {
      if (b[p] !== 0xff) { p++; continue; }
      const m = b[p + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: b.readUInt16BE(p + 7), h: b.readUInt16BE(p + 5) };
      p += 2 + b.readUInt16BE(p + 2);
    }
  }
  throw new Error('unsupported image (need PNG or JPEG)');
}

function loadStory(file) {
  let story;
  try { story = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { die(`${file}: ${e.message}`); }
  const base = path.dirname(path.resolve(file));
  const abs = (p) => (typeof p === 'string' ? path.resolve(base, p) : p);
  if (story && typeof story === 'object') {
    if (story.capture_dir !== undefined) story.capture_dir = abs(story.capture_dir);
    if (story.output_dir !== undefined) story.output_dir = abs(story.output_dir);
    if (Array.isArray(story.scenes)) for (const s of story.scenes) if (s && s.still !== undefined) s.still = abs(s.still);
  }
  return story;
}

function loadSources(story) {
  const src = { capture: null, stills: {} }, notes = [];
  if (story && typeof story.capture_dir === 'string') {
    const f = path.join(story.capture_dir, 'frames.json');
    try { src.capture = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { notes.push(`capture: cannot read ${f}: ${e.message}`); }
  }
  for (const s of (story && Array.isArray(story.scenes) ? story.scenes : [])) {
    if (s && typeof s.still === 'string' && !src.stills[s.still]) {
      try { src.stills[s.still] = imageSize(s.still); } catch (e) { notes.push(`still ${s.still}: ${e.message}`); }
    }
  }
  return { src, notes };
}

function compileOrDie(story, fmt, quiet) {
  const { src, notes } = loadSources(story);
  const res = core.compile(story, fmt, src);
  if (res.errors.length) {
    console.error(`ERROR: story is not renderable (${res.errors.length} problem${res.errors.length > 1 ? 's' : ''}):`);
    for (const e of res.errors.concat(notes)) console.error('  - ' + e);
    process.exit(1);
  }
  if (!quiet && res.warnings.length) console.error(`(${res.warnings.length} warning${res.warnings.length > 1 ? 's' : ''} — see --timeline)`);
  return { model: res.model, warnings: res.warnings, src };
}

// ---------- timeline / cues ----------
const f3 = (v) => v.toFixed(3);
function cuesOf(M) {
  const sfx = [];
  for (const s of M.scenes) for (const x of s.sfx) sfx.push({ t: +(s.start + x.t).toFixed(4), name: x.name });
  sfx.sort((a, b) => a.t - b.t);
  return { bpm: M.bpm, duration: +M.total.toFixed(4),
    scenes: M.scenes.map((s) => ({ id: s.id, start: +s.start.toFixed(4), end: +s.end.toFixed(4), theme: s.theme })), sfx };
}
function writeCues(story, M) {
  fs.mkdirSync(story.output_dir, { recursive: true });
  const f = path.join(story.output_dir, 'cues.json');
  fs.writeFileSync(f, JSON.stringify(cuesOf(M), null, 2) + '\n');
  return f;
}
function printTimeline(story, M, warnings) {
  const b = M.canon.body, out = [];
  out.push(`format ${M.format}: ${M.size.w}x${M.size.h} @ ${M.fps} fps   bpm ${M.bpm} (1 bar = ${f3(M.bar)} s)`);
  out.push(`device body: ${b.w}x${b.h} CSS px (aspect ${M.aspect.toFixed(4)}) at stage x=${b.x}, y=${b.y}` +
    (M.capture ? `   capture source: ${M.capture.w}x${M.capture.h} CSS px, ${M.times.length} frames, t=${f3(M.times[0])}…${f3(M.times[M.times.length - 1])}` : ''));
  out.push('');
  for (const s of M.scenes) {
    out.push(`${String(s.i + 1).padStart(2)}  ${s.id.padEnd(14)} ${f3(s.start).padStart(8)} → ${f3(s.end).padStart(8)}  (${s.bars} bar${s.bars === 1 ? '' : 's'}, ${f3(s.dur)} s, frames ${s.f0}–${s.f1 - 1})  ${s.theme}` +
      (s.number || s.name ? `  "${[s.number, s.name].filter(Boolean).join(' ')}"` : '') + (s.src ? '' : '  [no device]') + (s.cut !== 'cut' ? `  footage ${s.cut}` : ''));
    if (s.src && s.src.kind === 'still') out.push(`      still    ${s.src.path} (${s.src.w}x${s.src.h} px)`);
    for (const g of s.segs) {
      const span = `out ${f3(g.o0)}–${f3(g.o1)} (abs ${f3(s.start + g.o0)}–${f3(s.start + g.o1)})`;
      out.push(g.kind === 'hold' ? `      footage  ${span}  src ${f3(g.in)} HOLD ${f3(g.o1 - g.o0)} s`
        : `      footage  ${span}  src ${f3(g.in)}–${f3(g.out)}  ${g.speed.toFixed(2)}x` + (g.kind === 'remap' && g.speed >= 1.5 ? `  chip "${core.speedLabel(g.speed)}"` : ''));
    }
    if (s.segs.length) { const e = s.segs[s.segs.length - 1].o1; if (e < s.dur - 1e-6) out.push(`      footage  out ${f3(e)}–${f3(s.dur)}  last frame held ${f3(s.dur - e)} s`); }
    if (s.cam) s.cam.forEach((k, j) => {
      out.push(`      camera   ${j === 0 || k.t0 === k.t1 ? `t=${f3(k.t1)}` : `move ${f3(k.t0)}–${f3(k.t1)} (${k.ease})`}  → ${core.rectStr(k.rect)}` +
        (k.req && core.rectStr(k.req) !== core.rectStr(k.rect) ? `   (asked ${core.rectStr(k.req)})` : ''));
    });
    for (const c of s.callouts) out.push(`      callout  ${f3(c.t)}–${f3(c.end)} (abs ${f3(s.start + c.t)}–${f3(s.start + c.end)})  at [${c.at}] ${c.side}  "${c.label}"`);
    for (const x of s.sfx) out.push(`      sfx      ${f3(x.t)} (abs ${f3(s.start + x.t)})  ${x.name}`);
  }
  const bars = M.scenes.reduce((a, s) => a + s.bars, 0);
  out.push('');
  out.push(`total: ${bars} bars = ${f3(M.total)} s = ${M.nframes} frames`);
  console.log(out.join('\n'));
  if (warnings.length) { console.log(`\nwarnings (${warnings.length}):`); for (const w of warnings) console.log('  ! ' + w); }
}

// ---------- local HTTP server (stage + capture frames + stills) ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
function startServer(story) {
  const stills = new Set(story.scenes.map((s) => s.still).filter(Boolean));
  const inside = (root, rel) => { const f = path.resolve(root, '.' + path.posix.normalize('/' + rel)); return f.startsWith(path.resolve(root) + path.sep) ? f : null; };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    let file = null;
    const p = decodeURIComponent(u.pathname);
    if (p === '/vendor/anime.min.js') file = path.join(EDIT, 'node_modules/animejs/lib/anime.min.js');
    else if (p.startsWith('/stage/')) file = inside(path.join(EDIT, 'stage'), p.slice(7));
    else if (p.startsWith('/capture/') && story.capture_dir) file = inside(story.capture_dir, p.slice(9));
    else if (p === '/file' && stills.has(u.searchParams.get('path'))) file = u.searchParams.get('path');
    if (!file) { res.writeHead(404); res.end('not found'); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(data);
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ port: srv.address().port, close: () => srv.close() })));
}

// ---------- browser ----------
async function openStage(story, M, draft) {
  const { chromium } = require('playwright');
  const server = await startServer(story);
  const browser = await chromium.launch();
  const dsf = (M.size.w / M.canon.w) * (draft ? 0.5 : 1);
  const context = await browser.newContext({ viewport: { width: M.canon.w, height: M.canon.h }, deviceScaleFactor: dsf });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error('[stage error] ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.error('[stage console] ' + m.text()); });
  await page.goto(`http://127.0.0.1:${server.port}/stage/index.html`);
  await page.evaluate(([s, f]) => window.stage.load(s, f), [story, M.format]);
  const cdp = await context.newCDPSession(page);
  const seek = (t) => page.evaluate((x) => window.stage.seek(x), t);
  const shot = async () => Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true })).data, 'base64');
  const close = async () => { await browser.close(); server.close(); };
  return { page, seek, shot, close };
}

function parseTime(M, spec) {
  const m = /^([A-Za-z0-9_.-]*[A-Za-z_][A-Za-z0-9_.-]*)(?:\+([0-9.]+))?$/.exec(spec);
  if (m) {
    const s = M.scenes.find((x) => x.id === m[1]);
    if (!s) die(`--frame-at: no scene "${m[1]}"`);
    return s.start + (m[2] ? parseFloat(m[2]) : 0);
  }
  const t = Number(spec);
  if (!isFinite(t) || t < 0) die(`--frame-at: bad time "${spec}" (seconds, or sceneid+seconds)`);
  return t;
}

async function frameAt(story, M, draft, list) {
  const st = await openStage(story, M, draft);
  try {
    for (const [spec, out] of list) {
      const t = parseTime(M, spec), n = Math.min(M.nframes - 1, Math.floor(t * M.fps + 1e-6));
      await st.seek(n / M.fps);
      fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
      fs.writeFileSync(out, await st.shot());
      const d = await st.page.evaluate((x) => window.stage.describe(x), n / M.fps);
      console.log(`${out}: frame ${n} t=${f3(n / M.fps)}  scene ${d.scene}+${f3(d.local)}` +
        (d.camera ? `  camera [${d.camera}]` : '') + (d.frame !== undefined ? `  source t=${f3(d.source_t)} → frame #${d.frame} (t=${f3(d.frame_t)})` : ''));
    }
  } finally { await st.close(); }
}

// ---------- encoding ----------
function ffArgs(M, draft, out) {
  const vf = (draft ? 'crop=trunc(iw/2)*2:trunc(ih/2)*2:0:0,' : '') +
    'scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int,format=yuv420p';
  return ['-y', '-v', 'error', '-f', 'image2pipe', '-framerate', String(M.fps), '-c:v', 'png', '-i', 'pipe:0', '-an', '-vf', vf,
    '-c:v', 'libx264', '-profile:v', 'high', '-preset', draft ? 'veryfast' : 'medium', '-crf', draft ? '26' : '17',
    '-g', String(Math.round(M.fps * 2)), '-flags', '+cgop', '-pix_fmt', 'yuv420p',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv', out];
}

async function worker(jobFile) {
  const job = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
  const story = loadStory(job.story);
  const { model: M } = compileOrDie(story, job.format, true);
  const st = await openStage(story, M, job.draft);
  const ff = spawn('ffmpeg', ffArgs(M, job.draft, job.out), { stdio: ['pipe', 'inherit', 'inherit'] });
  const ffDone = new Promise((res, rej) => { ff.on('error', rej); ff.on('close', (c) => (c === 0 ? res() : rej(new Error('ffmpeg exited with code ' + c)))); });
  ff.stdin.on('error', () => {});
  let done = 0, reused = 0, lastSig = null, lastBuf = null, lastReport = 0;
  for (const [a, b] of job.spans) {
    for (let n = a; n < b; n++) {
      const sig = await st.seek(n / M.fps);
      if (sig !== lastSig || !lastBuf) { lastBuf = await st.shot(); lastSig = sig; } else reused++;   // identical state => identical pixels
      if (!ff.stdin.write(lastBuf)) await new Promise((r) => ff.stdin.once('drain', r));
      done++;
      if (Date.now() - lastReport > 500) { lastReport = Date.now(); process.stdout.write(JSON.stringify({ id: job.id, done, reused }) + '\n'); }
    }
  }
  ff.stdin.end();
  await ffDone;
  await st.close();
  process.stdout.write(JSON.stringify({ id: job.id, done, reused, finished: true }) + '\n');
}

async function render(storyFile, story, M, opt) {
  let spans;
  if (opt.scenes) {
    const want = opt.scenes;
    for (const id of want) if (!M.scenes.some((s) => s.id === id)) die(`--scenes: no scene "${id}" (have: ${M.scenes.map((s) => s.id).join(', ')})`);
    spans = M.scenes.filter((s) => want.includes(s.id)).map((s) => [s.f0, s.f1]);
  } else spans = [[0, M.nframes]];
  const merged = [];
  for (const s of spans) { const l = merged[merged.length - 1]; if (l && l[1] === s[0]) l[1] = s[1]; else merged.push(s.slice()); }
  const total = merged.reduce((a, s) => a + s[1] - s[0], 0);
  const K = Math.max(1, Math.min(opt.workers, Math.ceil(total / 45)));
  fs.mkdirSync(story.output_dir, { recursive: true });
  const name = M.format + (opt.draft ? '.draft' : '') + (opt.scenes ? '.' + opt.scenes.join('+').slice(0, 80) : '') + '.mp4';
  const outFile = path.join(story.output_dir, name);
  const tmp = fs.mkdtempSync(path.join(story.output_dir, '.render-'));
  // split the frame list into K contiguous chunks
  const per = Math.ceil(total / K), jobs = [];
  let cur = [], room = per;
  for (const [a, b] of merged) {
    let x = a;
    while (x < b) {
      const take = Math.min(room, b - x);
      cur.push([x, x + take]); x += take; room -= take;
      if (room === 0) { jobs.push(cur); cur = []; room = per; }
    }
  }
  if (cur.length) jobs.push(cur);
  const sz = opt.draft ? `${Math.floor(M.size.w / 4) * 2}x${Math.floor(M.size.h / 4) * 2} draft` : `${M.size.w}x${M.size.h}`;
  console.log(`rendering ${total} frames (${f3(total / M.fps)} s) ${M.format} ${sz} with ${jobs.length} worker${jobs.length > 1 ? 's' : ''} → ${outFile}`);
  const t0 = Date.now(), prog = jobs.map(() => ({ done: 0, reused: 0 }));
  const report = (final) => {
    const d = prog.reduce((a, p) => a + p.done, 0), el = (Date.now() - t0) / 1000;
    console.log(`  ${final ? 'done ' : ''}${d}/${total} frames (${(100 * d / total).toFixed(0)}%)  ${(d / Math.max(el, 0.001)).toFixed(1)} fps  elapsed ${el.toFixed(0)} s` +
      (final || !d ? '' : `  eta ${(el * (total - d) / d).toFixed(0)} s`));
  };
  const timer = setInterval(() => report(false), 4000);
  let failed = null;
  const kids = [];
  await Promise.all(jobs.map((sp, id) => new Promise((resolve) => {
    const jf = path.join(tmp, `job${id}.json`), out = path.join(tmp, `chunk${String(id).padStart(3, '0')}.mp4`);
    fs.writeFileSync(jf, JSON.stringify({ id, story: path.resolve(storyFile), format: M.format, draft: opt.draft, spans: sp, out }));
    const k = spawn(process.execPath, [__filename, '--worker', jf], { stdio: ['ignore', 'pipe', 'inherit'] });
    kids.push(k);
    let buf = '';
    k.stdout.on('data', (d) => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(line); prog[m.id] = m; } catch (e) { console.log(line); } }
    });
    k.on('close', (code) => { if (code !== 0 && !failed) { failed = `worker ${id} failed (exit ${code})`; kids.forEach((x) => x.kill()); } resolve(); });
  })));
  clearInterval(timer);
  if (failed) { fs.rmSync(tmp, { recursive: true, force: true }); die('ERROR: ' + failed); }
  report(true);
  const list = path.join(tmp, 'list.txt');
  fs.writeFileSync(list, jobs.map((_, id) => `file '${path.join(tmp, `chunk${String(id).padStart(3, '0')}.mp4`)}'`).join('\n') + '\n');
  const cc = spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', outFile], { stdio: 'inherit' });
  fs.rmSync(tmp, { recursive: true, force: true });
  if (cc.status !== 0) die('ERROR: concat failed');
  const pr = spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames,width,height:format=duration,size', '-of', 'json', outFile], { encoding: 'utf8' });
  const info = JSON.parse(pr.stdout), wall = (Date.now() - t0) / 1000;
  const nf = +info.streams[0].nb_read_frames;
  console.log(`wrote ${outFile}: ${info.streams[0].width}x${info.streams[0].height}, ${nf} frames, ${(+info.format.duration).toFixed(3)} s, ${(info.format.size / 1e6).toFixed(2)} MB` +
    `   (${wall.toFixed(1)} s wall = ${(total / M.fps / wall).toFixed(2)} output-seconds per second; ${prog.reduce((a, p) => a + p.reused, 0)} static frames reused)`);
  if (nf !== total) die(`ERROR: expected ${total} frames, file has ${nf}`);
}

// ---------- CLI ----------
async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--worker') return worker(argv[1]);
  const opt = { format: null, scenes: null, draft: false, timeline: false, frameAt: [], workers: 4 };
  let storyFile = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const need = (n) => { if (i + n >= argv.length) die(`${a}: missing argument`); };
    if (a === '--format') { need(1); opt.format = argv[++i]; }
    else if (a === '--scenes') { need(1); opt.scenes = argv[++i].split(',').map((s) => s.trim()).filter(Boolean); }
    else if (a === '--draft') opt.draft = true;
    else if (a === '--timeline') opt.timeline = true;
    else if (a === '--frame-at') { need(2); opt.frameAt.push([argv[i + 1], argv[i + 2]]); i += 2; }
    else if (a === '--workers') { need(1); opt.workers = Math.max(1, parseInt(argv[++i], 10) || 1); }
    else if (a.startsWith('--')) die(`unknown option ${a}`);
    else if (!storyFile) storyFile = a;
    else die(`unexpected argument ${a}`);
  }
  if (!storyFile || !opt.format) die('usage: node render.cjs story.json --format wide|tall [--scenes id1,id2] [--draft] [--timeline] [--frame-at T out.png]... [--workers N]');
  const story = loadStory(storyFile);
  const { model: M, warnings, src } = compileOrDie(story, opt.format, opt.timeline);
  if (opt.timeline) {
    const extra = [];
    const other = opt.format === 'wide' ? 'tall' : 'wide';
    if (story.formats && story.formats[other]) {
      const r = core.compile(story, other, src);
      for (const e of r.errors) extra.push(`(other format, would be an ERROR with --format ${other}) ${e}`);
    }
    printTimeline(story, M, warnings.concat(extra));
    console.log(`\ncues: ${writeCues(story, M)}`);
    return;
  }
  if (opt.frameAt.length) return frameAt(story, M, opt.draft, opt.frameAt);
  writeCues(story, M);
  await render(storyFile, story, M, opt);
}
main().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
