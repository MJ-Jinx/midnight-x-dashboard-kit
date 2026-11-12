// Normalising X API / archive posts into one shape, and merging them into the
// committed data files. Only Midnight-related posts are stored in full; other
// posts are kept as {id, created_at, kind} stubs so "share of voice" can be
// computed without republishing unrelated content.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify } from './classify.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DATA = path.join(ROOT, 'data');

export async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT' && fallback !== undefined) return structuredClone(fallback);
    throw err;
  }
}

export async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 1) + '\n', 'utf8');
}

export const EMPTY = {
  posts: { posts: [], other: [] },
  history: { days: {} },
  mentions: { days: {} },
  meta: { demo: false },
};

export async function loadStore() {
  return {
    posts: await readJson(path.join(DATA, 'posts.json'), EMPTY.posts),
    history: await readJson(path.join(DATA, 'history.json'), EMPTY.history),
    mentions: await readJson(path.join(DATA, 'mentions.json'), EMPTY.mentions),
    meta: await readJson(path.join(DATA, 'meta.json'), EMPTY.meta),
  };
}

export async function saveStore(store) {
  store.posts.posts.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  store.posts.other.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  await writeJson(path.join(DATA, 'posts.json'), store.posts);
  await writeJson(path.join(DATA, 'history.json'), store.history);
  await writeJson(path.join(DATA, 'mentions.json'), store.mentions);
  await writeJson(path.join(DATA, 'meta.json'), store.meta);
}

/** 'YYYY-MM-DD' for a Date in an IANA time zone. */
export function localDate(date, timeZone = 'UTC') {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

const STATUS_URL = /(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/i;
const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));

/**
 * Work out original / reply / thread / quote / repost and who was referenced.
 * Uses referenced_posts (2026 naming) or referenced_tweets (legacy) when the API
 * returns them, and falls back to text/conversation heuristics when it doesn't,
 * so no paid expansions are needed.
 */
export function detectKind({ id, text, refs, inReplyToUserId, conversationId, urls, myId, myUsername }) {
  const t = String(text ?? '');
  const types = new Set((refs ?? []).map((r) => r.type));
  const out = [];
  const rt = t.match(/^RT @([A-Za-z0-9_]{1,15}):/);
  if (types.has('retweeted') || types.has('reposted') || rt) {
    out.push({ type: 'repost', author: rt?.[1] ?? null });
    return { kind: 'repost', refs: out };
  }
  const leading = [...t.matchAll(/^(?:@([A-Za-z0-9_]{1,15})\s+)+/g)][0];
  const leadingHandles = leading ? [...leading[0].matchAll(/@([A-Za-z0-9_]{1,15})/g)].map((m) => m[1]) : [];
  const isReply =
    types.has('replied_to') ||
    Boolean(inReplyToUserId) ||
    (conversationId && String(conversationId) !== String(id));
  if (isReply) {
    const self =
      (inReplyToUserId && myId && String(inReplyToUserId) === String(myId)) ||
      (!inReplyToUserId && leadingHandles.length === 0) ||
      (leadingHandles.length > 0 && myUsername && leadingHandles.every((h) => h.toLowerCase() === myUsername.toLowerCase()));
    if (self) return { kind: 'thread', refs: [{ type: 'thread', author: myUsername ?? null }] };
    return { kind: 'reply', refs: leadingHandles.slice(0, 3).map((h) => ({ type: 'reply', author: h })) };
  }
  const quoteUrl = (urls ?? []).map((u) => String(u).match(STATUS_URL)).find(Boolean);
  if (types.has('quoted') || (refs === undefined && quoteUrl)) {
    return { kind: 'quote', refs: [{ type: 'quote', author: quoteUrl?.[1] ?? null }] };
  }
  return { kind: 'original', refs: [] };
}

/** X API v2 post object (either field-naming generation) → stored shape. */
export function normalizeApiPost(raw, me) {
  const text = raw.note_post?.text ?? raw.note_tweet?.text ?? raw.text ?? '';
  const ent = raw.note_post?.entities ?? raw.note_tweet?.entities ?? raw.entities ?? {};
  const urls = (ent.urls ?? []).map((u) => u.expanded_url ?? u.url).filter(Boolean);
  const rawRefs = raw.referenced_posts ?? raw.referenced_tweets;
  const { kind, refs } = detectKind({
    id: raw.id,
    text,
    refs: rawRefs,
    inReplyToUserId: raw.in_reply_to_user_id,
    conversationId: raw.conversation_id,
    urls,
    myId: me.id,
    myUsername: me.username,
  });
  const pm = raw.public_metrics ?? {};
  const npm = raw.non_public_metrics;
  const om = raw.organic_metrics;
  const post = {
    id: String(raw.id),
    created_at: new Date(raw.created_at).toISOString(),
    text,
    kind,
    refs,
    url: `https://x.com/${me.username}/status/${raw.id}`,
    lang: raw.lang ?? null,
    mentions: (ent.mentions ?? []).map((m) => m.username).filter(Boolean),
    hashtags: (ent.hashtags ?? []).map((h) => h.tag).filter(Boolean),
    cashtags: (ent.cashtags ?? []).map((c) => c.tag).filter(Boolean),
    urls,
    metrics: {
      impressions: num(pm.impression_count),
      likes: num(pm.like_count),
      replies: num(pm.reply_count),
      reposts: num(pm.retweet_count ?? pm.repost_count),
      quotes: num(pm.quote_count),
      bookmarks: num(pm.bookmark_count),
    },
    source: 'api',
  };
  if (npm || om) {
    post.private = {
      impressions: num(om?.impression_count ?? npm?.impression_count),
      engagements: num(npm?.engagements),
      link_clicks: num(npm?.url_link_clicks ?? om?.url_link_clicks),
      profile_clicks: num(npm?.user_profile_clicks ?? om?.user_profile_clicks),
    };
  }
  return post;
}

/**
 * Merge freshly fetched posts. `coveredFrom` is the start of the time range the
 * fetch fully covered; stored posts inside it that X no longer returned were
 * deleted on X and are removed here too (only when the fetch was complete).
 */
export function mergePosts(store, incoming, cc, { coveredFrom = null, complete = false, now = new Date() } = {}) {
  const full = new Map(store.posts.posts.map((p) => [p.id, p]));
  const stubs = new Map(store.posts.other.map((p) => [p.id, p]));
  const seen = new Set();
  let added = 0;

  for (const p of incoming) {
    seen.add(p.id);
    const prev = full.get(p.id);
    if (!prev && !stubs.has(p.id)) added++;
    const merged = {
      ...prev,
      ...p,
      private: p.private ?? prev?.private,
      first_seen: prev?.first_seen ?? now.toISOString(),
    };
    if (merged.private === undefined) delete merged.private;
    const c = classify(merged, cc);
    if (c.midnight) {
      full.set(p.id, { ...merged, class: c });
      stubs.delete(p.id);
    } else {
      full.delete(p.id);
      stubs.set(p.id, { id: p.id, created_at: p.created_at, kind: p.kind });
    }
  }

  let removed = 0;
  if (complete && coveredFrom) {
    const cutoff = coveredFrom.getTime() + 60 * 60 * 1000; // 1h safety margin
    for (const map of [full, stubs]) {
      for (const [id, p] of map) {
        if (!seen.has(id) && Date.parse(p.created_at) >= cutoff) {
          map.delete(id);
          removed++;
        }
      }
    }
  }

  store.posts.posts = [...full.values()];
  store.posts.other = [...stubs.values()];
  return { added, removed };
}

/** Re-run classification over stored full posts (after editing config.json). */
export function reclassifyAll(store, cc) {
  let moved = 0;
  const keep = [];
  for (const p of store.posts.posts) {
    const c = classify(p, cc);
    if (c.midnight) keep.push({ ...p, class: c });
    else {
      moved++;
      store.posts.other.push({ id: p.id, created_at: p.created_at, kind: p.kind });
    }
  }
  store.posts.posts = keep;
  return { moved, kept: keep.length };
}
