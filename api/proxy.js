// api/proxy.js
const https = require('https');
const http = require('http');
const { URL } = require('url');

module.exports = async (req, res) => {
  // Enhanced CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Expose-Headers', '*');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const targetUrl = req.query.url;
  
  if (!targetUrl) {
    res.status(400).json({ error: 'Missing url parameter' });
    return;
  }

  try {
    const content = await fetchWithRedirects(targetUrl);
    
    // Check if it's an M3U8 playlist by content or extension
    const isM3u8 = targetUrl.includes('.m3u8') || 
                   content.data.trim().startsWith('#EXTM3U') ||
                   content.type.includes('mpegurl') ||
                   content.type.includes('m3u8');
    
    if (isM3u8) {
      const baseUrl = getBaseUrl(content.finalUrl);
      const modifiedPlaylist = rewritePlaylist(content.data, baseUrl, req.headers.host);
      
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.status(200).send(modifiedPlaylist);
    } else {
      // For TS segments, return as binary
      const buffer = await fetchBinary(targetUrl);
      res.setHeader('Content-Type', 'video/mp2t');
      res.setHeader('Cache-Control', 'public, max-age=31536000');
      res.setHeader('Accept-Ranges', 'bytes');
      res.status(200).send(buffer);
    }
  } catch (error) {
    console.error('Proxy error:', error);
    res.status(500).json({ 
      error: 'Failed to fetch content',
      message: error.message 
    });
  }
};

function fetchBinary(url) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const protocol = parsedUrl.protocol === 'https:' ? https : http;
    
    const options = {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': '*/*',
        'Connection': 'keep-alive'
      }
    };

    protocol.get(url, options, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        const redirectUrl = new URL(response.headers.location, url).href;
        fetchBinary(redirectUrl).then(resolve).catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }

      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

function fetchWithRedirects(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    let redirectCount = 0;
    
    const fetch = (currentUrl) => {
      const parsedUrl = new URL(currentUrl);
      const protocol = parsedUrl.protocol === 'https:' ? https : http;
      
      const options = {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': '*/*',
          'Connection': 'keep-alive'
        }
      };

      protocol.get(currentUrl, options, (response) => {
        // Handle redirects
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
          redirectCount++;
          if (redirectCount > maxRedirects) {
            reject(new Error('Too many redirects'));
            return;
          }
          
          const redirectUrl = new URL(response.headers.location, currentUrl).href;
          fetch(redirectUrl);
          return;
        }

        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }

        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => {
          const buffer = Buffer.concat(chunks);
          resolve({
            data: buffer.toString('utf-8'),
            type: response.headers['content-type'] || 'application/octet-stream',
            finalUrl: currentUrl
          });
        });
      }).on('error', reject);
    };

    fetch(url);
  });
}

function getBaseUrl(url) {
  const parsedUrl = new URL(url);
  const pathParts = parsedUrl.pathname.split('/');
  pathParts.pop(); // Remove filename
  return `${parsedUrl.origin}${pathParts.join('/')}`;
}

function rewritePlaylist(content, baseUrl, proxyHost) {
  const lines = content.split('\n');
  const modifiedLines = lines.map(line => {
    const trimmed = line.trim();
    
    // Skip empty lines and comments (except URI attributes in tags)
    if (!trimmed || (trimmed.startsWith('#') && !trimmed.includes('URI='))) {
      return line;
    }

    // Handle URI attributes in tags (like #EXT-X-KEY)
    if (trimmed.startsWith('#') && trimmed.includes('URI=')) {
      return line.replace(/URI="([^"]+)"/g, (match, uri) => {
        const fullUrl = resolveUrl(uri, baseUrl);
        const protocol = proxyHost.includes('localhost') ? 'http' : 'https';
        return `URI="${protocol}://${proxyHost}/api/proxy?url=${encodeURIComponent(fullUrl)}"`;
      });
    }

    // Handle regular URLs (playlist entries)
    const fullUrl = resolveUrl(trimmed, baseUrl);
    const protocol = proxyHost.includes('localhost') ? 'http' : 'https';
    return `${protocol}://${proxyHost}/api/proxy?url=${encodeURIComponent(fullUrl)}`;
  });

  return modifiedLines.join('\n');
}

function resolveUrl(url, baseUrl) {
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return url;
  } else if (url.startsWith('/')) {
    const base = new URL(baseUrl);
    return `${base.origin}${url}`;
  } else {
    return `${baseUrl}/${url}`;
  }
}
