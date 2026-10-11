/* My truck tracker - Vercel serverless API (replaces api.php)
   Environment variables (Vercel > Project > Settings > Environment Variables):
     ADMIN_PASS   admin login password
     ROUTES_KEY   Google API key with "Routes API" enabled (server-side only, never put in index.html)
     TL           optional, demo time-lapse (default 120; use 1 for real time)
   Storage: add "Upstash Redis" from the Vercel Marketplace/Storage tab and connect it to this project;
   it sets KV_REST_API_URL / KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_URL / _TOKEN) automatically. */
const crypto = require('crypto');
const ADMIN_PASS = (process.env.ADMIN_PASS || '').trim();
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
  wd[wd.length - 1] = total;
  return { path, cum, total, wd, legs, secs: parseInt(R.duration) || 0, km: +((R.distanceMeters || 0) / 1000).toFixed(1) };
}
/* ---- Simulated GPS with halts at tolls/stops ----
   Simulated clock: 1 real second = TL simulated seconds (TL=1 -> real time).
   Every admin change (speed, halt time, route, restart) saves a checkpoint, so past arrival/departure times never change. */
const idxAt = (c, d) => { let lo = 0, hi = c.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (c[m] <= d) lo = m; else hi = m - 1; } return lo; };
const dwellSec = (t, k) => Math.max(0, Math.min(600, Number(t.points[k].dwell) || 0)) * 60;
function newCk(t, now) { const n = t.points.length; return { at: now, sim: 0, d: 0, dw: 0, k: 1, arr: [0, ...Array(n - 1).fill(null)], dep: [0, ...Array(n - 1).fill(null)] }; }
function sim(t, now) {
  const ck = t.ck, last = t.points.length - 1, v = t.speed / 3.6;
  let s = ck.sim, d = ck.d, dw = ck.dw, k = ck.k, rem = Math.max(0, (now - ck.at) * TL);
  const arr = ck.arr.slice(), dep = ck.dep.slice();
  let done = arr[last] != null;
  while (rem > 0 && !done) {
    if (dw > 0) { const x = Math.min(dw, rem); dw -= x; s += x; rem -= x; if (dw <= 0) { dw = 0; dep[k - 1] = s; } continue; }
    if (!(v > 0)) { s += rem; rem = 0; break; }
    const need = Math.max(0, (t.wd[k] - d) / v);
    if (need <= rem) {
      d = Math.max(d, t.wd[k]); s += need; rem -= need; arr[k] = s;
      if (k === last) { done = true; d = t.total; }
      else { const w = dwellSec(t, k); if (w > 0) dw = w; else dep[k] = s; k++; }
    } else { d += rem * v; s += rem; rem = 0; }
  }
  return { s, d: Math.min(d, t.total), dw, k, arr, dep, done };
}
function live(t, now) {
  const st = sim(t, now), c = t.cum, p = t.path, lo = idxAt(c, st.d);
  const j = Math.min(lo + 1, p.length - 1), seg = c[j] - c[lo], f = seg > 0 ? (st.d - c[lo]) / seg : 0;
  const pos = [+(p[lo][0] + (p[j][0] - p[lo][0]) * f).toFixed(5), +(p[lo][1] + (p[j][1] - p[lo][1]) * f).toFixed(5)];
  const at = st.dw > 0 ? t.points[st.k - 1] : null;
  const status = st.done ? 'Trip completed' : at ? 'Halted at ' + at.n : (t.speed > 0 ? 'Moving' : 'Stopped');
  return { d: st.d, i: lo, pos, done: st.done, halted: st.dw > 0, s: st.s, arr: st.arr, dep: st.dep, status };
}
function checkpoint(t, now) { const st = sim(t, now); t.ck = { at: now, sim: st.s, d: st.d, dw: st.dw, k: st.k, arr: st.arr, dep: st.dep }; }
/* CLIENT VIEW: only points already reached are ever sent */
function clientView(d, now) {
  const tk = {}; d.trucks.forEach(x => tk[x.id] = x);
  return { tl: TL, trips: d.trips.map(t => {
    const L = live(t, now), x = tk[t.truckId] || { name: 'Truck', plate: '', driver: '' }, T0 = t.start * 1000, last = t.points.length - 1;
    const passed = [];
    t.points.forEach((p, k) => {
      if (L.arr[k] == null) return;
      const here = L.dep[k] == null && k !== last && !L.done;
      passed.push({ type: p.type, n: p.n, lat: p.lat, lng: p.lng, km: +(t.wd[k] / 1000).toFixed(1), pi: Math.min(idxAt(t.cum, t.wd[k]), L.i),
        at: Math.round(T0 + L.arr[k] * 1000), dp: L.dep[k] != null ? Math.round(T0 + L.dep[k] * 1000) : null, here,
        hs: k === 0 || k === last ? 0 : Math.round(L.dep[k] != null ? L.dep[k] - L.arr[k] : L.s - L.arr[k]) });
    });
    return { id: t.id, name: t.name, truck: { name: x.name, plate: x.plate, driver: x.driver }, status: L.status,
      speed: L.done || L.halted ? 0 : t.speed, covered: +(L.d / 1000).toFixed(1), start: Math.round(T0), end: L.done ? Math.round(T0 + L.arr[last] * 1000) : null,
      elapsed: Math.round(L.s), passed, path: t.path.slice(0, L.i + 1).concat([L.pos]), pos: L.pos };
  }) };
}
function adminView(d, now) {
  return { tl: TL, trucks: d.trucks, trips: d.trips.map(t => { const { cum, wd, ck, ...r } = t; return { ...r, live: live(t, now) }; }) };
}
function cleanPts(a) {
  const o = (Array.isArray(a) ? a : []).map(p => {
    const la = Number(p && p.lat), ln = Number(p && p.lng);
    if (p == null || p.lat === '' || p.lng === '' || !isFinite(la) || !isFinite(ln) || Math.abs(la) > 90 || Math.abs(ln) > 180) fail('Invalid coordinates');
    const ty = ['start', 'end', 'toll', 'stop'].includes(p.type) ? p.type : 'stop', n = String(p.n || '').trim().slice(0, 80);
    return { type: ty, n: n || ty[0].toUpperCase() + ty.slice(1), lat: la, lng: ln, dwell: ty === 'toll' || ty === 'stop' ? Math.max(0, Math.min(600, Number(p.dwell) || 0)) : 0 };
  });
  if (o.length < 2 || o.length > 27) fail('Need a start, an end and at most 25 tolls/stops');
  o[0].type = 'start'; o[o.length - 1].type = 'end';
  return o;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'POST' && !ADMIN_PASS) fail('ADMIN_PASS is not set in Vercel environment variables (add it, then Redeploy)', 500);
    if (!RURL || !RTOK) fail('Storage not connected: add Upstash Redis to this project in Vercel (Storage tab) and redeploy', 500);
    const d = await load(), now = Date.now() / 1000;
    let mig = false; d.trips.forEach(t => { if (!t.ck || !t.start) { t.start = now; t.ck = newCk(t, now); mig = true; } });
    if (mig) await store(d);
    if (req.method === 'GET') return res.status(200).json(clientView(d, now));
    if (req.method !== 'POST') fail('Method not allowed', 405);
    if (!ADMIN_PASS) fail('ADMIN_PASS is not set in Vercel environment variables', 500);
    if (!safeEq(ADMIN_PASS, String(req.headers['x-admin-pass'] || '').trim())) fail('Wrong admin password', 401);
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
        const o = d.trips[k]; checkpoint(o, now);
        const arr = [], dep = []; let oi = 0;
        pts.forEach(p => { const q = o.points[oi]; if (q && q.lat === p.lat && q.lng === p.lng) { arr.push(o.ck.arr[oi]); dep.push(o.ck.dep[oi]); oi++; } else { arr.push(null); dep.push(null); } });
        let kk = 1; while (kk < pts.length && arr[kk] != null) kk++;
        const dw = (kk - 1 >= 1 && kk < pts.length && arr[kk - 1] != null && dep[kk - 1] == null) ? o.ck.dw : 0;
        d.trips[k] = { id: o.id, truckId: o.truckId, name: o.name, points: pts, speed: o.speed, start: o.start, ...r,
          ck: { at: now, sim: o.ck.sim, d: Math.min(o.ck.d, r.total), dw, k: Math.min(kk, pts.length - 1), arr, dep } };
      } else {
        if (!d.trucks.some(x => x.id === inp.truckId)) fail('Pick a truck first');
        const nm = String(inp.name || '').trim().slice(0, 80), t = { id: uid(), truckId: inp.truckId, name: nm || pts[0].n + ' → ' + pts[pts.length - 1].n, points: pts, speed: 60, start: now, ...r };
        t.ck = newCk(t, now); d.trips.push(t);
      }
    } else if (a === 'delTrip') {
      d.trips = d.trips.filter(x => x.id !== inp.id);
    } else if (a === 'speed' || a === 'restart' || a === 'dwell') {
      const k = ix(inp.id); if (k < 0) fail('Trip not found', 404);
      const t = d.trips[k];
      if (a === 'restart') { t.start = now; t.ck = newCk(t, now); }
      else {
        checkpoint(t, now);
        if (a === 'speed') t.speed = Math.max(0, Math.min(200, Number(inp.speed) || 0));
        else { const q = Number(inp.k); if (!(q >= 1 && q < t.points.length - 1)) fail('Only tolls/stops have a halt time'); t.points[q].dwell = Math.max(0, Math.min(600, Number(inp.min) || 0)); }
      }
    }
    if (a !== 'list') await store(d);
    res.status(200).json(adminView(d, now));
  } catch (e) {
    res.status(e.c || 500).json({ error: e.message });
  }
};
