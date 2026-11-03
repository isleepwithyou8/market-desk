// Vercel serverless function: a small proxy to Yahoo Finance so the dashboard can load live data.
// Routes (all GET):
//   /api/yahoo?type=ping
//   /api/yahoo?type=chart&symbol=NQ=F&range=1y&interval=1d
//   /api/yahoo?type=summary&symbol=NVDA
//   /api/yahoo?type=earnings&region=us&from=2026-11-01&to=2026-12-01   (region: us | in)
//   /api/yahoo?type=news&q=stock%20market
// No API key needed. Yahoo's endpoints are unofficial and can change; responses are cached briefly.

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const Q = 'https://query1.finance.yahoo.com';
let session = null; // { cookie, crumb, at }

async function getSession() {
  if (session && Date.now() - session.at < 30 * 60 * 1000) return session;
  const r = await fetch('https://fc.yahoo.com', { headers: { 'User-Agent': UA }, redirect: 'manual' });
  const raw = r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie') || ''];
  const cookie = raw.map(c => c.split(';')[0]).filter(Boolean).join('; ');
  const c = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', { headers: { 'User-Agent': UA, Cookie: cookie } });
  const crumb = (await c.text()).trim();
  if (!crumb || crumb.includes('<')) throw new Error('crumb failed');
  session = { cookie, crumb, at: Date.now() };
  return session;
}
const rd = x => (x == null ? null : +(+x).toPrecision(7));
const g = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);

async function chart(symbol, range, interval) {
  const r = await fetch(`${Q}/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`, { headers: { 'User-Agent': UA } });
  const j = await r.json(); const res = j.chart.result[0]; const q = res.indicators.quote[0];
  const bars = [];
  (res.timestamp || []).forEach((t, i) => { if (q.open[i] == null || q.close[i] == null) return; bars.push([t, rd(q.open[i]), rd(q.high[i]), rd(q.low[i]), rd(q.close[i]), q.volume[i] || 0]); });
  return { name: res.meta.shortName || res.meta.longName || symbol, cur: res.meta.currency, ex: res.meta.exchangeName, price: rd(res.meta.regularMarketPrice), prev: rd(res.meta.chartPreviousClose), bars };
}

async function summary(symbol) {
  const s = await getSession();
  const mods = 'calendarEvents,summaryDetail,financialData,defaultKeyStatistics,recommendationTrend,earnings,earningsHistory,assetProfile,price';
  const r = await fetch(`${Q}/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${mods}&crumb=${encodeURIComponent(s.crumb)}`, { headers: { 'User-Agent': UA, Cookie: s.cookie } });
  const j = await r.json(); const q = j.quoteSummary.result[0]; const v = p => g(q, p + '.raw') ?? null;
  return {
    name: g(q, 'price.shortName'), sector: g(q, 'assetProfile.sector'), industry: g(q, 'assetProfile.industry'),
    ed: v('calendarEvents.earnings.earningsDate.0'), edEst: g(q, 'calendarEvents.earnings.isEarningsDateEstimate'),
    epsAvg: v('calendarEvents.earnings.earningsAverage'), epsLow: v('calendarEvents.earnings.earningsLow'), epsHigh: v('calendarEvents.earnings.earningsHigh'), revAvg: v('calendarEvents.earnings.revenueAverage'),
    mcap: v('summaryDetail.marketCap'), pe: v('summaryDetail.trailingPE'), fpe: v('summaryDetail.forwardPE'), beta: v('summaryDetail.beta'), divY: v('summaryDetail.dividendYield'),
    hi52: v('summaryDetail.fiftyTwoWeekHigh'), lo52: v('summaryDetail.fiftyTwoWeekLow'),
    roe: v('financialData.returnOnEquity'), de: v('financialData.debtToEquity'), eg: v('financialData.earningsGrowth'), rg: v('financialData.revenueGrowth'), pm: v('financialData.profitMargins'), fcf: v('financialData.freeCashflow'),
    rec: g(q, 'financialData.recommendationKey'), tgt: v('financialData.targetMeanPrice'), nAn: v('financialData.numberOfAnalystOpinions'),
    short: v('defaultKeyStatistics.shortPercentOfFloat'), rt: g(q, 'recommendationTrend.trend.0'),
    qEps: (g(q, 'earnings.earningsChart.quarterly') || []).map(x => [x.date, x.actual && x.actual.raw, x.estimate && x.estimate.raw]),
    yFin: (g(q, 'earnings.financialsChart.yearly') || []).map(x => [x.date, x.revenue && x.revenue.raw, x.earnings && x.earnings.raw]),
    hist: (g(q, 'earningsHistory.history') || []).map(x => [x.quarter && x.quarter.fmt, x.epsActual && x.epsActual.raw, x.epsEstimate && x.epsEstimate.raw, x.surprisePercent && x.surprisePercent.raw])
  };
}

async function earnings(region, from, to) {
  const s = await getSession();
  const body = { sortType: 'DESC', entityIdType: 'sp_earnings', sortField: 'intradaymarketcap', includeFields: ['ticker', 'companyshortname', 'startdatetime', 'startdatetimetype', 'epsestimate', 'epsactual', 'epssurprisepct', 'intradaymarketcap'], size: 250, offset: 0,
    query: { operator: 'and', operands: [{ operator: 'gte', operands: ['startdatetime', from] }, { operator: 'lt', operands: ['startdatetime', to] }, { operator: 'eq', operands: ['region', region] }] } };
  const r = await fetch(`${Q}/v1/finance/visualization?crumb=${encodeURIComponent(s.crumb)}&lang=en-US&region=US`, { method: 'POST', headers: { 'User-Agent': UA, Cookie: s.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json(); const d = j.finance.result[0].documents[0]; const cols = d.columns.map(c => c.id);
  return d.rows.map(row => Object.fromEntries(cols.map((c, i) => [c, row[i]])));
}

async function news(q) {
  const r = await fetch(`${Q}/v1/finance/search?q=${encodeURIComponent(q)}&newsCount=12&quotesCount=0`, { headers: { 'User-Agent': UA } });
  const j = await r.json();
  return (j.news || []).map(x => ({ t: x.title, p: x.publisher, u: x.link, d: x.providerPublishTime, tk: x.relatedTickers }));
}

module.exports = async (req, res) => {
  const p = req.query || {};
  try {
    let data, maxAge = 60;
    if (p.type === 'ping') data = { ok: true };
    else if (p.type === 'chart') { data = await chart(p.symbol, p.range || '1y', p.interval || '1d'); maxAge = p.interval === '1d' ? 300 : 60; }
    else if (p.type === 'summary') { data = await summary(p.symbol); maxAge = 3600; }
    else if (p.type === 'earnings') { data = await earnings(p.region === 'in' ? 'in' : 'us', p.from, p.to); maxAge = 1800; }
    else if (p.type === 'news') { data = await news(p.q || 'stock market'); maxAge = 300; }
    else { res.status(400).json({ error: 'unknown type' }); return; }
    res.setHeader('Cache-Control', `s-maxage=${maxAge}, stale-while-revalidate=${maxAge * 4}`);
    res.status(200).json(data);
  } catch (e) {
    session = null;
    res.status(502).json({ error: String(e && e.message || e) });
  }
};
