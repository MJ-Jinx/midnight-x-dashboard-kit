// Reads Midnight-related work beyond X from the accounts in sources.json and writes data/content.json.
//   node scripts/fetch-sources.mjs          (the "Refresh articles and code" workflow runs it every day)
// - GitHub: pull requests and issues in Midnight repositories (sources.json "githubOrgs"), and the account's own
//   public repositories that mention Midnight. Public results only: private repositories are never listed.
// - dev.to: every public article. Page views (shown only to the author) need the optional DEVTO_API_KEY secret,
//   and are kept in each article's "private" block, which the public copy of the site leaves out.
// - Medium and Substack: the latest posts in their public feeds (about 10 and 20). Each post is kept from the first
//   day it is seen, so the history grows from the day an account is connected.
// Only Midnight-related items are kept, judged with the same keyword lists as the X posts (config.json "midnight").
// Posts deleted on a platform drop out: dev.to and GitHub list everything, and a feed post that is missing while
// newer and older posts are still listed counts as deleted.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, compileConfig } from './lib/classify.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UA = 'Mozilla/5.0 (compatible; kpi-dashboard/1.0)';
export const PLATFORMS = ['github', 'devto', 'medium', 'substack'];
export const DEFAULT_ORGS = ['midnightntwrk', 'LFDT-Minokawa'];

/* ---------- account names, from whatever was typed: a name, @name or a profile link ---------- */
const clean = (v) => String(v ?? '').trim();
export const normalise = {
  github(v) {
    v = clean(v).replace(/^https?:\/\/(www\.)?github\.com\//i, '').split(/[/?#]/)[0].replace(/^@/, '');
    return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(v) ? v : null;
  },
  devto(v) {
    v = clean(v).replace(/^https?:\/\/(www\.)?dev\.to\//i, '').split(/[/?#]/)[0].replace(/^@/, '');
    return /^[A-Za-z0-9_]{1,30}$/.test(v) ? v : null;
  },
  medium(v) {
    v = clean(v);
    const m = v.match(/^(?:https?:\/\/)?(?:www\.)?medium\.com\/@([A-Za-z0-9_.-]{1,40})/i)
      || v.match(/^(?:https?:\/\/)?([A-Za-z0-9-]{1,40})\.medium\.com\/?$/i)
      || v.match(/^@?([A-Za-z0-9_.-]{1,40})$/);
    return m ? m[1] : null;
  },
  // a Substack name ("name"), its address (name.substack.com) or a custom domain; stored as the site's address
  substack(v) {
    v = clean(v).replace(/\/+$/, '');
    if (!v) return null;
    if (/^[a-z0-9-]{1,63}$/i.test(v)) return `https://${v.toLowerCase()}.substack.com`;
    if (/\s/.test(v)) return null;
    try {
      const u = new URL(/^https?:/i.test(v) ? v : 'https://' + v);
      return u.protocol === 'https:' && /\.[a-z]{2,}$/i.test(u.hostname) ? `https://${u.hostname.toLowerCase()}` : null;
    } catch { return null; }
  },
};
export const profileUrl = {
  github: (a) => `https://github.com/${a}`,
  devto: (a) => `https://dev.to/${a}`,
  medium: (a) => `https://medium.com/@${a}`,
  substack: (a) => a,
};

/* ---------- RSS feeds (Medium, Substack), without dependencies ---------- */
const decode = (s) => String(s)
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
const unwrap = (s) => String(s).replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1');
export const plain = (html) => decode(String(html).replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function parseRss(xml) {
  return [...String(xml).matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/g)].map(([, block]) => {
    const all = (name) => [...block.matchAll(new RegExp(`<${esc(name)}\\b[^>]*>([\\s\\S]*?)<\\/${esc(name)}>`, 'g'))].map((m) => unwrap(m[1]));
    const one = (name) => all(name)[0] ?? '';
    return {
      title: plain(one('title')), link: plain(one('link')), guid: plain(one('guid')), date: plain(one('pubDate')),
      categories: all('category').map(plain).filter(Boolean), description: one('description'), content: one('content:encoded'),
    };
  });
}

/* ---------- is it about Midnight? ---------- */
// The title, tags and summary decide on their own; the body only counts with a clear Midnight term, so an article
// that merely says it was written "at midnight" stays out. A match on a bare "midnight" is marked for review.
export function midnightCheck(item, body, cc) {
  if (cc.exclude.has(item.id)) return { keep: false, review: false };
  if (cc.include.has(item.id) || (item.tags || []).some((t) => /midnight/i.test(t))) return { keep: true, review: false }; // a tag is chosen on purpose
  const head = [item.title, (item.tags || []).map((t) => '#' + t).join(' '), item.summary].filter(Boolean).join('\n');
  const a = classify({ id: item.id, text: head, urls: [item.url], kind: 'original' }, cc);
  if (a.midnight) return { keep: true, review: a.review };
  const b = classify({ id: item.id, text: `${head}\n${String(body || '').slice(0, 6000)}`, urls: [item.url], kind: 'original' }, cc);
  return { keep: b.midnight && b.confidence !== 'low', review: b.review };
}
const summaryOf = (t, n = 220) => { t = plain(t); return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t; };
const iso = (d) => { const t = Date.parse(d); return Number.isFinite(t) ? new Date(t).toISOString() : null; };

export function feedItems(source, account, posts, cc) {
  const out = [];
  for (const p of posts) {
    const url = (p.link || p.guid || '').replace(/\?source=rss[^#]*$/, '');
    const date = iso(p.date);
    if (!url || !date || !p.title) continue;
    const key = source === 'medium' ? (p.guid.match(/\/p\/([0-9a-f]+)/)?.[1] || url) : (() => { try { return new URL(url).pathname; } catch { return url; } })();
    const item = { id: `${source}:${key}`, source, account, kind: 'article', title: p.title, url, date, tags: p.categories.slice(0, 8), summary: summaryOf(p.description || p.content) };
    const check = midnightCheck(item, plain(p.content || p.description), cc);
    if (check.keep) out.push(check.review ? { ...item, review: true } : item);
  }
  return out;
}
// A feed lists only the latest posts: older posts are kept, but one that should still be listed and isn't was deleted.
export function mergeFeed(prev, fresh, feedOldest) {
  if (feedOldest == null) return prev;
  const ids = new Set(fresh.map((i) => i.id));
  return [...fresh, ...prev.filter((p) => !ids.has(p.id) && Date.parse(p.date) < feedOldest)];
}

export function devtoItems(account, list, views, cc) {
  const out = [];
  for (const a of list) {
    const item = {
      id: `devto:${a.id}`, source: 'devto', account, kind: 'article', title: String(a.title || '').trim(), url: a.url,
      date: iso(a.published_timestamp || a.published_at), tags: Array.isArray(a.tag_list) ? a.tag_list : String(a.tag_list || '').split(/,\s*/).filter(Boolean),
      summary: summaryOf(a.description || ''),
      metrics: { reactions: a.public_reactions_count ?? a.positive_reactions_count ?? 0, comments: a.comments_count ?? 0 },
    };
    if (!item.title || !item.url || !item.date) continue;
    if (views && views.has(a.id)) item.private = { views: views.get(a.id) };
    const check = midnightCheck(item, '', cc);
    if (check.keep) out.push(check.review ? { ...item, review: true } : item);
  }
  return out;
}

export function githubItems(account, issues, repos) {
  const out = [];
  for (const it of issues) {
    const repo = String(it.repository_url || '').split('/repos/')[1];
    if (!repo) continue;
    const pr = !!it.pull_request;
    out.push({
      id: `github:${pr ? 'pr' : 'issue'}:${repo}#${it.number}`, source: 'github', account, kind: pr ? 'pr' : 'issue', title: it.title, url: it.html_url,
      date: iso(it.created_at), repo, state: pr && it.pull_request.merged_at ? 'merged' : it.state, metrics: { comments: it.comments ?? 0 },
    });
  }
  for (const r of repos) {
    if (r.private || r.visibility === 'private' || r.fork) continue; // public, own work only
    out.push({
      id: `github:repo:${r.full_name}`, source: 'github', account, kind: 'repo', title: r.name, url: r.html_url, date: iso(r.created_at), repo: r.full_name,
      summary: summaryOf(r.description || ''), tags: (r.topics || []).slice(0, 8), metrics: { stars: r.stargazers_count ?? 0, forks: r.forks_count ?? 0 },
    });
  }
  return out;
}

/* ---------- the platforms ---------- */
async function getText(url, headers = {}) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}
const getJson = async (url, headers) => JSON.parse(await getText(url, headers));

async function readGithub(account, orgs, token) {
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  const search = async (kind, q, pages = 3) => {
    const found = [];
    for (let page = 1; page <= pages; page++) {
      const res = await getJson(`https://api.github.com/search/${kind}?per_page=100&page=${page}&q=${encodeURIComponent(q)}`, headers);
      found.push(...(res.items || []));
      if ((res.items || []).length < 100) break;
    }
    return found;
  };
  const issues = orgs.length ? await search('issues', `author:${account} is:public ${orgs.map((o) => `org:${o}`).join(' ')}`) : [];
  const repos = await search('repositories', `user:${account} is:public fork:false midnight in:name,description,readme,topics`, 1);
  return { issues, repos };
}
async function readDevto(account, key) {
  const headers = { Accept: 'application/vnd.forem.api-v1+json' };
  const list = [];
  for (let page = 1; page <= 5; page++) {
    const batch = await getJson(`https://dev.to/api/articles?username=${encodeURIComponent(account)}&per_page=1000&page=${page}`, headers);
    list.push(...batch);
    if (batch.length < 1000) break;
  }
  let views = null;
  let note = null;
  if (key) {
    try {
      const mine = await getJson('https://dev.to/api/articles/me/published?per_page=1000', { ...headers, 'api-key': key });
      if (mine.length && String(mine[0].user?.username || '').toLowerCase() !== account.toLowerCase()) note = `The DEVTO_API_KEY secret belongs to another dev.to account (${mine[0].user?.username}), so page views were left out.`;
      else views = new Map(mine.map((a) => [a.id, a.page_views_count ?? null]));
    } catch (e) { note = `dev.to didn't accept the DEVTO_API_KEY secret (${e.message}), so page views were left out.`; }
  }
  return { list, views, note };
}
const feedUrl = { medium: (a) => `https://medium.com/feed/@${a}`, substack: (a) => `${a}/feed` };

/* ---------- main ---------- */
// everything except the "checked" stamps, to tell whether anything really changed
const comparable = (c) => JSON.stringify({ items: c.items, accounts: Object.fromEntries(Object.entries(c.accounts || {}).map(([k, v]) => [k, { ...v, checked: null }])) });

export async function run({ root = ROOT, env = process.env, log = console.log } = {}) {
  const read = (p, fb) => { try { return JSON.parse(fs.readFileSync(path.join(root, p), 'utf8')); } catch { return fb; } };
  const cfg = read('config.json', {});
  const cc = compileConfig(cfg);
  const src = read('sources.json', {});
  const prev = read('data/content.json', { items: [], accounts: {} });
  const orgs = Array.isArray(src.githubOrgs) ? src.githubOrgs.filter((o) => /^[A-Za-z0-9-]{1,39}$/.test(o)) : DEFAULT_ORGS;
  const now = new Date().toISOString();
  const next = { updated: now, accounts: {}, items: [] };
  for (const p of PLATFORMS) {
    const raw = clean(src[p]);
    if (!raw) continue;
    const account = normalise[p](raw);
    if (!account) { log(`::warning::sources.json "${p}": "${raw}" doesn't look like a ${p} account, so it was skipped.`); continue; }
    const before = (prev.items || []).filter((i) => i.source === p && i.account === account);
    const acc = { user: account, profile: profileUrl[p](account), checked: now };
    try {
      let items;
      if (p === 'github') { const g = await readGithub(account, orgs, env.GH_TOKEN); items = githubItems(account, g.issues, g.repos); }
      if (p === 'devto') { const d = await readDevto(account, String(env.DEVTO_API_KEY || '').trim()); items = devtoItems(account, d.list, d.views, cc); if (d.note) { acc.note = d.note; log(`::warning::${d.note}`); } }
      if (p === 'medium' || p === 'substack') {
        const posts = parseRss(await getText(feedUrl[p](account), { Accept: 'application/rss+xml, application/xml, text/xml' }));
        const dates = posts.map((x) => Date.parse(x.date)).filter(Number.isFinite);
        items = mergeFeed(before, feedItems(p, account, posts, cc), dates.length ? Math.min(...dates) : null);
      }
      next.items.push(...items);
      log(`${p} ${account}: ${items.length} Midnight-related item${items.length === 1 ? '' : 's'}.`);
    } catch (e) {
      // the platform didn't answer: keep what was there, and say so (the owner sees it on the page)
      next.items.push(...before);
      acc.checked = prev.accounts?.[p]?.user === account ? prev.accounts[p].checked ?? null : null;
      acc.error = `${({ github: 'GitHub', devto: 'dev.to', medium: 'Medium', substack: 'Substack' })[p]} didn't answer (${e.message}) on ${now.slice(0, 10)}, so the last numbers were kept.`;
      log(`::warning::${acc.error}`);
    }
    next.accounts[p] = acc;
  }
  next.items.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.id.localeCompare(b.id)));
  const changed = !fs.existsSync(path.join(root, 'data/content.json')) || comparable(prev) !== comparable(next);
  if (changed) fs.writeFileSync(path.join(root, 'data/content.json'), JSON.stringify(next, null, 1) + '\n');
  log(changed ? `data/content.json written: ${next.items.length} items.` : 'Nothing new.');
  return { next, changed };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await run();
