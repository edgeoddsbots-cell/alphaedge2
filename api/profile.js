module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const slug = req.query.slug || '';
  if (!slug) { res.status(400).json({ error: 'no slug' }); return; }

  const isAddr = slug.startsWith('0x');
  const endpoints = isAddr ? [
    `https://gamma-api.polymarket.com/profile?address=${slug}`,
    `https://gamma-api.polymarket.com/profile?slug=${slug}`,
  ] : [
    `https://gamma-api.polymarket.com/profile?slug=${encodeURIComponent(slug)}`,
    `https://gamma-api.polymarket.com/profile/${encodeURIComponent(slug)}`,
    `https://gamma-api.polymarket.com/users?username=${encodeURIComponent(slug)}`,
  ];

  for (const ep of endpoints) {
    try {
      const r = await fetch(ep, {
        headers: { 'User-Agent': 'AlphaEdge/1.0', 'Accept': 'application/json' },
        signal: AbortSignal.timeout(6000),
      });
      if (!r.ok) continue;
      const d = await r.json();
      if (!d || d.error || (!d.name && !d.displayName && !d.username && !d.pseudonym && !d.volume)) continue;
      res.status(200).json({
        displayName: d.name || d.displayName || d.username || d.pseudonym || slug,
        volume: d.volume || d.volumeTraded || null,
        pnl: d.pnl || d.profit || null,
        winRate: d.winRate || null,
        tradesCount: d.tradesCount || d.numTrades || null,
        rank: d.rank || d.leaderboardRank || null,
      });
      return;
    } catch {}
  }

  // Return minimal — profile not public
  res.status(200).json({
    displayName: slug,
    volume: null, pnl: null, winRate: null, tradesCount: null, rank: null,
    _note: 'Profile not public or not found',
  });
};
