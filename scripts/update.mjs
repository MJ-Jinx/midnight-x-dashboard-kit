// Brings a copy of the dashboard up to the latest kit, keeping the owner's own settings and numbers.
//   node <downloaded kit>/scripts/update.mjs --kit=<downloaded kit folder> --version=<kit commit> [--copy=<folder>] [--check]
// The "Update from the kit" workflow runs it from the new kit's own copy of this script, inside the copy (--copy
// defaults to the current folder).
// - Replaces the code: index.html, assets (never the builder pictures), scripts, workflows, README.md and LICENSE.
// - Removes code files an earlier kit had and this one dropped (from the file list kept in kit.json).
// - Adds files a newer kit needs that the copy doesn't have yet, empty (events.json, sources.json, …).
// - Adds settings a newer kit introduced to config.json, without changing any the owner has.
// - Never touches plan.json, builders.json, events.json, sources.json, the data folder or the owner's config values.
// Then it re-runs scripts/setup.mjs with the answers saved in config.json, so the page keeps the owner's name, address
// and focus area. A copy that was never set up keeps the kit's sample labels.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CODE_FILES = ['index.html', 'README.md', 'LICENSE', 'favicon.svg', '.nojekyll', '.gitattributes', '.gitignore'];
export const isCode = (rel) => CODE_FILES.includes(rel) || /^(scripts|\.github\/workflows)\//.test(rel) || (rel.startsWith('assets/') && !rel.startsWith('assets/builders/'));
export const ADD_IF_MISSING = ['config.json', 'plan.json', 'builders.json', 'events.json', 'sources.json', 'data/content.json', 'data/builder-previews.json', 'data/pending-archive.json'];
export const KIT_README = 'Where this copy came from and which kit version it runs, for the "Update from the kit" workflow. Updated by that workflow; leave it as it is.';
const safeRel = (rel) => typeof rel === 'string' && /^[\w.\-/]+$/.test(rel) && !rel.split('/').includes('..') && !rel.startsWith('/');

const walk = (dir, base = dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  if (e.name === '.git' || e.name === 'node_modules') return [];
  const p = path.join(dir, e.name);
  return e.isDirectory() ? walk(p, base) : [path.relative(base, p).split(path.sep).join('/')];
}) : []);
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const same = (a, b) => fs.readFileSync(a).equals(fs.readFileSync(b));

/** What an update would change in `copy`, from the kit in `kit`. Changes nothing. */
export function planUpdate(copy, kit) {
  const kitFiles = walk(kit);
  const code = kitFiles.filter(isCode).sort();
  const manifest = readJson(path.join(copy, 'kit.json')) || {};
  const plan = {
    replace: [], add: [], remove: [], config: [], code,
    oldVersion: manifest.version || null, repo: manifest.repo || readJson(path.join(kit, 'kit.json'))?.repo || null,
  };
  for (const rel of code) {
    const dst = path.join(copy, rel);
    if (!fs.existsSync(dst)) plan.add.push(rel);
    else if (!same(path.join(kit, rel), dst)) plan.replace.push(rel);
  }
  for (const rel of Array.isArray(manifest.files) ? manifest.files : []) {
    if (safeRel(rel) && isCode(rel) && !code.includes(rel) && fs.existsSync(path.join(copy, rel))) plan.remove.push(rel);
  }
  for (const rel of ADD_IF_MISSING) if (kitFiles.includes(rel) && !fs.existsSync(path.join(copy, rel))) plan.add.push(rel);
  const mine = readJson(path.join(copy, 'config.json'));
  const theirs = readJson(path.join(kit, 'config.json'));
  if (mine && theirs) plan.config = Object.keys(theirs).filter((k) => !(k in mine));
  return plan;
}

/** Carries out a plan from planUpdate, and records the kit version and its code files in kit.json. */
export function applyUpdate(copy, kit, plan, version) {
  for (const rel of [...plan.replace, ...plan.add]) {
    const dst = path.join(copy, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(kit, rel), dst);
  }
  for (const rel of plan.remove) fs.rmSync(path.join(copy, rel), { force: true });
  if (plan.config.length) {
    const mine = readJson(path.join(copy, 'config.json'));
    const theirs = readJson(path.join(kit, 'config.json'));
    for (const k of plan.config) mine[k] = theirs[k];
    fs.writeFileSync(path.join(copy, 'config.json'), JSON.stringify(mine, null, 2) + '\n');
  }
  fs.writeFileSync(path.join(copy, 'kit.json'), JSON.stringify({ _readme: KIT_README, repo: plan.repo, version: version || null, updated: new Date().toISOString(), files: plan.code }, null, 2) + '\n');
}

/** The setup answers saved in config.json, as the environment scripts/setup.mjs reads. */
export function setupEnv(cfg) {
  const profile = cfg.profile || {};
  const local = cfg.local || {};
  return {
    ROLE: profile.role || '', FOCUS_AREA: profile.area || local.label || '', FOCUS_TERMS: (local.terms || []).join(', '),
    TIMEZONE: cfg.timezone || 'UTC', PUBLIC_REPO: cfg.publicRepo || '',
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (n) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : ''; };
  const fail = (msg) => { console.log(`::error::${msg}`); process.exit(1); };
  const out = (k, v) => { if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`); };
  const kit = path.resolve(arg('kit') || '');
  const copy = path.resolve(arg('copy') || process.cwd());
  const check = process.argv.includes('--check');
  if (!arg('kit') || !fs.existsSync(path.join(kit, 'scripts/update.mjs'))) fail('--kit must be a downloaded copy of the kit.');
  if (kit === copy) fail('--kit and the copy to update must be different folders.');
  if (!fs.existsSync(path.join(copy, 'config.json'))) fail(`${copy} doesn't look like a copy of the dashboard (no config.json).`);

  const plan = planUpdate(copy, kit);
  // index.html always differs from the kit's (it carries the owner's own labels, put back after every update), so it
  // isn't counted as a change
  const counted = (list) => list.filter((r) => r !== 'index.html');
  const changed = [...counted(plan.replace), ...plan.add, ...plan.remove];
  const workflows = changed.filter((r) => r.startsWith('.github/workflows/'));
  console.log(`From ${plan.oldVersion ? plan.oldVersion.slice(0, 7) : 'an earlier version'} to ${String(arg('version') || 'the latest').slice(0, 7)}: ${counted(plan.replace).length} files updated, ${plan.add.length} added, ${plan.remove.length} removed${plan.config.length ? `; new settings: ${plan.config.join(', ')}` : ''}.`);
  for (const [label, list] of [['updated', counted(plan.replace)], ['added', plan.add], ['removed', plan.remove]]) if (list.length) console.log(`  ${label}: ${list.join(', ')}`);
  out('old_version', plan.oldVersion || '');
  out('repo', plan.repo || '');
  out('files', changed.length);
  out('workflows', workflows.join(' '));
  out('settings', plan.config.join(', '));
  if (check) { console.log('Check only: nothing was changed.'); process.exit(0); }

  applyUpdate(copy, kit, plan, arg('version'));
  const cfg = readJson(path.join(copy, 'config.json'));
  if (cfg?.repo && fs.existsSync(path.join(copy, 'scripts/setup.mjs'))) {
    console.log('Putting your setup answers back…');
    execFileSync(process.execPath, [path.join(copy, 'scripts/setup.mjs')], { cwd: copy, stdio: 'inherit', env: { ...process.env, ...setupEnv(cfg) } });
    out('setup', 'true');
  } else {
    console.log("This copy hasn't been set up yet, so its page keeps the kit's sample labels. Run Set up the dashboard when you're ready.");
    out('setup', 'false');
  }
}
