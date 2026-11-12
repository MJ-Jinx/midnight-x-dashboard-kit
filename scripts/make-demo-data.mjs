#!/usr/bin/env node
// Writes SYNTHETIC sample data so the dashboard can be previewed before X API keys
// are connected. meta.demo = true makes the page show a "demo data" banner, and the
// first real fetch/import discards all of it.
import path from 'node:path';
import { compileConfig, classify } from './lib/classify.mjs';
import { ROOT, readJson, saveStore, localDate } from './lib/posts.mjs';

function rng(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(20261111);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const between = (a, b) => a + Math.floor(rand() * (b - a + 1));

const ORIGINAL = [
  'Sample post: a short Compact tip on keeping witness data private before it hits the ledger #Midnight',
  'Sample post: why rational privacy matters for everyday payments, a quick explainer 🧵',
  'Sample post: recap of our builder session, deploying a first Compact contract on preprod',
  'Sample post: join us for an X Space on zero-knowledge proofs and the Midnight Network',
  'Sample post: shipped a small Midnight demo DApp today, repo link in the replies',
  'Sample post: meetup recap with local builders exploring selective disclosure on Midnight',
  'Sample post: what DUST is and how the NIGHT token generates it, in plain words',
  'Sample post: Nightforce community call notes and next steps for new builders',
  'Sample post: university workshop on privacy-preserving apps with Compact',
  'Sample post: partner chain basics, how Midnight relates to Cardano',
];
const REPLY = [
  '@builder_one great question, Compact keeps that value in the witness so it never goes on chain',
  '@devfriend yes, the Midnight docs have a preprod faucet guide, happy to walk you through it',
  '@community_q the next Midnight meetup date is going up on Luma this week',
  '@zk_curious short answer: zero-knowledge proofs let you prove the rule without the data',
];
const QUOTE = [
  'Sample quote: big step for privacy on @MidnightNtwrk, worth reading https://x.com/MidnightNtwrk/status/1',
  'Sample quote: this is why we build on Midnight https://x.com/midnightfdn/status/2',
];
const REPOST = ['RT @MidnightNtwrk: Sample repost of a Midnight Network announcement', 'RT @midnightfdn: Sample repost of a Midnight Foundation update'];

const cfg = await readJson(path.join(ROOT, 'config.json'));
const cc = compileConfig(cfg);
const tz = cfg.timezone || 'UTC';
// phrases that tag some sample posts with the focus area (config.json local.terms), if one is set
const LOCAL = (cfg.local?.terms || []).filter((t) => /\p{L}/u.test(t)).slice(0, 5).map((t) => `about ${t.replace(/^#/, '')}`);
// about five months of sample activity, ending today
const end = new Date(); end.setUTCHours(6, 0, 0, 0);
const start = new Date(end.getTime() - 163 * 86_400_000);
const snapshotsFrom = new Date(end.getTime() - 133 * 86_400_000);

const posts = [];
const other = [];
const historyDays = {};
const mentionDays = {};
let followers = 2380;
let id = 1990000000000000000n;

for (let d = new Date(start); d <= end; d = new Date(d.getTime() + 86_400_000)) {
  const day = localDate(d, tz);
  const ramp = (d - start) / (end - start); // activity grows over time
  const nMid = rand() < 0.35 + ramp * 0.35 ? between(1, 2 + Math.round(ramp)) : 0;
  for (let i = 0; i < nMid; i++) {
    const roll = rand();
    const kind = roll < 0.45 ? 'original' : roll < 0.72 ? 'reply' : roll < 0.8 ? 'thread' : roll < 0.9 ? 'quote' : 'repost';
    let text;
    let refs = [];
    if (kind === 'original' || kind === 'thread') text = pick(ORIGINAL) + (LOCAL.length && rand() < 0.42 ? ' ' + pick(LOCAL) : '');
    if (kind === 'reply') {
      text = pick(REPLY) + (LOCAL.length && rand() < 0.3 ? ' ' + pick(LOCAL) : '');
      refs = [{ type: 'reply', author: text.slice(1, text.indexOf(' ')) }];
    }
    if (kind === 'quote') {
      text = pick(QUOTE);
      refs = [{ type: 'quote', author: text.includes('midnightfdn') ? 'midnightfdn' : 'MidnightNtwrk' }];
    }
    if (kind === 'repost') {
      text = pick(REPOST);
      refs = [{ type: 'repost', author: text.slice(4, text.indexOf(':')) }];
    }
    const created = new Date(Math.min(d.getTime() + between(0, 14 * 3600) * 1000, end.getTime() - between(60, 3 * 3600) * 1000));
    const base = kind === 'reply' ? 120 : kind === 'repost' ? 0 : 900;
    const impressions = kind === 'repost' ? null : Math.round(base * (0.4 + rand() * 1.8) * (1 + ramp));
    const er = 0.015 + rand() * 0.04;
    const eng = impressions ? Math.round(impressions * er) : 0;
    const post = {
      id: String((id += 7919n)),
      created_at: created.toISOString(),
      text,
      kind,
      refs,
      url: 'https://x.com/',
      lang: 'en',
      mentions: [],
      hashtags: [],
      cashtags: [],
      urls: [],
      metrics: {
        impressions,
        likes: Math.round(eng * 0.7),
        replies: Math.round(eng * 0.12),
        reposts: Math.round(eng * 0.13),
        quotes: Math.round(eng * 0.05),
        bookmarks: Math.round(eng * 0.08),
      },
      source: 'demo',
    };
    const c = classify(post, cc);
    if (c.midnight) posts.push({ ...post, first_seen: created.toISOString(), class: c });
    else other.push({ id: post.id, created_at: post.created_at, kind });
  }
  const nOther = between(0, 3);
  for (let i = 0; i < nOther; i++) {
    other.push({ id: String((id += 7919n)), created_at: new Date(Math.min(d.getTime() + between(0, 15 * 3600) * 1000, end.getTime() - 60_000)).toISOString(), kind: pick(['original', 'reply', 'reply', 'repost']) });
  }
  followers += Math.round(rand() * 3 * (0.4 + ramp)) - (rand() < 0.2 ? 1 : 0);
  if (d >= snapshotsFrom) historyDays[day] = { followers, following: 610, posts: 5400, listed: 41 };
  const total = between(1, 6 + Math.round(ramp * 8));
  mentionDays[day] = { total, midnight: Math.min(total, between(0, 3 + Math.round(ramp * 5))) };
}

const store = {
  posts: { posts, other },
  history: { days: historyDays },
  mentions: { days: mentionDays },
  meta: {
    demo: true,
    handle: 'your_handle',
    user: { username: 'your_handle', name: 'Demo account' },
    lastRun: { at: end.toISOString(), mode: 'demo', postsRead: 0, mentionsRead: 0, usersRead: 0, estCostUSD: 0 },
    costByMonth: {},
  },
};
await saveStore(store);
const reviewCount = posts.filter((p) => p.class.review).length;
console.log(`Demo data written: ${posts.length} Midnight posts (${reviewCount} flagged for review), ${other.length} other posts, ${Object.keys(historyDays).length} follower snapshots.`);
