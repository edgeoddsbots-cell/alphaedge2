// api/codes.js — License code management via Supabase
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ADMIN_CODE = process.env.ADMIN_CODE || 'AE-ADMIN-0000';

async function supa(path, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': opts.prefer || 'return=representation',
    },
    signal: AbortSignal.timeout(8000),
    ...opts,
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`Supabase error ${r.status}: ${err}`);
  }
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { action, code, deviceId, adminCode, plan, count } = req.body || req.query || {};

  // ── VALIDATE — check if code is valid and lock to device ──
  if (req.method === 'POST' && action === 'validate') {
    if (!code) { res.status(400).json({ error: 'no code' }); return; }
    const upper = code.toUpperCase();
    
    // Admin code bypass
    if (upper === ADMIN_CODE) {
      res.status(200).json({ valid: true, role: 'admin' });
      return;
    }
    
    try {
      const rows = await supa(`codes?code=eq.${encodeURIComponent(upper)}&select=*`);
      if (!rows || rows.length === 0) {
        res.status(200).json({ valid: false, error: 'Invalid license key' });
        return;
      }
      const row = rows[0];
      
      // Check device lock
      if (row.device_id && row.device_id !== deviceId) {
        res.status(200).json({ valid: false, error: 'Key is locked to another device' });
        return;
      }
      
      // Lock to device on first use
      if (!row.device_id && deviceId) {
        await supa(`codes?id=eq.${row.id}`, {
          method: 'PATCH',
          prefer: 'return=minimal',
          body: JSON.stringify({ device_id: deviceId, used_at: new Date().toISOString() }),
        });
      }
      
      res.status(200).json({ valid: true, role: 'user', plan: row.plan });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
    return;
  }

  // ── GENERATE — admin only ──
  if (req.method === 'POST' && action === 'generate') {
    if (!adminCode || adminCode.toUpperCase() !== ADMIN_CODE) {
      res.status(403).json({ error: 'Unauthorized' }); return;
    }
    
    const n = Math.min(parseInt(count) || 1, 50);
    const planName = plan || 'lifetime';
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const seg = () => Array.from({length:4}, () => chars[Math.floor(Math.random()*chars.length)]).join('');
    
    const newCodes = Array.from({length: n}, () => ({
      code: `AE-${seg()}-${seg()}`,
      plan: planName,
      price: 149,
    }));
    
    try {
      const inserted = await supa('codes', {
        method: 'POST',
        body: JSON.stringify(newCodes),
      });
      res.status(200).json({ generated: inserted });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
    return;
  }

  // ── LIST — admin only ──
  if (req.method === 'GET' && action === 'list') {
    if (!adminCode || adminCode.toUpperCase() !== ADMIN_CODE) {
      res.status(403).json({ error: 'Unauthorized' }); return;
    }
    try {
      const rows = await supa('codes?select=*&order=created_at.desc&limit=200');
      res.status(200).json({ codes: rows || [] });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
    return;
  }

  // ── DELETE — admin only ──
  if (req.method === 'DELETE') {
    if (!adminCode || adminCode.toUpperCase() !== ADMIN_CODE) {
      res.status(403).json({ error: 'Unauthorized' }); return;
    }
    const id = req.query.id;
    if (!id) { res.status(400).json({ error: 'no id' }); return; }
    try {
      await supa(`codes?id=eq.${id}`, { method: 'DELETE', prefer: 'return=minimal' });
      res.status(200).json({ deleted: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
    return;
  }

  res.status(400).json({ error: 'Unknown action' });
};
