// Personalises a fresh copy of the dashboard. Run by the "Set up the dashboard" workflow; safe to run again.
// Reads its answers from environment variables (the workflow's form):
//   ROLE         shown under the title, e.g. "Nightforce Leader"
//   FOCUS_AREA   optional region or topic to track, e.g. "Nigeria", "Lagos", "DeFi"
//   FOCUS_TERMS  optional words that mark a post as about the focus area, comma-separated
//   TIMEZONE     IANA time zone for days and refresh times, e.g. "Africa/Lagos"
//   GITHUB_REPOSITORY  owner/repo (set by GitHub Actions)
// Writes config.json, index.html (link-preview tags and first-paint labels), plan.json (first run only) and,
// while the copy still shows demo data, fresh demo data. Real data is only re-tagged (free, offline).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = (p) => path.join(ROOT, p);
const readJson = (p) => JSON.parse(fs.readFileSync(file(p), 'utf8'));
const env = (k) => String(process.env[k] || '').trim();
const fail = (msg) => { console.log(`::error::${msg}`); process.exit(1); };

const repo = env('GITHUB_REPOSITORY');
if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) fail('GITHUB_REPOSITORY is missing. Run this from the "Set up the dashboard" workflow.');
const [owner, name] = repo.split('/');
const role = env('ROLE').slice(0, 60);
const area = env('FOCUS_AREA').slice(0, 40);
const timezone = env('TIMEZONE') || 'UTC';
try { new Intl.DateTimeFormat('en-GB', { timeZone: timezone }); } catch { fail(`"${timezone}" isn't a time zone name. Use one like Africa/Lagos, Europe/London or Asia/Singapore (see https://en.wikipedia.org/wiki/List_of_tz_database_time_zones).`); }

// the focus area's words: whatever was typed, plus the area's own name and hashtag
const terms = [];
const add = (t) => { t = t.trim().toLowerCase(); if (t && t.length <= 60 && !terms.includes(t)) terms.push(t); };
if (area) { add(area); add('#' + area.replace(/\s+/g, '')); }
env('FOCUS_TERMS').split(/[,\n]/).forEach(add);
if (!area && terms.length) fail('You listed focus words but no focus area name. Fill in "Focus area" too, or leave both empty.');

const pagesUrl = name.toLowerCase() === `${owner.toLowerCase()}.github.io` ? `https://${owner.toLowerCase()}.github.io/` : `https://${owner.toLowerCase()}.github.io/${name}/`;
const zoneLabel = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, timeZoneName: 'short' }).formatToParts(new Date()).find((x) => x.type === 'timeZoneName')?.value || timezone;

/* ---------- config.json: edit only the fields setup owns, keep the rest (keywords, series, themes) as they are ---------- */
const cfgText = fs.readFileSync(file('config.json'), 'utf8');
const cfg = JSON.parse(cfgText);
const oldTerms = JSON.stringify(cfg.local?.terms || []);
cfg.repo = repo;
cfg.profile = { ...(cfg.profile || {}), role, area };
cfg.timezone = timezone;
cfg.timezoneLabel = '';
cfg.local = { ...(cfg.local || {}), label: area, short: area, terms };
fs.writeFileSync(file('config.json'), formatJson(cfg));

/* ---------- index.html: link-preview tags (crawlers don't run scripts) and the labels shown before the data loads ---------- */
const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const desc = `Self-updating KPI and planning dashboard for Midnight-related posts on X${area ? `, with a focus on ${area}` : ''}.`;
let html = fs.readFileSync(file('index.html'), 'utf8');
const swap = (re, to, what) => { if (!re.test(html)) fail(`index.html: couldn't find ${what}. Was it edited by hand?`); html = html.replace(re, typeof to === 'function' ? to : () => to); };
swap(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${esc(desc)}">`, 'the description tag');
swap(/<meta property="og:description" content="[^"]*">/, `<meta property="og:description" content="${esc(desc)}">`, 'the og:description tag');
swap(/<meta property="og:url" content="[^"]*">/, `<meta property="og:url" content="${pagesUrl}">`, 'the og:url tag');
swap(/<meta property="og:image" content="[^"]*">/, `<meta property="og:image" content="${pagesUrl}share.jpg">`, 'the og:image tag');
swap(/<link rel="canonical" href="[^"]*">/, `<link rel="canonical" href="${pagesUrl}">`, 'the canonical link');
swap(/(<small data-bind="brand-sub">)[^<]*(<\/small>)/, (m, a, b) => a + esc([role, area].filter(Boolean).join(' · ')) + b, 'the title line');
swap(/(<span data-bind="focus-filter-label">)[^<]*(<\/span>)/, (m, a, b) => a + esc(area || 'Focus area') + b, 'the focus filter');
const [hh, mm] = String(cfg.refreshUtc || '04:15').split(':').map(Number);
const daily = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit' }).format(new Date(Date.UTC(2026, 0, 15, hh || 0, mm || 0)));
swap(/(<p class="db-pop__hint" data-bind="refresh-hint">)[^<]*(<\/p>)/, (m, a, b) => `${a}Loads the newest numbers already saved by the daily ${daily} ${esc(zoneLabel)} refresh.${b}`, 'the refresh hint');
fs.writeFileSync(file('index.html'), html);

/* ---------- plan.json: on the first run, this quarter and this year with no targets yet ---------- */
const plan = readJson('plan.json');
if (plan._kit) {
  const now = new Date();
  const y = now.getUTCFullYear();
  const q = Math.floor(now.getUTCMonth() / 3) + 1;
  const none = { midnightPosts: null, impressions: null, engagementRate: null, followersNet: null, localShare: null, midnightMentions: null };
  const next = {
    _readme: plan._readme,
    quarters: { [`${y}-Q${q}`]: { label: `Q${q} ${y}`, targets: { ...none }, focus: [] } },
    years: { [y]: { label: String(y), targets: { ...none } } },
    calendar: [],
  };
  fs.writeFileSync(file('plan.json'), JSON.stringify(next, null, 2) + '\n');
  console.log(`plan.json: Q${q} ${y} and ${y} added, with no targets yet.`);
}

/* ---------- data: fresh demo data while it's still demo; otherwise re-tag real posts if the focus words changed ---------- */
const meta = readJson('data/meta.json');
if (meta.demo) {
  execFileSync(process.execPath, [file('scripts/make-demo-data.mjs')], { stdio: 'inherit' });
} else if (oldTerms !== JSON.stringify(terms)) {
  execFileSync(process.execPath, [file('scripts/fetch-x.mjs'), '--mode=reclassify'], { stdio: 'inherit' });
}

console.log(`Set up ${repo}: ${[role, area].filter(Boolean).join(' · ') || '(no title line)'}; time zone ${timezone} (${zoneLabel}); focus area ${area ? `"${area}" with ${terms.length} words` : 'none'}.`);
console.log(`Dashboard address: ${pagesUrl}`);
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `url=${pagesUrl}\n`);

// JSON with short lists kept on one line, like the hand-written files
function formatJson(value) {
  const out = (v, ind) => {
    const pad = '  '.repeat(ind);
    if (Array.isArray(v)) {
      if (!v.length) return '[]';
      if (v.every((x) => typeof x !== 'object' || x === null)) {
        const items = v.map((x) => JSON.stringify(x));
        const lines = [];
        let cur = '';
        for (const it of items) {
          if (cur && (pad.length + 2 + cur.length + it.length + 2) > 100) { lines.push(cur); cur = ''; }
          cur += (cur ? ', ' : '') + it;
        }
        lines.push(cur);
        return lines.length === 1 && lines[0].length + pad.length < 90 ? `[${lines[0]}]` : `[\n${lines.map((l) => `${pad}  ${l}`).join(',\n')}\n${pad}]`;
      }
      return `[\n${v.map((x) => `${pad}  ${out(x, ind + 1)}`).join(',\n')}\n${pad}]`;
    }
    if (v && typeof v === 'object') {
      const keys = Object.keys(v);
      if (!keys.length) return '{}';
      return `{\n${keys.map((k) => `${pad}  ${JSON.stringify(k)}: ${out(v[k], ind + 1)}`).join(',\n')}\n${pad}}`;
    }
    return JSON.stringify(v);
  };
  return out(value, 0) + '\n';
}
