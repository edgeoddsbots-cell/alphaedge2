// api/signal.js — Shared signal storage for all users
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

async function supa(path, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': opts.prefer || 'return=representation',
    },
    signal: AbortSignal.timeout(5000),
    ...opts,
  });
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const nowSec = Math.floor(Date.now() / 1000);
  const windowTs = Math.floor(nowSec / 300) * 300;

  // GET — return current signal OR last N signals
  if (req.method === 'GET') {
    try {
      if (!SUPABASE_URL) {
        res.status(200).json({ windowTs, direction: null, source: 'no_db' });
        return;
      }

      // ?last=N — return last N signals for the trades list
      const lastN = parseInt(req.query.last || '0');
      if (lastN > 0) {
        const nowSec = Math.floor(Date.now() / 1000);
        const closedTs = nowSec - 330;
        const rows = await supa(
          `signals?select=*&window_ts=lt.${closedTs}&order=window_ts.desc&limit=${Math.min(lastN + 10, 30)}`
        );
        res.status(200).json({ signals: rows || [] });
        return;
      }

      // Default — current window signal
      // Try current window first
      const rows = await supa(`signals?window_ts=eq.${windowTs}&select=*&limit=1`);
      let signal = rows?.[0] || null;

      // If no signal for current window, get most recent one (within last 10 min)
      if (!signal) {
        const recent = await supa(`signals?window_ts=gte.${windowTs - 600}&select=*&order=window_ts.desc&limit=1`);
        signal = recent?.[0] || null;
      }

      res.status(200).json({
        windowTs: signal?.window_ts || windowTs,
        direction: signal?.direction || null,
        confidence: signal?.confidence || null,
        reason: signal?.reason || null,
        lockedAt: signal?.locked_at || null,
        isCurrentWindow: signal?.window_ts === windowTs,
      });
    } catch (e) {
      res.status(200).json({ windowTs, direction: null, error: e.message });
    }
    return;
  }

  // POST — save signal (called internally when signal locks)
  if (req.method === 'POST') {
    const { direction, confidence, reason, windowTs: wts } = req.body || {};
    if (!direction || !wts) { res.status(400).json({ error: 'missing fields' }); return; }
    try {
      // Upsert signal for this window
      await supa('signals', {
        method: 'POST',
        prefer: 'resolution=merge-duplicates,return=minimal',
        body: JSON.stringify({
          window_ts: wts,
          direction,
          confidence,
          reason,
          locked_at: new Date().toISOString(),
        }),
      });
      res.status(200).json({ saved: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
};
