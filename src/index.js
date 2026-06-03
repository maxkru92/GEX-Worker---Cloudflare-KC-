// GEX Collector v3.2 — Cloudflare Worker
// Fixes:
//   - Gamma=0 from CBOE -> approximate via BSM using IV, DTE
//   - Filter to front expiry only (avoid mixing expirations)
//   - Proper GEX formula: Gamma * OI * Spot * 0.01 (per 1% move)
//   - Deduplicate strikes across expirations (sum OI+GEX)

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const SYMBOL_CONFIG = {
  SPX:  { index: true,  label: "S&P 500",     multiplier: 100 },
  NDX:  { index: true,  label: "Nasdaq 100",   multiplier: 100 },
  RUT:  { index: true,  label: "Russell 2000",  multiplier: 100 },
  VIX:  { index: true,  label: "VIX",           multiplier: 100 },
  SPY:  { index: false, label: "SPY ETF",       multiplier: 100 },
  QQQ:  { index: false, label: "QQQ ETF",       multiplier: 100 },
  IWM:  { index: false, label: "IWM ETF",       multiplier: 100 },
};

const INDEX_SYMBOLS = ["SPX", "NDX", "RUT", "VIX", "OEX", "XEO", "SPXW"];
function isIndex(symbol) { return INDEX_SYMBOLS.includes(symbol.toUpperCase()); }

// ================================================================
// BSM GAMMA CALCULATION
// ================================================================

function bsmGamma(S, K, sigma, T) {
  if (!sigma || sigma <= 0 || !S || S <= 0 || !K || K <= 0 || T <= 0) return 0;
  try {
    const sqrtT = Math.sqrt(T);
    const d1 = (Math.log(S / K) + 0.5 * sigma * sigma * T) / (sigma * sqrtT);
    const nd1 = Math.exp(-0.5 * d1 * d1) / Math.sqrt(2 * Math.PI);
    return nd1 / (S * sigma * sqrtT);
  } catch { return 0; }
}

function approxGammaFromIV(S, K, iv, dte) {
  if (!iv || iv <= 0) return 0;
  const T = Math.max(dte, 1) / 365;
  return bsmGamma(S, K, iv / 100, T); // IV is in percent (e.g. 13.19)
}

// ================================================================
// CBOE DATA FETCHER
// ================================================================

async function fetchCBOESpot(symbol) {
  const url = `https://www.cboe.com/education/tools/trade-optimizer/symbol-info/?symbol=${isIndex(symbol) ? "^" : ""}${symbol}`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, "Accept": "application/json" },
      cf: { cacheTtl: 120 }
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.success || !data?.details) return null;
    const d = data.details;
    const price = parseFloat(d.current_price);
    if (!price || price <= 0) return null;
    return {
      price,
      change: parseFloat(d.price_change) || 0,
      changePct: parseFloat(d.price_change_percent) || 0,
      iv30: parseFloat(d.iv30) || 0,
      iv30Change: parseFloat(d.iv30_change) || 0,
      prevClose: parseFloat(d.prev_day_close) || 0,
      source: "cboe",
      expirations: data.expirations || []
    };
  } catch { return null; }
}

async function fetchCBOEChain(symbol) {
  const prefix = isIndex(symbol) ? "_" : "";
  const url = `https://cdn.cboe.com/api/global/delayed_quotes/options/${prefix}${symbol}.json`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, "Accept": "application/json" },
      cf: { cacheTtl: 300 }
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.data) return null;
    
    const d = data.data;
    const spot = parseFloat(d.current_price) || 0;
    const options = d.options;
    if (!options || !Array.isArray(options) || options.length === 0) return null;
    
    // Parse all options
    const allEntries = [];
    for (const opt of options) {
      const sym = opt.option || opt.symbol || "";
      if (!sym) continue;
      
      const match = sym.match(/^([A-Z]+)(\d{6})([CP])(\d{8})$/);
      if (!match) continue;
      
      const [, ticker, dateStr, type, strikeRaw] = match;
      const strike = parseInt(strikeRaw) / 1000;
      const expiry = `20${dateStr.slice(0,2)}-${dateStr.slice(2,4)}-${dateStr.slice(4,6)}`;
      
      // Calculate DTE
      const expDate = new Date(expiry);
      const now = new Date();
      const dte = Math.max(0, Math.floor((expDate - now) / (1000 * 60 * 60 * 24)));
      
      // Gamma: use CBOE value if > 0, else approximate from IV via BSM
      let gamma = parseFloat(opt.gamma) || 0;
      const iv = parseFloat(opt.iv) || 0;
      if (gamma <= 0 && iv > 0 && dte > 0) {
        // CBOE IV is in decimal form (e.g. 0.1316 for 13.16%)
        const T = Math.max(dte, 1) / 365;
        gamma = bsmGamma(spot, strike, iv, T);
      }
      // For 0DTE (dte=0), use T=1/365 as minimum
      if (gamma <= 0 && iv > 0 && dte === 0) {
        gamma = bsmGamma(spot, strike, iv, 1/365);
      }
      
      allEntries.push({
        strike, expiry, dte, type,
        oi: parseInt(opt.open_interest) || 0,
        volume: parseInt(opt.volume) || 0,
        iv, gamma,
        delta: parseFloat(opt.delta) || 0,
        bid: parseFloat(opt.bid) || 0,
        ask: parseFloat(opt.ask) || 0,
      });
    }
    
    if (allEntries.length === 0) return null;
    
    // Get front expiry (closest DTE > 0)
    const futureEntries = allEntries.filter(e => e.dte >= 0);
    if (futureEntries.length === 0) return null;
    
    const minDTE = Math.min(...futureEntries.map(e => e.dte));
    const frontExpiry = futureEntries.filter(e => e.dte === minDTE)[0]?.expiry;
    
    // Filter to front expiry only
    const frontEntries = futureEntries.filter(e => e.expiry === frontExpiry);
    
    // Deduplicate strikes (sum OI and gamma*OI across entries for same strike)
    const callAgg = new Map();
    const putAgg = new Map();
    
    for (const e of frontEntries) {
      if (e.type === "C") {
        const existing = callAgg.get(e.strike) || { strike: e.strike, oi: 0, volume: 0, gammaOI: 0, ivSum: 0, ivCount: 0 };
        existing.oi += e.oi;
        existing.volume += e.volume;
        existing.gammaOI += e.gamma * e.oi; // weighted gamma
        if (e.iv > 0) { existing.ivSum += e.iv; existing.ivCount++; }
        callAgg.set(e.strike, existing);
      } else {
        const existing = putAgg.get(e.strike) || { strike: e.strike, oi: 0, volume: 0, gammaOI: 0, ivSum: 0, ivCount: 0 };
        existing.oi += e.oi;
        existing.volume += e.volume;
        existing.gammaOI += e.gamma * e.oi;
        if (e.iv > 0) { existing.ivSum += e.iv; existing.ivCount++; }
        putAgg.set(e.strike, existing);
      }
    }
    
    // Build combined strikes
    const allStrikes = new Set([...callAgg.keys(), ...putAgg.keys()]);
    const strikes = [];
    
    for (const strike of allStrikes) {
      const c = callAgg.get(strike);
      const p = putAgg.get(strike);
      
      // Average gamma = gammaOI / OI (or 0 if no OI)
      const callGamma = c && c.oi > 0 ? c.gammaOI / c.oi : 0;
      const putGamma = p && p.oi > 0 ? p.gammaOI / p.oi : 0;
      const callIV = c && c.ivCount > 0 ? c.ivSum / c.ivCount : 0;
      const putIV = p && p.ivCount > 0 ? p.ivSum / p.ivCount : 0;
      
      strikes.push({
        strike, expiry: frontExpiry, dte: minDTE,
        callOI: c?.oi || 0, putOI: p?.oi || 0,
        callGamma, putGamma,
        callIV, putIV,
        callVolume: c?.volume || 0, putVolume: p?.volume || 0,
      });
    }
    
    strikes.sort((a, b) => a.strike - b.strike);
    
    return {
      strikes, spot, source: "cboe",
      fetchedAt: new Date().toISOString(),
      totalOptions: options.length,
      frontExpiry, dte: minDTE,
      allExpiries: [...new Set(futureEntries.map(e => e.expiry))].sort()
    };
  } catch (e) {
    console.log(`[CBOE CHAIN] ${symbol} error: ${e.message}`);
    return null;
  }
}

// ================================================================
// YAHOO FALLBACK
// ================================================================

async function fetchYahooSpot(symbol) {
  const yahooSymbol = isIndex(symbol) ? `^${symbol}` : symbol;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=15m&range=1d`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) return null;
    const data = await res.json();
    const closes = data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close;
    if (!closes) return null;
    for (let i = closes.length - 1; i >= 0; i--) {
      if (closes[i] > 0) return { price: closes[i], source: "yahoo" };
    }
    return null;
  } catch { return null; }
}

async function fetchSpot(symbol) {
  let spot = await fetchCBOESpot(symbol);
  if (spot) return spot;
  console.log(`[SPOT] ${symbol} -> Yahoo fallback`);
  const yahoo = await fetchYahooSpot(symbol);
  if (yahoo) return yahoo;
  throw new Error(`FETCH_ERROR: no spot for ${symbol}`);
}

async function fetchChain(symbol, spotPrice, iv30) {
  let chain = await fetchCBOEChain(symbol);
  if (chain && chain.strikes && chain.strikes.length > 0) return chain;
  
  console.log(`[CHAIN] ${symbol} -> BSM synthetic`);
  const iv = iv30 ? iv30 / 100 : 0.15;
  const synthetic = generateSyntheticChain(spotPrice, iv, symbol);
  if (synthetic) return synthetic;
  throw new Error(`FETCH_ERROR: no chain for ${symbol}`);
}

function generateSyntheticChain(spot, iv, underlying) {
  if (!spot || spot <= 0 || !iv || iv <= 0) return null;
  const strikes = [];
  const atmStrike = Math.round(spot / 5) * 5;
  const minStrike = atmStrike - 150;
  const maxStrike = atmStrike + 150;
  
  for (let k = minStrike; k <= maxStrike; k += 5) {
    const distPct = Math.abs(k - atmStrike) / spot;
    const baseOI = 80000 * Math.exp(-distPct * distPct * 200);
    const noise = 0.8 + Math.random() * 0.4;
    const totalOI = Math.round(baseOI * noise);
    const callOI = Math.round(totalOI * (0.42 + Math.random() * 0.06));
    const putOI = Math.round(totalOI * (0.55 + Math.random() * 0.03));
    const skew = distPct * 0.3;
    const callIV = iv * (1 + skew);
    const putIV = iv * (1 + skew + 0.05);
    const T = 7 / 252;
    const callGamma = bsmGamma(spot, k, callIV, T);
    const putGamma = bsmGamma(spot, k, putIV, T);
    strikes.push({
      strike: k, expiry: "synthetic", dte: 7,
      callOI: Math.max(100, callOI), putOI: Math.max(100, putOI),
      callGamma: Math.max(0.0001, callGamma), putGamma: Math.max(0.0001, putGamma),
      callIV, putIV
    });
  }
  
  return { strikes, spot, source: "bsm-synthetic", fetchedAt: new Date().toISOString(), frontExpiry: "synthetic", dte: 7, totalOptions: strikes.length, allExpiries: ["synthetic"] };
}

// ================================================================
// GEX COMPUTATION
// ================================================================

function computeGEX(strikes, spot) {
  let netGEX = 0;
  let maxCallGEX = 0, maxPutGEX = 0;
  let maxCallStrike = spot, maxPutStrike = spot;
  const topCalls = [], topPuts = [];
  
  for (const s of strikes) {
    // GEX formula: Gamma * OI * Spot^2 / 100 (per 1% move, institutional standard)
    // CBOE gamma is per $1 move, Spot^2/100 converts to per 1% move
    const callGEX = s.callGamma * s.callOI * spot * spot / 100;
    const putGEX = s.putGamma * s.putOI * spot * spot / 100;
    const strikeNetGEX = callGEX - putGEX;
    netGEX += strikeNetGEX;
    
    if (callGEX > maxCallGEX) { maxCallGEX = callGEX; maxCallStrike = s.strike; }
    if (putGEX > maxPutGEX) { maxPutGEX = putGEX; maxPutStrike = s.strike; }
    
    topCalls.push({ strike: s.strike, oi: s.callOI, gex: callGEX });
    topPuts.push({ strike: s.strike, oi: s.putOI, gex: putGEX });
  }
  
  topCalls.sort((a, b) => b.gex - a.gex);
  topPuts.sort((a, b) => b.gex - a.gex);
  
  return {
    netGEX,
    regime: netGEX > 0 ? "POSITIVE_GAMMA" : netGEX < 0 ? "NEGATIVE_GAMMA" : "NEUTRAL",
    callWall: { strike: maxCallStrike, gex: maxCallGEX },
    putSupport: { strike: maxPutStrike, gex: maxPutGEX },
    hvl: Math.round((maxCallStrike + maxPutStrike) / 2 * 100) / 100,
    topCalls: topCalls.slice(0, 10),
    topPuts: topPuts.slice(0, 10),
    strikeCount: strikes.length
  };
}

function normalizeGEX(value) {
  return Math.max(-1, Math.min(1, value / 1e11)); // Normalize to ~100B range for SPX
}

function detectRegimeChange(prev, curr) {
  if (!prev) return { changed: false, prevRegime: null, currRegime: null, gexDeltaPercent: 0 };
  const prevNet = prev?.netGex || 0;
  const currNet = curr?.netGEX || 0;
  const delta = Math.abs(currNet - prevNet);
  const threshold = Math.abs(prevNet) * 0.15 || 1e8; // 15% or 100M minimum
  const changed = delta > threshold;
  const prevRegime = prevNet > 0 ? "POSITIVE" : prevNet < 0 ? "NEGATIVE" : "NEUTRAL";
  const currRegime = currNet > 0 ? "POSITIVE" : currNet < 0 ? "NEGATIVE" : "NEUTRAL";
  const gexDeltaPercent = prevNet !== 0 ? Math.round((currNet - prevNet) / Math.abs(prevNet) * 10000) / 100 : 0;
  return { changed, prevRegime, currRegime, gexDeltaPercent };
}

function formatGex(value) {
  if (Math.abs(value) >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (Math.abs(value) >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (Math.abs(value) >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return value.toFixed(0);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-cache" }
  });
}

// ================================================================
// COLLECT GEX
// ================================================================

async function collectGEX(symbol, env) {
  const cfg = SYMBOL_CONFIG[symbol];
  if (!cfg) throw new Error(`UNKNOWN_SYMBOL: ${symbol}`);
  
  const spot = await fetchSpot(symbol);
  const chain = await fetchChain(symbol, spot.price, spot.iv30);
  const gex = computeGEX(chain.strikes, spot.price);
  const prevRaw = await env.GEX_KV.get(`gex:${symbol}:previous`, "json");
  const regimeChange = detectRegimeChange(prevRaw, gex);
  
  const result = {
    timestamp: new Date().toISOString(),
    symbol, spot: spot.price, spotSource: spot.source, label: cfg.label,
    iv30: spot.iv30 || null,
    spotChangePct: spot.changePct || null,
    regime: gex.regime,
    regimeChanged: regimeChange.changed,
    regimeChangeReason: regimeChange.changed
      ? `${regimeChange.prevRegime} -> ${regimeChange.currRegime} | ${regimeChange.gexDeltaPercent}%`
      : null,
    netGex: Math.round(gex.netGEX * 100) / 100,
    netGexFormatted: formatGex(gex.netGEX),
    netGexNormalized: normalizeGEX(gex.netGEX),
    callWall: {
      strike: gex.callWall.strike, gex: formatGex(gex.callWall.gex),
      distance: Math.round((gex.callWall.strike - spot.price) / spot.price * 10000) / 100
    },
    putSupport: {
      strike: gex.putSupport.strike, gex: formatGex(gex.putSupport.gex),
      distance: Math.round((gex.putSupport.strike - spot.price) / spot.price * 10000) / 100
    },
    hvl: gex.hvl,
    topCallStrikes: gex.topCalls.map(s => ({ strike: s.strike, oi: s.oi, gex: formatGex(s.gex) })),
    topPutStrikes: gex.topPuts.map(s => ({ strike: s.strike, oi: s.oi, gex: formatGex(s.gex) })),
    chainSource: chain.source,
    frontExpiry: chain.frontExpiry,
    dte: chain.dte,
    strikeCount: gex.strikeCount,
    totalOptions: chain.totalOptions,
    allExpiries: chain.allExpiries || [],
    fetchedAt: chain.fetchedAt
  };
  
  const currentRaw = await env.GEX_KV.get(`gex:${symbol}:latest`, "json");
  if (currentRaw) await env.GEX_KV.put(`gex:${symbol}:previous`, JSON.stringify(currentRaw));
  await env.GEX_KV.put(`gex:${symbol}:latest`, JSON.stringify(result));
  
  if (regimeChange.changed) {
    const alert = {
      timestamp: result.timestamp, symbol, type: "REGIME_CHANGE",
      from: regimeChange.prevRegime, to: regimeChange.currRegime,
      netGex: result.netGexFormatted, callWall: result.callWall.strike, putSupport: result.putSupport.strike
    };
    const alertsRaw = await env.GEX_KV.get("gex:alerts", "json") || [];
    alertsRaw.unshift(alert);
    await env.GEX_KV.put("gex:alerts", JSON.stringify(alertsRaw.slice(0, 20)));
  }
  
  return result;
}

// ================================================================
// PHASE D: BROADCAST
// ================================================================

async function broadcastRegimeChange(symbol, result, env) {
  const subs = await env.GEX_KV.get(`gex:subs:${symbol}`, "json") || [];
  if (subs.length === 0) return;
  
  const message = {
    type: "GEX_REGIME_CHANGE", symbol, regime: result.regime,
    netGex: result.netGexFormatted, callWall: result.callWall.strike,
    putSupport: result.putSupport.strike, hvl: result.hvl,
    spot: result.spot, timestamp: result.timestamp, subscribers: subs
  };
  
  const queue = await env.GEX_KV.get("gex:push-queue", "json") || [];
  queue.unshift(message);
  await env.GEX_KV.put("gex:push-queue", JSON.stringify(queue.slice(0, 50)));
  
  if (env.HF_WEBHOOK_URL) {
    try {
      await fetch(env.HF_WEBHOOK_URL, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(message)
      });
    } catch { /* ignore */ }
  }
}

// ================================================================
// WORKER ENTRY
// ================================================================

export default {
  async scheduled(event, env, ctx) {
    const symbols = (env.SYMBOLS || "SPX,VIX").split(",").map(s => s.trim());
    const results = [];
    for (const sym of symbols) {
      try {
        const result = await collectGEX(sym, env);
        results.push(result);
        if (result.regimeChanged) await broadcastRegimeChange(sym, result, env);
      } catch (e) {
        console.error(`[GEX] ${sym} failed: ${e.message}`);
        results.push({ symbol: sym, error: e.message });
      }
    }
    console.log(`[GEX] Cron done: ${results.filter(r => !r.error).length}/${symbols.length} OK`);
  },
  
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    
    if (path === "/health") {
      return json({ status: "ok", worker: "gex-collector", version: "3.2", ts: new Date().toISOString() });
    }
    
    if (path === "/latest") {
      const sym = (url.searchParams.get("symbol") || "SPX").toUpperCase();
      const data = await env.GEX_KV.get(`gex:${sym}:latest`, "json");
      if (!data) return json({ error: "no data", symbol: sym }, 404);
      return json(data);
    }
    
    if (path === "/previous") {
      const sym = (url.searchParams.get("symbol") || "SPX").toUpperCase();
      const data = await env.GEX_KV.get(`gex:${sym}:previous`, "json");
      if (!data) return json({ error: "no previous data" }, 404);
      return json(data);
    }
    
    if (path === "/compare") {
      const sym = (url.searchParams.get("symbol") || "SPX").toUpperCase();
      const [curr, prev] = await Promise.all([
        env.GEX_KV.get(`gex:${sym}:latest`, "json"),
        env.GEX_KV.get(`gex:${sym}:previous`, "json")
      ]);
      if (!curr) return json({ error: "no current data" }, 404);
      return json({ symbol: sym, comparison: detectRegimeChange(prev, curr) });
    }
    
    if (path === "/trigger" && request.method === "POST") {
      const sym = (url.searchParams.get("symbol") || "SPX").toUpperCase();
      const result = await collectGEX(sym, env);
      return json(result);
    }
    
    if (path === "/symbols") {
      const symbols = (env.SYMBOLS || "SPX,VIX").split(",").map(s => s.trim());
      const result = {};
      for (const sym of symbols) {
        const data = await env.GEX_KV.get(`gex:${sym}:latest`, "json");
        result[sym] = data ? { regime: data.regime, spot: data.spot, netGex: data.netGexFormatted, callWall: data.callWall?.strike, putSupport: data.putSupport?.strike, chainSource: data.chainSource, frontExpiry: data.frontExpiry } : null;
      }
      return json({ symbols: result });
    }
    
    if (path === "/alerts") {
      const alerts = await env.GEX_KV.get("gex:alerts", "json") || [];
      return json({ alerts, count: alerts.length });
    }
    
    if (path === "/webhook" && request.method === "POST") {
      try {
        const body = await request.json();
        const symMap = { "SPX": "SPX", "VIX": "VIX", "NDX": "NDX", "RUT": "RUT", "SPY": "SPX", "QQQ": "NDX", "IWM": "RUT" };
        const sym = symMap[(body.symbol || body.ticker || "SPX").toUpperCase()] || "SPX";
        const result = await collectGEX(sym, env);
        if (env.HF_WEBHOOK_URL) {
          await fetch(env.HF_WEBHOOK_URL, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ source: "tv-webhook", symbol: sym, gex: result })
          });
        }
        return json({ ok: true, symbol: sym, regime: result.regime });
      } catch (e) { return json({ error: e.message }, 400); }
    }
    
    if (path === "/subscribe" && request.method === "POST") {
      const sym = (url.searchParams.get("symbol") || "SPX").toUpperCase();
      const chatId = url.searchParams.get("chat_id") || "unknown";
      await env.GEX_KV.put(`gex:sub:${sym}:${chatId}`, JSON.stringify({ symbol: sym, chatId, subscribedAt: new Date().toISOString(), active: true }));
      const idx = await env.GEX_KV.get(`gex:subs:${sym}`, "json") || [];
      if (!idx.includes(chatId)) { idx.push(chatId); await env.GEX_KV.put(`gex:subs:${sym}`, JSON.stringify(idx)); }
      return json({ ok: true, action: "subscribed", symbol: sym, chatId });
    }
    
    if (path === "/unsubscribe" && request.method === "POST") {
      const sym = (url.searchParams.get("symbol") || "SPX").toUpperCase();
      const chatId = url.searchParams.get("chat_id") || "unknown";
      await env.GEX_KV.delete(`gex:sub:${sym}:${chatId}`);
      const idx = await env.GEX_KV.get(`gex:subs:${sym}`, "json") || [];
      await env.GEX_KV.put(`gex:subs:${sym}`, JSON.stringify(idx.filter(id => id !== chatId)));
      return json({ ok: true, action: "unsubscribed" });
    }
    
    if (path === "/subscriptions") {
      const sym = (url.searchParams.get("symbol") || "SPX").toUpperCase();
      return json({ symbol: sym, subscribers: await env.GEX_KV.get(`gex:subs:${sym}`, "json") || [] });
    }
    
    return json({
      worker: "gex-collector", version: "3.2",
      phases: ["A: GEX-Compute", "C: Webhook-Bridge", "D: Subscription"],
      data_source: "CBOE (primary) + Yahoo Spot Fallback + BSM Synthetic Fallback",
      endpoints: {
        phase_a: ["/health", "/latest?symbol=SPX", "/previous", "/compare", "/symbols", "/trigger (POST)", "/alerts"],
        phase_c: ["/webhook (POST)"],
        phase_d: ["/subscribe (POST)", "/unsubscribe (POST)", "/subscriptions"]
      },
      cron: "*/15 * * * *"
    });
  }
};
