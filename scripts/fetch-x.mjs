#!/usr/bin/env node
// Pulls your own posts (and mention counts) from the X API v2 and updates data/*.json.
//
//   node scripts/fetch-x.mjs                 # auto: weekly on Sundays (UTC), daily otherwise
//   node scripts/fetch-x.mjs --mode=daily    # last 7 days (config.fetch.dailyWindowDays)
//   node scripts/fetch-x.mjs --mode=weekly   # last 29 days, incl. link/profile clicks
//   node scripts/fetch-x.mjs --mode=backfill # whole reachable timeline (X keeps ~3,200 most recent)
//   node scripts/fetch-x.mjs --mode=reclassify   # offline: re-apply config.json keywords
//   node scripts/fetch-x.mjs --mode=verify-archive  # look up archive posts queued by import-archive.mjs
//   add --dry-run to fetch and report without writing files
//
// Credentials (OAuth 1.0a user context, from console.x.com → your app → Keys and tokens):
//   X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { oauthHeader, buildQuery, cleanParams } from './lib/oauth1.mjs';
import { compileConfig, classify } from './lib/classify.mjs';
import {
  ROOT, DATA, readJson, writeJson, loadStore, saveStore, normalizeApiPost, mergePosts, reclassifyAll, localDate,
} from './lib/posts.mjs';

const API = 'https://api.x.com';
// Estimates from docs.x.com/x-api/getting-started/pricing (Nov 2026): reads of your own
// timeline/mentions bill as "Owned Reads"; a user lookup bills at the user rate.
// A lookup by post ID (/2/tweets?ids=) is a plain post read.
export const COST = { ownedPost: 0.001, post: 0.005, user: 0.01 };

export class XApiError extends Error {
  constructor(status, body, url) {
    const detail = body?.detail ?? body?.title ?? body?.errors?.[0]?.message ?? JSON.stringify(body).slice(0, 300);
    super(`X API ${status}: ${detail}`);
    this.status = status;
    this.body = body;
    this.url = url;
  }
}

const HINTS = {
  401: 'Check the four X_* secrets: they must be the API Key/Secret and the Access Token/Secret of the SAME app, and the access token must be regenerated after any permission change.',
  402: 'Your X API credit balance is empty or a spending limit was hit. Top up / raise the limit at console.x.com.',
  403: 'The app may lack Read permission, be outside a project, or have no credits. Check the app in console.x.com.',
  429: 'Rate limited. The job retries automatically; if it keeps failing, run less often.',
};

// Field names: the 2026 docs use post.fields / note_post / referenced_posts; older apps
// used tweet.fields / note_tweet / referenced_tweets. Try in order; a 400 costs nothing.
function paramSets(includePrivate) {
  const priv = includePrivate ? ',non_public_metrics,organic_metrics' : '';
  return [
    {
      name: 'post-fields-2026',
      params: {
        'post.fields': `created_at,public_metrics,entities,conversation_id,lang,note_post${priv}`,
      },
    },
    {
      name: 'tweet-fields-legacy',
      params: {
        'tweet.fields': `created_at,public_metrics,entities,conversation_id,lang,note_tweet,referenced_tweets,in_reply_to_user_id${priv}`,
      },
    },
  ];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class XClient {
  constructor(creds, { fetchImpl = globalThis.fetch, preferredSet = null, log = console.log } = {}) {
    this.creds = creds;
    this.fetch = fetchImpl;
    this.preferredSet = preferredSet;
    this.log = log;
    this.workingSet = null;
  }

  async get(pathname, params = {}, attempt = 0) {
    const url = API + pathname;
    const clean = cleanParams(params);
    const { header } = oauthHeader({
      method: 'GET',
      url,
      params: clean,
      consumerKey: this.creds.apiKey,
      consumerSecret: this.creds.apiSecret,
      token: this.creds.accessToken,
      tokenSecret: this.creds.accessTokenSecret,
    });
    const qs = buildQuery(clean);
    const res = await this.fetch(qs ? `${url}?${qs}` : url, {
      headers: { Authorization: header, 'User-Agent': 'midnight-x-dashboard/1.0' },
    });
    if (res.status === 429 && attempt < 3) {
      const reset = Number(res.headers.get('x-rate-limit-reset')) * 1000;
      const wait = Math.min(Math.max((reset || Date.now() + 60_000) - Date.now(), 5_000), 15 * 60_000);
      this.log(`  rate limited; waiting ${Math.round(wait / 1000)}s`);
      await sleep(wait);
      return this.get(pathname, params, attempt + 1);
    }
    let body;
    try {
      body = await res.json();
    } catch {
      body = {};
    }
    if (!res.ok) throw new XApiError(res.status, body, url);
    return body;
  }

  /** Page through a v2 list endpoint, picking a field-naming generation that works. */
  async paged(pathname, baseParams, { includePrivate = false, maxItems = 1000 } = {}) {
    let sets = paramSets(includePrivate);
    if (this.workingSet || this.preferredSet) {
      const pref = this.workingSet ?? this.preferredSet;
      sets = [...sets.filter((s) => s.name === pref), ...sets.filter((s) => s.name !== pref)];
    }
    let lastErr;
    for (const set of sets) {
      const items = [];
      const errors = [];
      let token;
      try {
        do {
          const body = await this.get(pathname, {
            ...baseParams,
            ...set.params,
            max_results: 100,
            pagination_token: token,
          });
          items.push(...(body.data ?? []));
          if (body.errors?.length) errors.push(...body.errors);
          token = body.meta?.next_token;
        } while (token && items.length < maxItems);
        this.workingSet = set.name;
        return { items, errors, complete: !token, set: set.name };
      } catch (err) {
        lastErr = err;
        if (err instanceof XApiError && err.status === 400 && items.length === 0) {
          this.log(`  field set "${set.name}" rejected (${err.message}); trying next`);
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  }
}

/**
 * Archive posts queued by import-archive.mjs are looked up on X (100 per call). Posts that still
 * exist are stored with X's current text and public metrics; deleted or hidden ones are dropped,
 * so nothing removed from X after the archive was made reaches the dashboard.
 */
async function verifyArchive({ client, store, cc, log, dryRun, now, injected }) {
  const pendingFile = path.join(DATA, 'pending-archive.json');
  const pending = store.pending ?? (await readJson(pendingFile, { posts: [] }));
  if (!pending.posts.length) {
    log('Nothing queued. Run scripts/import-archive.mjs first.');
    return { mode: 'verify-archive', usage: { postsRead: 0 }, est: 0, found: 0, dropped: 0 };
  }
  let me = store.meta.user;
  let usersRead = 0;
  if (!me?.id || !me?.username) {
    me = (await client.get('/2/users/me', { 'user.fields': 'username,name' })).data;
    usersRead++;
  }
  const ids = pending.posts.map((p) => p.id);
  const incoming = [];
  const gone = new Set();
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    let body;
    let lastErr;
    const sets = paramSets(false);
    const pref = client.workingSet ?? client.preferredSet;
    for (const set of [...sets.filter((s) => s.name === pref), ...sets.filter((s) => s.name !== pref)]) {
      try {
        body = await client.get('/2/tweets', { ids: batch.join(','), ...set.params });
        client.workingSet = set.name;
        break;
      } catch (err) {
        lastErr = err;
        if (!(err instanceof XApiError && err.status === 400)) throw err;
      }
    }
    if (!body) throw lastErr;
    const found = new Set();
    for (const raw of body.data ?? []) {
      found.add(String(raw.id));
      incoming.push({ ...normalizeApiPost(raw, me), via: 'archive' });
    }
    for (const id of batch) if (!found.has(id)) gone.add(id);
  }
  mergePosts(store, incoming, cc, { complete: false, now });
  // Anything X no longer serves is dropped everywhere, stubs included.
  store.posts.posts = store.posts.posts.filter((p) => !gone.has(p.id));
  store.posts.other = store.posts.other.filter((p) => !gone.has(p.id));
  const kept = incoming.filter((p) => store.posts.posts.some((q) => q.id === p.id)).length;

  const est = incoming.length * COST.post + usersRead * COST.user;
  const month = now.toISOString().slice(0, 7);
  store.meta = {
    ...store.meta,
    paramSet: client.workingSet ?? store.meta.paramSet ?? null,
    lastRun: { at: now.toISOString(), mode: 'verify-archive', postsRead: incoming.length, mentionsRead: 0, usersRead, estCostUSD: Number(est.toFixed(4)) },
    costByMonth: { ...(store.meta.costByMonth ?? {}), [month]: Number((((store.meta.costByMonth ?? {})[month] ?? 0) + est).toFixed(4)) },
    archiveVerify: { at: now.toISOString(), checked: ids.length, found: incoming.length, kept, dropped: gone.size },
  };
  log(`Archive check: ${ids.length} queued, ${incoming.length} still on X (${kept} Midnight-related, stored), ${gone.size} deleted or hidden (dropped).`);
  log(`Estimated cost this run: $${est.toFixed(3)}.`);
  pending.posts = [];
  pending.updated = now.toISOString();
  if (!dryRun) {
    await saveStore(store);
    if (!injected) await writeJson(pendingFile, pending);
  }
  return { mode: 'verify-archive', usage: { postsRead: incoming.length, usersRead }, est, found: incoming.length, kept, dropped: gone.size };
}

function parseArgs(argv) {
  const args = { mode: null, dryRun: false };
  for (const a of argv) {
    if (a.startsWith('--mode=')) args.mode = a.slice(7);
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function credsFromEnv(env) {
  const creds = {
    apiKey: env.X_API_KEY,
    apiSecret: env.X_API_SECRET,
    accessToken: env.X_ACCESS_TOKEN,
    accessTokenSecret: env.X_ACCESS_TOKEN_SECRET,
  };
  const missing = Object.entries({
    X_API_KEY: creds.apiKey,
    X_API_SECRET: creds.apiSecret,
    X_ACCESS_TOKEN: creds.accessToken,
    X_ACCESS_TOKEN_SECRET: creds.accessTokenSecret,
  })
    .filter(([, v]) => !v)
    .map(([k]) => k);
  return { creds, missing };
}

export async function run({
  mode,
  dryRun = false,
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = new Date(),
  log = console.log,
  store: injectedStore,
  config: injectedConfig,
} = {}) {
  const cfg = injectedConfig ?? (await readJson(path.join(ROOT, 'config.json')));
  const cc = compileConfig(cfg);
  const store = injectedStore ?? (await loadStore());
  const tz = cfg.timezone || 'UTC';
  mode = mode ?? (now.getUTCDay() === 0 ? 'weekly' : 'daily');

  if (mode === 'reclassify') {
    const r = reclassifyAll(store, cc);
    log(`Reclassified: ${r.kept} Midnight posts kept, ${r.moved} moved to non-Midnight.`);
    if (!dryRun) await saveStore(store);
    return { mode, ...r };
  }
  if (!['daily', 'weekly', 'backfill', 'verify-archive'].includes(mode)) throw new Error(`Unknown --mode=${mode}`);

  const { creds, missing } = credsFromEnv(env);
  if (missing.length) {
    throw new Error(`Missing environment variables: ${missing.join(', ')}. See README → "Connect your X account".`);
  }

  if (store.meta.demo) {
    // First real run: throw away the bundled demo data.
    log('Replacing demo data with your real data.');
    store.posts = { posts: [], other: [] };
    store.history = { days: {} };
    store.mentions = { days: {} };
    store.meta = { demo: false };
  }

  const client = new XClient(creds, { fetchImpl, preferredSet: store.meta.paramSet, log });
  if (mode === 'verify-archive') return verifyArchive({ client, store, cc, log, dryRun, now, injected: injectedStore !== undefined });
  const usage = { postsRead: 0, mentionsRead: 0, usersRead: 0 };

  // 1. Who am I (+ follower snapshot)
  const meBody = await client.get('/2/users/me', {
    'user.fields': 'public_metrics,username,name,profile_image_url,created_at',
  });
  usage.usersRead++;
  const me = meBody.data;
  if (!me?.id) throw new Error('Unexpected /2/users/me response: ' + JSON.stringify(meBody).slice(0, 300));
  const upm = me.public_metrics ?? {};
  const today = localDate(now, tz);
  store.history.days[today] = {
    followers: upm.followers_count ?? null,
    following: upm.following_count ?? null,
    posts: upm.tweet_count ?? upm.post_count ?? null,
    listed: upm.listed_count ?? null,
  };
  log(`@${me.username}: ${upm.followers_count ?? '?'} followers`);

  // 2. Own timeline
  const windowDays =
    mode === 'backfill' ? null : mode === 'weekly' ? cfg.fetch?.weeklyWindowDays ?? 29 : cfg.fetch?.dailyWindowDays ?? 7;
  const includePrivate = windowDays !== null && windowDays <= 29; // non-public metrics: last 30 days only
  const start = windowDays === null ? null : new Date(now.getTime() - windowDays * 86_400_000);
  const maxItems = mode === 'backfill' ? 3300 : cfg.fetch?.maxPostsPerRun ?? 1000;
  const tl = await client.paged(
    `/2/users/${me.id}/tweets`,
    {
      start_time: start?.toISOString(),
      exclude: (cfg.fetch?.exclude ?? []).join(',') || undefined,
    },
    { includePrivate, maxItems },
  );
  usage.postsRead += tl.items.length;
  const incoming = tl.items.map((raw) => normalizeApiPost(raw, me));
  const oldest = incoming.reduce((min, p) => (p.created_at < min ? p.created_at : min), now.toISOString());
  // The range this fetch fully covered: the window start, or for a backfill the oldest post reached.
  const coveredFrom = start ?? new Date(oldest);
  const merged = mergePosts(store, incoming, cc, { coveredFrom, complete: tl.complete, now });
  const mid = incoming.filter((p) => store.posts.posts.some((q) => q.id === p.id)).length;
  log(`Timeline (${mode}): ${incoming.length} posts read, ${mid} Midnight-related, ${merged.added} new, ${merged.removed} removed (deleted on X).`);
  if (tl.errors.length) log(`  ${tl.errors.length} partial errors, first: ${tl.errors[0]?.detail ?? tl.errors[0]?.message ?? ''}`);

  // 3. Mention counts (stored as daily totals only — other people's posts are not republished)
  if (cfg.fetch?.mentions !== false) {
    const mDays = cfg.fetch?.mentionsWindowDays ?? 3;
    const mStart = new Date(now.getTime() - mDays * 86_400_000);
    const firstFullDay = localDate(new Date(mStart.getTime() + 86_400_000), tz);
    const mn = await client.paged(
      `/2/users/${me.id}/mentions`,
      { start_time: mStart.toISOString() },
      { includePrivate: false, maxItems: cfg.fetch?.maxMentionsPerRun ?? 500 },
    );
    usage.mentionsRead += mn.items.length;
    const counts = {};
    for (const raw of mn.items) {
      const day = localDate(new Date(raw.created_at), tz);
      if (day < firstFullDay) continue; // partial first day — keep the earlier, complete count
      const text = raw.note_post?.text ?? raw.note_tweet?.text ?? raw.text ?? '';
      const ent = raw.entities ?? {};
      const c = classify(
        {
          id: raw.id,
          text,
          mentions: (ent.mentions ?? []).map((m) => m.username),
          urls: (ent.urls ?? []).map((u) => u.expanded_url ?? u.url),
        },
        cc,
      );
      counts[day] ??= { total: 0, midnight: 0 };
      counts[day].total++;
      if (c.midnight) counts[day].midnight++;
    }
    for (let d = new Date(mStart.getTime() + 86_400_000); localDate(d, tz) <= today; d = new Date(d.getTime() + 86_400_000)) {
      const key = localDate(d, tz);
      if (key >= firstFullDay) store.mentions.days[key] = counts[key] ?? { total: 0, midnight: 0 };
    }
    log(`Mentions: ${mn.items.length} read since ${firstFullDay}.`);
  }

  // 4. Meta + cost estimate
  const est = (usage.postsRead + usage.mentionsRead) * COST.ownedPost + usage.usersRead * COST.user;
  const month = now.toISOString().slice(0, 7);
  store.meta = {
    ...store.meta,
    demo: false,
    handle: me.username,
    user: { id: me.id, username: me.username, name: me.name, profile_image_url: me.profile_image_url ?? null },
    paramSet: client.workingSet ?? store.meta.paramSet ?? null,
    lastRun: { at: now.toISOString(), mode, ...usage, estCostUSD: Number(est.toFixed(4)) },
    costByMonth: { ...(store.meta.costByMonth ?? {}), [month]: Number((((store.meta.costByMonth ?? {})[month] ?? 0) + est).toFixed(4)) },
  };
  log(`Estimated cost this run: $${est.toFixed(3)} (X dedupes repeat reads of the same post within a UTC day).`);

  if (!dryRun) await saveStore(store);
  return { mode, usage, est, merged };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node scripts/fetch-x.mjs [--mode=daily|weekly|backfill|reclassify] [--dry-run]');
    process.exit(0);
  }
  run(args).catch((err) => {
    console.error('\n✖ ' + err.message);
    if (err instanceof XApiError && HINTS[err.status]) console.error('  Hint: ' + HINTS[err.status]);
    process.exit(1);
  });
}
