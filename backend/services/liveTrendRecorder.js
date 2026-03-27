const { getAllTickerStats, getBookTickers, getPrices } = require("./binanceService");

const SAMPLE_INTERVAL_MS = Math.max(10_000, Number(process.env.CRYPTO_LIVE_RECORDER_INTERVAL_MS || 15_000));
const UNIVERSE_REFRESH_MS = Math.max(SAMPLE_INTERVAL_MS * 2, Number(process.env.CRYPTO_LIVE_RECORDER_UNIVERSE_MS || 60_000));
const HISTORY_WINDOW_MS = Math.max(5 * 60_000, Number(process.env.CRYPTO_LIVE_RECORDER_WINDOW_MS || 20 * 60_000));
const MAX_SYMBOLS = Math.max(8, Number(process.env.CRYPTO_LIVE_RECORDER_MAX_SYMBOLS || 24));
const MAX_POINTS_PER_SYMBOL = Math.max(40, Number(process.env.CRYPTO_LIVE_RECORDER_MAX_POINTS || 180));
const EVALUATION_WINDOW_MS = Math.max(3 * 60_000, Number(process.env.CRYPTO_LIVE_RECORDER_EVAL_WINDOW_MS || 5 * 60_000));
const WIN_THRESHOLD_PCT = Math.max(0.15, Number(process.env.CRYPTO_LIVE_RECORDER_WIN_PCT || 0.35));
const LOSS_THRESHOLD_PCT = -Math.max(0.15, Number(process.env.CRYPTO_LIVE_RECORDER_LOSS_PCT || 0.25));
const GUIDANCE_VERSION = "trend_guidance_v2";

const state = {
  historyBySymbol: {},
  metaBySymbol: {},
  universe: [],
  lastSampleAt: 0,
  lastUniverseAt: 0,
  lastError: null,
  samplingPromise: null,
  timer: null,
  running: false,
  activeRecommendations: {},
  performance: {
    overall: { wins: 0, losses: 0, neutrals: 0, total: 0 },
    bySignal: {},
    lastEvaluatedAt: null,
  },
};

function clamp(value, min, max) {
  return Math.min(Math.max(Number(value || 0), min), max);
}

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function computeActivityScore(ticker = {}) {
  const quoteVolume = toNumber(ticker.quoteVolume);
  const volume = toNumber(ticker.volume);
  const tradeCount = toNumber(ticker.count || ticker.tradeCount);
  const openInterestValue = toNumber(ticker.openInterestValue);
  return (
    Math.log10(quoteVolume + 1) * 16 +
    Math.log10(volume + 1) * 4 +
    Math.log10(tradeCount + 1) * 8 +
    Math.log10(openInterestValue + 1) * 10
  );
}

function trimHistory(points = [], nowMs = Date.now()) {
  const cutoff = nowMs - HISTORY_WINDOW_MS;
  const recent = points.filter((point) => point.ts >= cutoff);
  return recent.slice(-MAX_POINTS_PER_SYMBOL);
}

function getDirectionForSignal(signal) {
  const normalized = String(signal || "").toUpperCase();
  if (normalized.includes("LONG") || normalized === "BULLISH") return 1;
  if (normalized.includes("SHORT") || normalized === "BEARISH") return -1;
  return 0;
}

function computeWindowChange(points = [], ageMs = 0) {
  if (!points.length) return { value: null, ready: false };
  const latest = points[points.length - 1];
  const oldest = points[0];
  const toleranceMs = Math.max(SAMPLE_INTERVAL_MS * 1.3, 20_000);

  if (latest.ts - oldest.ts < Math.max(0, ageMs - toleranceMs)) {
    return { value: null, ready: false };
  }

  const targetTs = latest.ts - ageMs;
  let closest = null;
  for (const point of points) {
    const distance = Math.abs(point.ts - targetTs);
    if (!closest || distance < closest.distance) {
      closest = { point, distance };
    }
  }

  if (!closest || closest.distance > toleranceMs || !Number.isFinite(closest.point.price) || closest.point.price <= 0) {
    return { value: null, ready: false };
  }

  return {
    value: Number((((latest.price - closest.point.price) / closest.point.price) * 100).toFixed(3)),
    ready: true,
    sampledAt: closest.point.ts,
  };
}

function getSignalWinRate(signal) {
  const bucket = state.performance.bySignal[String(signal || "").toUpperCase()];
  if (!bucket || bucket.total <= 0) return null;
  return (bucket.wins / bucket.total) * 100;
}

function buildGuidance(signal, strength, metrics = {}) {
  const normalized = String(signal || "").toUpperCase();
  const signalWinRate = getSignalWinRate(normalized);
  const enoughHistory = metrics.historyReady2m && metrics.historyReady5m;
  const performanceWeak = signalWinRate !== null && metrics.performanceSample >= 6 && signalWinRate < 45;

  if (!enoughHistory) {
    return {
      version: GUIDANCE_VERSION,
      shouldTrade: false,
      action: "Wait for history",
      plan: "Abhi recent history complete nahi hai. 2m aur 5m data build hone do.",
      risk: "HIGH",
      reason: "insufficient_history",
    };
  }

  if (performanceWeak) {
    return {
      version: GUIDANCE_VERSION,
      shouldTrade: false,
      action: "Avoid for now",
      plan: "Is signal type ki recent live performance weak rahi hai. Better setup ka wait karo.",
      risk: "HIGH",
      reason: "weak_live_performance",
    };
  }

  if (normalized === "BREAKOUT_LONG") {
    return {
      version: GUIDANCE_VERSION,
      shouldTrade: strength === "STRONG",
      action: strength === "STRONG" ? "LONG trade dekh sakte ho" : "Confirmation ka wait karo",
      plan: metrics.nearHigh
        ? "Price breakout zone par hai. Entry tab lo jab candle range ke upar hold kare aur spread tight ho."
        : "Momentum bullish hai, lekin breakout hold confirm karo.",
      risk: strength === "STRONG" ? "MEDIUM" : "HIGH",
      reason: "breakout_long",
    };
  }

  if (normalized === "BREAKOUT_SHORT") {
    return {
      version: GUIDANCE_VERSION,
      shouldTrade: strength === "STRONG",
      action: strength === "STRONG" ? "SHORT trade dekh sakte ho" : "Confirmation ka wait karo",
      plan: metrics.nearLow
        ? "Price breakdown zone par hai. Short tab lo jab candle range ke niche sustain kare aur spread tight ho."
        : "Momentum bearish hai, lekin breakdown hold confirm karo.",
      risk: strength === "STRONG" ? "MEDIUM" : "HIGH",
      reason: "breakout_short",
    };
  }

  if (normalized === "REVERSAL_LONG") {
    return {
      version: GUIDANCE_VERSION,
      shouldTrade: strength === "STRONG",
      action: strength === "STRONG" ? "Aggressive long possible" : "Abhi wait karo",
      plan: "Reversal signal hai. Entry tab lo jab next candle higher low ya reclaim confirm kare.",
      risk: "HIGH",
      reason: "reversal_long",
    };
  }

  if (normalized === "REVERSAL_SHORT") {
    return {
      version: GUIDANCE_VERSION,
      shouldTrade: strength === "STRONG",
      action: strength === "STRONG" ? "Aggressive short possible" : "Abhi wait karo",
      plan: "Reversal short hai. Entry tab lo jab next candle lower high ya rejection confirm kare.",
      risk: "HIGH",
      reason: "reversal_short",
    };
  }

  if (normalized === "BULLISH") {
    return {
      version: GUIDANCE_VERSION,
      shouldTrade: strength === "STRONG" && toNumber(metrics.change2m) > 0.3,
      action: strength === "STRONG" && toNumber(metrics.change2m) > 0.3 ? "Dip buy dekh sakte ho" : "Watch rakho",
      plan: "Trend up hai but full breakout nahi hai. Pullback ya fresh confirmation candle ka wait karo.",
      risk: "MEDIUM",
      reason: "bullish_trend",
    };
  }

  if (normalized === "BEARISH") {
    return {
      version: GUIDANCE_VERSION,
      shouldTrade: strength === "STRONG" && toNumber(metrics.change2m) < -0.3,
      action: strength === "STRONG" && toNumber(metrics.change2m) < -0.3 ? "Short on bounce dekh sakte ho" : "Watch rakho",
      plan: "Trend down hai but full breakdown nahi hai. Bounce reject hone ka wait karo.",
      risk: "MEDIUM",
      reason: "bearish_trend",
    };
  }

  return {
    version: GUIDANCE_VERSION,
    shouldTrade: false,
    action: "Trade mat lo abhi",
    plan: "Signal mixed hai. Watchlist me rakho aur clear breakout ya reversal ka wait karo.",
    risk: "LOW",
    reason: "watch_only",
  };
}

function buildSignalNote(signal, metrics) {
  if (!metrics.historyReady2m || !metrics.historyReady5m) {
    return "History build ho rahi hai. 2m aur 5m trend complete hone do.";
  }
  const directionText = toNumber(metrics.change2m) >= 0 ? "up" : "down";
  if (signal === "BREAKOUT_LONG") return `Short-term highs are being pressed with ${directionText} momentum.`;
  if (signal === "BREAKOUT_SHORT") return `Short-term lows are breaking with ${directionText} momentum.`;
  if (signal === "REVERSAL_LONG") return "Weak daily structure is bouncing with fresh upside acceleration.";
  if (signal === "REVERSAL_SHORT") return "Strong daily move is fading with fresh downside acceleration.";
  if (signal === "BULLISH") return "Recorded snapshots show aligned upside momentum across the last few minutes.";
  if (signal === "BEARISH") return "Recorded snapshots show aligned downside momentum across the last few minutes.";
  return "Momentum is mixed. Keep it on watch until direction becomes clearer.";
}

function getSignalLabel({ change30s, change2m, change5m, dayChange, nearHigh, nearLow, historyReady2m, historyReady5m }) {
  if (!historyReady2m || !historyReady5m) return "WATCH";

  const sameDirectionUp = change30s > 0 && change2m > 0 && change5m > 0;
  const sameDirectionDown = change30s < 0 && change2m < 0 && change5m < 0;
  const reversalUp = dayChange < -1.25 && change30s > 0.22 && change2m > 0.35;
  const reversalDown = dayChange > 1.25 && change30s < -0.22 && change2m < -0.35;

  if (sameDirectionUp && change30s >= 0.18 && change2m >= 0.4 && nearHigh) return "BREAKOUT_LONG";
  if (sameDirectionDown && change30s <= -0.18 && change2m <= -0.4 && nearLow) return "BREAKOUT_SHORT";
  if (reversalUp) return "REVERSAL_LONG";
  if (reversalDown) return "REVERSAL_SHORT";
  if (sameDirectionUp && change2m >= 0.2) return "BULLISH";
  if (sameDirectionDown && change2m <= -0.2) return "BEARISH";
  return "WATCH";
}

function buildTrendEntry(symbol, meta = {}, points = []) {
  if (!points.length) return null;

  const latest = points[points.length - 1];
  const window30s = computeWindowChange(points, 30_000);
  const window2m = computeWindowChange(points, 2 * 60_000);
  const window5m = computeWindowChange(points, 5 * 60_000);
  const prices = points.map((point) => point.price);
  const high = Math.max(...prices);
  const low = Math.min(...prices);
  const range = Math.max(high - low, latest.price * 0.0001);
  const nearHigh = high > 0 ? (high - latest.price) / high <= 0.0018 : false;
  const nearLow = low > 0 ? (latest.price - low) / low <= 0.0018 : false;
  const change30s = window30s.ready ? window30s.value : null;
  const change2m = window2m.ready ? window2m.value : null;
  const change5m = window5m.ready ? window5m.value : null;
  const dayChange = Number(toNumber(meta.priceChangePercent).toFixed(2));
  const acceleration = change30s !== null && change2m !== null ? Number((change30s - (change2m - change30s)).toFixed(3)) : null;
  const spreadBps = Number.isFinite(meta.spreadBps) ? meta.spreadBps : null;
  const historyReady2m = window2m.ready;
  const historyReady5m = window5m.ready;
  const signal = getSignalLabel({
    change30s: toNumber(change30s),
    change2m: toNumber(change2m),
    change5m: toNumber(change5m),
    dayChange,
    nearHigh,
    nearLow,
    historyReady2m,
    historyReady5m,
  });

  const rawMomentumScore =
    toNumber(change30s) * 2.8 +
    toNumber(change2m) * 1.7 +
    toNumber(change5m) * 1.15 +
    clamp(dayChange, -12, 12) * 0.18 +
    toNumber(acceleration) * 1.2 -
    toNumber(spreadBps) * 0.08;
  const momentumScore = Number(rawMomentumScore.toFixed(2));
  const absoluteScore = Math.abs(momentumScore);
  const strength = historyReady2m && historyReady5m
    ? absoluteScore >= 2.8 ? "STRONG" : absoluteScore >= 1.35 ? "MODERATE" : "EARLY"
    : "BUILDING";
  const recordedSeconds = Math.max(0, Math.round((latest.ts - points[0].ts) / 1000));
  const signalBucket = state.performance.bySignal[String(signal || "").toUpperCase()] || { total: 0, wins: 0, losses: 0, neutrals: 0 };
  const guidance = buildGuidance(signal, strength, {
    change2m,
    nearHigh,
    nearLow,
    historyReady2m,
    historyReady5m,
    performanceSample: signalBucket.total,
  });

  return {
    symbol,
    price: latest.price,
    priceChangePercent24h: dayChange,
    signal,
    strength,
    momentumScore,
    change30s,
    change2m,
    change5m,
    acceleration,
    recordedPoints: points.length,
    recordedSeconds,
    rangePercent: Number(((range / latest.price) * 100).toFixed(3)),
    nearHigh,
    nearLow,
    historyReady2m,
    historyReady5m,
    spreadBps,
    quoteVolume24h: toNumber(meta.quoteVolume),
    tradeCount24h: toNumber(meta.count || meta.tradeCount),
    activityScore: Number(computeActivityScore(meta).toFixed(2)),
    candidateScore: Number(toNumber(meta.candidateScore).toFixed(2)),
    note: buildSignalNote(signal, { change2m, historyReady2m, historyReady5m }),
    guidance,
    performance: {
      sampleSize: signalBucket.total,
      winRate: signalBucket.total ? Number(((signalBucket.wins / signalBucket.total) * 100).toFixed(1)) : null,
    },
    updatedAt: new Date(latest.ts).toISOString(),
  };
}

function buildEntries() {
  return state.universe
    .map((symbol) => buildTrendEntry(symbol, state.metaBySymbol[symbol], state.historyBySymbol[symbol] || []))
    .filter(Boolean);
}

function getLatestPrice(symbol) {
  const points = state.historyBySymbol[symbol] || [];
  return points.length ? points[points.length - 1].price : null;
}

function applyOutcome(signal, outcome) {
  const normalized = String(signal || "WATCH").toUpperCase();
  if (!state.performance.bySignal[normalized]) {
    state.performance.bySignal[normalized] = { wins: 0, losses: 0, neutrals: 0, total: 0 };
  }
  const bucket = state.performance.bySignal[normalized];
  bucket.total += 1;
  bucket[outcome] += 1;
  state.performance.overall.total += 1;
  state.performance.overall[outcome] += 1;
  state.performance.lastEvaluatedAt = new Date().toISOString();
}

function evaluateRecommendations(entries = [], nowMs = Date.now()) {
  const currentKeys = new Set();
  const currentEntriesByKey = new Map();

  for (const entry of entries) {
    const key = `${entry.symbol}|${entry.signal}`;
    if (entry.guidance?.shouldTrade) {
      currentKeys.add(key);
      currentEntriesByKey.set(key, entry);
      if (!state.activeRecommendations[key]) {
        state.activeRecommendations[key] = {
          symbol: entry.symbol,
          signal: entry.signal,
          openedAt: nowMs,
          entryPrice: entry.price,
          direction: getDirectionForSignal(entry.signal),
        };
      }
    }
  }

  for (const [key, recommendation] of Object.entries({ ...state.activeRecommendations })) {
    const currentEntry = currentEntriesByKey.get(key);
    const latestPrice = currentEntry?.price ?? getLatestPrice(recommendation.symbol);
    if (!Number.isFinite(latestPrice) || !Number.isFinite(recommendation.entryPrice) || !recommendation.entryPrice) {
      continue;
    }

    const ageMs = nowMs - recommendation.openedAt;
    const movePct = (((latestPrice - recommendation.entryPrice) / recommendation.entryPrice) * 100) * recommendation.direction;
    const disappeared = !currentKeys.has(key);
    const matured = ageMs >= EVALUATION_WINDOW_MS;
    const decisive = movePct >= WIN_THRESHOLD_PCT || movePct <= LOSS_THRESHOLD_PCT;

    if (!disappeared && !matured && !decisive) {
      continue;
    }

    let outcome = "neutrals";
    if (movePct >= WIN_THRESHOLD_PCT) outcome = "wins";
    else if (movePct <= LOSS_THRESHOLD_PCT) outcome = "losses";

    applyOutcome(recommendation.signal, outcome);
    delete state.activeRecommendations[key];
  }
}

async function refreshUniverse(nowMs = Date.now()) {
  if (state.universe.length && nowMs - state.lastUniverseAt < UNIVERSE_REFRESH_MS) {
    return;
  }

  const [tickerStats, bookTickers] = await Promise.all([getAllTickerStats(), getBookTickers()]);
  const bookMap = bookTickers.reduce((accumulator, ticker) => {
    accumulator[ticker.symbol] = ticker;
    return accumulator;
  }, {});

  const scored = tickerStats
    .filter((ticker) => String(ticker.symbol || "").toUpperCase().endsWith("USDT"))
    .map((ticker) => {
      const symbol = String(ticker.symbol || "").toUpperCase();
      const activityScore = computeActivityScore(ticker);
      const book = bookMap[symbol] || {};
      const spreadBps = Number.isFinite(book.spreadBps) ? book.spreadBps : 25;
      const candidateScore = activityScore - spreadBps * 7 + (spreadBps <= 6 ? 12 : 0) + (toNumber(ticker.quoteVolume) >= 20_000_000 ? 10 : 0);
      return { ...ticker, symbol, spreadBps, candidateScore, bid: book.bid ?? null, ask: book.ask ?? null, mid: book.mid ?? null };
    })
    .filter((ticker) => ticker.spreadBps === null || ticker.spreadBps <= 35)
    .sort((left, right) => right.candidateScore - left.candidateScore)
    .slice(0, MAX_SYMBOLS);

  if (!scored.length) {
    return;
  }

  state.universe = scored.map((ticker) => ticker.symbol);
  state.metaBySymbol = scored.reduce((accumulator, ticker) => {
    accumulator[ticker.symbol] = ticker;
    return accumulator;
  }, {});
  state.lastUniverseAt = nowMs;
}

async function collectSample() {
  const nowMs = Date.now();
  await refreshUniverse(nowMs);

  if (!state.universe.length) {
    state.lastError = "No Binance futures symbols available for live recorder";
    return;
  }

  const prices = await getPrices(state.universe);
  const nextHistory = { ...state.historyBySymbol };

  for (const symbol of state.universe) {
    const price = toNumber(prices[symbol]);
    if (!price) continue;
    const current = Array.isArray(nextHistory[symbol]) ? nextHistory[symbol] : [];
    const lastPoint = current[current.length - 1];
    if (lastPoint && nowMs - lastPoint.ts < SAMPLE_INTERVAL_MS * 0.7) continue;
    nextHistory[symbol] = trimHistory([...current, { ts: nowMs, price }], nowMs);
  }

  state.historyBySymbol = nextHistory;
  state.lastSampleAt = nowMs;
  state.lastError = null;

  const entries = buildEntries();
  evaluateRecommendations(entries, nowMs);
}

async function ensureFreshSample() {
  const nowMs = Date.now();
  if (state.samplingPromise) {
    return state.samplingPromise;
  }

  if (state.lastSampleAt && nowMs - state.lastSampleAt < SAMPLE_INTERVAL_MS && Object.keys(state.historyBySymbol).length) {
    return;
  }

  state.samplingPromise = (async () => {
    try {
      await collectSample();
    } catch (error) {
      state.lastError = error.message;
    } finally {
      state.samplingPromise = null;
    }
  })();

  return state.samplingPromise;
}

function start() {
  if (state.running) return getStatus();
  state.running = true;
  state.timer = setInterval(() => {
    collectSample().catch((error) => {
      state.lastError = error.message;
    });
  }, SAMPLE_INTERVAL_MS);
  collectSample().catch((error) => {
    state.lastError = error.message;
  });
  return getStatus();
}

function stop() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  state.running = false;
  return getStatus();
}

function getStatus() {
  return {
    running: state.running,
    sampleIntervalMs: SAMPLE_INTERVAL_MS,
    universeSize: state.universe.length,
    lastSampleAt: state.lastSampleAt ? new Date(state.lastSampleAt).toISOString() : null,
    lastError: state.lastError,
    guidanceVersion: GUIDANCE_VERSION,
  };
}

async function getLiveTrendScanner({ limit = 12 } = {}) {
  if (!state.running) start();
  await ensureFreshSample();

  const entries = buildEntries()
    .sort((left, right) => {
      const tradeRankLeft = left.guidance?.shouldTrade ? 1 : 0;
      const tradeRankRight = right.guidance?.shouldTrade ? 1 : 0;
      return tradeRankRight - tradeRankLeft || Math.abs(right.momentumScore) - Math.abs(left.momentumScore) || right.candidateScore - left.candidateScore;
    })
    .slice(0, Math.max(1, Math.min(Number(limit || 12), MAX_SYMBOLS)));

  const summary = entries.reduce((accumulator, entry) => {
    accumulator.total += 1;
    if (entry.signal.includes("LONG") || entry.signal === "BULLISH") accumulator.bullish += 1;
    if (entry.signal.includes("SHORT") || entry.signal === "BEARISH") accumulator.bearish += 1;
    if (entry.signal.startsWith("BREAKOUT")) accumulator.breakouts += 1;
    if (entry.signal.startsWith("REVERSAL")) accumulator.reversals += 1;
    if (entry.signal === "WATCH") accumulator.watch += 1;
    if (entry.guidance?.shouldTrade) accumulator.actionable += 1;
    return accumulator;
  }, { total: 0, bullish: 0, bearish: 0, breakouts: 0, reversals: 0, watch: 0, actionable: 0 });

  const overall = state.performance.overall;
  const performance = {
    overall: {
      ...overall,
      winRate: overall.total ? Number(((overall.wins / overall.total) * 100).toFixed(1)) : null,
    },
    bySignal: state.performance.bySignal,
    lastEvaluatedAt: state.performance.lastEvaluatedAt,
  };

  return {
    summary,
    performance,
    recorder: {
      sampleIntervalMs: SAMPLE_INTERVAL_MS,
      universeSize: state.universe.length,
      historyWindowMinutes: Math.round(HISTORY_WINDOW_MS / 60_000),
      lastSampleAt: state.lastSampleAt ? new Date(state.lastSampleAt).toISOString() : null,
      lastError: state.lastError,
      running: state.running,
      guidanceVersion: GUIDANCE_VERSION,
    },
    trends: entries,
  };
}

module.exports = {
  getLiveTrendScanner,
  getStatus,
  start,
  stop,
};
