/* Study Hard — سيرفر التحديات (Vercel Serverless + Upstash Redis REST)
   من غير أي مكتبات. المتغيرات بتتضاف لوحدها لما توصّل Upstash Redis من تبويب Storage في Vercel:
   KV_REST_API_URL + KV_REST_API_TOKEN  (أو UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN)
   بنخزّن: اسم مستعار + لون + مجموع ساعات كل يوم. مفيش أي بيانات شخصية تانية. */
const crypto = require('crypto');

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';

async function redis(cmds) {
  const r = await fetch(URL_ + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds),
  });
  if (!r.ok) throw new Error('redis ' + r.status);
  const out = await r.json();
  return out.map((x) => {
    if (x.error) throw new Error(x.error);
    return x.result;
  });
}
const R1 = async (...cmd) => (await redis([cmd]))[0];
const J = (s) => { try { return s ? JSON.parse(s) : null; } catch (e) { return null; } };

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const rid = (n) => crypto.randomBytes(n).toString('hex');
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const code = () => Array.from(crypto.randomBytes(6), (b) => ALPHA[b % ALPHA.length]).join('');

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const HANDLE_RE = /^[a-z0-9_]{3,20}$/;
const TYPES = ['time', 'race', 'streak', 'rank'];
const STREAK_MIN = 600; // 10 دقايق = يوم محسوب (زي التطبيق)

const cleanName = (s) => String(s || '').replace(/[<>&"]/g, '').trim().slice(0, 24);
const cleanColor = (s) => (/^#[0-9a-fA-F]{6}$/.test(s) ? s : '#8b5cf6');

function cleanDays(d) {
  const out = {};
  if (!d || typeof d !== 'object') return out;
  const keys = Object.keys(d).filter((k) => DAY_RE.test(k)).sort().slice(-70);
  for (const k of keys) {
    const v = Number(d[k]);
    if (isFinite(v) && v > 0) out[k] = Math.min(Math.round(v), 86400);
  }
  return out;
}

async function auth(b) {
  if (!b || !/^[0-9a-f]{16}$/.test(b.id || '') || !b.token) return null;
  const u = J(await R1('GET', 'u:' + b.id));
  if (!u || u.th !== sha(b.token)) return null;
  return u;
}

function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  const x = new Date(Date.UTC(y, m - 1, d + n));
  return x.toISOString().slice(0, 10);
}
function windowOf(c) { return { from: c.start, to: addDays(c.start, c.days - 1) }; }

function progressOf(c, days) {
  const w = windowOf(c);
  let sec = 0, run = 0, best = 0, hit = null;
  for (let i = 0; i < c.days; i++) {
    const k = addDays(w.from, i);
    const v = (days && days[k]) || 0;
    sec += v;
    if (v >= STREAK_MIN) { run++; if (run > best) best = run; } else run = 0;
    if (!hit && c.type === 'race' && c.goalSec && sec >= c.goalSec) hit = k;
  }
  return { sec, streak: best, hit };
}

async function view(me, cids) {
  if (!cids.length) return [];
  const cs = (await redis(cids.map((id) => ['GET', 'c:' + id]))).map(J).filter(Boolean);
  const uids = [...new Set(cs.flatMap((c) => Object.keys(c.members)))];
  const us = {}, ss = {};
  if (uids.length) {
    const ur = await redis(uids.map((id) => ['GET', 'u:' + id]));
    const sr = await redis(uids.map((id) => ['GET', 's:' + id]));
    uids.forEach((id, i) => { us[id] = J(ur[i]); ss[id] = J(sr[i]); });
  }
  return cs.map((c) => {
    const members = Object.keys(c.members).map((id) => {
      const u = us[id] || {}, s = ss[id] || {};
      const p = progressOf(c, s.days);
      return { id, name: u.name || '؟', handle: u.handle || '', color: u.color || '#8b5cf6',
        state: c.members[id], sec: p.sec, streak: p.streak, hit: p.hit, me: id === me };
    });
    return { id: c.id, code: c.code, type: c.type, goalSec: c.goalSec, days: c.days, start: c.start,
      reward: c.reward || '', owner: c.owner, members };
  });
}

const handlers = {
  async ping() { return { ok: true, t: Date.now() }; },

  async register(b) {
    const handle = String(b.handle || '').toLowerCase();
    if (!HANDLE_RE.test(handle)) return [400, { error: 'bad_handle' }];
    const id = rid(8), token = rid(16);
    const got = await R1('SET', 'h:' + handle, id, 'NX');
    if (got !== 'OK') return [409, { error: 'taken' }];
    const u = { id, handle, name: cleanName(b.name) || handle, color: cleanColor(b.color), th: sha(token), created: Date.now() };
    await redis([['SET', 'u:' + id, JSON.stringify(u)], ['ZADD', 'idx', 0, handle]]);
    return { id, token, handle, name: u.name, color: u.color };
  },

  async sync(b) {
    const u = await auth(b);
    if (!u) return [401, { error: 'auth' }];
    const name = cleanName(b.name), color = b.color ? cleanColor(b.color) : u.color;
    if ((name && name !== u.name) || color !== u.color) {
      u.name = name || u.name; u.color = color;
      await R1('SET', 'u:' + u.id, JSON.stringify(u));
    }
    await R1('SET', 's:' + u.id, JSON.stringify({ days: cleanDays(b.days), t: Date.now() }));
    return { ok: true };
  },

  async search(b) {
    const u = await auth(b);
    if (!u) return [401, { error: 'auth' }];
    const q = String(b.q || '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20);
    if (q.length < 2) return { users: [] };
    const hs = await R1('ZRANGEBYLEX', 'idx', '[' + q, '[' + q + '\xff', 'LIMIT', 0, 10);
    if (!hs || !hs.length) return { users: [] };
    const ids = await redis(hs.map((h) => ['GET', 'h:' + h]));
    const us = (await redis(ids.filter(Boolean).map((id) => ['GET', 'u:' + id]))).map(J).filter(Boolean);
    return { users: us.filter((x) => x.id !== u.id).map((x) => ({ id: x.id, handle: x.handle, name: x.name, color: x.color })) };
  },

  async create(b) {
    const u = await auth(b);
    if (!u) return [401, { error: 'auth' }];
    if (!TYPES.includes(b.type)) return [400, { error: 'type' }];
    const days = Math.max(1, Math.min(365, parseInt(b.days) || 7));
    const goalSec = Math.max(0, Math.min(3600 * 5000, Math.round(Number(b.goalSec) || 0)));
    if (!DAY_RE.test(b.start || '')) return [400, { error: 'start' }];
    const invitees = (Array.isArray(b.invitees) ? b.invitees : []).filter((x) => /^[0-9a-f]{16}$/.test(x) && x !== u.id).slice(0, 30);
    const members = { [u.id]: 'joined' };
    invitees.forEach((x) => { members[x] = 'invited'; });
    let cid = '';
    for (let i = 0; i < 5; i++) {
      cid = code();
      if ((await R1('SET', 'k:' + cid, '1', 'NX')) === 'OK') break;
      cid = '';
    }
    if (!cid) return [500, { error: 'code' }];
    const c = { id: cid, code: cid, type: b.type, goalSec, days, start: b.start, reward: String(b.reward || '').slice(0, 60), owner: u.id, members, created: Date.now() };
    await redis([['SET', 'c:' + cid, JSON.stringify(c)], ...Object.keys(members).map((id) => ['SADD', 'uc:' + id, cid])]);
    return { id: cid };
  },

  async list(b) {
    const u = await auth(b);
    if (!u) return [401, { error: 'auth' }];
    const cids = (await R1('SMEMBERS', 'uc:' + u.id)) || [];
    return { challenges: await view(u.id, cids.slice(0, 60)) };
  },

  async respond(b) {
    const u = await auth(b);
    if (!u) return [401, { error: 'auth' }];
    const c = J(await R1('GET', 'c:' + String(b.cid || '')));
    if (!c || !c.members[u.id]) return [404, { error: 'none' }];
    if (b.accept) c.members[u.id] = 'joined';
    else { delete c.members[u.id]; await R1('SREM', 'uc:' + u.id, c.id); }
    if (!Object.keys(c.members).length) await redis([['DEL', 'c:' + c.id], ['DEL', 'k:' + c.id]]);
    else await R1('SET', 'c:' + c.id, JSON.stringify(c));
    return { ok: true };
  },

  async join(b) {
    const u = await auth(b);
    if (!u) return [401, { error: 'auth' }];
    const cid = String(b.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    const c = J(await R1('GET', 'c:' + cid));
    if (!c) return [404, { error: 'none' }];
    if (Object.keys(c.members).length >= 60 && !c.members[u.id]) return [409, { error: 'full' }];
    c.members[u.id] = 'joined';
    await redis([['SET', 'c:' + cid, JSON.stringify(c)], ['SADD', 'uc:' + u.id, cid]]);
    return { id: cid };
  },

  async leave(b) {
    const u = await auth(b);
    if (!u) return [401, { error: 'auth' }];
    const c = J(await R1('GET', 'c:' + String(b.cid || '')));
    if (!c) return { ok: true };
    delete c.members[u.id];
    await R1('SREM', 'uc:' + u.id, c.id);
    if (!Object.keys(c.members).length) await redis([['DEL', 'c:' + c.id], ['DEL', 'k:' + c.id]]);
    else {
      if (c.owner === u.id) c.owner = Object.keys(c.members)[0];
      await R1('SET', 'c:' + c.id, JSON.stringify(c));
    }
    return { ok: true };
  },
};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!URL_ || !TOKEN) return res.status(503).json({ error: 'no_db' });
  try {
    let b = req.body;
    if (typeof b === 'string') b = J(b);
    if (!b || typeof b !== 'object') b = {};
    const action = req.method === 'GET' ? 'ping' : b.action;
    const h = handlers[action];
    if (!h) return res.status(400).json({ error: 'action' });
    const out = await h(b);
    if (Array.isArray(out)) return res.status(out[0]).json(out[1]);
    return res.status(200).json(out);
  } catch (e) {
    return res.status(500).json({ error: 'server' });
  }
};
