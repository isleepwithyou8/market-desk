/* Market Desk scanner engine
   Rules come from the Stock Wealth lessons (teacher's method):
   - 9 candles: buy = Hammer, Bullish Engulfing, Bullish Inside Bar, Morning Star
                sell = Shooting Star, Bearish Engulfing, Bearish Inside Bar, Evening Star
                Doji = side decided by location (support -> buy, resistance -> sell)
   - Buy candles only count at support / bottom, sell candles only at resistance / top
   - Entry on break of the signal candle, stop beyond the candle (or level), target 1:2
   - Supertrend (ATR 10, factor 2), RSI 14 (20/80, 40/60, 50), Stochastic (14, 5, 3) 20/80
   - Support/resistance: 3 touches; market structure HH/HL vs LH/LL; no trades in sideways
   - Chart patterns: double/triple top & bottom, head & shoulders, triangles, flags, cup & handle
   Every setting lives in CONFIG so it can be tuned without touching the logic. */
(function (root) {
  const CONFIG = {
    supertrend: { atrLen: 10, factor: 2 },
    rsi: { len: 14, low: 20, high: 80, rangeLow: 40, rangeHigh: 60, mid: 50, tol: 3 },
    stoch: { len: 14, kSmooth: 5, dSmooth: 3, low: 20, high: 80, tol: 5 },
    pivot: { left: 3, right: 3 },
    level: { tolATR: 0.5, nearATR: 0.6, minTouches: 2 },
    rr: 2,
    lookback: { candle: 3, cross: 3 },
    scoring: { A: 75, B: 55, C: 40 }
  };

  // ---------- basic math ----------
  const sma = (a, n) => a.map((_, i) => (i < n - 1 ? null : a.slice(i - n + 1, i + 1).reduce((s, x) => s + x, 0) / n));
  function ema(a, n) { const k = 2 / (n + 1); const out = []; let p = null; a.forEach((x, i) => { if (x == null) { out.push(null); return; } p = p == null ? x : x * k + p * (1 - k); out.push(p); }); return out; }
  function atr(b, n = 14) {
    const tr = b.map((x, i) => i === 0 ? x.h - x.l : Math.max(x.h - x.l, Math.abs(x.h - b[i - 1].c), Math.abs(x.l - b[i - 1].c)));
    const out = []; let p = null;
    tr.forEach((t, i) => { if (i < n - 1) { out.push(null); return; } if (p == null) { p = tr.slice(0, n).reduce((s, x) => s + x, 0) / n; } else p = (p * (n - 1) + t) / n; out.push(p); });
    return out;
  }
  function rsi(b, n = 14) {
    const out = [null]; let ag = 0, al = 0;
    for (let i = 1; i < b.length; i++) {
      const d = b[i].c - b[i - 1].c, g = Math.max(d, 0), l = Math.max(-d, 0);
      if (i <= n) { ag += g / n; al += l / n; out.push(i === n ? (al === 0 ? 100 : 100 - 100 / (1 + ag / al)) : null); }
      else { ag = (ag * (n - 1) + g) / n; al = (al * (n - 1) + l) / n; out.push(al === 0 ? 100 : 100 - 100 / (1 + ag / al)); }
    }
    return out;
  }
  function stoch(b, len = 14, kS = 5, dS = 3) {
    const raw = b.map((x, i) => { if (i < len - 1) return null; const w = b.slice(i - len + 1, i + 1); const hh = Math.max(...w.map(y => y.h)), ll = Math.min(...w.map(y => y.l)); return hh === ll ? 50 : 100 * (x.c - ll) / (hh - ll); });
    const smooth = (a, n) => a.map((_, i) => { const w = a.slice(Math.max(0, i - n + 1), i + 1); return w.length < n || w.some(v => v == null) ? null : w.reduce((s, v) => s + v, 0) / n; });
    const k = smooth(raw, kS); const d = smooth(k, dS); return { k, d };
  }
  function supertrend(b, len = 10, factor = 2) {
    const a = atr(b, len); const line = [], dir = []; let fu = null, fl = null, d = 1;
    b.forEach((x, i) => {
      if (a[i] == null) { line.push(null); dir.push(null); return; }
      const hl2 = (x.h + x.l) / 2, bu = hl2 + factor * a[i], bl = hl2 - factor * a[i];
      const pc = i > 0 ? b[i - 1].c : x.c;
      fu = fu == null || bu < fu || pc > fu ? bu : fu;
      fl = fl == null || bl > fl || pc < fl ? bl : fl;
      if (d === 1 && x.c < fl) d = -1; else if (d === -1 && x.c > fu) d = 1;
      line.push(d === 1 ? fl : fu); dir.push(d);
    });
    return { line, dir };
  }

  // ---------- candles (the 9 candles) ----------
  const CANDLES = {
    hammer: { name: 'Hammer', side: 'buy', bars: 1 },
    bullEngulf: { name: 'Bullish Engulfing', side: 'buy', bars: 2 },
    bullInside: { name: 'Bullish Inside Bar', side: 'buy', bars: 2 },
    morningStar: { name: 'Morning Star', side: 'buy', bars: 3 },
    shootingStar: { name: 'Shooting Star', side: 'sell', bars: 1 },
    bearEngulf: { name: 'Bearish Engulfing', side: 'sell', bars: 2 },
    bearInside: { name: 'Bearish Inside Bar', side: 'sell', bars: 2 },
    eveningStar: { name: 'Evening Star', side: 'sell', bars: 3 },
    doji: { name: 'Doji', side: 'both', bars: 1 }
  };
  function shape(x) { const body = Math.abs(x.c - x.o), range = Math.max(x.h - x.l, 1e-9); return { body, range, up: x.h - Math.max(x.o, x.c), lo: Math.min(x.o, x.c) - x.l, green: x.c > x.o, red: x.c < x.o }; }
  // returns list of candle keys that complete at bar i
  function candlesAt(b, i, avgBody) {
    const out = []; const x = b[i]; if (!x) return out; const s = shape(x);
    if (s.body <= 0.1 * s.range && s.range > 0.3 * avgBody) out.push('doji');
    if (s.body > 0.08 * s.range && s.lo >= 2 * s.body && s.up <= Math.max(0.6 * s.body, 0.12 * s.range)) out.push('hammer');
    if (s.body > 0.08 * s.range && s.up >= 2 * s.body && s.lo <= Math.max(0.6 * s.body, 0.12 * s.range)) out.push('shootingStar');
    if (i >= 1) {
      const p = b[i - 1], ps = shape(p);
      if (ps.red && s.green && x.c >= p.o && x.o <= p.c && s.body > ps.body) out.push('bullEngulf');
      if (ps.green && s.red && x.c <= p.c && x.o >= p.c - 1e-9 && x.c <= p.o && s.body > ps.body) out.push('bearEngulf');
      const inside = x.h <= p.h && x.l >= p.l && s.body < 0.6 * ps.body && ps.body > 0.6 * avgBody;
      if (inside && ps.red && s.green) out.push('bullInside');
      if (inside && ps.green && s.red) out.push('bearInside');
    }
    if (i >= 2) {
      const a = b[i - 2], m = b[i - 1], as = shape(a), ms = shape(m);
      if (as.red && as.body > 0.6 * avgBody && ms.body <= 0.4 * as.body && s.green && x.c >= (a.o + a.c) / 2 && Math.min(m.o, m.c) <= a.c + 0.2 * as.body) out.push('morningStar');
      if (as.green && as.body > 0.6 * avgBody && ms.body <= 0.4 * as.body && s.red && x.c <= (a.o + a.c) / 2 && Math.max(m.o, m.c) >= a.c - 0.2 * as.body) out.push('eveningStar');
    }
    return out;
  }
  function patternRange(b, i, key) { const n = CANDLES[key].bars; const w = b.slice(i - n + 1, i + 1); return { hi: Math.max(...w.map(y => y.h)), lo: Math.min(...w.map(y => y.l)) }; }

  // ---------- swings, levels, structure ----------
  function pivots(b, L = 3, R = 3) {
    const hs = [], ls = [];
    for (let i = L; i < b.length - R; i++) {
      let isH = true, isL = true;
      for (let j = i - L; j <= i + R; j++) { if (j === i) continue; if (b[j].h > b[i].h) isH = false; if (b[j].l < b[i].l) isL = false; }
      if (isH) hs.push({ i, p: b[i].h, t: 'H' }); if (isL) ls.push({ i, p: b[i].l, t: 'L' });
    }
    return { hs, ls };
  }
  function levels(b, piv, a, upto) {
    const tol = CONFIG.level.tolATR * a;
    const pts = [...piv.hs, ...piv.ls].filter(p => p.i <= upto).sort((x, y) => x.p - y.p);
    const clusters = [];
    pts.forEach(p => { const c = clusters.find(c => Math.abs(c.price - p.p) <= tol); if (c) { c.pts.push(p); c.price = c.pts.reduce((s, q) => s + q.p, 0) / c.pts.length; } else clusters.push({ price: p.p, pts: [p] }); });
    return clusters.filter(c => c.pts.length >= CONFIG.level.minTouches).map(c => ({ price: c.price, touches: c.pts.length, last: Math.max(...c.pts.map(q => q.i)), first: Math.min(...c.pts.map(q => q.i)) }));
  }
  function structure(piv, n) {
    const H = piv.hs.slice(-2), L = piv.ls.slice(-2);
    if (H.length < 2 || L.length < 2) return { trend: 'sideways', label: 'Not enough swings' };
    const hh = H[1].p > H[0].p, hl = L[1].p > L[0].p;
    if (hh && hl) return { trend: 'up', label: 'Higher highs & higher lows' };
    if (!hh && !hl) return { trend: 'down', label: 'Lower highs & lower lows' };
    return { trend: 'sideways', label: hh ? 'Higher high but lower low' : 'Lower high but higher low' };
  }

  // ---------- chart patterns ----------
  function lineAt(p1, p2, i) { return p1.p + (p2.p - p1.p) * (i - p1.i) / (p2.i - p1.i); }
  function status(b, side, neck, a) {
    // neck: function(i) -> price of neckline at bar i
    const n = b.length - 1; let brk = -1;
    for (let i = Math.max(1, n - 15); i <= n; i++) { const lv = neck(i); if (side === 'buy' ? b[i].c > lv && b[i - 1].c <= neck(i - 1) : b[i].c < lv && b[i - 1].c >= neck(i - 1)) brk = i; }
    const lvn = neck(n);
    if (brk < 0) { const dist = Math.abs(b[n].c - lvn) / a; const before = side === 'buy' ? b[n].c <= lvn : b[n].c >= lvn; if (!before) return null; return { state: dist <= 1 ? 'near-break' : 'forming', brk }; }
    const after = b.slice(brk + 1); const touched = after.some((x, k) => side === 'buy' ? x.l <= neck(brk + 1 + k) + 0.4 * a : x.h >= neck(brk + 1 + k) - 0.4 * a);
    const failed = side === 'buy' ? b[n].c < lvn - 0.5 * a : b[n].c > lvn + 0.5 * a;
    if (failed) return null;
    return { state: touched ? 'retest' : 'breakout', brk };
  }
  function findPatterns(b, piv, a) {
    const n = b.length - 1, out = [], tol = 0.8 * a, recent = n - 45;
    const H = piv.hs, L = piv.ls;
    const between = (arr, i1, i2) => arr.filter(p => p.i > i1 && p.i < i2);
    // double / triple bottom
    for (const [k, side, arr, other] of [['bottom', 'buy', L, H], ['top', 'sell', H, L]]) {
      const last3 = arr.slice(-3);
      if (last3.length >= 3 && last3[0].i >= n - 120 && last3[2].i >= recent) {
        const ps = last3.map(p => p.p); if (Math.max(...ps) - Math.min(...ps) <= tol) {
          const mids = between(other, last3[0].i, last3[2].i); if (mids.length) {
            const neck = side === 'buy' ? Math.max(...mids.map(p => p.p)) : Math.min(...mids.map(p => p.p));
            const base = ps.reduce((s, x) => s + x, 0) / 3;
            if (Math.abs(neck - base) >= 2 * a) { const st = status(b, side, () => neck, a); if (st) { out.push({ key: 'triple-' + k, name: 'Triple ' + (k === 'bottom' ? 'Bottom' : 'Top'), side, ...st, neck, target: neck + (neck - base), pts: last3, lines: [{ from: last3[0].i, to: n, p1: neck, p2: neck, kind: 'neck' }] }); continue; } }
          }
        }
      }
      const last2 = arr.slice(-2);
      if (last2.length === 2 && last2[1].i >= recent && last2[1].i - last2[0].i >= 5 && Math.abs(last2[0].p - last2[1].p) <= tol) {
        const mids = between(other, last2[0].i, last2[1].i); if (mids.length) {
          const neck = side === 'buy' ? Math.max(...mids.map(p => p.p)) : Math.min(...mids.map(p => p.p));
          const base = (last2[0].p + last2[1].p) / 2;
          if (Math.abs(neck - base) >= 2 * a) { const st = status(b, side, () => neck, a); if (st) out.push({ key: 'double-' + k, name: 'Double ' + (k === 'bottom' ? 'Bottom' : 'Top'), side, ...st, neck, target: neck + (neck - base), pts: last2, lines: [{ from: last2[0].i, to: n, p1: neck, p2: neck, kind: 'neck' }] }); }
        }
      }
    }
    // head & shoulders (sell) and inverse (buy)
    for (const [side, arr, other, sign] of [['sell', H, L, 1], ['buy', L, H, -1]]) {
      const t = arr.slice(-3); if (t.length < 3 || t[2].i < recent || t[0].i < n - 150) continue;
      const [s1, hd, s2] = t;
      if (sign * (hd.p - s1.p) >= 0.5 * a && sign * (hd.p - s2.p) >= 0.5 * a && Math.abs(s1.p - s2.p) <= 1.2 * a) {
        const n1 = between(other, s1.i, hd.i), n2 = between(other, hd.i, s2.i); if (!n1.length || !n2.length) continue;
        const pick = (xs) => sign > 0 ? xs.reduce((m, p) => p.p < m.p ? p : m) : xs.reduce((m, p) => p.p > m.p ? p : m);
        const a1 = pick(n1), a2 = pick(n2); const neck = (i) => lineAt(a1, a2, i);
        const st = status(b, side, neck, a);
        if (st) out.push({ key: side === 'sell' ? 'hs' : 'ihs', name: side === 'sell' ? 'Head & Shoulders' : 'Inverse Head & Shoulders', side, ...st, neck: neck(n), target: neck(n) - sign * Math.abs(hd.p - neck(hd.i)), pts: t, lines: [{ from: a1.i, to: n, p1: a1.p, p2: neck(n), kind: 'neck' }] });
      }
    }
    // triangles (last 3 highs + 3 lows inside 70 bars)
    const h3 = H.slice(-3), l3 = L.slice(-3);
    if (h3.length === 3 && l3.length === 3 && Math.min(h3[0].i, l3[0].i) >= n - 90 && Math.max(h3[2].i, l3[2].i) >= n - 25) {
      const flatH = Math.max(...h3.map(p => p.p)) - Math.min(...h3.map(p => p.p)) <= tol;
      const flatL = Math.max(...l3.map(p => p.p)) - Math.min(...l3.map(p => p.p)) <= tol;
      const risingL = l3[1].p > l3[0].p + 0.25 * a && l3[2].p > l3[1].p + 0.25 * a;
      const fallingH = h3[1].p < h3[0].p - 0.25 * a && h3[2].p < h3[1].p - 0.25 * a;
      const upper = flatH ? () => h3.reduce((s, p) => s + p.p, 0) / 3 : (i) => lineAt(h3[0], h3[2], i);
      const lower = flatL ? () => l3.reduce((s, p) => s + p.p, 0) / 3 : (i) => lineAt(l3[0], l3[2], i);
      const height = h3[0].p - l3[0].p;
      let kind = null; if (flatH && risingL) kind = 'asc'; else if (flatL && fallingH) kind = 'desc'; else if (fallingH && risingL) kind = 'sym';
      if (kind && height > 1.5 * a) {
        const nm = { asc: 'Ascending Triangle', desc: 'Descending Triangle', sym: 'Symmetrical Triangle' }[kind];
        const sides = kind === 'asc' ? ['buy'] : kind === 'desc' ? ['sell'] : ['buy', 'sell'];
        const from = Math.min(h3[0].i, l3[0].i);
        const lines = [{ from, to: n, p1: upper(from), p2: upper(n), kind: 'res' }, { from, to: n, p1: lower(from), p2: lower(n), kind: 'sup' }];
        let pushed = false;
        for (const sd of sides) { const st = status(b, sd, sd === 'buy' ? upper : lower, a); if (st && st.state !== 'forming') { out.push({ key: 'tri-' + kind, name: nm, side: sd, ...st, neck: (sd === 'buy' ? upper : lower)(n), target: (sd === 'buy' ? upper(n) + height : lower(n) - height), lines }); pushed = true; } }
        if (!pushed) out.push({ key: 'tri-' + kind, name: nm, side: sides.length === 2 ? 'both' : sides[0], state: 'forming', neck: kind === 'desc' ? lower(n) : upper(n), target: null, lines });
      }
    }
    // flags: strong pole then tight consolidation
    for (let len = 4; len <= 18; len++) {
      const fs = n - len + 1; if (fs < 12) break;
      const flag = b.slice(fs, n + 1); const fh = Math.max(...flag.map(x => x.h)), fl = Math.min(...flag.map(x => x.l));
      for (let pl = 3; pl <= 10; pl++) {
        const ps = fs - pl; if (ps < 0) break; const pole = b[fs - 1].c - b[ps].o;
        if (Math.abs(pole) < 3.5 * a) continue;
        const side = pole > 0 ? 'buy' : 'sell';
        if (fh - fl > 0.5 * Math.abs(pole)) continue;
        const retr = side === 'buy' ? (b[fs - 1].c - fl) : (fh - b[fs - 1].c); if (retr > 0.5 * Math.abs(pole)) continue;
        const edge = side === 'buy' ? Math.max(...flag.slice(0, -1).map(x => x.h)) : Math.min(...flag.slice(0, -1).map(x => x.l));
        const broke = side === 'buy' ? b[n].c > edge : b[n].c < edge;
        out.push({ key: side === 'buy' ? 'bull-flag' : 'bear-flag', name: side === 'buy' ? 'Bullish Flag' : 'Bearish Flag', side, state: broke ? 'breakout' : 'forming', neck: edge, target: edge + pole, lines: [{ from: ps, to: fs - 1, p1: b[ps].o, p2: b[fs - 1].c, kind: 'pole' }, { from: fs, to: n, p1: fh, p2: fh, kind: 'res' }, { from: fs, to: n, p1: fl, p2: fl, kind: 'sup' }] });
        len = 99; break;
      }
    }
    // cup & handle (experimental)
    for (const [side, rims, lows] of [['buy', H, L], ['sell', L, H]]) {
      const r = rims.slice(-2); if (r.length < 2) continue; const [r1, r2] = r;
      if (r2.i - r1.i < 15 || r1.i < n - 160 || Math.abs(r1.p - r2.p) > 1.2 * a) continue;
      const mids = between(lows, r1.i, r2.i); if (!mids.length) continue;
      const cup = side === 'buy' ? mids.reduce((m, p) => p.p < m.p ? p : m) : mids.reduce((m, p) => p.p > m.p ? p : m);
      const depth = Math.abs(((r1.p + r2.p) / 2) - cup.p); if (depth < 4 * a) continue;
      if (cup.i - r1.i < 5 || r2.i - cup.i < 5) continue;
      const handle = b.slice(r2.i + 1, n + 1); if (handle.length < 3 || handle.length > 25) continue;
      const hx = side === 'buy' ? Math.min(...handle.map(x => x.l)) : Math.max(...handle.map(x => x.h));
      const hDepth = Math.abs(((r1.p + r2.p) / 2) - hx); if (hDepth > 0.5 * depth || hDepth < 0.5 * a) continue;
      const neck = side === 'buy' ? Math.max(r1.p, r2.p) : Math.min(r1.p, r2.p);
      const st = status(b, side, () => neck, a); if (!st) continue;
      out.push({ key: side === 'buy' ? 'cup' : 'inv-cup', name: side === 'buy' ? 'Cup & Handle' : 'Inverse Cup & Handle', side, ...st, neck, target: side === 'buy' ? neck + depth : neck - depth, experimental: true, lines: [{ from: r1.i, to: n, p1: neck, p2: neck, kind: 'neck' }] });
    }
    return out;
  }

  // ---------- full analysis of one instrument ----------
  function analyze(rawBars, opts = {}) {
    const b = rawBars.map(r => Array.isArray(r) ? { t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] } : r).filter(x => x.c != null && x.h != null);
    if (b.length < 60) return null;
    const n = b.length - 1;
    const A = atr(b, 14); const a = A[n] || (b[n].h - b[n].l);
    const avgBody = b.slice(-20).reduce((s, x) => s + Math.abs(x.c - x.o), 0) / 20;
    const piv = pivots(b, CONFIG.pivot.left, CONFIG.pivot.right);
    const lv = levels(b, piv, a, n);
    const price = b[n].c;
    const sups = lv.filter(l => l.price < price).sort((x, y) => y.price - x.price);
    const ress = lv.filter(l => l.price > price).sort((x, y) => x.price - y.price);
    // strongest within reach: prefer more touches among nearest 3
    const pickStrong = (arr) => arr.slice(0, 3).sort((x, y) => y.touches - x.touches || 0)[0] || null;
    const sup = sups[0] || null, res = ress[0] || null;
    const st = supertrend(b, CONFIG.supertrend.atrLen, CONFIG.supertrend.factor);
    const R = rsi(b, CONFIG.rsi.len); const S = stoch(b, CONFIG.stoch.len, CONFIG.stoch.kSmooth, CONFIG.stoch.dSmooth);
    const ms = structure(piv, n);
    const pats = findPatterns(b, piv, a);

    // candle in the last few bars
    let candle = null;
    for (let i = n; i >= n - CONFIG.lookback.candle + 1; i--) { const ks = candlesAt(b, i, avgBody); if (ks.length) { const pri = ['morningStar', 'eveningStar', 'bullEngulf', 'bearEngulf', 'hammer', 'shootingStar', 'bullInside', 'bearInside', 'doji']; ks.sort((x, y) => pri.indexOf(x) - pri.indexOf(y)); candle = { key: ks[0], all: ks, i, ago: n - i }; break; } }

    // location (teacher: buy candle at support, sell candle at resistance)
    const near = (lvl, side) => { if (!lvl) return false; const lowWin = Math.min(...b.slice(n - 2).map(x => x.l)), hiWin = Math.max(...b.slice(n - 2).map(x => x.h)); return side === 'buy' ? lowWin <= lvl.price + CONFIG.level.nearATR * a && price >= lvl.price - CONFIG.level.nearATR * a : hiWin >= lvl.price - CONFIG.level.nearATR * a && price <= lvl.price + CONFIG.level.nearATR * a; };
    // also count the level price is sitting on (just above/below)
    const nearSup = lv.filter(l => Math.abs(l.price - Math.min(...b.slice(n - 2).map(x => x.l))) <= CONFIG.level.nearATR * a && l.price <= price + 0.3 * a).sort((x, y) => y.touches - x.touches)[0] || (near(sup, 'buy') ? sup : null);
    const nearRes = lv.filter(l => Math.abs(l.price - Math.max(...b.slice(n - 2).map(x => x.h))) <= CONFIG.level.nearATR * a && l.price >= price - 0.3 * a).sort((x, y) => y.touches - x.touches)[0] || (near(res, 'sell') ? res : null);

    // indicator states
    const crossedUp = (arr, lvl, k = CONFIG.lookback.cross) => { for (let i = n; i > n - k; i--) if (arr[i] != null && arr[i - 1] != null && arr[i - 1] <= lvl && arr[i] > lvl) return true; return false; };
    const crossedDn = (arr, lvl, k = CONFIG.lookback.cross) => { for (let i = n; i > n - k; i--) if (arr[i] != null && arr[i - 1] != null && arr[i - 1] >= lvl && arr[i] < lvl) return true; return false; };
    const minR = Math.min(...R.slice(n - 3).filter(v => v != null)), maxR = Math.max(...R.slice(n - 3).filter(v => v != null));
    let stochUp = false, stochDn = false;
    for (let i = n; i > n - 3; i--) { const k0 = S.k[i - 1], d0 = S.d[i - 1], k1 = S.k[i], d1 = S.d[i]; if ([k0, d0, k1, d1].some(v => v == null)) continue; if (k0 <= d0 && k1 > d1 && Math.min(k0, d0) <= CONFIG.stoch.low + CONFIG.stoch.tol) stochUp = true; if (k0 >= d0 && k1 < d1 && Math.max(k0, d0) >= CONFIG.stoch.high - CONFIG.stoch.tol) stochDn = true; }
    const stDir = st.dir[n], stLine = st.line[n];
    const stTapBuy = stDir === 1 && Math.min(...b.slice(n - 2).map(x => x.l)) <= stLine + 0.35 * a;
    const stTapSell = stDir === -1 && Math.max(...b.slice(n - 2).map(x => x.h)) >= stLine - 0.35 * a;
    const ind = {
      rsi: R[n], k: S.k[n], d: S.d[n], st: stDir, stLine,
      rsiExtremeBuy: minR <= CONFIG.rsi.low + CONFIG.rsi.tol, rsiExtremeSell: maxR >= CONFIG.rsi.high - CONFIG.rsi.tol,
      rsiRangeBuy: crossedUp(R, CONFIG.rsi.rangeHigh), rsiRangeSell: crossedDn(R, CONFIG.rsi.rangeLow),
      rsiMidBuy: crossedUp(R, CONFIG.rsi.mid), rsiMidSell: crossedDn(R, CONFIG.rsi.mid),
      stochBuy: stochUp, stochSell: stochDn, stTapBuy, stTapSell
    };

    // build both sides, keep the stronger
    function sideScore(side) {
      const pts = [], why = [];
      let s = 0;
      const lvl = side === 'buy' ? nearSup : nearRes;
      if (lvl) { const add = lvl.touches >= 3 ? 30 : 22; s += add; why.push(`${side === 'buy' ? 'At support' : 'At resistance'} ${fmtP(lvl.price)} (${lvl.touches} touches)`); }
      let cd = null;
      if (candle) { const c = CANDLES[candle.key]; const ok = c.side === side || (c.side === 'both' && lvl); if (ok) { cd = candle; s += 25; why.push(`${c.name}${candle.ago ? ` ${candle.ago} bar${candle.ago > 1 ? 's' : ''} ago` : ' on last bar'}`); } }
      const tr = ms.trend; if ((tr === 'up' && side === 'buy') || (tr === 'down' && side === 'sell')) { s += 15; why.push(tr === 'up' ? 'Uptrend (HH/HL)' : 'Downtrend (LH/LL)'); } else if (tr === 'sideways') { s -= 5; } else s -= 10;
      if ((stDir === 1 && side === 'buy') || (stDir === -1 && side === 'sell')) { s += 8; if (side === 'buy' ? stTapBuy : stTapSell) { s += 7; why.push(`Supertrend ${side === 'buy' ? 'green' : 'red'} zone tap`); } }
      const osc = side === 'buy' ? [ind.rsiExtremeBuy && 'RSI near 20', ind.stochBuy && 'Stochastic cross up from 20', ind.rsiRangeBuy && 'RSI broke above 60', ind.rsiMidBuy && 'RSI crossed 50 up'] : [ind.rsiExtremeSell && 'RSI near 80', ind.stochSell && 'Stochastic cross down from 80', ind.rsiRangeSell && 'RSI broke below 40', ind.rsiMidSell && 'RSI crossed 50 down'];
      const oscHits = osc.filter(Boolean); if (oscHits.length) { s += Math.min(12, 6 * oscHits.length); why.push(oscHits.join(', ')); }
      const pt = pats.filter(p => (p.side === side || p.side === 'both') && p.state !== 'forming').sort((x, y) => (y.state === 'retest') - (x.state === 'retest'))[0];
      if (pt) { s += pt.state === 'retest' ? 15 : 12; why.push(`${pt.name} ${pt.state === 'retest' ? 'retest' : pt.state === 'near-break' ? 'near neckline' : 'breakout'}`); }
      // trade plan from candle (teacher): entry on break, stop beyond candle, 1:2
      let plan = null;
      if (cd) {
        const rg = patternRange(b, cd.i, cd.key);
        let entry = side === 'buy' ? b[cd.i].h : b[cd.i].l;
        let stop = side === 'buy' ? rg.lo : rg.hi;
        if (lvl) stop = side === 'buy' ? Math.min(stop, lvl.price - 0.15 * a) : Math.max(stop, lvl.price + 0.15 * a);
        const risk = Math.abs(entry - stop);
        if (risk > 0) {
          const target = side === 'buy' ? entry + CONFIG.rr * risk : entry - CONFIG.rr * risk;
          const opp = side === 'buy' ? ress.find(l => l.price > entry) : sups.find(l => l.price < entry);
          const room = opp ? Math.abs(opp.price - entry) / risk : 9;
          const triggered = side === 'buy' ? b.slice(cd.i + 1).some(x => x.h > entry) : b.slice(cd.i + 1).some(x => x.l < entry);
          plan = { entry, stop, target, risk, room, blocked: room < CONFIG.rr, triggered, riskATR: risk / a };
          if (plan.blocked) { s -= 20; why.push(`Next ${side === 'buy' ? 'resistance' : 'support'} only ${room.toFixed(1)}R away`); } else s += 5;
        }
      }
      return { side, score: Math.max(0, Math.min(100, Math.round(s))), why, level: lvl, candle: cd, pattern: pt || null, plan };
    }
    const sb = sideScore('buy'), ss = sideScore('sell');
    const best = sb.score >= ss.score ? sb : ss;
    let signal = 'Neutral', grade = '';
    const hasCore = best.level && best.candle;
    if (hasCore && best.score >= CONFIG.scoring.B && !(best.plan && best.plan.blocked)) signal = best.side === 'buy' ? 'Buy Setup' : 'Sell Setup';
    else if (best.score >= CONFIG.scoring.B && (best.level || best.pattern) && !(best.plan && best.plan.blocked)) signal = best.side === 'buy' ? 'Buy Bias' : 'Sell Bias';
    else if (best.level) signal = 'Watch';
    else if (ms.trend === 'sideways') signal = 'In Range';
    grade = best.score >= CONFIG.scoring.A ? 'A' : best.score >= CONFIG.scoring.B ? 'B' : best.score >= CONFIG.scoring.C ? 'C' : '–';
    if (best.plan && best.plan.blocked) { grade = best.score >= CONFIG.scoring.C ? 'C' : '–'; if (signal === 'Neutral' || signal === 'In Range') signal = 'Watch'; }
    let headline = '';
    if (best.plan && best.plan.blocked && best.candle) headline = `${CANDLES[best.candle.key].name} at level, but target blocked (${best.plan.room.toFixed(1)}R room)`;
    else if (signal === 'Watch') headline = best.side === 'buy' ? 'Near support — wait for a buy candle' : 'Near resistance — wait for a sell candle';
    else if (signal === 'In Range') headline = 'Sideways — teacher rule: no trade';
    else if (signal === 'Neutral') headline = 'Between levels — nothing to do';
    else headline = best.why.slice(0, 2).join(' + ');

    return {
      bars: b, n, price, atr: a, piv, levels: lv, sup, res, strongSup: pickStrong(sups), strongRes: pickStrong(ress), st, rsi: R, stoch: S, structure: ms, patterns: pats, candle, ind,
      buy: sb, sell: ss, best, signal, grade, score: best.score, headline,
      chg: opts.prev != null ? price - opts.prev : price - b[n - 1].c
    };
  }
  function fmtP(x) { if (x == null) return '–'; const ab = Math.abs(x); return ab >= 1000 ? x.toLocaleString('en-US', { maximumFractionDigits: 1 }) : ab >= 10 ? x.toFixed(2) : x.toFixed(3); }

  // ---------- backtest (no look-ahead): does the rule reach 1:2 before the stop? ----------
  function backtest(rawBars) {
    const b = rawBars.map(r => Array.isArray(r) ? { t: r[0], o: r[1], h: r[2], l: r[3], c: r[4] } : r);
    const out = { candleAtLevel: [], supertrendTap: [], rsi50: [], stoch: [], anyCandle: [] };
    if (b.length < 80) return out;
    const A = atr(b, 14); const st = supertrend(b, CONFIG.supertrend.atrLen, CONFIG.supertrend.factor); const R = rsi(b, 14); const S = stoch(b, 14, 5, 3);
    const P = pivots(b, CONFIG.pivot.left, CONFIG.pivot.right);
    function resolve(i, side, entry, stop) {
      const risk = Math.abs(entry - stop); if (!(risk > 0)) return null; const tgt = side === 'buy' ? entry + 2 * risk : entry - 2 * risk;
      let filled = -1; for (let j = i + 1; j <= Math.min(i + 3, b.length - 1); j++) { if (side === 'buy' ? b[j].h > entry : b[j].l < entry) { filled = j; break; } }
      if (filled < 0) return null;
      for (let j = filled; j < b.length; j++) { const hitS = side === 'buy' ? b[j].l <= stop : b[j].h >= stop; const hitT = side === 'buy' ? b[j].h >= tgt : b[j].l <= tgt; if (hitS) return -1; if (hitT) return 2; }
      return null; // still open
    }
    for (let i = 60; i < b.length - 1; i++) {
      const a = A[i]; if (!a) continue;
      const avgBody = b.slice(i - 19, i + 1).reduce((s, x) => s + Math.abs(x.c - x.o), 0) / 20;
      const ks = candlesAt(b, i, avgBody); if (!ks.length) continue;
      const known = { hs: P.hs.filter(p => p.i <= i - CONFIG.pivot.right), ls: P.ls.filter(p => p.i <= i - CONFIG.pivot.right) };
      const lv = levels(b, known, a, i - CONFIG.pivot.right);
      for (const k of ks) {
        const c = CANDLES[k];
        for (const side of c.side === 'both' ? ['buy', 'sell'] : [c.side]) {
          const rg = patternRange(b, i, k); const entry = side === 'buy' ? b[i].h : b[i].l; const stop = side === 'buy' ? rg.lo : rg.hi;
          const atLevel = lv.some(l => side === 'buy' ? Math.abs(l.price - rg.lo) <= a && l.price <= b[i].c : Math.abs(l.price - rg.hi) <= a && l.price >= b[i].c);
          if (c.side !== 'both') { const r0 = resolve(i, side, entry, stop); if (r0 != null) out.anyCandle.push(r0); }
          if (atLevel) { const r = resolve(i, side, entry, stop); if (r != null) out.candleAtLevel.push(r); }
          if (c.side !== 'both') {
            const tap = side === 'buy' ? st.dir[i] === 1 && b[i].l <= st.line[i] + 0.35 * a : st.dir[i] === -1 && b[i].h >= st.line[i] - 0.35 * a;
            if (tap) { const r = resolve(i, side, entry, stop); if (r != null) out.supertrendTap.push(r); }
            const r50 = side === 'buy' ? R[i - 1] <= 50 && R[i] > 50 : R[i - 1] >= 50 && R[i] < 50;
            if (r50) { const r = resolve(i, side, entry, stop); if (r != null) out.rsi50.push(r); }
            const sx = side === 'buy' ? S.k[i - 1] <= S.d[i - 1] && S.k[i] > S.d[i] && S.k[i - 1] <= 25 : S.k[i - 1] >= S.d[i - 1] && S.k[i] < S.d[i] && S.k[i - 1] >= 75;
            if (sx) { const r = resolve(i, side, entry, stop); if (r != null) out.stoch.push(r); }
          }
        }
      }
    }
    return out;
  }
  const summarize = (arr) => { const n = arr.length, w = arr.filter(x => x > 0).length; return { n, w, wr: n ? w / n : null, exp: n ? arr.reduce((s, x) => s + x, 0) / n : null }; };

  const api = { CONFIG, CANDLES, sma, ema, atr, rsi, stoch, supertrend, candlesAt, pivots, levels, structure, findPatterns, analyze, backtest, summarize, fmtP };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Engine = api;
})(typeof window !== 'undefined' ? window : globalThis);
