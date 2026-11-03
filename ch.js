// api/ch.js — سيرفر Study Hard (Vercel Serverless Function)
// يحتاج قاعدة بيانات Redis. استخدم إضافة Upstash من Vercel Marketplace
// (أو Vercel KV القديم)، وده هيضيف المتغيرات دي تلقائي لمشروعك:
//   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
//   (أو KV_REST_API_URL / KV_REST_API_TOKEN لو بتستخدم Vercel KV)
//
// تثبيت: npm install @upstash/redis
//
// ========= ملاحظة مهمة =========
// النقاط هنا "نقاط لعبة" رمزية بين أصحاب، مش فلوس حقيقية ومفيش تحويل
// بنكي أو دفع حقيقي. النظام مبني على الثقة بين الأصحاب (زي باقي بيانات
// التطبيق اللي بييجي من الجهاز نفسه)، مش نظام مقاوم للغش 100%.

import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

const START_PTS = 100;
const STREAK_MIN = 600; // ثانية, زي الواجهة
const MAX_STAKE_BASE = 20, MAX_STAKE_PER_LVL = 5;

function id(n = 16) {
  const a = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < n; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
}
function code() {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // من غير أحرف ملبوسة
  let s = '';
  for (let i = 0; i < 6; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
}
function err(res, code, status = 400) {
  return res.status(status).json({ error: code });
}
function dayK(d) {
  return new Date(d).toISOString().slice(0, 10);
}
function addDays(k, n) {
  const d = new Date(k + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function getAcct(idv) {
  return (await redis.get(`acct:${idv}`)) || null;
}
async function saveAcct(a) {
  await redis.set(`acct:${a.id}`, a);
}
async function auth(body) {
  if (!body.id || !body.token) return null;
  const a = await getAcct(body.id);
  if (!a || a.token !== body.token) return null;
  return a;
}
async function getCh(idv) {
  return (await redis.get(`ch:${idv}`)) || null;
}
async function saveCh(c) {
  await redis.set(`ch:${c.id}`, c);
}

// يحسب ثواني المذاكرة والستريك لعضو من سجل أيامه المحفوظ، في مدة التحدي
function memberMetrics(days, start, nDays) {
  let sec = 0, run = 0, best = 0, hit = null;
  for (let i = 0; i < nDays; i++) {
    const k = addDays(start, i);
    const v = (days && days[k]) || 0;
    sec += v;
    if (v >= STREAK_MIN) { run++; if (run > best) best = run; } else run = 0;
  }
  return { sec: Math.round(sec), streak: best, hit };
}

function isEnded(c) {
  const end = addDays(c.start, c.days - 1);
  if (dayK(Date.now()) > end) return true;
  if (c.type === 'race') {
    return c.members.some(m => m.state === 'joined' && m.hit);
  }
  return false;
}

// يوزّع الصندوق على الأعضاء المنضمين حسب نسبة مجهود كل واحد من المقياس
// (ثواني للـ time/race، أيام ستريك للـ streak، وللـ rank بنفس المقياس)
function settlePot(c) {
  if (!c.stake || c.pot.settled) return;
  if (!isEnded(c)) return;
  const joined = c.members.filter(m => m.state === 'joined' && m.paid);
  const total = c.pot.total || 0;
  const metricOf = m => (c.type === 'streak' ? (m.streak || 0) : (m.sec || 0));
  const sum = joined.reduce((s, m) => s + metricOf(m), 0);
  joined.forEach(m => {
    const share = sum > 0 ? Math.round((total * metricOf(m)) / sum) : Math.round(total / Math.max(1, joined.length));
    m.payout = share;
  });
  // فرق التقريب (لو حصل) يروح لصاحب أعلى مجهود
  const given = joined.reduce((s, m) => s + (m.payout || 0), 0);
  if (joined.length && given !== total) {
    joined.slice().sort((a, b) => metricOf(b) - metricOf(a))[0].payout += (total - given);
  }
  c.pot.settled = true;
}

async function creditAcct(a, amount) {
  a.pts = Math.max(0, Math.round((a.pts || 0) + amount));
  await saveAcct(a);
  return a.pts;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return err(res, 'method', 405);
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const a = body.action;

  try {
    if (!process.env.UPSTASH_REDIS_REST_URL && !process.env.KV_REST_API_URL) {
      return err(res, 'no_db', 500);
    }

    // ---------- تسجيل ----------
    if (a === 'register') {
      const handle = String(body.handle || '').toLowerCase().trim();
      if (!/^[a-z0-9_]{3,20}$/.test(handle)) return err(res, 'bad_handle');
      const taken = await redis.get(`handle:${handle}`);
      if (taken) return err(res, 'taken');
      const acct = {
        id: id(), token: id(24), handle,
        name: String(body.name || handle).slice(0, 24),
        color: body.color || '#8b5cf6',
        pts: START_PTS, days: {}, friends: [], createdAt: Date.now(),
      };
      await saveAcct(acct);
      await redis.set(`handle:${handle}`, acct.id);
      await redis.zadd('handles', { score: 0, member: handle });
      return res.json({ id: acct.id, token: acct.token, handle, name: acct.name, color: acct.color, pts: acct.pts });
    }

    // الحركات الجاية كلها محتاجة حساب مسجّل دخول
    const me = await auth(body);
    if (!me) return err(res, 'auth', 401);

    // ---------- مزامنة يومية ----------
    if (a === 'sync') {
      if (body.name) me.name = String(body.name).slice(0, 24);
      if (body.color) me.color = body.color;
      if (body.days && typeof body.days === 'object') {
        me.days = Object.assign({}, me.days, body.days); // آخر 45 يوم بييجوا من الواجهة
      }
      await saveAcct(me);
      return res.json({ ok: true, pts: me.pts });
    }

    // ---------- بحث عن مستخدم ----------
    if (a === 'search') {
      const q = String(body.q || '').toLowerCase().trim();
      if (q.length < 2) return res.json({ users: [] });
      const matches = await redis.zrange('handles', `[${q}`, `[${q}\xff`, { byLex: true, offset: 0, count: 10 });
      const users = [];
      for (const h of matches) {
        if (h === me.handle) continue;
        const uid = await redis.get(`handle:${h}`);
        if (!uid) continue;
        const u = await getAcct(uid);
        if (u) users.push({ id: u.id, name: u.name, handle: u.handle, color: u.color });
      }
      return res.json({ users });
    }

    // ---------- مكافأة نقاط عند الترقية بالمستوى (من الواجهة) ----------
    if (a === 'credit') {
      if (body.reason !== 'levelup') return err(res, 'bad_reason');
      const amount = Math.max(0, Math.min(2000, Math.round(Number(body.amount) || 0)));
      const pts = await creditAcct(me, amount);
      return res.json({ ok: true, pts });
    }

    // ---------- إنشاء تحدي ----------
    if (a === 'create') {
      const stake = Math.max(0, Math.min(999999, Math.round(Number(body.stake) || 0)));
      const maxStake = MAX_STAKE_BASE + (Number(body.lvl) >= 0 ? Number(body.lvl) : 0) * MAX_STAKE_PER_LVL;
      // (lvl الحقيقي مش بييجي من الواجهة حاليًا، فبنسيب الحد الأقصى يتفحص تاني في الواجهة
      // وهنا بس بنتأكد إن معاه نقاط كفاية)
      if (stake > 0 && (me.pts || 0) < stake) return err(res, 'low_pts');

      const invitees = Array.isArray(body.invitees) ? body.invitees.slice(0, 30) : [];
      const c = {
        id: id(), code: code(), owner: me.id,
        type: body.type, goalSec: Number(body.goalSec) || 0,
        days: Math.max(1, Math.min(365, Number(body.days) || 7)),
        start: body.start || dayK(Date.now()),
        reward: String(body.reward || '').slice(0, 40),
        stake, pot: { total: 0, settled: false },
        members: [],
        createdAt: Date.now(),
      };
      c.members.push({ id: me.id, name: me.name, color: me.color, state: 'joined', paid: false, sec: 0, streak: 0, payout: null });
      for (const uid of invitees) {
        const u = await getAcct(uid);
        if (u) c.members.push({ id: u.id, name: u.name, color: u.color, state: 'invited', paid: false, sec: 0, streak: 0, payout: null });
      }
      if (stake > 0) {
        await creditAcct(me, -stake);
        c.members[0].paid = true;
        c.pot.total += stake;
      }
      await saveCh(c);
      await redis.set(`code:${c.code}`, c.id);
      for (const m of c.members) await redis.sadd(`user:${m.id}:chals`, c.id);
      return res.json({ ok: true, id: c.id, code: c.code, pts: me.pts });
    }

    // ---------- الرد على دعوة ----------
    if (a === 'respond') {
      const c = await getCh(body.cid);
      if (!c) return err(res, 'none');
      const m = c.members.find(x => x.id === me.id);
      if (!m || m.state !== 'invited') return err(res, 'none');
      if (!body.accept) {
        c.members = c.members.filter(x => x.id !== me.id);
        await saveCh(c);
        return res.json({ ok: true });
      }
      if (c.stake > 0) {
        if ((me.pts || 0) < c.stake) return err(res, 'low_pts');
        await creditAcct(me, -c.stake);
        c.pot.total += c.stake;
        m.paid = true;
      }
      m.state = 'joined';
      await saveCh(c);
      return res.json({ ok: true, pts: me.pts });
    }

    // ---------- انضمام بكود ----------
    if (a === 'join') {
      const cid = await redis.get(`code:${String(body.code || '').toUpperCase()}`);
      if (!cid) return err(res, 'none');
      const c = await getCh(cid);
      if (!c) return err(res, 'none');
      if (c.members.length >= 40) return err(res, 'full');
      let m = c.members.find(x => x.id === me.id);
      if (!m) {
        if (c.stake > 0 && (me.pts || 0) < c.stake) return err(res, 'low_pts');
        m = { id: me.id, name: me.name, color: me.color, state: 'joined', paid: false, sec: 0, streak: 0, payout: null };
        c.members.push(m);
      }
      if (m.state !== 'joined') {
        if (c.stake > 0) {
          if ((me.pts || 0) < c.stake) return err(res, 'low_pts');
          await creditAcct(me, -c.stake);
          c.pot.total += c.stake;
          m.paid = true;
        }
        m.state = 'joined';
      }
      await saveCh(c);
      await redis.sadd(`user:${me.id}:chals`, c.id);
      return res.json({ ok: true, id: c.id, pts: me.pts, stake: c.stake });
    }

    // ---------- خروج من تحدي ----------
    if (a === 'leave') {
      const c = await getCh(body.cid);
      if (!c) return err(res, 'none');
      // لو كان دافع رهان وخرج قبل ما التحدي يخلص، الرهان يضيع لصالح الصندوق (تحفيز للالتزام)
      c.members = c.members.filter(x => x.id !== me.id);
      await saveCh(c);
      return res.json({ ok: true, pts: me.pts });
    }

    // ---------- قائمة التحديات بتاعتي ----------
    if (a === 'list') {
      const ids = await redis.smembers(`user:${me.id}:chals`);
      const out = [];
      for (const cid of ids) {
        const c = await getCh(cid);
        if (!c) continue;
        // حدّث مقاييس كل عضو منضم من سجل أيامه
        for (const m of c.members) {
          if (m.state !== 'joined') continue;
          const u = await getAcct(m.id);
          const met = memberMetrics(u ? u.days : {}, c.start, c.days);
          m.sec = met.sec; m.streak = met.streak;
          if (c.type === 'race' && c.goalSec && met.sec >= c.goalSec) m.hit = true;
        }
        settlePot(c);
        await saveCh(c);
        out.push({
          id: c.id, code: c.code, type: c.type, goalSec: c.goalSec, days: c.days, start: c.start,
          reward: c.reward, owner: c.owner, stake: c.stake, pot: c.pot,
          members: c.members.map(m => ({ ...m, me: m.id === me.id })),
        });
      }
      return res.json({ challenges: out });
    }

    return err(res, 'bad_action');
  } catch (e) {
    console.error(e);
    return err(res, 'server_error', 500);
  }
}
