import http from 'node:http';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Relay-Secret',
};

async function handleRequest(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const reqUrl = new URL(request.url);
  const path = reqUrl.pathname;

  // Health / Ping endpoint
  if (path === '/ping' || path === '/health') {
    return new Response(
      JSON.stringify({
        status: 'ok',
        service: 'WataaTube Token Relay (Render US)',
        version: '1.3.0',
        platform: 'render',
        region: process.env.RENDER_REGION || 'US',
        timestamp: Date.now(),
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  // Media & Image Proxy Endpoint (/proxy?url=... or /media?url=...)
  if (path === '/proxy' || path === '/media') {
    const target = reqUrl.searchParams.get('url') || '';
    if (!target || !target.startsWith('http')) {
      return new Response('Missing target URL', { status: 400 });
    }
    try {
      const isMedia = target.includes('.mp4') || target.includes('.webm') || target.includes('/get_file/') || target.includes('remote_control.php');
      const mHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Referer': 'https://pimpbunny.com/',
        'Accept': isMedia ? '*/*' : 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      };
      const clientRange = request.headers.get('Range') || request.headers.get('range');
      if (clientRange) {
        mHeaders['Range'] = clientRange;
      }
      const mRes = await fetch(target, { headers: mHeaders });
      const contentType = mRes.headers.get('content-type') || (isMedia ? 'video/mp4' : 'image/jpeg');
      const outHeaders = {
        ...corsHeaders,
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=604800, s-maxage=604800',
      };
      const contentRange = mRes.headers.get('Content-Range') || mRes.headers.get('content-range');
      if (contentRange) outHeaders['Content-Range'] = contentRange;
      const acceptRanges = mRes.headers.get('Accept-Ranges') || mRes.headers.get('accept-ranges');
      if (acceptRanges) outHeaders['Accept-Ranges'] = acceptRanges;
      const contentLength = mRes.headers.get('Content-Length') || mRes.headers.get('content-length');
      if (contentLength) outHeaders['Content-Length'] = contentLength;

      return new Response(mRes.body, {
        status: mRes.status,
        headers: outHeaders,
      });
    } catch (e) {
      return new Response('Upstream fetch error: ' + e.message, { status: 502 });
    }
  }

  // Diagnostic self-test endpoint: /test or /test?id=620806
  if (path === '/test') {
    const testId = reqUrl.searchParams.get('id') || '620806';
    const testUrl = `https://pimpbunny.com/embed/${testId}/`;
    const t0 = Date.now();
    try {
      const testRes = await resolvePimpBunnyStreams(testUrl, '');
      testRes.test_id = testId;
      testRes.test_target = testUrl;
      testRes.latency_ms = Date.now() - t0;
      testRes.relay_host = 'Render US';
      return new Response(JSON.stringify(testRes, null, 2), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    } catch (err) {
      return new Response(
        JSON.stringify({
          success: false,
          error: err.message,
          latency_ms: Date.now() - t0,
          relay_host: 'Render US',
        }, null, 2),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
  }

  // Main resolution request: handle GET or POST
  let targetUrl = '';
  let targetId = '';
  let requestedQuality = '';

  if (request.method === 'POST') {
    try {
      const body = await request.json();
      targetUrl = body.url || body.source_url || '';
      targetId = body.id || body.video_id || '';
      requestedQuality = (body.quality || '').toLowerCase().trim();
    } catch (e) {}
  } else {
    targetUrl = reqUrl.searchParams.get('url') || reqUrl.searchParams.get('source_url') || '';
    targetId = reqUrl.searchParams.get('id') || reqUrl.searchParams.get('video_id') || '';
    requestedQuality = (reqUrl.searchParams.get('quality') || '').toLowerCase().trim();
  }

  if (targetId && !targetUrl) {
    const cleanId = targetId.toString().replace(/[^0-9]/g, '');
    if (cleanId) {
      targetUrl = `https://pimpbunny.com/embed/${cleanId}/`;
    }
  }

  if (!targetUrl) {
    return new Response(
      JSON.stringify({
        success: false,
        error: 'Missing required parameter: "url" or "id"',
        usage: 'GET /?id=620806 or GET /?url=https://pimpbunny.com/embed/620806/ or POST { "url": "..." }',
      }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  const tStart = Date.now();
  try {
    const data = await resolvePimpBunnyStreams(targetUrl, requestedQuality);
    data.latency_ms = Date.now() - tStart;
    data.relay_host = 'Render US';

    return new Response(JSON.stringify(data), {
      status: data.success ? 200 : 502,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({
        success: false,
        error: err.message,
        latency_ms: Date.now() - tStart,
        relay_host: 'Render US',
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
}

async function resolvePimpBunnyStreams(pageUrl, requestedQuality = '') {
  const browserUa =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

  const pageHeaders = {
    'User-Agent': browserUa,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://pimpbunny.com/',
    'Sec-Ch-Ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
  };

  const pageRes = await fetch(pageUrl, {
    method: 'GET',
    headers: pageHeaders,
    redirect: 'follow',
  });

  const statusCode = pageRes.status;
  const cdnCountry = pageRes.headers.get('cdn-requestcountrycode') || '';
  const html = await pageRes.text();

  if (!pageRes.ok) {
    const isBunnyBlocked = html.includes('bunny_shield') || html.includes('errorcode') || statusCode === 403;
    return {
      success: false,
      error: `Upstream returned HTTP ${statusCode}`,
      status_code: statusCode,
      cdn_country: cdnCountry,
      bunny_shield_blocked: isBunnyBlocked,
    };
  }

  const setCookie = pageRes.headers.get('set-cookie') || '';

  const streamKeys = [
    { key: 'video_alt_url3', def: '1080p' },
    { key: 'video_alt_url2', def: '720p' },
    { key: 'video_alt_url',  def: '480p' },
    { key: 'video_url',      def: '360p' },
  ];

  const rawStreams = {};
  for (const item of streamKeys) {
    const reg = new RegExp(`\\b${item.key}\\s*:\\s*['"]([^'"]+)['"]`, 'i');
    const m = html.match(reg);
    if (m && m[1]) {
      let rawUrl = m[1].trim();
      if (rawUrl.toLowerCase().includes('upgrade=')) continue;
      if (rawUrl.startsWith('//')) {
        rawUrl = 'https:' + rawUrl;
      } else if (rawUrl.startsWith('/')) {
        rawUrl = 'https://pimpbunny.com' + rawUrl;
      }

      try {
        const uHost = new URL(rawUrl).hostname;
        if (uHost === 'st17.pimpbunny.com') continue;
      } catch(e) {}

      let label = item.def;
      const labelReg = new RegExp(`\\b${item.key}_text\\s*:\\s*['"]([^'"]+)['"]`, 'i');
      const lm = html.match(labelReg);
      if (lm && lm[1]) {
        let customLabel = lm[1].trim().toLowerCase();
        if (!customLabel.includes('p') && /^\d+$/.test(customLabel)) {
          customLabel += 'p';
        }
        if (customLabel) label = customLabel;
      }
      rawStreams[label] = rawUrl;
    }
  }

  let previewUrl = '';
  const prevMatch = html.match(/data-preview=['"]([^'"]+\.mp4[^'"]*)['"]/i) ||
                    html.match(/["']preview_url["']\s*:\s*['"]([^'"]+\.mp4[^'"]*)['"]/i);
  if (prevMatch && prevMatch[1] && !prevMatch[1].includes('${')) {
    previewUrl = prevMatch[1].trim();
    if (previewUrl.startsWith('//')) {
      previewUrl = 'https:' + previewUrl;
    } else if (previewUrl.startsWith('/')) {
      previewUrl = 'https://pimpbunny.com' + previewUrl;
    }
  }

  if (Object.keys(rawStreams).length === 0) {
    return {
      success: false,
      error: 'No video streams found in page HTML',
      status_code: statusCode,
      cdn_country: cdnCountry,
      html_length: html.length,
    };
  }

  const resolved = {};
  let targetQuality = '';

  if (requestedQuality === 'preview') {
    if (previewUrl && !previewUrl.includes('remote_control.php')) {
      try {
        const resolvedPrev = await resolveToCdnStorage(previewUrl, pageUrl, setCookie, browserUa);
        if (resolvedPrev) previewUrl = resolvedPrev;
      } catch (e) {}
    }
  } else {
    if (requestedQuality && rawStreams[requestedQuality]) {
      targetQuality = requestedQuality;
    } else if (rawStreams['720p']) {
      targetQuality = '720p';
    } else if (rawStreams['1080p']) {
      targetQuality = '1080p';
    } else if (rawStreams['480p']) {
      targetQuality = '480p';
    } else {
      targetQuality = Object.keys(rawStreams)[0] || '';
    }

    if (targetQuality && rawStreams[targetQuality]) {
      const finalStream = await resolveToCdnStorage(rawStreams[targetQuality], pageUrl, setCookie, browserUa);
      if (finalStream) {
        resolved[targetQuality] = finalStream;
      }
    }
  }

  const defaultQuality = targetQuality || Object.keys(resolved)[0] || '720p';
  const defaultUrl = resolved[defaultQuality] || Object.values(resolved)[0] || '';

  let tokenExpiry = 0;
  if (defaultUrl) {
    const tokenMatch = defaultUrl.match(/acctoken=([a-zA-Z0-9_\-=]+)/i);
    if (tokenMatch && tokenMatch[1]) {
      try {
        const decoded = atob(tokenMatch[1].replace(/-/g, '+').replace(/_/g, '/'));
        const parts = decoded.split('|');
        if (parts.length >= 2 && /^\d+$/.test(parts[1])) {
          tokenExpiry = parseInt(parts[1], 10);
        }
      } catch (e) {}
    }
  }

  return {
    success: Object.keys(resolved).length > 0,
    source_url: pageUrl,
    cdn_country: cdnCountry,
    qualities: resolved,
    default_quality: defaultQuality,
    default_url: defaultUrl,
    preview_url: previewUrl,
    token_expires_at: tokenExpiry,
    token_valid_seconds: tokenExpiry > 0 ? Math.max(0, tokenExpiry - Math.floor(Date.now() / 1000)) : 7200,
    requested_quality: requestedQuality,
    requested_url: requestedQuality && resolved[requestedQuality] ? resolved[requestedQuality] : defaultUrl,
  };
}

async function resolveToCdnStorage(rawUrl, refererUrl, cookieStr, browserUa) {
  if (!rawUrl) return null;
  rawUrl = rawUrl.replace(/&amp;/g, '&');
  if (rawUrl.startsWith('//')) {
    rawUrl = 'https:' + rawUrl;
  } else if (rawUrl.startsWith('/')) {
    rawUrl = 'https://pimpbunny.com' + rawUrl;
  }

  if (rawUrl.includes('remote_control.php')) {
    return rawUrl;
  }

  const reqHeaders = {
    'User-Agent': browserUa,
    'Accept': '*/*',
    'Referer': refererUrl || 'https://pimpbunny.com/',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
  };
  if (cookieStr) {
    reqHeaders['Cookie'] = cookieStr;
  }

  try {
    const res = await fetch(rawUrl, {
      method: 'GET',
      headers: reqHeaders,
      redirect: 'manual',
    });

    const location = res.headers.get('location') || res.headers.get('Location');
    if (location && location.includes('remote_control.php')) {
      return location;
    }

    if (res.status === 200 && res.url && res.url.includes('remote_control.php')) {
      return res.url;
    }
  } catch (err) {}

  return null;
}

// HTTP Server Adapter for Node.js / Render
const PORT = process.env.PORT || 3000;

const server = http.createServer(async (req, res) => {
  try {
    const proto = req.headers['x-forwarded-proto'] || 'http';
    const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
    const fullUrl = `${proto}://${host}${req.url}`;

    let body = null;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      body = Buffer.concat(chunks);
    }

    const webHeaders = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (Array.isArray(v)) {
        v.forEach(val => webHeaders.append(k, val));
      } else if (v !== undefined) {
        webHeaders.set(k, v);
      }
    }

    const webReq = new Request(fullUrl, {
      method: req.method,
      headers: webHeaders,
      body: body,
      duplex: body ? 'half' : undefined,
    });

    const webRes = await handleRequest(webReq);

    const outHeaders = {};
    webRes.headers.forEach((val, key) => {
      outHeaders[key] = val;
    });

    res.writeHead(webRes.status, outHeaders);

    if (webRes.body) {
      const reader = webRes.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    }
    res.end();
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: err.message }));
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 WataaTube Token Relay listening on port ${PORT}`);
});
