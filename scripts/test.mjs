// Run with:  node --test scripts/test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { existsSync } from 'node:fs';
import { oauthHeader } from './lib/oauth1.mjs';
import { compileConfig, classify } from './lib/classify.mjs';
import { normalizeApiPost, mergePosts, detectKind, ROOT } from './lib/posts.mjs';
import { run } from './fetch-x.mjs';
import { parseYtd, normalizeArchiveTweet, queueArchive, noteTextIndex } from './import-archive.mjs';
import { publicPosts, publicMeta, build, leaks } from './publish.mjs';

// The real keyword lists, plus a fixed focus area and fixed series, so the tests pass whatever this copy's config.json sets.
const base = JSON.parse(await fs.readFile(path.join(ROOT, 'config.json'), 'utf8'));
const cfg = {
  ...base,
  local: { label: 'Testland', short: 'Testland', terms: ['testland', 'test city', '🏳️'] },
  series: [
    { id: 'daily-fact', label: 'Daily Fact', phrases: ['daily fact #'] },
    { id: 'myth-reality', label: 'Myth vs Reality', phrases: ['myth vs reality series', 'myth vs. reality series'] },
    { id: 'roadmap', label: 'Roadmap breakdown', phrases: ['of the roadmap'], from: '2026-10-20', to: '2026-10-29', kinds: ['original', 'quote'] },
  ],
};
const cc = compileConfig(cfg);
const me = { id: '42', username: 'jinx_demo' };

test('OAuth 1.0a signature matches the published X/Twitter reference example', () => {
  const { signature } = oauthHeader({
    method: 'POST',
    url: 'https://api.twitter.com/1.1/statuses/update.json',
    params: { include_entities: 'true', status: 'Hello Ladies + Gentlemen, a signed OAuth request!' },
    consumerKey: 'xvz1evFS4wEEPTGEFPHBog',
    consumerSecret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw',
    token: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb',
    tokenSecret: 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE',
    nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg',
    timestamp: 1318622958,
  });
  assert.equal(signature, 'hCtSmYh+iHYCEqBWrE7C7hYmtUk=');
});

const c = (text, extra = {}) => classify({ id: 'x', text, ...extra }, cc);

test('classifier: Midnight signals are detected', () => {
  assert.equal(c('Loving what @MidnightNtwrk is shipping').midnight, true);
  assert.equal(c('Holding $NIGHT for the long run').midnight, true);
  assert.equal(c('New Compact contract deployed on preprod').midnight, true);
  assert.equal(c('Midnight is the privacy chain I build on').midnight, true);
  assert.equal(c('see https://midnight.network/blog').midnight, true);
  assert.equal(c('quoted', { kind: 'quote', refs: [{ type: 'quote', author: 'midnightfdn' }] }).midnight, true);
});

test('classifier: time-of-day "midnight" and look-alikes are ignored', () => {
  assert.equal(c('Still coding at midnight again').midnight, false);
  assert.equal(c('Good night everyone').midnight, false);
  assert.equal(c('zkSync gas is low today').midnight, false);
  assert.equal(c('Burning the midnight oil').midnight, false);
});

test('classifier: bare "midnight" is included but flagged for review', () => {
  const r = c('Midnight community vibes this week');
  assert.equal(r.midnight, true);
  assert.equal(r.review, true);
  assert.equal(c('@MidnightNtwrk community vibes').review, false);
});

test('classifier: focus area, themes and overrides', () => {
  const r = c('Compact workshop in Test City for Midnight builders 🏳️');
  assert.equal(r.local, true);
  assert.ok(r.themes.includes('build'));
  assert.ok(r.themes.includes('events'));
  const cc2 = compileConfig({ ...cfg, midnight: { ...cfg.midnight, overrides: { include: ['7'], exclude: ['8'] } } });
  assert.equal(classify({ id: '7', text: 'unrelated' }, cc2).midnight, true);
  assert.equal(classify({ id: '8', text: 'Midnight Network rocks' }, cc2).midnight, false);
  const rp = classify({ id: '9', text: 'RT @MidnightNtwrk: big news', kind: 'repost', refs: [{ type: 'repost', author: 'MidnightNtwrk' }] }, cc);
  assert.ok(rp.themes.includes('amplify'));
});

test('series: phrase, date window and kind rules; series posts are always kept', () => {
  const ep = classify({ id: 's1', kind: 'original', created_at: '2026-07-24T08:00:00Z', text: 'Myth vs Reality Series 9/15 privacy is normal' }, cc);
  assert.equal(ep.midnight, true);
  assert.ok(ep.reasons.includes('series: Myth vs Reality'));
  const inWindow = classify({ id: 's2', kind: 'original', created_at: '2026-10-22T08:00:00Z', text: 'Track 2 of the roadmap' }, cc);
  assert.ok(inWindow.reasons.includes('series: Roadmap breakdown'));
  const outWindow = classify({ id: 's3', kind: 'original', created_at: '2026-11-05T08:00:00Z', text: 'our product roadmap' }, cc);
  assert.ok(!outWindow.reasons.some((r) => r.startsWith('series:')));
  const reply = classify({ id: 's4', kind: 'reply', created_at: '2026-10-22T08:00:00Z', text: '@bob the roadmap is out' }, cc);
  assert.ok(!reply.reasons.some((r) => r.startsWith('series:')));
});

test('kind detection works with 2026 names, legacy names and no reference fields', () => {
  assert.equal(detectKind({ id: '1', text: 'RT @MidnightNtwrk: hi' }).kind, 'repost');
  assert.equal(detectKind({ id: '2', text: '@bob thanks', conversationId: '1' }).kind, 'reply');
  assert.equal(detectKind({ id: '3', text: 'part 2 of my thread', conversationId: '1' }).kind, 'thread');
  assert.equal(detectKind({ id: '4', text: 'look', urls: ['https://x.com/midnightfdn/status/9'] }).kind, 'quote');
  assert.equal(detectKind({ id: '5', text: 'look', refs: [{ type: 'quoted', id: '9' }] }).kind, 'quote');
  assert.equal(detectKind({ id: '6', text: 'hello', refs: [] }).kind, 'original');
  assert.equal(detectKind({ id: '7', text: '@jinx_demo more', conversationId: '1', myUsername: 'jinx_demo' }).kind, 'thread');
});

test('normalizeApiPost reads both field generations', () => {
  const p2026 = normalizeApiPost(
    {
      id: '100', text: 'short', created_at: '2026-11-01T10:00:00Z', conversation_id: '100',
      note_post: { text: 'long Midnight Network post' },
      public_metrics: { impression_count: 500, like_count: 10, reply_count: 2, repost_count: 3, quote_count: 1, bookmark_count: 4 },
      non_public_metrics: { url_link_clicks: 5, user_profile_clicks: 6, engagements: 30 },
    },
    me,
  );
  assert.equal(p2026.text, 'long Midnight Network post');
  assert.equal(p2026.metrics.reposts, 3);
  assert.equal(p2026.private.link_clicks, 5);
  assert.equal(p2026.kind, 'original');
  const legacy = normalizeApiPost(
    {
      id: '101', text: '@alice yes', created_at: '2026-11-01T10:00:00Z', conversation_id: '99',
      referenced_tweets: [{ type: 'replied_to', id: '99' }], in_reply_to_user_id: '7',
      public_metrics: { impression_count: 50, like_count: 1, reply_count: 0, retweet_count: 0, quote_count: 0 },
    },
    me,
  );
  assert.equal(legacy.kind, 'reply');
  assert.equal(legacy.refs[0].author, 'alice');
});

test('mergePosts keeps Midnight posts in full, stubs others, removes deleted posts in a complete window', () => {
  const store = {
    posts: {
      posts: [{ id: 'old', created_at: '2026-11-08T00:00:00Z', text: 'Midnight Network', kind: 'original', metrics: {} }],
      other: [],
    },
  };
  const incoming = [
    { id: 'a', created_at: '2026-11-09T00:00:00Z', text: '@MidnightNtwrk gm', kind: 'original', metrics: {} },
    { id: 'b', created_at: '2026-11-09T00:00:00Z', text: 'lunch', kind: 'original', metrics: {} },
  ];
  const r = mergePosts(store, incoming, cc, { coveredFrom: new Date('2026-11-04T00:00:00Z'), complete: true });
  assert.deepEqual(store.posts.posts.map((p) => p.id), ['a']);
  assert.deepEqual(store.posts.other.map((p) => p.id), ['b']);
  assert.equal(r.removed, 1);
  assert.deepEqual(Object.keys(store.posts.other[0]).sort(), ['created_at', 'id', 'kind']);
});

test('run(): falls back to legacy field names, paginates, records history, mentions and cost', async () => {
  const calls = [];
  const json = (status, body) => ({ status, ok: status < 400, headers: new Map(), json: async () => body });
  const fakeFetch = async (url, opts) => {
    calls.push(url);
    assert.match(opts.headers.Authorization, /^OAuth oauth_consumer_key="ck"/);
    const u = new URL(url);
    if (u.pathname === '/2/users/me') {
      return json(200, { data: { id: '42', username: 'jinx_demo', name: 'Jinx', public_metrics: { followers_count: 1234 } } });
    }
    if (u.searchParams.has('post.fields')) return json(400, { title: 'Invalid Request', detail: 'bad param' });
    if (u.pathname === '/2/users/42/tweets') {
      if (!u.searchParams.get('pagination_token')) {
        return json(200, {
          data: [{ id: '1', text: 'Midnight Network workshop in Test City', created_at: '2026-11-10T08:00:00Z', conversation_id: '1', public_metrics: { impression_count: 1000, like_count: 30, reply_count: 5, retweet_count: 4, quote_count: 1 } }],
          meta: { next_token: 'p2' },
        });
      }
      return json(200, { data: [{ id: '2', text: 'coffee', created_at: '2026-11-09T08:00:00Z', conversation_id: '2', public_metrics: {} }], meta: {} });
    }
    if (u.pathname === '/2/users/42/mentions') {
      return json(200, {
        data: [
          { id: 'm1', text: '@jinx_demo great Midnight Network talk', created_at: '2026-11-10T12:00:00Z' },
          { id: 'm2', text: '@jinx_demo hi', created_at: '2026-11-10T13:00:00Z' },
        ],
        meta: {},
      });
    }
    throw new Error('unexpected ' + url);
  };
  const store = { posts: { posts: [], other: [] }, history: { days: {} }, mentions: { days: {} }, meta: { demo: true } };
  const res = await run({
    mode: 'daily',
    dryRun: true,
    env: { X_API_KEY: 'ck', X_API_SECRET: 'cs', X_ACCESS_TOKEN: 't', X_ACCESS_TOKEN_SECRET: 'ts' },
    fetchImpl: fakeFetch,
    now: new Date('2026-11-11T04:00:00Z'),
    log: () => {},
    store,
    config: cfg,
  });
  assert.equal(store.meta.paramSet, 'tweet-fields-legacy');
  assert.equal(store.meta.demo, false);
  assert.deepEqual(store.posts.posts.map((p) => p.id), ['1']);
  assert.equal(store.posts.posts[0].class.local, true);
  assert.equal(store.history.days['2026-11-11'].followers, 1234);
  assert.deepEqual(store.mentions.days['2026-11-10'], { total: 2, midnight: 1 });
  assert.equal(res.usage.postsRead, 2);
  assert.equal(res.usage.mentionsRead, 2);
  assert.ok(Math.abs(res.est - (4 * 0.001 + 0.01)) < 1e-9);
  assert.ok(calls.some((u) => u.includes('start_time=')));
});

test('archive import: skips API-covered posts, queues Midnight ones (no text kept), stubs the rest', () => {
  const tw = (id, at, text, extra = {}) => ({ tweet: { id_str: id, created_at: at, full_text: text, entities: {}, ...extra } });
  const rows = [
    tw('1', 'Mon Jun 01 10:00:00 +0000 2026', 'Midnight Network workshop recap'), // newer than cutoff → skipped
    tw('2', 'Mon Jun 02 10:00:00 +0000 2025', 'Daily Fact #3 - @MidnightNtwrk basics'), // queued
    tw('3', 'Mon Jun 03 10:00:00 +0000 2025', 'lunch was great'), // stub
    tw('4', 'Mon Jun 04 10:00:00 +0000 2025', 'A long post that gets truncated in tweets.js…'), // note text makes it Midnight
  ];
  const notes = noteTextIndex([{ noteTweet: { createdAt: '2025-06-04T10:00:00.000Z', core: { text: 'A long post about the Midnight Network and Compact contracts', mentions: [], urls: [] } } }]);
  const store = { posts: { posts: [], other: [] } };
  const pending = { posts: [] };
  const counts = queueArchive({ rows, notes, store, pending, cc, username: 'jinx_demo', cutoff: '2026-04-12T00:00:00.000Z' });
  assert.equal(counts.skippedRecent, 1);
  assert.deepEqual(pending.posts.map((p) => p.id), ['2', '4']);
  assert.deepEqual(Object.keys(pending.posts[0]).sort(), ['created_at', 'id', 'kind']);
  assert.deepEqual(store.posts.other.map((p) => p.id), ['3']);
  assert.equal(store.posts.posts.length, 0);
  const again = queueArchive({ rows, notes, store, pending, cc, username: 'jinx_demo', cutoff: '2026-04-12T00:00:00.000Z' });
  assert.equal(again.queued + again.stubbed, 0);
});

test('verify-archive: stores posts still on X with live metrics, drops deleted ones', async () => {
  const json = (status, body) => ({ status, ok: status < 400, headers: new Map(), json: async () => body });
  let calls = 0;
  const fakeFetch = async (url) => {
    calls++;
    const u = new URL(url);
    assert.equal(u.pathname, '/2/tweets');
    assert.equal(u.searchParams.get('ids'), '2,4');
    return json(200, {
      data: [{ id: '2', text: 'Daily Fact #3 - @MidnightNtwrk basics', created_at: '2025-06-02T10:00:00Z', conversation_id: '2', public_metrics: { impression_count: 321, like_count: 9, reply_count: 1, retweet_count: 2, quote_count: 0 } }],
      errors: [{ resource_id: '4', title: 'Not Found Error', detail: 'Could not find tweet with ids: [4].' }],
    });
  };
  const store = {
    posts: { posts: [], other: [{ id: '4', created_at: '2025-06-04T10:00:00.000Z', kind: 'original' }] },
    history: { days: {} }, mentions: { days: {} },
    meta: { demo: false, user: { id: '42', username: 'jinx_demo' }, paramSet: 'post-fields-2026' },
    pending: { posts: [{ id: '2', created_at: '2025-06-02T10:00:00.000Z', kind: 'original' }, { id: '4', created_at: '2025-06-04T10:00:00.000Z', kind: 'original' }] },
  };
  const res = await run({
    mode: 'verify-archive', dryRun: true, store, config: cfg, log: () => {}, fetchImpl: fakeFetch,
    env: { X_API_KEY: 'ck', X_API_SECRET: 'cs', X_ACCESS_TOKEN: 't', X_ACCESS_TOKEN_SECRET: 'ts' },
    now: new Date('2026-11-11T08:00:00Z'),
  });
  assert.equal(calls, 1);
  assert.equal(res.found, 1);
  assert.equal(res.dropped, 1);
  assert.deepEqual(store.posts.posts.map((p) => p.id), ['2']);
  assert.equal(store.posts.posts[0].metrics.impressions, 321);
  assert.equal(store.posts.posts[0].via, 'archive');
  assert.equal(store.posts.other.length, 0);
  assert.ok(Math.abs(res.est - 0.005) < 1e-9);
  assert.equal(store.pending.posts.length, 0);
});

test('archive parsing', () => {
  const rows = parseYtd('window.YTD.tweets.part0 = [{"tweet":{"id_str":"5","full_text":"RT @MidnightNtwrk: news","created_at":"Wed Oct 01 10:00:00 +0000 2025","favorite_count":"0","retweet_count":"3","entities":{}}}]');
  const p = normalizeArchiveTweet(rows[0].tweet, 'jinx_demo');
  assert.equal(p.kind, 'repost');
  assert.equal(p.refs[0].author, 'MidnightNtwrk');
  assert.equal(p.metrics.reposts, 3);
  assert.equal(p.created_at, '2025-10-01T10:00:00.000Z');
});

test('public copy: drops targets, link clicks and spend, keeps what the page shows', async () => {
  const posts = { posts: [{ id: '1', text: 'a', metrics: { impressions: 5 }, private: { link_clicks: 2, profile_clicks: 1 } }], other: [{ id: '2', kind: 'reply', private: { engagements: 3 } }] };
  const pp = publicPosts(posts);
  assert.deepEqual(pp.posts[0], { id: '1', text: 'a', metrics: { impressions: 5 } });
  assert.deepEqual(pp.other[0], { id: '2', kind: 'reply' });
  assert.ok(posts.posts[0].private, 'the original is left alone');
  const meta = { demo: false, handle: 'h', user: { id: '9' }, paramSet: 'x', lastRun: { at: '2026-11-11T00:00:00Z', mode: 'daily', estCostUSD: 0.13, postsRead: 76 }, costByMonth: { '2026-11': 4.36 }, archiveImport: {} };
  assert.deepEqual(publicMeta(meta), { demo: false, handle: 'h', user: { id: '9' }, lastRun: { at: '2026-11-11T00:00:00Z', mode: 'daily' } });
  // the whole build from this repository passes its own leak check, and leaves plan.json and the scripts behind
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'mx-public-'));
  try {
    assert.deepEqual(build(out), []);
    for (const gone of ['plan.json', 'data/pending-archive.json', 'scripts', '.github', 'kit']) assert.equal(existsSync(path.join(out, gone)), false, gone);
    for (const kept of ['index.html', 'config.json', 'builders.json', 'data/posts.json', 'assets/app.js']) assert.ok(existsSync(path.join(out, kept)), kept);
    await fs.writeFile(path.join(out, 'plan.json'), '{}');
    assert.deepEqual(leaks(out), ['plan.json is not on the public list']);
  } finally {
    await fs.rm(out, { recursive: true, force: true });
  }
});
