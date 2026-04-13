module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const windowTs = Math.floor(nowSec / 300) * 300;
    const elapsed = nowSec - windowTs;

    // Binance has multiple endpoints — try each until one works
    const BINANCE_HOSTS = [
      'https://api1.binance.com',
      'https://api2.binance.com',
      'https://api3.binance.com',
      'https://api4.binance.com',
      'https://api.binance.com',
    ];

    let book = null, trades = null, klines = null;

    for (const host of BINANCE_HOSTS) {
      try {
        const [b, t, k] = await Promise.all([
          fetchJSON(`${host}/api/v3/depth?symbol=BTCUSDT&limit=20`),
          fetchJSON(`${host}/api/v3/trades?symbol=BTCUSDT&limit=500`),
          fetchJSON(`${host}/api/v3/klines?symbol=BTCUSDT&interval=5m&limit=5`),
        ]);
        if (b?.bids && t?.length) {
          book = b; trades = t; klines = k;
          break;
        }
      } catch (e) {
        continue;
      }
    }

    if (!book || !trades) {
      // Last resort: use public Binance websocket snapshot via REST
      try {
        const snap = await fetchJSON('https://data-api.binance.vision/api/v3/depth?symbol=BTCUSDT&limit=20');
        const tr = await fetchJSON('https://data-api.binance.vision/api/v3/trades?symbol=BTCUSDT&limit=500');
        if (snap?.bids && tr?.length) { book = snap; trades = tr; }
      } catch (e) {}
    }

    if (!book || !trades) {
      return res.status(200).json({
        ok: false,
        error: 'All Binance endpoints failed',
        windowTs,
        elapsed,
        hint: 'Binance may be blocking Vercel IPs — signal will use local browser computation'
      });
    }

    // ── OBI calculation ──
    const W = i => 1 / (i + 1);
    const bids = book.bids.slice(0, 5);
    const asks = book.asks.slice(0, 5);
    const bidVol = bids.reduce((s, [, q], i) => s + W(i) * parseFloat(q), 0);
    const askVol = asks.reduce((s, [, q], i) => s + W(i) * parseFloat(q), 0);
    const obi = bidVol + askVol > 0 ? bidVol / (bidVol + askVol) : 0.5;

    // ── CVD (last 60s) ──
    const cutoff = Date.now() - 60000;
    const recent = trades.filter(t => t.time > cutoff);
    let buyVol = 0, sellVol = 0;
    recent.forEach(t => {
      const q = parseFloat(t.qty);
      if (t.isBuyerMaker) sellVol += q;
      else buyVol += q;
    });
    const cvd = buyVol + sellVol > 0 ? buyVol / (buyVol + sellVol) : 0.5;

    // Current BTC price
    const midBid = parseFloat(book.bids[0][0]);
    const midAsk = parseFloat(book.asks[0][0]);
    const btcPrice = (midBid + midAsk) / 2;

    // ── Candle structure ──
    let struct = 'sideways';
    if (klines?.length >= 3) {
      const [, , h1, l1] = klines[klines.length - 2].map(parseFloat);
      const [, , h2, l2] = klines[klines.length - 3].map(parseFloat);
      if (h1 > h2 && l1 > l2) struct = 'bullish';
      else if (h1 < h2 && l1 < l2) struct = 'bearish';
    }

    // ── Signal logic ──
    let direction = null, confidence = 0, reason = '';
    const score = obi + 0.12 * (obi - 0.5) + 0.18 * (cvd - 0.5)
      + (struct === 'bullish' ? 0.03 : struct === 'bearish' ? -0.03 : 0);

    const inWindow = elapsed >= 15 && elapsed <= 270; // 270s grace (cron fires at 240+)

    if (!inWindow && elapsed >= 270) {
      // Window closed - return last saved signal from DB if available
      reason = `Window closed · ${elapsed}s elapsed`;
    } else if (!inWindow && elapsed < 15) {
      reason = `Stabilizing · ${15 - elapsed}s to entry`;
    } else if (obi > 0.68 && cvd < 0.42) {
      direction = 'DOWN'; confidence = Math.min(90, (obi - 0.5 + 0.5 - cvd) * 120);
      reason = `Fake bid wall · OBI ${obi.toFixed(3)} CVD ${Math.round(cvd * 100)}%`;
    } else if (obi < 0.32 && cvd > 0.58) {
      direction = 'UP'; confidence = Math.min(90, (0.5 - obi + cvd - 0.5) * 120);
      reason = `Fake ask wall · OBI ${obi.toFixed(3)} CVD ${Math.round(cvd * 100)}%`;
    } else if (score > 0.60 && cvd > 0.55) {
      direction = 'UP'; confidence = Math.min(99, ((score - 0.5) / 0.5) * 100 * (cvd > 0.65 ? 1.2 : 1));
      reason = `BID pressure · OBI ${obi.toFixed(3)} CVD ${Math.round(cvd * 100)}% · ${struct}`;
    } else if (score < 0.40 && cvd < 0.45) {
      direction = 'DOWN'; confidence = Math.min(99, ((0.5 - score) / 0.5) * 100 * (cvd < 0.35 ? 1.2 : 1));
      reason = `ASK pressure · OBI ${obi.toFixed(3)} CVD ${Math.round(cvd * 100)}% · ${struct}`;
    } else {
      reason = `Weak signal · OBI ${obi.toFixed(3)} CVD ${Math.round(cvd * 100)}%`;
    }

    // ── Save to Supabase ──
    let saved = false;
    if (direction && SUPABASE_URL && SUPABASE_KEY) {
      try {
        const existing = await supaGet(SUPABASE_URL, SUPABASE_KEY,
          `signals?window_ts=eq.${windowTs}&select=id&limit=1`);
        if (!existing?.length) {
          await supaPost(SUPABASE_URL, SUPABASE_KEY, 'signals', {
            window_ts: windowTs,
            direction,
            confidence: Math.round(confidence),
            reason,
            locked_at: new Date().toISOString(),
          });
          saved = true;
        }
      } catch (e) {}
    }

    return res.status(200).json({
      ok: true,
      windowTs,
      elapsed,
      direction,
      confidence: Math.round(confidence),
      reason,
      obi: +obi.toFixed(4),
      cvdRatio: +cvd.toFixed(4),
      btcPrice: +btcPrice.toFixed(2),
      struct,
      saved,
      tradesAnalyzed: recent.length,
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

async function fetchJSON(url) {
  const r = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Accept': 'application/json',
    },
    signal: AbortSignal.timeout(4000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function supaGet(url, key, path) {
  const r = await fetch(`${url}/rest/v1/${path}`, {
    headers: { 'apikey': key, 'Authorization': `Bearer ${key}` },
    signal: AbortSignal.timeout(4000),
  });
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

async function supaPost(url, key, table, body) {
  await fetch(`${url}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'apikey': key,
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(4000),
  });
}
