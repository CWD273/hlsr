
const https = require('https');
const http = require('http');
const { URL } = require('url');

module.exports = async (req, res) => {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

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
    const contentType = content.type;
    
    // Check if it's an M3U8 playlist
    if (contentType.includes('application/vnd.apple.mpegurl') || 
        contentType.includes('application/x-mpegURL') ||
        targetUrl.endsWith('.m3u8')) {
      
      const baseUrl = getBaseUrl(content.finalUrl);
      const modifiedPlaylist = rewritePlaylist(content.data, baseUrl, req.headers.host);
      
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.status(200).send(modifiedPlaylist);
    } else {
      // Return raw content for TS segments or other files
      res.setHeader('Content-Type', contentType);
      res.status(200).send(content.data);
    }
  } catch (error) {
    console.error('Proxy error:', error);
    res.status(500).json({ 
      error: 'Failed to fetch content',
      message: error.message 
    });
  }
};

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
          'Accept-Encoding': 'identity'
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
    
    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#')) {
      return line;
    }

    // Handle relative and absolute URLs
    let fullUrl;
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      fullUrl = trimmed;
    } else if (trimmed.startsWith('/')) {
      const base = new URL(baseUrl);
      fullUrl = `${base.origin}${trimmed}`;
    } else {
      fullUrl = `${baseUrl}/${trimmed}`;
    }

    // Rewrite to proxy through our endpoint
    const protocol = proxyHost.includes('localhost') ? 'http' : 'https';
    return `${protocol}://${proxyHost}/api/proxy?url=${encodeURIComponent(fullUrl)}`;
  });

  return modifiedLines.join('\n');
}
