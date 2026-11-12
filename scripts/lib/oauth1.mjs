// OAuth 1.0a (HMAC-SHA1) request signing for the X API — zero dependencies.
// User-context auth is what makes reads of your OWN posts bill at the cheaper
// "Owned Reads" rate, and the access token generated in the X Developer Console
// for the app owner does not expire (unlike OAuth 2.0 user tokens), which suits
// an unattended GitHub Actions job.
import crypto from 'node:crypto';

/** RFC 3986 percent-encoding (encodeURIComponent leaves !'()* alone). */
export function rfc3986(value) {
  return encodeURIComponent(String(value)).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/** Drop undefined/null/empty values so the signed set equals the sent set. */
export function cleanParams(params = {}) {
  const out = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    out[k] = String(v);
  }
  return out;
}

export function buildQuery(params = {}) {
  return Object.entries(cleanParams(params))
    .map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`)
    .join('&');
}

function byPair(a, b) {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
  return 0;
}

/**
 * Build the Authorization header for one request.
 * `params` are the query (or form-body) parameters that will be sent.
 * `nonce` / `timestamp` are only passed in tests.
 */
export function oauthHeader({
  method,
  url,
  params = {},
  consumerKey,
  consumerSecret,
  token,
  tokenSecret,
  nonce,
  timestamp,
}) {
  const oauth = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: nonce ?? crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(timestamp ?? Math.floor(Date.now() / 1000)),
    oauth_token: token,
    oauth_version: '1.0',
  };
  const all = { ...cleanParams(params), ...oauth };
  const paramString = Object.entries(all)
    .map(([k, v]) => [rfc3986(k), rfc3986(v)])
    .sort(byPair)
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const base = [method.toUpperCase(), rfc3986(url), rfc3986(paramString)].join('&');
  const key = `${rfc3986(consumerSecret)}&${rfc3986(tokenSecret ?? '')}`;
  const signature = crypto.createHmac('sha1', key).update(base).digest('base64');
  const header =
    'OAuth ' +
    Object.entries({ ...oauth, oauth_signature: signature })
      .sort(byPair)
      .map(([k, v]) => `${rfc3986(k)}="${rfc3986(v)}"`)
      .join(', ');
  return { header, signature, base };
}
