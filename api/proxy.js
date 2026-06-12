// api/proxy.js
const https = require('https');
const http = require('http');
const { URL } = require('url');

// ─── Helpers ────────────────────────────────────────────────────────────────

const REDIRECT_CODES = [301, 302, 303, 307, 308];

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': '*/*',
  'Connection': 'keep-alive',
};

/** Resolve a possibly-relative URL against a base. */
function resolveUrl(url, baseUrl) {
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  if (url.startsWith('/')) {
    const base = new URL(baseUrl);
    return `${base.origin}${url}`;
  }
  return `${baseUrl}/${url}`;
}

/** Strip the filename from a URL, returning the directory base. */
function getBaseUrl(url) {
  const parsed = new URL(url);
  const parts = parsed.pathname.split('/');
  parts.pop();
  return `${parsed.origin}${parts.join('/')}`;
}

/** Determine the proxy scheme from the host header. */
function proxyScheme(host) {
  return host.includes('localhost') ? 'http' : 'https';
}

/**
 * Detect whether a URL / content-type / body looks like an M3U / M3U8.
 * Returns true for any playlist; false for raw TS.
 */
function isPlaylist(url, contentType, bodyStart) {
  const u = url.toLowerCase();
  if (u.includes('.m3u8') || u.includes('.m3u')) return true;
  if (contentType && (contentType.includes('mpegurl') || contentType.includes('m3u'))) return true;
  if (bodyStart && bodyStart.trim().startsWith('#EXTM3U')) return true;
  return false;
}

/**
 * Detect whether a URL / content-type looks like a raw TS stream.
 */
function isTsStream(url, contentType) {
  const u = url.toLowerCase();
  if (u.includes('.ts')) return true;
  if (contentType && (contentType.includes('mp2t') || contentType.includes('mpeg2') || contentType.includes('video/ts'))) return true;
  return false;
}

// ─── HTTP fetch utilities ────────────────────────────────────────────────────

/**
 * Follow redirects and return { response, finalUrl }.
 * The response stream is NOT consumed — caller pipes or reads it.
 */
function openStream(url, maxRedirects = 10) {
  return new Promise((resolve, reject) => {
    let hops = 0;

    const attempt = (currentUrl) => {
      const parsed = new URL(currentUrl);
      const protocol = parsed.protocol === 'https:' ? https : http;

      const req = protocol.get(currentUrl, { headers: DEFAULT_HEADERS }, (res) => {
        if (REDIRECT_CODES.includes(res.statusCode)) {
          hops++;
          if (hops > maxRedirects) {
            reject(new Error('Too many redirects'));
            return;
          }
          // Consume and discard the redirect body so the socket can be reused
          res.resume();
          const location = new URL(res.headers.location, currentUrl).href;
          attempt(location);
          return;
        }

        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} from ${currentUrl}`));
          return;
        }

        resolve({ response: res, finalUrl: currentUrl });
      });

      req.on('error', reject);
    };

    attempt(url);
  });
}

/**
 * Fetch a text body fully (for playlist rewriting).
 * Returns { data: string, type: string, finalUrl: string }
 */
function fetchText(url) {
  return openStream(url).then(({ response, finalUrl }) => {
    return new Promise((resolve, reject) => {
      const chunks = [];
      response.on('data', (c) => chunks.push(c));
      response.on('end', () => resolve({
        data: Buffer.concat(chunks).toString('utf-8'),
        type: response.headers['content-type'] || '',
        finalUrl,
      }));
      response.on('error', reject);
    });
  });
}

// ─── Playlist rewriting ──────────────────────────────────────────────────────

function rewritePlaylist(content, baseUrl, host) {
  const scheme = proxyScheme(host);
  return content.split('\n').map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;

    // Tags with URI= attributes (e.g. #EXT-X-KEY)
    if (trimmed.startsWith('#') && trimmed.includes('URI=')) {
      return line.replace(/URI="([^"]+)"/g, (_, uri) => {
        const full = resolveUrl(uri, baseUrl);
        return `URI="${scheme}://${host}/api/proxy?url=${encodeURIComponent(full)}"`;
      });
    }

    // Pure comment / directive lines without URI
    if (trimmed.startsWith('#')) return line;

    // Segment / child-playlist URL
    const full = resolveUrl(trimmed, baseUrl);
    return `${scheme}://${host}/api/proxy?url=${encodeURIComponent(full)}`;
  }).join('\n');
}

// ─── Synthetic M3U8 wrapper for a TS stream ──────────────────────────────────

/**
 * Build a minimal live-stream M3U8 that wraps a single continuous TS URL.
 * Players that support it will reload the "playlist" and keep playing.
 */
function buildTsWrapperM3u8(tsProxyUrl) {
  // TARGET-DURATION of 0 tells players this is a live/event stream.
  // EXT-X-ALLOW-CACHE NO + no EXT-X-ENDLIST = indefinite live stream.
  return [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:0',
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-ALLOW-CACHE:NO',
    '#EXTINF:-1,',
    tsProxyUrl,
    '',   // trailing newline
  ].join('\n');
}

// ─── Main handler ────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Expose-Headers', '*');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const targetUrl = req.query.url;
  const wantM3u   = req.query.m3u === 'true';

  if (!targetUrl) {
    res.status(400).json({ error: 'Missing url parameter' });
    return;
  }

  try {
    // ── Step 1: peek at the URL (and follow redirects) to sniff content ──
    const { response: peekRes, finalUrl } = await openStream(targetUrl);
    const contentType = peekRes.headers['content-type'] || '';

    // Consume the peek stream so the socket isn't left hanging
    peekRes.resume();

    // ── Step 2: decide what we're dealing with ───────────────────────────

    // Peek at the URL string first (cheap); for playlists we'll re-fetch.
    const looksLikePlaylist = isPlaylist(targetUrl, contentType, null);
    const looksLikeTs       = !looksLikePlaylist && isTsStream(finalUrl, contentType);

    // ── Case A: It's a playlist (M3U / M3U8) ────────────────────────────
    if (looksLikePlaylist) {
      // Fetch full text so we can rewrite URLs
      const { data, type, finalUrl: resolvedUrl } = await fetchText(finalUrl);

      // Double-check body in case content-type was misleading
      if (!isPlaylist(resolvedUrl, type, data)) {
        // Actually looks like TS binary — fall through to TS handling below
        // (rare edge-case: server lies about content-type)
        await streamTs(finalUrl, wantM3u, req, res);
        return;
      }

      const baseUrl = getBaseUrl(resolvedUrl);
      const modified = rewritePlaylist(data, baseUrl, req.headers.host);

      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.status(200).send(modified);
      return;
    }

    // ── Case B: It's a TS stream (or unknown — treat as binary) ─────────
    await streamTs(finalUrl, wantM3u, req, res);

  } catch (error) {
    console.error('Proxy error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to fetch content', message: error.message });
    }
  }
};

// ─── TS streaming logic ──────────────────────────────────────────────────────

/**
 * Either serve a synthetic M3U8 wrapper (when wantM3u=true) or stream
 * the raw TS bytes straight through to the client.
 */
async function streamTs(finalUrl, wantM3u, req, res) {
  const host = req.headers.host;
  const scheme = proxyScheme(host);

  // When ?m3u=true, return a synthetic playlist instead of the raw stream.
  if (wantM3u) {
    const tsProxyUrl = `${scheme}://${host}/api/proxy?url=${encodeURIComponent(finalUrl)}`;
    const playlist   = buildTsWrapperM3u8(tsProxyUrl);

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.status(200).send(playlist);
    return;
  }

  // Otherwise, open a fresh stream and pipe it straight through.
  // This supports continuous/live TS streams because we never buffer the
  // whole body — we just pipe chunks as they arrive.
  const { response: tsRes } = await openStream(finalUrl);

  res.setHeader('Content-Type', 'video/mp2t');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Accept-Ranges', 'bytes');

  // Forward Content-Length if the upstream provided one (VOD segments)
  if (tsRes.headers['content-length']) {
    res.setHeader('Content-Length', tsRes.headers['content-length']);
  }

  res.status(200);

  // Pipe: upstream → client.  Handle client disconnect gracefully.
  tsRes.pipe(res);

  req.on('close', () => {
    tsRes.destroy();
  });

  tsRes.on('error', (err) => {
    console.error('TS stream error:', err);
    if (!res.headersSent) res.status(500).end();
    else res.end();
  });
}
