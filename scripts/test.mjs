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
import { publicPosts, publicMeta, publicEvents, publicContent, build, leaks, checkToken } from './publish.mjs';
import { normalise, parseRss, feedItems, mergeFeed, devtoItems, githubItems } from './fetch-sources.mjs';
import { planUpdate, applyUpdate, setupEnv, isCode } from './update.mjs';

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
    if (existsSync(path.join(out, 'events.json'))) assert.ok(!('_example' in JSON.parse(await fs.readFile(path.join(out, 'events.json'), 'utf8'))), 'events.json example left behind');
    await fs.writeFile(path.join(out, 'plan.json'), '{}');
    assert.deepEqual(leaks(out), ['plan.json is not on the public list']);
    // an event's cost, score, partners and notes never reach the public copy
    await fs.rm(path.join(out, 'plan.json'));
    await fs.writeFile(path.join(out, 'events.json'), JSON.stringify({ events: [{ name: 'x', date: '2026-01-01', private: { cost: 1 } }] }));
    assert.deepEqual(leaks(out), ['events.json still has private blocks']);
  } finally {
    await fs.rm(out, { recursive: true, force: true });
  }
});

test('public copy: events keep what the page shows, minus the owner-only block and the example', () => {
  const file = { _readme: 'r', _example: { name: 'e', private: { cost: 1 } }, events: [{ name: 'Meetup', date: '2026-11-20', attended: 28, private: { cost: 150, currency: 'USD', partners: 'p', notes: 'n', rating: 4.5 } }, { name: 'Space', date: '2026-11-01', format: 'Online' }] };
  const pub = publicEvents(file);
  assert.deepEqual(pub, { _readme: 'r', events: [{ name: 'Meetup', date: '2026-11-20', attended: 28 }, { name: 'Space', date: '2026-11-01', format: 'Online' }] });
  assert.ok(file.events[0].private && file._example, 'the original is left alone');
});

test('publishing key check: asks git\'s push question and says what to fix', async () => {
  const calls = [];
  const answer = (status) => async (url, opts) => { calls.push([url, opts.headers.Authorization]); return { ok: status === 200, status }; };
  assert.equal(await checkToken('me/site', 'tok', answer(200)), null);
  assert.equal(calls[0][0], 'https://github.com/me/site.git/info/refs?service=git-receive-pack');
  assert.equal(calls[0][1], 'Basic ' + Buffer.from('x-access-token:tok').toString('base64'));
  assert.match(await checkToken('me/site', 'tok', answer(401)), /expired.*Only select repositories → site/);
  assert.match(await checkToken('me/site', 'tok', answer(403)), /can't update me\/site.*Contents: Read and write/);
  assert.match(await checkToken('me/site', 'tok', answer(404)), /can't find me\/site/);
  assert.match(await checkToken('me/site', 'tok', async () => { throw new Error('offline'); }), /Couldn't reach GitHub/);
});

test('articles and code: account names from names, @names and profile links', () => {
  assert.equal(normalise.github('https://github.com/Some-User/repo'), 'Some-User');
  assert.equal(normalise.github('@someone'), 'someone');
  assert.equal(normalise.github('two words'), null);
  assert.equal(normalise.devto('https://dev.to/ben/'), 'ben');
  assert.equal(normalise.medium('https://medium.com/@midnightnetwork/some-post-123'), 'midnightnetwork');
  assert.equal(normalise.medium('writer.medium.com'), 'writer');
  assert.equal(normalise.medium('@writer'), 'writer');
  assert.equal(normalise.substack('mynews'), 'https://mynews.substack.com');
  assert.equal(normalise.substack('https://news.example.com/archive/'), 'https://news.example.com');
  assert.equal(normalise.substack('not a site'), null);
});

test('articles and code: feed posts are kept only when they are about Midnight', () => {
  const item = (title, guid, day, extra) => `<item><title>${title}</title><link>https://medium.com/@w/${guid}?source=rss-abc</link><guid isPermaLink="false">https://medium.com/p/${guid}</guid><pubDate>${day} Nov 2026 10:00:00 GMT</pubDate>${extra}</item>`;
  const xml = '<rss><channel><title>x</title>'
    + item('<![CDATA[Building on the Midnight Network &amp; Compact]]>', 'aaa111', 'Mon, 02', '<category><![CDATA[blockchain]]></category><content:encoded><![CDATA[<p>Hello</p>]]></content:encoded>')
    + item('My week in CSS', 'bbb222', 'Tue, 03', '<content:encoded><![CDATA[<p>I shipped the fix at midnight.</p>]]></content:encoded>')
    + item('Notes from the week', 'ccc333', 'Wed, 04', '<content:encoded><![CDATA[<p>I wrote my first Compact contract and ran the proof server.</p>]]></content:encoded>')
    + item('Weekend reading', 'ddd444', 'Thu, 05', '<category>midnight</category>')
    + '</channel></rss>';
  const posts = parseRss(xml);
  assert.equal(posts.length, 4);
  assert.equal(posts[0].title, 'Building on the Midnight Network & Compact');
  assert.deepEqual(posts[0].categories, ['blockchain']);
  const items = feedItems('medium', 'w', posts, cc);
  assert.deepEqual(items.map((i) => i.id), ['medium:aaa111', 'medium:ccc333', 'medium:ddd444'], 'the CSS post only said "at midnight" in its text');
  assert.equal(items[0].url, 'https://medium.com/@w/aaa111', 'the feed tracking is cut off the link');
  assert.ok(items.every((i) => !i.review), 'a clear term or a midnight tag needs no review');
  const cx = compileConfig({ ...cfg, midnight: { ...cfg.midnight, overrides: { include: [], exclude: ['medium:aaa111'] } } });
  assert.ok(!feedItems('medium', 'w', posts, cx).some((i) => i.id === 'medium:aaa111'), 'overrides.exclude leaves an item out');
});

test('articles and code: a deleted feed post drops out, an older one stays', () => {
  const prev = [{ id: 'm:old', date: '2025-01-01T00:00:00Z' }, { id: 'm:gone', date: '2026-10-05T00:00:00Z' }, { id: 'm:kept', date: '2026-10-09T00:00:00Z' }];
  const fresh = [{ id: 'm:kept', date: '2026-10-09T00:00:00Z' }, { id: 'm:new', date: '2026-11-01T00:00:00Z' }];
  assert.deepEqual(mergeFeed(prev, fresh, Date.parse('2026-10-01T00:00:00Z')).map((i) => i.id), ['m:kept', 'm:new', 'm:old']);
  assert.equal(mergeFeed(prev, [], null), prev, 'an empty feed changes nothing');
});

test('articles and code: dev.to views stay owner-only, GitHub lists public work only', () => {
  const list = [
    { id: 1, title: 'Shielded tokens on Midnight', url: 'https://dev.to/w/a', published_timestamp: '2026-11-01T00:00:00Z', tag_list: ['midnightnetwork', 'zk'], description: '', public_reactions_count: 12, comments_count: 3 },
    { id: 2, title: 'CSS tricks', url: 'https://dev.to/w/b', published_timestamp: '2026-11-02T00:00:00Z', tag_list: ['css'], description: 'Grids', public_reactions_count: 99, comments_count: 9 },
  ];
  const dv = devtoItems('w', list, new Map([[1, 340]]), cc);
  assert.equal(dv.length, 1);
  assert.deepEqual(dv[0].metrics, { reactions: 12, comments: 3 });
  assert.deepEqual(dv[0].private, { views: 340 });
  const issues = [
    { number: 7, title: 'Add an entry', html_url: 'https://github.com/midnightntwrk/x/pull/7', repository_url: 'https://api.github.com/repos/midnightntwrk/x', created_at: '2026-10-01T00:00:00Z', state: 'closed', comments: 2, pull_request: { merged_at: '2026-10-02T00:00:00Z' } },
    { number: 9, title: 'Bug', html_url: 'https://github.com/midnightntwrk/x/issues/9', repository_url: 'https://api.github.com/repos/midnightntwrk/x', created_at: '2026-10-03T00:00:00Z', state: 'open', comments: 0 },
  ];
  const repos = [
    { full_name: 'w/public-dapp', name: 'public-dapp', html_url: 'https://github.com/w/public-dapp', created_at: '2026-09-01T00:00:00Z', private: false, stargazers_count: 4, forks_count: 1, topics: ['midnight'] },
    { full_name: 'w/secret', name: 'secret', html_url: 'https://github.com/w/secret', created_at: '2026-09-02T00:00:00Z', private: true },
    { full_name: 'w/fork', name: 'fork', html_url: 'https://github.com/w/fork', created_at: '2026-09-03T00:00:00Z', private: false, fork: true },
  ];
  const g = githubItems('w', issues, repos);
  assert.deepEqual(g.map((i) => `${i.kind}:${i.state || ''}`), ['pr:merged', 'issue:open', 'repo:']);
  assert.ok(!g.some((i) => /secret|fork/.test(i.id)), 'private repositories and forks are never listed');
});

test('update from the kit: new code in, the owner\'s settings, numbers and pictures untouched', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mx-update-'));
  const put = async (dir, rel, text) => { await fs.mkdir(path.dirname(path.join(tmp, dir, rel)), { recursive: true }); await fs.writeFile(path.join(tmp, dir, rel), text); };
  const get = (dir, rel) => fs.readFile(path.join(tmp, dir, rel), 'utf8');
  const has = (dir, rel) => existsSync(path.join(tmp, dir, rel));
  try {
    // an owner's copy made from an older kit
    await put('copy', 'config.json', JSON.stringify({ repo: 'me/dash-private', publicRepo: 'me/dash', profile: { role: 'Leader', area: 'Lagos' }, timezone: 'Africa/Lagos', local: { label: 'Lagos', terms: ['lagos', '#lagos', 'ikeja'] }, midnight: { strong: ['mine'] } }));
    await put('copy', 'plan.json', '{"quarters":{"2026-Q4":{"targets":{"midnightPosts":40}}}}');
    await put('copy', 'builders.json', '{"builders":[{"name":"Ada"}]}');
    await put('copy', 'data/posts.json', '{"posts":["real"]}');
    await put('copy', 'assets/builders/ada.jpg', 'picture');
    await put('copy', 'assets/app.js', 'old app');
    await put('copy', 'scripts/old-helper.mjs', 'dropped later');
    await put('copy', 'scripts/mine.mjs', 'the owner\'s own script, never in a kit');
    await put('copy', '.github/workflows/refresh.yml', 'old refresh');
    await put('copy', 'share.jpg', 'my own preview');
    await put('copy', 'kit.json', JSON.stringify({ repo: 'kit/repo', version: 'aaa1111', files: ['assets/app.js', 'scripts/old-helper.mjs', '.github/workflows/refresh.yml'] }));
    // the latest kit
    await put('kit', 'config.json', JSON.stringify({ repo: '', profile: { role: '' }, midnight: { strong: ['kit'] }, newSetting: { on: true } }));
    await put('kit', 'plan.json', '{}');
    await put('kit', 'builders.json', '{"builders":[]}');
    await put('kit', 'events.json', '{"events":[]}');
    await put('kit', 'sources.json', '{"github":""}');
    await put('kit', 'data/posts.json', '{"posts":["demo"]}');
    await put('kit', 'data/content.json', '{"items":[]}');
    await put('kit', 'assets/app.js', 'new app');
    await put('kit', 'scripts/update.mjs', 'updater');
    await put('kit', '.github/workflows/refresh.yml', 'new refresh');
    await put('kit', '.github/workflows/sources.yml', 'new workflow');
    await put('kit', 'share.jpg', 'kit preview');
    await put('kit', 'kit.json', JSON.stringify({ repo: 'kit/repo', version: null, files: [] }));

    const plan = planUpdate(path.join(tmp, 'copy'), path.join(tmp, 'kit'));
    assert.deepEqual(plan.replace.sort(), ['.github/workflows/refresh.yml', 'assets/app.js']);
    assert.deepEqual(plan.add.sort(), ['.github/workflows/sources.yml', 'data/content.json', 'events.json', 'scripts/update.mjs', 'sources.json']);
    assert.deepEqual(plan.remove, ['scripts/old-helper.mjs'], 'only code an earlier kit installed is removed');
    assert.deepEqual(plan.config, ['newSetting']);
    assert.equal(plan.oldVersion, 'aaa1111');

    applyUpdate(path.join(tmp, 'copy'), path.join(tmp, 'kit'), plan, 'bbb2222');
    assert.equal(await get('copy', 'assets/app.js'), 'new app');
    assert.equal(await get('copy', '.github/workflows/sources.yml'), 'new workflow');
    assert.ok(!has('copy', 'scripts/old-helper.mjs'));
    assert.equal(await get('copy', 'scripts/mine.mjs'), 'the owner\'s own script, never in a kit');
    assert.equal(await get('copy', 'plan.json'), '{"quarters":{"2026-Q4":{"targets":{"midnightPosts":40}}}}');
    assert.equal(await get('copy', 'builders.json'), '{"builders":[{"name":"Ada"}]}');
    assert.equal(await get('copy', 'data/posts.json'), '{"posts":["real"]}', 'never the demo data');
    assert.equal(await get('copy', 'assets/builders/ada.jpg'), 'picture');
    assert.equal(await get('copy', 'share.jpg'), 'my own preview');
    const cfgAfter = JSON.parse(await get('copy', 'config.json'));
    assert.deepEqual(cfgAfter.midnight, { strong: ['mine'] }, 'the owner\'s settings stay');
    assert.equal(cfgAfter.repo, 'me/dash-private');
    assert.deepEqual(cfgAfter.newSetting, { on: true }, 'a new setting is added');
    const kit = JSON.parse(await get('copy', 'kit.json'));
    assert.equal(kit.version, 'bbb2222');
    assert.ok(kit.files.includes('.github/workflows/sources.yml') && !kit.files.includes('scripts/old-helper.mjs'));
    assert.deepEqual(planUpdate(path.join(tmp, 'copy'), path.join(tmp, 'kit')).replace, [], 'a second run finds nothing to do');

    assert.deepEqual(setupEnv(cfgAfter), { ROLE: 'Leader', FOCUS_AREA: 'Lagos', FOCUS_TERMS: 'lagos, #lagos, ikeja', TIMEZONE: 'Africa/Lagos', PUBLIC_REPO: 'me/dash' });
    assert.ok(isCode('assets/app.js') && !isCode('assets/builders/ada.jpg') && !isCode('config.json') && !isCode('share.jpg'));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('public copy: articles keep their public numbers, not page views or account notes', async () => {
  const file = { updated: 'x', accounts: { devto: { user: 'w', profile: 'https://dev.to/w', checked: 'x', note: 'key note' }, medium: { user: 'm', error: 'Medium did not answer' } }, items: [{ id: 'devto:1', metrics: { reactions: 2 }, private: { views: 9 } }] };
  const pub = publicContent(file);
  assert.deepEqual(pub.accounts, { devto: { user: 'w', profile: 'https://dev.to/w', checked: 'x' }, medium: { user: 'm' } });
  assert.deepEqual(pub.items, [{ id: 'devto:1', metrics: { reactions: 2 } }]);
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'mx-content-'));
  try {
    await fs.mkdir(path.join(out, 'data'));
    await fs.writeFile(path.join(out, 'data/content.json'), JSON.stringify(file));
    assert.deepEqual(leaks(out), ['data/content.json still has owner-only parts']);
    await fs.writeFile(path.join(out, 'data/content.json'), JSON.stringify(pub));
    assert.deepEqual(leaks(out), []);
  } finally {
    await fs.rm(out, { recursive: true, force: true });
  }
});
