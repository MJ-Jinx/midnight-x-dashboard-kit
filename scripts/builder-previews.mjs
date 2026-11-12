// Takes a picture of each builder's website for the banner on their card.
// Runs in the "Builder previews" workflow after builders.json changes; needs Chrome (preinstalled on GitHub's runners).
//   node scripts/builder-previews.mjs [--force] [--builders=builders.json] [--dir=assets/builders] [--manifest=data/builder-previews.json]
// A picture is retaken only when a builder's website changes (or with --force). Pictures of builders who were
// removed are deleted. A site that fails to load just gets no picture; the card then shows its plain banner.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, dflt) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : dflt; };
const FORCE = process.argv.includes('--force');
const BUILDERS = path.resolve(ROOT, arg('builders', 'builders.json'));
const DIR = path.resolve(ROOT, arg('dir', 'assets/builders'));
const MANIFEST = path.resolve(ROOT, arg('manifest', 'data/builder-previews.json'));
const WEB_DIR = path.relative(ROOT, DIR).split(path.sep).join('/'); // the path the page loads pictures from
const W = 1200;
const H = 675;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// the same rules as safeUrl() in assets/app.js, so the page can tell a picture belongs to the current website
const safeUrl = (v) => {
  v = String(v || '').trim();
  if (!v) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(v)) v = 'https://' + v;
  try { const u = new URL(v); return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null; } catch { return null; }
};
const slugOf = (name) => String(name).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'builder';

function findChrome() {
  const list = [process.env.CHROME, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    'C:/Program Files/Google/Chrome/Application/chrome.exe', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  return list.find((p) => p && fs.existsSync(p)) || null;
}

async function main() {
  const file = JSON.parse(fs.readFileSync(BUILDERS, 'utf8'));
  const builders = (Array.isArray(file.builders) ? file.builders : []).filter((b) => b && String(b.name || '').trim());
  let manifest = {};
  try { manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch { /* first run */ }

  const used = new Set();
  const jobs = [];
  const next = {};
  for (const b of builders) {
    const key = String(b.name).trim().toLowerCase();
    const url = safeUrl(b.links?.website);
    if (!url) continue;
    let slug = slugOf(b.name);
    for (let i = 2; used.has(slug); i++) slug = `${slugOf(b.name)}-${i}`;
    used.add(slug);
    const prev = manifest[key];
    const rel = `${WEB_DIR}/${slug}.jpg`;
    if (!FORCE && prev && prev.url === url && prev.file === rel && fs.existsSync(path.join(DIR, `${slug}.jpg`))) { next[key] = prev; continue; }
    jobs.push({ key, name: String(b.name).trim(), url, slug, rel });
  }

  if (jobs.length) {
    const chrome = findChrome();
    if (!chrome) {
      console.log('::notice::Chrome not found, so no website pictures were taken. Cards keep their plain banner.');
    } else {
      fs.mkdirSync(DIR, { recursive: true });
      await shoot(chrome, jobs, next);
    }
  }

  // pictures of builders who were removed, or whose website changed name, are deleted
  const keep = new Set(Object.values(next).filter((e) => e.file).map((e) => path.basename(e.file)));
  if (fs.existsSync(DIR)) for (const f of fs.readdirSync(DIR)) if (f.endsWith('.jpg') && !keep.has(f)) { fs.rmSync(path.join(DIR, f)); console.log(`removed ${f}`); }
  fs.mkdirSync(path.dirname(MANIFEST), { recursive: true });
  fs.writeFileSync(MANIFEST, JSON.stringify(next, null, 2) + '\n');
  console.log(`previews: ${Object.values(next).filter((e) => e.file).length} pictures for ${builders.length} builders (${jobs.length} taken this run)`);
}

async function shoot(chrome, jobs, next) {
  const port = 9300 + Math.floor(Math.random() * 500);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'builder-previews-'));
  const proc = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--mute-audio', '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`, `--window-size=${W},${H}`, 'about:blank'], { stdio: 'ignore' });
  try {
    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) { try { await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); ready = true; } catch { await sleep(250); } }
    if (!ready) throw new Error('Chrome did not start');
    for (const job of jobs) {
      const taken = new Date().toISOString();
      try {
        await shootOne(port, job);
        next[job.key] = { name: job.name, url: job.url, file: job.rel, takenAt: taken };
        console.log(`took ${job.rel} from ${job.url}`);
      } catch (err) {
        next[job.key] = { name: job.name, url: job.url, error: String(err.message || err).slice(0, 200), takenAt: taken };
        console.log(`::warning::No picture for ${job.name} (${job.url}): ${err.message || err}`);
      }
    }
  } finally {
    proc.kill();
    await sleep(300);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* Chrome may still hold files on Windows */ }
  }
}

async function shootOne(port, job) {
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  let id = 0;
  const pending = new Map();
  let loaded;
  const loadedP = new Promise((r) => { loaded = r; });
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    if (msg.method === 'Page.loadEventFired') loaded();
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id;
    const t = setTimeout(() => { pending.delete(n); reject(new Error(`${method} timed out`)); }, 30000);
    pending.set(n, (m) => { clearTimeout(t); if (m.error) reject(new Error(m.error.message)); else resolve(m.result); });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  try {
    await send('Page.enable');
    await send('Browser.setDownloadBehavior', { behavior: 'deny' }).catch(() => {});
    await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    const nav = await send('Page.navigate', { url: job.url });
    if (nav.errorText) throw new Error(nav.errorText);
    await Promise.race([loadedP, sleep(20000)]);
    await sleep(2500); // fonts, images and cookie banners settle
    const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 72, clip: { x: 0, y: 0, width: W, height: H, scale: 1 } });
    fs.writeFileSync(path.join(DIR, `${job.slug}.jpg`), Buffer.from(shot.data, 'base64'));
  } finally {
    ws.close();
    await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => {});
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
