// CommonJS format for Vercel
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store, no-cache, max-age=0');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const nowSec = Math.floor(Date.now() / 1000);
  const windowTs = Math.floor(nowSec / 300) * 300;

  try {
    let market = null;
    for (const ts of [windowTs, windowTs - 300, windowTs + 300]) {
      market = await fetchBySlug(`btc-updown-5m-${ts}`);
      if (market) break;
    }
    if (!market) market = await fetchActiveBTC();
    if (!market) {
      res.status(404).json({ error: 'not_found', windowTs });
      return;
    }

    const parsed = parsePrices(market);
    
    // Try CLOB for live prices
    let upPc = parsed.upPc;
    let dnPc = parsed.dnPc;
    let source = 'gamma';

    if (market.clobTokenIds && market.clobTokenIds.length >= 2) {
      try {
        const [upMid, dnMid] = await Promise.all([
          fetchMidpoint(market.clobTokenIds[0]),
          fetchMidpoint(market.clobTokenIds[1]),
        ]);
        if (upMid && upMid > 0 && upMid < 1) {
          upPc = Math.round(upMid * 100);
          dnPc = Math.round((dnMid || 1 - upMid) * 100);
          source = 'clob';
        }
      } catch (e) {}
    }

    res.status(200).json({
      ok: true,
      windowTs,
      slug: market.slug,
      question: market.question,
      upPc,
      dnPc,
      upP: upPc / 100,
      dnP: dnPc / 100,
      source,
      parsed,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

async function fetchMidpoint(tokenId) {
  const r = await fetch(`https://clob.polymarket.com/midpoint?token_id=${tokenId}`, {
    headers: { 'User-Agent': 'AlphaEdge/1.0' },
    signal: AbortSignal.timeout(4000),
  });
  if (!r.ok) return null;
  const d = await r.json();
  const v = parseFloat(d.mid || d.price || '0');
  return v > 0 && v < 1 ? v : null;
}

function toArray(v) {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string') {
    const s = v.trim();
    if (s.startsWith('[')) { try { return JSON.parse(s).map(String); } catch {} }
    return s.split(',').map(x => x.trim());
  }
  return [];
}
function toNum(s) { const c = String(s).replace(/[^0-9.]/g, ''); return c ? parseFloat(c) : NaN; }
function toStr(s) { return String(s).replace(/[^a-zA-Z]/g, '').toLowerCase(); }

function parsePrices(market) {
  const outcomes = toArray(market.outcomes).map(toStr);
  const prices = toArray(market.outcomePrices).map(toNum);
  let upIdx = outcomes.findIndex(o => o === 'up');
  let dnIdx = outcomes.findIndex(o => o === 'down');
  if (upIdx < 0) upIdx = 0;
  if (dnIdx < 0) dnIdx = 1;
  const upP = prices[upIdx], dnP = prices[dnIdx];
  const ok = v => !isNaN(v) && v > 0 && v < 1;
  return {
    upP: ok(upP) ? upP : null,
    dnP: ok(dnP) ? dnP : null,
    upPc: ok(upP) ? Math.round(upP * 100) : null,
    dnPc: ok(dnP) ? Math.round(dnP * 100) : null,
  };
}

async function fetchBySlug(slug) {
  try {
    const r = await fetch(`https://gamma-api.polymarket.com/markets?slug=${slug}`, {
      headers: { 'User-Agent': 'AlphaEdge/1.0', 'Cache-Control': 'no-cache' },
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) return null;
    const data = await r.json();
    const arr = Array.isArray(data) ? data : [data];
    return arr.find(m => m?.slug) || null;
  } catch { return null; }
}

async function fetchActiveBTC() {
  try {
    const r = await fetch(
      'https://gamma-api.polymarket.com/markets?tag=crypto&active=true&closed=false&limit=200',
      { headers: { 'User-Agent': 'AlphaEdge/1.0', 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(8000) }
    );
    if (!r.ok) return null;
    const data = await r.json();
    const mkts = Array.isArray(data) ? data : (data.data || []);
    return mkts.find(m => {
      const s = (m.slug || '').toLowerCase();
      const q = (m.question || '').toLowerCase();
      return s.includes('btc-updown-5m') || (q.includes('bitcoin') && q.includes('5 min'));
    }) || null;
  } catch { return null; }
}
