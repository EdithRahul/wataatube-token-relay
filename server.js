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
        version: '1.7.0',
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

  // Recent Videos Feed Relay Endpoint (/feed or ?action=feed)
  if (path === '/feed' || reqUrl.searchParams.get('action') === 'feed') {
    const page = parseInt(reqUrl.searchParams.get('page') || '1', 10);
    const rawSort = reqUrl.searchParams.get('sort') || 'post_date';
    const limit = Math.min(36, Math.max(1, parseInt(reqUrl.searchParams.get('limit') || '10', 10)));
    const customUrl = reqUrl.searchParams.get('target_url') || reqUrl.searchParams.get('custom_url') || reqUrl.searchParams.get('url') || '';
    
    let feedTarget = '';
    let sortKey = 'post_date';
    if (rawSort === 'most_viewed' || rawSort === 'video_viewed' || rawSort === 'views') {
      sortKey = 'video_viewed';
    } else if (rawSort === 'top_rated' || rawSort === 'rating') {
      sortKey = 'rating';
    } else if (rawSort === 'most_commented' || rawSort === 'comments') {
      sortKey = 'most_commented';
    }

    if (customUrl) {
      if (customUrl.includes('/videos/') && !customUrl.match(/\/videos\/[a-zA-Z0-9\-]{5,}\/?$/)) {
        let base = customUrl.replace(/\/\d+\/?(?:\?.*)?$/, '').replace(/\?.*$/, '');
        feedTarget = page > 1 ? `${base.replace(/\/+$/, '')}/${page}/` : `${base.replace(/\/+$/, '')}/`;
        if (customUrl.includes('?')) feedTarget += '?' + customUrl.split('?')[1];
      } else if (customUrl.match(/\/(?:onlyfans-creators|creators|models)\//i)) {
        let base = customUrl.replace(/\/\d+\/?(?:\?.*)?$/, '').replace(/\?.*$/, '');
        feedTarget = page > 1 ? `${base.replace(/\/+$/, '')}/${page}/` : `${base.replace(/\/+$/, '')}/`;
      } else {
        feedTarget = customUrl;
      }
    } else {
      feedTarget = page > 1 
        ? `https://pimpbunny.com/videos/${page}/?sort_by=${sortKey}`
        : `https://pimpbunny.com/videos/?sort_by=${sortKey}`;
    }

    const tStart = Date.now();
    try {
      const feedRes = await fetch(feedTarget, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Sec-Ch-Ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
          'Sec-Ch-Ua-Mobile': '?0',
          'Sec-Ch-Ua-Platform': '"Windows"',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Sec-Fetch-User': '?1',
          'Upgrade-Insecure-Requests': '1',
        },
      });

      const status = feedRes.status;
      const html = await feedRes.text();

      if (!feedRes.ok) {
        return new Response(JSON.stringify({
          success: false,
          error: `Upstream feed returned HTTP ${status}`,
          status_code: status,
          latency_ms: Date.now() - tStart,
        }), { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      const cards = html.split('ui-card-root');
      cards.shift();

      const items = [];
      for (const card of cards) {
        if (items.length >= limit) break;

        const urlMatch = card.match(/href=["']([^"']*?\/videos\/[^"']+?)["']/i);
        if (!urlMatch) continue;
        let vUrl = urlMatch[1];
        if (!vUrl.startsWith('http')) vUrl = 'https://pimpbunny.com' + vUrl;
        if (/\/videos\/\d+\/?(?:\?|$)/.test(vUrl)) continue;

        let title = '';
        const t1 = card.match(/class=["'][^"']*?ui-card-title[^"']*?["'][^>]*>(.*?)<\/span>/is);
        if (t1) {
          title = t1[1].replace(/<[^>]+>/g, '').trim();
        } else {
          const t2 = card.match(/title=["']([^"']+)["']/i);
          if (t2) title = t2[1].trim();
        }
        if (!title) continue;

        let thumb = '';
        const thOrig = card.match(/data-original=["']([^"']+)["']/i);
        const thWebp = card.match(/data-webp=["']([^"']+)["']/i);
        const thImg = card.match(/<img[^>]+src=["']([^"']+)["']/i);
        if (thOrig) thumb = thOrig[1];
        else if (thWebp) thumb = thWebp[1];
        else if (thImg) thumb = thImg[1];
        if (thumb && !thumb.startsWith('http')) thumb = 'https://pimpbunny.com' + thumb;

        let previewUrl = '';
        const prevMatch = card.match(/data-preview=["']([^"']+)["']/i);
        if (prevMatch) {
          previewUrl = prevMatch[1];
          if (!previewUrl.startsWith('http') && !previewUrl.startsWith('//')) {
            previewUrl = 'https://pimpbunny.com' + previewUrl;
          }
        }

        let duration = '10:00';
        const durMatch = card.match(/(\d{1,2}:\d{2}(?::\d{2})?)/);
        if (durMatch) duration = durMatch[1];

        let rating = '98%';
        const ratMatch = card.match(/(\d{1,3})%/);
        if (ratMatch) rating = ratMatch[1] + '%';

        const allModels = [];
        const modelRegex = /href=["'][^"']*?\/(onlyfans-creators|creators|models)\/([^/"']+)\/?["'][^>]*>(.*?)<\/a>/gis;
        let mMatch;
        while ((mMatch = modelRegex.exec(card)) !== null) {
          let mSection = mMatch[1].trim();
          let mSlug = mMatch[2].trim();
          let rawText = mMatch[3];
          let cleanMod = '';
          const truncM = rawText.match(/<span[^>]*class=["'][^"']*text-truncate[^"']*["'][^>]*>([^<]+)<\/span>/i);
          if (truncM) {
            cleanMod = truncM[1].trim();
          } else {
            cleanMod = rawText.replace(/<[^>]+>/g, ' ').trim();
          }
          cleanMod = cleanMod.replace(/(?:\s*verified|\s*collab)$/i, '');
          cleanMod = cleanMod.replace(/(?<=[a-z])(?:verified|collab)\b/i, '');
          cleanMod = cleanMod.replace(/\b(?:verified|collab)\b/gi, '').replace(/\s+/g, ' ').trim();
          if (!cleanMod && mSlug) {
            cleanMod = mSlug.replace(/-(?:verified|collab|exclusive-new-leaks|exclusive-leaks|new-leaks|leaked|leaks)$/i, '').replace(/[-_]/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
          }

          let cardModelImg = '';
          const cardImgM = rawText.match(/(?:data-original|src|data-webp|data-src)=["']([^"']*?\/contents\/(?:models|creators|avatars)\/[^"']+)["']/i);
          if (cardImgM) {
            cardModelImg = cardImgM[1].split('?')[0];
            if (!cardModelImg.startsWith('http')) cardModelImg = 'https://pimpbunny.com/' + cardModelImg.replace(/^\/+/, '');
          }

          if (cleanMod && !allModels.some(existing => existing.slug.toLowerCase() === mSlug.toLowerCase() || existing.name.toLowerCase() === cleanMod.toLowerCase())) {
            const baseSlug = mSlug.replace(/-(?:verified|collab|exclusive-new-leaks|exclusive-leaks|new-leaks|leaked|leaks)$/i, '');
            allModels.push({
              name: cleanMod,
              slug: mSlug,
              section: mSection,
              onlyfans: baseSlug ? `https://onlyfans.com/${baseSlug}` : '',
              image: cardModelImg || '',
            });
          }
        }

        let primaryModel = allModels[0] || null;
        let modelName = primaryModel ? primaryModel.name : '';
        let modelSlug = primaryModel ? primaryModel.slug : '';
        let modelOnlyfans = primaryModel ? primaryModel.onlyfans : '';

        if (modelName && title.toLowerCase().endsWith(modelName.toLowerCase())) {
          title = title.substring(0, title.length - modelName.length).trim();
        }

        let numId = '';
        const combo = (thumb + ' ' + previewUrl);
        const prMatch = combo.match(/\/(\d{4,8})_(?:pb_)?preview\.mp4/i);
        const scMatch = combo.match(/\/(\d{4,8})\/800x450\//i);
        const dirMatch = combo.match(/\/\d{4,8}\/(\d{4,8})\//);
        if (prMatch) {
          numId = prMatch[1];
        } else if (scMatch) {
          numId = scMatch[1];
        } else if (dirMatch) {
          numId = dirMatch[1];
        } else {
          const fallbackM = combo.match(/\/(\d{4,8})\//);
          if (fallbackM && !fallbackM[1].endsWith('000')) numId = fallbackM[1];
        }

        if (numId && numId.endsWith('000')) {
          numId = '';
        }

        const embedUrl = numId ? `https://pimpbunny.com/embed/${numId}` : '';

        let vSlug = '';
        const vsMatch = vUrl.match(/\/videos\/([^/]+)/);
        if (vsMatch) vSlug = vsMatch[1].replace(/[^a-z0-9\-]/gi, '').toLowerCase();

        items.push({
          source_id: (numId && !numId.endsWith('000')) ? `pb_${numId}` : (vSlug ? `pb_${vSlug}` : `pb_${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')}`),
          numeric_id: numId,
          title: title,
          duration: duration,
          rating: rating,
          quality: '1080p HD',
          thumb_url: thumb,
          preview_url: previewUrl,
          video_url: embedUrl,
          source_url: vUrl,
          model_name: modelName,
          model_slug: modelSlug,
          model_onlyfans: modelOnlyfans,
          model_image: '',
          models: allModels,
        });
      }

      // Collect all unique model entries across the batch
      const uniqueModelsMap = new Map();
      for (const item of items) {
        if (Array.isArray(item.models)) {
          for (const m of item.models) {
            if (m.slug && !uniqueModelsMap.has(m.slug.toLowerCase())) {
              uniqueModelsMap.set(m.slug.toLowerCase(), {
                slug: m.slug,
                section: m.section || 'models',
                image: m.image || '',
              });
            }
          }
        } else if (item.model_slug && !uniqueModelsMap.has(item.model_slug.toLowerCase())) {
          uniqueModelsMap.set(item.model_slug.toLowerCase(), {
            slug: item.model_slug,
            section: 'models',
            image: item.model_image || '',
          });
        }
      }

      const avatarMap = {};
      for (const [sKey, mObj] of uniqueModelsMap.entries()) {
        if (mObj.image) {
          avatarMap[mObj.slug] = mObj.image;
        }
      }

      const modelsToFetch = Array.from(uniqueModelsMap.values()).filter(m => !m.image).slice(0, 25);
      const fetchHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': feedTarget || 'https://pimpbunny.com/',
      };

      const CHUNK_SIZE = 5;
      for (let i = 0; i < modelsToFetch.length; i += CHUNK_SIZE) {
        const chunk = modelsToFetch.slice(i, i + CHUNK_SIZE);
        await Promise.allSettled(
          chunk.map(async (m) => {
            try {
              const rawSlug = m.slug;
              const section = m.section || 'models';
              const altSection = section === 'models' ? 'onlyfans-creators' : 'models';
              const baseSlug = rawSlug.replace(/-(?:verified|collab|exclusive-new-leaks|exclusive-leaks|new-leaks|leaked|leaks)$/i, '');

              const targets = [
                `https://pimpbunny.com/${section}/${rawSlug}/`,
                `https://pimpbunny.com/${altSection}/${rawSlug}/`,
              ];
              if (baseSlug && baseSlug !== rawSlug) {
                targets.push(`https://pimpbunny.com/${section}/${baseSlug}/`);
              }

              for (const target of targets) {
                try {
                  const cRes = await fetch(target, { headers: fetchHeaders });
                  if (cRes.ok) {
                    const cHtml = await cRes.text();
                    if (cHtml.includes('bunny_shield') || cHtml.includes('Hold tight')) continue;
                    const avMatch = cHtml.match(/(?:data-original|src|data-webp|data-src)=["']([^"']*?\/contents\/(?:models|creators|avatars)\/[^"']+)["']/i);
                    if (avMatch) {
                      let avUrl = avMatch[1].split('?')[0];
                      if (!avUrl.startsWith('http')) avUrl = 'https://pimpbunny.com/' + avUrl.replace(/^\/+/, '');
                      avatarMap[rawSlug] = avUrl;
                      break;
                    }
                  }
                } catch (ce) {}
              }
            } catch (e) {}
          })
        );
      }

      for (const item of items) {
        if (Array.isArray(item.models)) {
          for (const m of item.models) {
            if (m.slug && avatarMap[m.slug]) {
              m.image = avatarMap[m.slug];
            }
          }
        }
        if (item.model_slug && avatarMap[item.model_slug]) {
          item.model_image = avatarMap[item.model_slug];
        } else if (item.models && item.models[0] && item.models[0].image) {
          item.model_image = item.models[0].image;
        }
      }

      return new Response(JSON.stringify({
        success: true,
        feed_url: feedTarget,
        count: items.length,
        page: page,
        sort: sortKey,
        items: items,
        latency_ms: Date.now() - tStart,
        relay_host: 'Render US',
      }, null, 2), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });

    } catch (err) {
      return new Response(JSON.stringify({
        success: false,
        error: err.message,
        latency_ms: Date.now() - tStart,
        relay_host: 'Render US',
      }, null, 2), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  }

  // Model / Creator Profile Relay Endpoint (/creator?slug=sara-blonde)
  if (path === '/creator' || reqUrl.searchParams.get('action') === 'creator') {
    const rawSlug = reqUrl.searchParams.get('slug') || reqUrl.searchParams.get('model') || '';
    if (!rawSlug) {
      return new Response(JSON.stringify({ success: false, error: 'Missing slug parameter' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const sLow = rawSlug.toLowerCase().trim();
    const baseSlug = sLow.replace(/-(?:verified|collab|exclusive-new-leaks|exclusive-leaks|new-leaks|leaked|leaks)$/i, '').replace(/[^a-z0-9\-]/g, '');
    const cleanSlug = sLow.replace(/-(?:verified|collab|leaked|leaks)$/i, '').replace(/[^a-z0-9\-]/g, '');

    const candUrls = [
      `https://pimpbunny.com/onlyfans-creators/${sLow}/`,
      `https://pimpbunny.com/models/${sLow}/`,
      `https://pimpbunny.com/onlyfans-creators/${cleanSlug}/`,
      `https://pimpbunny.com/models/${cleanSlug}/`,
      `https://pimpbunny.com/onlyfans-creators/${baseSlug}/`,
      `https://pimpbunny.com/models/${baseSlug}/`,
      `https://pimpbunny.com/onlyfans-creators/${baseSlug}-leaks/`,
      `https://pimpbunny.com/models/${baseSlug}-leaks/`,
    ];
    const uniqueCand = [...new Set(candUrls)];

    const creatorHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Sec-Ch-Ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Windows"',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1',
      'Referer': 'https://pimpbunny.com/',
    };

    let foundImage = '';
    let foundBio = '';
    let foundOnlyfans = baseSlug ? `https://onlyfans.com/${baseSlug}` : `https://onlyfans.com/${sLow}`;
    let foundInstagram = '';
    let foundTwitter = '';
    let foundFansly = '';
    let foundTiktok = '';
    let foundTelegram = '';

    for (const target of uniqueCand) {
      try {
        const cRes = await fetch(target, { headers: creatorHeaders });
        if (cRes.ok) {
          const cHtml = await cRes.text();
          if (cHtml.includes('bunny_shield') || cHtml.includes('Hold tight')) continue;

          const avMatch = cHtml.match(/(?:data-original|src|data-webp|data-src)=["']([^"']*?\/contents\/(?:models|creators|avatars)\/[^"']+)["']/i);
          if (avMatch && !foundImage) {
            let img = avMatch[1].split('?')[0];
            if (!img.startsWith('http')) img = 'https://pimpbunny.com/' + img.replace(/^\/+/, '');
            foundImage = img;
          }

          const bioMatch = cHtml.match(/data-model-description>([^<]+)<\/div>/i) ||
                           cHtml.match(/<div[^>]*class=["'][^"']*(?:model-description|creator-bio|bio-text)[^"']*["'][^>]*>(.*?)<\/div>/is);
          if (bioMatch && !foundBio) {
            foundBio = bioMatch[1].replace(/<[^>]+>/g, '').trim();
          }

          const socMatches = cHtml.matchAll(/href=["'](https?:\/\/[^"']*(?:onlyfans\.com|fansly\.com|instagram\.com|twitter\.com|x\.com|tiktok\.com|t\.me)[^"']*)["']/gi);
          for (const sm of socMatches) {
            const surl = sm[1];
            if (surl.includes('itspimpbunny') || surl.includes('pimpbunny.com')) continue;
            if (surl.includes('onlyfans.com')) foundOnlyfans = surl;
            else if (surl.includes('fansly.com') && !foundFansly) foundFansly = surl;
            else if (surl.includes('instagram.com') && !foundInstagram) foundInstagram = surl;
            else if ((surl.includes('twitter.com') || surl.includes('x.com')) && !foundTwitter) foundTwitter = surl;
            else if (surl.includes('tiktok.com') && !foundTiktok) foundTiktok = surl;
            else if (surl.includes('t.me') && !foundTelegram) foundTelegram = surl;
          }

          if (foundImage) break;
        }
      } catch (e) {}
    }

    if (foundImage || foundBio) {
      return new Response(JSON.stringify({
        success: true,
        slug: baseSlug || cleanSlug || sLow,
        image: foundImage,
        bio: foundBio,
        onlyfans: foundOnlyfans,
        instagram: foundInstagram,
        twitter: foundTwitter,
        fansly: foundFansly,
        tiktok: foundTiktok,
        telegram: foundTelegram,
        relay_host: 'Render US',
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({
      success: false,
      error: 'Creator profile not found upstream',
      slug: baseSlug || cleanSlug || sLow,
      image: '',
      bio: '',
      onlyfans: foundOnlyfans,
    }), {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
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

  const cleanId = targetId ? targetId.toString().replace(/[^0-9]/g, '') : '';
  if (cleanId && !targetUrl) {
    targetUrl = `https://pimpbunny.com/embed/${cleanId}/`;
  }

  if (!targetUrl) {
    return new Response(
      JSON.stringify({
        success: false,
        error: 'Missing required parameter: "url" or "id"',
        usage: 'GET /?id=620806 or GET /?url=https://pimpbunny.com/videos/... or POST { "url": "..." }',
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

  const isEmbed = pageUrl.includes('/embed/');
  const pageHeaders = {
    'User-Agent': browserUa,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': isEmbed ? 'https://wataatube.com/' : 'https://pimpbunny.com/',
    'Sec-Ch-Ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': isEmbed ? 'iframe' : 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': isEmbed ? 'cross-site' : 'none',
    'Upgrade-Insecure-Requests': '1',
  };
  if (!isEmbed) {
    pageHeaders['Sec-Fetch-User'] = '?1';
  }

  const pageRes = await fetch(pageUrl, {
    method: 'GET',
    headers: pageHeaders,
    redirect: 'follow',
  });

  const statusCode = pageRes.status;
  const cdnCountry = pageRes.headers.get('cdn-requestcountrycode') || '';
  const html = await pageRes.text();

  const isBunnyBlocked = (!pageRes.ok && statusCode === 403) || html.includes('Establishing a secure connection') || html.includes('shield-challenge.js');
  if (!pageRes.ok || isBunnyBlocked) {
    return {
      success: false,
      error: `Upstream returned HTTP ${statusCode}` + (isBunnyBlocked ? ' (BunnyShield Challenge)' : ''),
      status_code: statusCode,
      cdn_country: cdnCountry,
      bunny_shield_blocked: isBunnyBlocked,
    };
  }

  // Extract full cookie jar (PHPSESSID, kt_acctoken, bunny_shield_id)
  let cookieStr = '';
  if (typeof pageRes.headers.getSetCookie === 'function') {
    cookieStr = pageRes.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  } else {
    cookieStr = pageRes.headers.get('set-cookie') || '';
  }

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
      if (rawUrl.includes('/videos/') && !rawUrl.includes('/get_file/')) continue;
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
  
  // Resolve ALL available qualities in parallel (1080p, 720p, 480p, 360p)
  const qualityTasks = Object.keys(rawStreams).map(async (qk) => {
    try {
      const finalStream = await resolveToCdnStorage(rawStreams[qk], pageUrl, cookieStr, browserUa);
      if (finalStream) {
        resolved[qk] = finalStream;
      }
    } catch (e) {}
  });

  // Concurrently resolve preview clip if needed
  const previewTask = (async () => {
    if (previewUrl && !previewUrl.includes('remote_control.php')) {
      try {
        const resolvedPrev = await resolveToCdnStorage(previewUrl, pageUrl, cookieStr, browserUa);
        if (resolvedPrev) previewUrl = resolvedPrev;
      } catch (e) {}
    }
  })();

  await Promise.all([...qualityTasks, previewTask]);

  // Determine default stream: requested quality, or prefer 720p HD, then 1080p, 480p, 360p
  let defaultQuality = '';
  if (requestedQuality && resolved[requestedQuality]) {
    defaultQuality = requestedQuality;
  } else if (resolved['720p']) {
    defaultQuality = '720p';
  } else if (resolved['1080p']) {
    defaultQuality = '1080p';
  } else if (resolved['480p']) {
    defaultQuality = '480p';
  } else {
    defaultQuality = Object.keys(resolved)[0] || '720p';
  }
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
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': refererUrl || 'https://pimpbunny.com/',
    'Sec-Fetch-Dest': 'video',
    'Sec-Fetch-Mode': 'no-cors',
    'Sec-Fetch-Site': 'same-origin',
    'Range': 'bytes=0-',
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
