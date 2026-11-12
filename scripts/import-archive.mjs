#!/usr/bin/env node
// Brings in post history older than the API's reach (~3,200 most recent posts) from an
// X data archive (x.com → Settings → Your account → Download an archive of your data).
//
//   node scripts/import-archive.mjs "C:\path\to\archive\data"   [--before=YYYY-MM-DD]
//
// An archive is a snapshot: posts deleted on X after it was made are still in it. So nothing
// from the archive is published as-is:
//   • posts newer than the oldest stored API post are skipped (the API already covers them,
//     deletions included; --before overrides the cut-off);
//   • older Midnight-related posts are only QUEUED (id, date, type) in data/pending-archive.json.
//     The "verify-archive" workflow mode then looks each one up on X: posts that still exist are
//     stored with X's current text and metrics, deleted ones are dropped;
//   • older non-Midnight posts are stored as date-only stubs (for share of voice).
// Reads tweets.js (+ tweets-part*.js), note-tweet.js (full text of long posts) and account.js.
// Keep the archive OUTSIDE this repo: it also holds DMs and other personal data.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileConfig, classify } from './lib/classify.mjs';
import { ROOT, DATA, readJson, writeJson, loadStore, saveStore, detectKind } from './lib/posts.mjs';

export const PENDING_FILE = path.join(DATA, 'pending-archive.json');

/** Parse "window.YTD.tweets.part0 = [ ... ]" files. */
export function parseYtd(source) {
  const eq = source.indexOf('=');
  if (eq === -1) throw new Error('Not an X archive data file');
  return JSON.parse(source.slice(eq + 1).trim().replace(/;\s*$/, ''));
}

export function normalizeArchiveTweet(t, username) {
  const ent = t.entities ?? {};
  const urls = (ent.urls ?? []).map((u) => u.expanded_url ?? u.url).filter(Boolean);
  const text = t.full_text ?? t.text ?? '';
  const replyTo = t.in_reply_to_screen_name;
  let kind;
  let refs;
  if (/^RT @[A-Za-z0-9_]{1,15}:/.test(text)) {
    ({ kind, refs } = detectKind({ id: t.id_str, text, refs: [{ type: 'retweeted' }], urls }));
  } else if (t.in_reply_to_status_id_str) {
    const self = replyTo && username && replyTo.toLowerCase() === username.toLowerCase();
    kind = self ? 'thread' : 'reply';
    refs = [{ type: kind, author: replyTo ?? null }];
  } else {
    ({ kind, refs } = detectKind({ id: t.id_str, text, refs: undefined, urls }));
  }
  return {
    id: String(t.id_str ?? t.id),
    created_at: new Date(t.created_at).toISOString(),
    text,
    kind,
    refs,
    url: `https://x.com/${username || 'i'}/status/${t.id_str ?? t.id}`,
    lang: t.lang ?? null,
    mentions: (ent.user_mentions ?? []).map((m) => m.screen_name).filter(Boolean),
    hashtags: (ent.hashtags ?? []).map((h) => h.text).filter(Boolean),
    cashtags: (ent.symbols ?? []).map((s) => s.text).filter(Boolean),
    urls,
    metrics: {
      impressions: null,
      likes: t.favorite_count != null ? Number(t.favorite_count) : null,
      replies: null,
      reposts: t.retweet_count != null ? Number(t.retweet_count) : null,
      quotes: null,
      bookmarks: null,
    },
    source: 'archive',
  };
}

/** Long posts: tweets.js holds a truncated text; note-tweet.js the full one, matched on creation time. */
export function noteTextIndex(noteRows = []) {
  const map = new Map();
  for (const row of noteRows) {
    const n = row.noteTweet ?? row;
    const at = n.createdAt ? new Date(n.createdAt).toISOString() : null;
    if (at && n.core?.text) map.set(at, n.core);
  }
  return map;
}

/**
 * Sort archive posts into: skipped (covered by the API), queued for verification (Midnight-related),
 * or stored as stubs. Mutates `store` and `pending`; returns counts.
 */
export function queueArchive({ rows, notes = new Map(), store, pending, cc, username, cutoff }) {
  const known = new Set([...store.posts.posts, ...store.posts.other].map((p) => p.id));
  const queued = new Set(pending.posts.map((p) => p.id));
  const counts = { read: 0, skippedRecent: 0, known: 0, queued: 0, stubbed: 0 };
  for (const row of rows) {
    const t = row.tweet ?? row;
    counts.read++;
    const post = normalizeArchiveTweet(t, username);
    const note = notes.get(post.created_at);
    if (note) {
      post.text = note.text;
      post.mentions = [...new Set([...post.mentions, ...(note.mentions ?? []).map((m) => m.screenName ?? m.screen_name).filter(Boolean)])];
      post.urls = [...new Set([...post.urls, ...(note.urls ?? []).map((u) => u.expandedUrl ?? u.expanded_url).filter(Boolean)])];
    }
    if (cutoff && post.created_at >= cutoff) {
      counts.skippedRecent++;
      continue;
    }
    if (known.has(post.id) || queued.has(post.id)) {
      counts.known++;
      continue;
    }
    if (classify(post, cc).midnight) {
      pending.posts.push({ id: post.id, created_at: post.created_at, kind: post.kind });
      queued.add(post.id);
      counts.queued++;
    } else {
      store.posts.other.push({ id: post.id, created_at: post.created_at, kind: post.kind });
      known.add(post.id);
      counts.stubbed++;
    }
  }
  return counts;
}

async function main(argv) {
  const dir = argv.find((a) => !a.startsWith('--'));
  const before = argv.find((a) => a.startsWith('--before='))?.slice('--before='.length);
  if (!dir) {
    console.error('Usage: node scripts/import-archive.mjs <path to the archive\'s data folder> [--before=YYYY-MM-DD]');
    process.exit(1);
  }
  const files = (await fs.readdir(dir)).filter((f) => /^tweets(-part\d+)?\.js$/.test(f));
  if (!files.length) throw new Error(`No tweets.js found in ${dir}. Point at the archive's "data" folder.`);

  const cfg = await readJson(path.join(ROOT, 'config.json'));
  const cc = compileConfig(cfg);
  const store = await loadStore();
  if (store.meta.demo) {
    store.posts = { posts: [], other: [] };
    store.history = { days: {} };
    store.mentions = { days: {} };
    store.meta = { demo: false };
  }
  const pending = await readJson(PENDING_FILE, { posts: [] });

  let username = store.meta.user?.username || cfg.handle || '';
  try {
    const acct = parseYtd(await fs.readFile(path.join(dir, 'account.js'), 'utf8'));
    username = acct[0]?.account?.username || username;
  } catch {
    /* account.js is optional */
  }
  let notes = new Map();
  try {
    notes = noteTextIndex(parseYtd(await fs.readFile(path.join(dir, 'note-tweet.js'), 'utf8')));
  } catch {
    /* note-tweet.js is optional */
  }

  const stored = [...store.posts.posts, ...store.posts.other].map((p) => p.created_at).sort();
  const cutoff = before ? new Date(before + 'T00:00:00Z').toISOString() : stored[0] ?? null;

  const rows = [];
  for (const f of files) rows.push(...parseYtd(await fs.readFile(path.join(dir, f), 'utf8')));
  const counts = queueArchive({ rows, notes, store, pending, cc, username, cutoff });

  pending.updated = new Date().toISOString();
  await writeJson(PENDING_FILE, pending);
  store.meta.archiveImport = { at: new Date().toISOString(), cutoff, ...counts };
  if (!store.meta.handle && username) store.meta.handle = username;
  await saveStore(store);

  console.log(`Archive: ${counts.read} posts read.`);
  if (cutoff) console.log(`  ${counts.skippedRecent} on or after ${cutoff.slice(0, 10)} skipped: the API already covers them, deletions included.`);
  console.log(`  ${counts.queued} older Midnight-related posts queued for verification (${pending.posts.length} in the queue).`);
  console.log(`  ${counts.stubbed} older non-Midnight posts stored as date-only stubs; ${counts.known} already known.`);
  console.log(`Next: run the "Refresh X data" workflow in mode verify-archive (≈ $${(pending.posts.length * 0.005).toFixed(2)} at most; deleted posts cost nothing and are dropped).`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main(process.argv.slice(2)).catch((err) => {
    console.error('✖ ' + err.message);
    process.exit(1);
  });
}
