// Decides whether a post is Midnight-related, which themes it covers and whether
// it is SA-specific. Rule-based on purpose: deterministic, free, explainable
// (every decision carries its reasons), and tunable by editing config.json.

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whole-term match that also works for $cashtags, #hashtags, emoji and dotted domains. */
function termRegex(term) {
  return new RegExp(`(?<![\\p{L}\\p{N}_$#@])${escapeRe(term.toLowerCase())}(?![\\p{L}\\p{N}_])`, 'iu');
}

const compileTerms = (terms = []) => terms.map((term) => ({ term, re: termRegex(term) }));

export function compileConfig(cfg) {
  const m = cfg.midnight ?? {};
  return {
    accounts: (m.accounts ?? []).map((a) => a.replace(/^@/, '').toLowerCase()),
    domains: (m.domains ?? []).map((d) => d.toLowerCase()),
    strong: compileTerms(m.strong),
    medium: compileTerms(m.medium),
    timePhrases: (m.timePhrases ?? []).map(
      (p) => new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(p)}(?![\\p{L}\\p{N}_])`, 'giu'),
    ),
    include: new Set((m.overrides?.include ?? []).map(String)),
    exclude: new Set((m.overrides?.exclude ?? []).map(String)),
    local: compileTerms(cfg.local?.terms),
    series: (cfg.series ?? []).map((s) => ({
      id: s.id,
      label: s.label ?? s.id,
      phrases: (s.phrases ?? []).map((p) => String(p).toLowerCase()),
      from: s.from ?? null,
      to: s.to ?? null,
      kinds: s.kinds ?? ['original', 'quote', 'thread'],
    })),
    themes: (cfg.themes ?? []).map((t) => ({ id: t.id, terms: compileTerms(t.terms) })),
  };
}

/** Handles mentioned in, or referenced by, the post (lower-case, no @). */
export function handlesOf(post) {
  const out = new Set();
  for (const h of post.mentions ?? []) out.add(String(h).toLowerCase());
  for (const r of post.refs ?? []) if (r.author) out.add(String(r.author).toLowerCase());
  for (const m of String(post.text ?? '').matchAll(/@([A-Za-z0-9_]{1,15})/g)) out.add(m[1].toLowerCase());
  return out;
}

/**
 * Series a post belongs to (config.json "series"): phrase match, optional date window
 * (YYYY-MM-DD, inclusive) and post kinds. Mirrors seriesOf() in assets/app.js.
 */
export function seriesOf(post, list = []) {
  const day = String(post.created_at ?? '').slice(0, 10);
  const txt = String(post.text ?? '').toLowerCase().replace(/[‘’]/g, "'");
  for (const s of list) {
    if (s.from && day && day < s.from) continue;
    if (s.to && day && day > s.to) continue;
    if (post.kind && !s.kinds.includes(post.kind)) continue;
    if (s.phrases.some((ph) => txt.includes(ph))) return s;
  }
  return null;
}

export function classify(post, cc) {
  const text = String(post.text ?? '');
  const lower = text.toLowerCase();
  const urls = (post.urls ?? []).map((u) => String(u).toLowerCase());
  const reasons = [];
  let score = 0;
  let strongHits = 0;

  const handles = handlesOf(post);
  for (const acc of cc.accounts) {
    if (handles.has(acc)) {
      score += 3;
      strongHits++;
      reasons.push('@' + acc);
    }
  }
  for (const d of cc.domains) {
    if (urls.some((u) => u.includes(d)) || lower.includes(d)) {
      score += 3;
      strongHits++;
      reasons.push(d);
    }
  }
  for (const { term, re } of cc.strong) {
    if (re.test(text)) {
      score += 3;
      strongHits++;
      reasons.push(term);
    }
  }

  // Your own series always count, so an episode is kept in full even if it never says "Midnight".
  const series = seriesOf(post, cc.series ?? []);
  if (series) {
    score += 3;
    strongHits++;
    reasons.push('series: ' + series.label);
  }

  // A bare "midnight" counts unless every occurrence is a time-of-day phrase.
  let stripped = lower;
  for (const re of cc.timePhrases) stripped = stripped.replace(re, ' ');
  const bareMidnight = /(?<![\p{L}\p{N}_])midnight(?![\p{L}\p{N}_])/iu.test(stripped);
  if (bareMidnight && strongHits === 0) {
    score += 2;
    reasons.push('"midnight"');
  }

  let mediumScore = 0;
  for (const { term, re } of cc.medium) {
    if (mediumScore < 2 && re.test(text)) {
      mediumScore++;
      reasons.push(term);
    }
  }
  score += mediumScore;

  let midnight = score >= 2;
  const id = String(post.id ?? '');
  if (cc.include.has(id)) {
    midnight = true;
    reasons.unshift('manual include');
  }
  if (cc.exclude.has(id)) {
    midnight = false;
    reasons.unshift('manual exclude');
  }

  const confidence = strongHits > 0 || cc.include.has(id) ? 'high' : score >= 3 ? 'medium' : 'low';
  const review = midnight && confidence !== 'high';

  const themes = [];
  for (const t of cc.themes) {
    if (t.terms.some(({ re }) => re.test(text))) themes.push(t.id);
  }
  const amplifies =
    (post.kind === 'repost' || post.kind === 'quote') &&
    (post.refs ?? []).some((r) => r.author && cc.accounts.includes(String(r.author).toLowerCase()));
  if (amplifies && !themes.includes('amplify')) themes.push('amplify');
  if (themes.length === 0) themes.push('general');

  const local = cc.local.some(({ re }) => re.test(text));

  return { midnight, score, confidence, review, reasons, themes, local };
}
