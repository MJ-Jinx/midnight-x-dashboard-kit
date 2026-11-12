// Builds the public copy of the dashboard: the page plus the numbers anyone may see.
//   node scripts/publish.mjs --out=<folder>
//   node scripts/publish.mjs --check     checks that the PUBLISH_TOKEN secret can update the public repository
// The "Publish the public site" workflow pushes that folder to the public repository named in config.json
// ("publicRepo"), which hosts the view-only site. These stay behind in this repository:
//   plan.json (targets, focus notes, content calendar), each post's "private" block (link clicks, profile clicks,
//   engagements), each event's "private" block (cost, feedback score, partners, notes), each article's "private"
//   block (dev.to page views) and the notes on accounts that didn't answer, X API spend and run details in meta.json,
//   the archive queue, scripts, workflows and the kit.
// The owner's browser reads those straight from this repository through the GitHub API (owner mode in app.js).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// copied unchanged (a missing one is skipped); everything under assets/ is copied too
export const PUBLIC_FILES = ['index.html', 'favicon.svg', 'share.jpg', '.nojekyll', 'config.json', 'builders.json', 'sources.json', 'data/history.json', 'data/mentions.json', 'data/builder-previews.json'];
const PUBLIC_DIRS = ['assets'];
// rebuilt without their owner-only parts
const FILTERED = ['data/posts.json', 'data/meta.json', 'events.json', 'data/content.json'];

const strip = (p) => { const { private: _owner, ...rest } = p; return rest; };
export function publicPosts(file) {
  return { ...file, posts: (file.posts || []).map(strip), other: (file.other || []).map(strip) };
}

// data/content.json without the numbers a platform shows only to the author (dev.to page views) and without the
// owner's notes on accounts that didn't answer
export function publicContent(file) {
  const accounts = Object.fromEntries(Object.entries(file.accounts || {}).map(([k, v]) => { const { error: _e, note: _n, ...rest } = v || {}; return [k, rest]; }));
  return { ...file, accounts, items: (file.items || []).map(strip) };
}

// events.json without each event's cost, feedback score, partners and notes (and without the worked example)
export function publicEvents(file) {
  const { _example: _x, ...rest } = file;
  return { ...rest, events: (file.events || []).map(strip) };
}

export function publicMeta(m) {
  const out = { demo: !!m.demo };
  if (m.handle) out.handle = m.handle;
  if (m.user) out.user = m.user;
  if (m.lastRun) out.lastRun = { at: m.lastRun.at, mode: m.lastRun.mode };
  return out;
}

const README = (cfg) => `# Midnight on X · KPI dashboard

The view-only public page${cfg.publicRepo ? ` at https://${cfg.publicRepo.split('/')[0].toLowerCase()}.github.io/${cfg.publicRepo.split('/')[1]}/` : ''}.

Published automatically from a private repository. Don't edit files here: the next update replaces them.

Community planning tool, not an official Midnight Network or Midnight Foundation publication.
`;

const json = (v) => JSON.stringify(v, null, 1) + '\n';

/** Problems that would publish owner-only data; an empty list means the folder is safe to publish. */
export function leaks(dir) {
  const out = [];
  const allowed = new Set([...PUBLIC_FILES, ...FILTERED, 'README.md']);
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const file of walk(dir)) {
    const rel = path.relative(dir, file).split(path.sep).join('/');
    if (!allowed.has(rel) && !PUBLIC_DIRS.some((x) => rel.startsWith(x + '/'))) out.push(`${rel} is not on the public list`);
    if (rel.endsWith('.json') && /link_clicks|profile_clicks|costByMonth|estCostUSD/.test(fs.readFileSync(file, 'utf8'))) out.push(`${rel} holds owner-only numbers`);
  }
  const posts = path.join(dir, 'data/posts.json');
  if (fs.existsSync(posts)) {
    const p = JSON.parse(fs.readFileSync(posts, 'utf8'));
    if ([...(p.posts || []), ...(p.other || [])].some((x) => x && 'private' in x)) out.push('data/posts.json still has private blocks');
  }
  const events = path.join(dir, 'events.json');
  if (fs.existsSync(events)) {
    const e = JSON.parse(fs.readFileSync(events, 'utf8'));
    if ('_example' in e || (e.events || []).some((x) => x && 'private' in x)) out.push('events.json still has private blocks');
  }
  const content = path.join(dir, 'data/content.json');
  if (fs.existsSync(content)) {
    const c = JSON.parse(fs.readFileSync(content, 'utf8'));
    if ((c.items || []).some((x) => x && 'private' in x) || Object.values(c.accounts || {}).some((a) => a && ('error' in a || 'note' in a))) out.push('data/content.json still has owner-only parts');
  }
  const meta = path.join(dir, 'data/meta.json');
  if (fs.existsSync(meta)) {
    const extra = Object.keys(JSON.parse(fs.readFileSync(meta, 'utf8'))).filter((k) => !['demo', 'handle', 'user', 'lastRun'].includes(k));
    if (extra.length) out.push(`data/meta.json has owner-only fields: ${extra.join(', ')}`);
  }
  return out;
}

/**
 * Asks GitHub whether `token` may push to `repo` (the same request git makes before a push).
 * Returns null when it may, otherwise a message that says what to fix.
 */
export async function checkToken(repo, token, get = fetch) {
  const fix = `Make a new key (README, step 5): Only select repositories → ${repo.split('/')[1]}, and Contents: Read and write. Then replace the PUBLISH_TOKEN secret in this repository.`;
  let r;
  try {
    r = await get(`https://github.com/${repo}.git/info/refs?service=git-receive-pack`, {
      headers: { Authorization: `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`, 'User-Agent': 'git/2 (dashboard publish check)' },
    });
  } catch (e) {
    return `Couldn't reach GitHub to check PUBLISH_TOKEN (${e.message}). Run the workflow again.`;
  }
  if (r.ok) return null;
  if (r.status === 401) return `GitHub doesn't accept PUBLISH_TOKEN: it has expired, was deleted, or wasn't copied whole. ${fix}`;
  if (r.status === 404) return `GitHub can't find ${repo}, or PUBLISH_TOKEN can't see it. Check "publicRepo" in config.json. ${fix}`;
  return `PUBLISH_TOKEN can't update ${repo} (GitHub answered ${r.status}). ${fix}`;
}

export function build(out, root = ROOT) {
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(path.join(out, 'data'), { recursive: true });
  for (const f of PUBLIC_FILES) if (fs.existsSync(path.join(root, f))) fs.copyFileSync(path.join(root, f), path.join(out, f));
  for (const d of PUBLIC_DIRS) if (fs.existsSync(path.join(root, d))) fs.cpSync(path.join(root, d), path.join(out, d), { recursive: true });
  const read = (f) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
  fs.writeFileSync(path.join(out, 'data/posts.json'), json(publicPosts(read('data/posts.json'))));
  fs.writeFileSync(path.join(out, 'data/meta.json'), json(publicMeta(read('data/meta.json'))));
  if (fs.existsSync(path.join(root, 'events.json'))) fs.writeFileSync(path.join(out, 'events.json'), JSON.stringify(publicEvents(read('events.json')), null, 2) + '\n');
  if (fs.existsSync(path.join(root, 'data/content.json'))) fs.writeFileSync(path.join(out, 'data/content.json'), json(publicContent(read('data/content.json'))));
  fs.writeFileSync(path.join(out, 'README.md'), README(read('config.json')));
  return leaks(out);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv.includes('--check')) {
  const repo = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')).publicRepo || '';
  const token = String(process.env.PUBLISH_TOKEN || '').trim();
  if (!repo) { console.log('No public site repository is set (config.json "publicRepo").'); process.exit(0); }
  if (!token) { console.log(`::error::The PUBLISH_TOKEN secret isn't set, so this repository can't update ${repo}. Add it (README, step 5).`); process.exit(1); }
  const problem = await checkToken(repo, token);
  if (problem) { console.log(`::error::${problem}`); process.exit(1); }
  console.log(`PUBLISH_TOKEN can update ${repo}.`);
} else if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = process.argv.find((a) => a.startsWith('--out='));
  if (!arg) { console.error('Usage: node scripts/publish.mjs --out=<folder>'); process.exit(2); }
  const out = path.resolve(arg.slice(6));
  if (out === ROOT || ROOT.startsWith(out + path.sep)) { console.error('--out must be a separate folder, not the repository itself.'); process.exit(2); }
  const problems = build(out);
  if (problems.length) { console.error('Not safe to publish:\n- ' + problems.join('\n- ')); process.exit(1); }
  console.log(`Public copy written to ${out}`);
}
