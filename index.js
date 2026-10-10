/* My truck tracker - Vercel serverless API (replaces api.php)
   Environment variables (Vercel > Project > Settings > Environment Variables):
     ADMIN_PASS   admin login password
     ROUTES_KEY   Google API key with "Routes API" enabled (server-side only, never put in index.html)
     TL           optional, demo time-lapse (default 120; use 1 for real time)
   Storage: add "Upstash Redis" from the Vercel Marketplace/Storage tab and connect it to this project;
   it sets KV_REST_API_URL / KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_URL / _TOKEN) automatically. */
const crypto = require('crypto');
const ADMIN_PASS = process.env.ADMIN_PASS || '';
const ROUTES_KEY = process.env.ROUTES_KEY || '';
const TL = +(process.env.TL || 120);
const RURL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const RTOK = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const KEY = 'trucktracker';

class HttpErr extends Error { constructor(m, c) { super(m); this.c = c; } }
const fail = (m, c = 422) => { throw new HttpErr(m, c); };
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const sha = s => crypto.createHash('sha256').update(s).digest();
const safeEq = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

async function rc(cmd) {
  const r = await fetch(RURL, { method: 'POST', headers: { Authorization: 'Bearer ' + RTOK }, body: JSON.stringify(cmd) });
  const j = await r.json();
  if (j.error) throw new Error('Storage error: ' + j.error);
  return j.result;
}
async function load() {
  const r = await rc(['GET', KEY]);
  try { const j = JSON.parse(r); if (j && j.trips && j.trucks) return j; } catch (e) {}
  return { trucks: [], trips: [] };
}
const store = d => rc(['SET', KEY, JSON.stringify(d)]);

const hav = (a, b) => {
  const R = 6371000, rad = x => x * Math.PI / 180, p1 = rad(a[0]), p2 = rad(b[0]);
  const h = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(rad(b[1] - a[1]) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
function decode(s) {
  let i = 0, la = 0, ln = 0; const o = [];
  while (i < s.length) {
    for (let k = 0; k < 2; k++) {
      let sh = 0, r = 0, b;
      do { b = s.charCodeAt(i++) - 63; r |= (b & 31) << sh; sh += 5; } while (b >= 32);
      const v = (r & 1) ? ~(r >> 1) : (r >> 1);
      if (k === 0) la += v; else ln += v;
    }
    o.push([+(la / 1e5).toFixed(5), +(ln / 1e5).toFixed(5)]);
  }
  return o;
}
/* Real driving route via Google Routes API: start -> tolls/stops (in order) -> end */
async function route(pts) {
  if (!ROUTES_KEY) fail('ROUTES_KEY is not set in Vercel environment variables', 500);
  const mk = p => ({ location: { latLng: { latitude: p.lat, longitude: p.lng } } });
  const body = { origin: mk(pts[0]), destination: mk(pts[pts.length - 1]), travelMode: 'DRIVE' };
  if (pts.length > 2) body.intermediates = pts.slice(1, -1).map(mk);
  const r = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': ROUTES_KEY,
      'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline,routes.legs.distanceMeters,routes.legs.duration' },
    body: JSON.stringify(body)
  });
  const j = await r.json().catch(() => ({}));
  const R = j.routes && j.routes[0];
  if (!R) fail((j.error && j.error.message) || 'Google could not find a driving route (check key / coordinates)');
  const path = decode(R.polyline.encodedPolyline), cum = [0];
  for (let i = 1; i < path.length; i++) cum.push(Math.round(cum[i - 1] + hav(path[i - 1], path[i])));
  const total = Math.max(1, cum[cum.length - 1]), apiT = Math.max(1, R.distanceMeters || 1), wd = [0], legs = [];
  let s = 0;
  for (const L of R.legs || []) { s += L.distanceMeters || 0; wd.push(Math.round(s / apiT * total)); legs.push({ m: L.distanceMeters || 0, s: parseInt(L.duration) || 0 }); }
  return { path, cum, total, wd, legs, secs: parseInt(R.duration) || 0, km: +((R.distanceMeters || 0) / 1000).toFixed(1) };
}
/* Simulated GPS: distance (metres) along the real road path */
function live(t, now) {
  const T = t.total, d = Math.min(T, Math.max(0, t.anchorD + (now - t.anchorT) * t.speed / 3.6 * TL));
  const c = t.cum, p = t.path; let lo = 0, hi = c.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (c[m] <= d) lo = m; else hi = m - 1; }
  const j = Math.min(lo + 1, p.length - 1), seg = c[j] - c[lo], f = seg > 0 ? (d - c[lo]) / seg : 0;
  const pos = [+(p[lo][0] + (p[j][0] - p[lo][0]) * f).toFixed(5), +(p[lo][1] + (p[j][1] - p[lo][1]) * f).toFixed(5)];
  const done = d >= T - 1;
  return { d, i: lo, pos, done, status: done ? 'Trip completed' : (t.speed > 0 ? 'Moving' : 'Stopped') };
}
/* CLIENT VIEW: only points already passed are ever sent */
function clientView(d, now) {
  const tk = {}; d.trucks.forEach(x => tk[x.id] = x);
  return { trips: d.trips.map(t => {
    const L = live(t, now), x = tk[t.truckId] || { name: 'Truck', plate: '', driver: '' };
    const passed = t.points.map((p, k) => ({ ...p, km: +(t.wd[k] / 1000).toFixed(1), w: t.wd[k] })).filter(p => p.w <= L.d + 1).map(({ w, ...p }) => p);
    return { id: t.id, name: t.name, truck: { name: x.name, plate: x.plate, driver: x.driver }, status: L.status,
      speed: L.done ? 0 : t.speed, covered: +(L.d / 1000).toFixed(1), passed, path: t.path.slice(0, L.i + 1).concat([L.pos]), pos: L.pos };
  }) };
}
function adminView(d, now) {
  return { trucks: d.trucks, trips: d.trips.map(t => { const { cum, wd, ...r } = t; return { ...r, live: live(t, now) }; }) };
}
function cleanPts(a) {
  const o = (Array.isArray(a) ? a : []).map(p => {
    const la = Number(p && p.lat), ln = Number(p && p.lng);
    if (p == null || p.lat === '' || p.lng === '' || !isFinite(la) || !isFinite(ln) || Math.abs(la) > 90 || Math.abs(ln) > 180) fail('Invalid coordinates');
    const ty = ['start', 'end', 'toll', 'stop'].includes(p.type) ? p.type : 'stop', n = String(p.n || '').trim().slice(0, 80);
    return { type: ty, n: n || ty[0].toUpperCase() + ty.slice(1), lat: la, lng: ln };
  });
  if (o.length < 2 || o.length > 27) fail('Need a start, an end and at most 25 tolls/stops');
  o[0].type = 'start'; o[o.length - 1].type = 'end';
  return o;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (!RURL || !RTOK) fail('Storage not connected: add Upstash Redis to this project in Vercel (Storage tab) and redeploy', 500);
    const d = await load(), now = Date.now() / 1000;
    if (req.method === 'GET') return res.status(200).json(clientView(d, now));
    if (req.method !== 'POST') fail('Method not allowed', 405);
    if (!ADMIN_PASS) fail('ADMIN_PASS is not set in Vercel environment variables', 500);
    if (!safeEq(ADMIN_PASS, String(req.headers['x-admin-pass'] || ''))) fail('Wrong admin password', 401);
    const inp = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const a = inp.action || 'list', ix = id => d.trips.findIndex(t => t.id === id);
    if (a === 'truck') {
      const n = String(inp.name || '').trim(); if (!n) fail('Truck name required');
      d.trucks.push({ id: uid(), name: n.slice(0, 60), plate: String(inp.plate || '').slice(0, 30), driver: String(inp.driver || '').slice(0, 60) });
    } else if (a === 'delTruck') {
      d.trucks = d.trucks.filter(x => x.id !== inp.id); d.trips = d.trips.filter(x => x.truckId !== inp.id);
    } else if (a === 'trip') { /* create, or (with id) replace points e.g. add a toll/stop to an ongoing trip */
      const pts = cleanPts(inp.points), r = await route(pts), k = ix(inp.id);
      if (k >= 0) {
        const o = d.trips[k], L = live(o, now);
        d.trips[k] = { id: o.id, truckId: o.truckId, name: o.name, points: pts, speed: o.speed, anchorD: Math.min(L.d, r.total), anchorT: now, ...r };
      } else {
        if (!d.trucks.some(x => x.id === inp.truckId)) fail('Pick a truck first');
        const nm = String(inp.name || '').trim().slice(0, 80);
        d.trips.push({ id: uid(), truckId: inp.truckId, name: nm || pts[0].n + ' → ' + pts[pts.length - 1].n, points: pts, speed: 60, anchorD: 0, anchorT: now, ...r });
      }
    } else if (a === 'delTrip') {
      d.trips = d.trips.filter(x => x.id !== inp.id);
    } else if (a === 'speed' || a === 'restart') {
      const k = ix(inp.id); if (k < 0) fail('Trip not found', 404);
      const t = d.trips[k];
      if (a === 'speed') { t.anchorD = live(t, now).d; t.speed = Math.max(0, Math.min(200, Number(inp.speed) || 0)); } else t.anchorD = 0;
      t.anchorT = now;
    }
    if (a !== 'list') await store(d);
    res.status(200).json(adminView(d, now));
  } catch (e) {
    res.status(e.c || 500).json({ error: e.message });
  }
};
