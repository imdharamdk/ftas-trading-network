	/**
	 * FTAS Diagnose Script
	 * Run from project root: node backend/scripts/diagnose.js
	 */
	require("dotenv").config({ path: require("path").join(__dirname, "../.env") });

	const axios = require("axios");

	async function run() {
	  console.log("\n========== FTAS DIAGNOSIS ==========\n");

	  // 1. Binance connectivity
	  console.log("1. Binance API check...");
	  try {
	    const r = await axios.get("https://fapi.binance.com/fapi/v1/ticker/price?symbol=BTCUSDT", { timeout: 5000 });
	    console.log("   OK Binance ONLINE - BTC price:", r.data.price);
	  } catch (e) {
	    console.log("   WARN Binance OFFLINE:", e.message);
	    console.log("   -> Mock candle fallback will be used");
	  }

	  // 2. Signals in DB
	  console.log("\n2. Signals in database...");
	  const { readCollection, mutateCollection } = require("../storage/fileStore");
	  const signals = await readCollection("signals");
	  const active  = signals.filter(s => s.status === "ACTIVE");
	  const closed  = signals.filter(s => s.status !== "ACTIVE");
	  console.log("   Total:", signals.length, "| Active:", active.length, "| Closed/Expired:", closed.length);
	  active.forEach(s =>
	    console.log("   ACTIVE:", s.coin, s.side, s.timeframe, "conf:" + s.confidence)
	  );

	  // 3. User signal access
	  console.log("\n3. Users & Signal Access...");
	  const { hasSignalAccess } = require("../models/User");
	  const users = await readCollection("users");
	  users.forEach(u => {
	    const access = hasSignalAccess(u);
	    console.log("  ", access ? "OK" : "NO ACCESS", u.email, "| role:" + u.role, "plan:" + u.plan, "status:" + u.subscriptionStatus, "access:" + access);
	  });

	  // 4. Mock candle TF variance check
	  console.log("\n4. Mock candle timeframe variance check (BTC)...");
	  const { getKlines } = require("../services/binanceService");
	  const { analyzeCandles } = require("../services/indicatorEngine");
	  const TFS = ["1m", "5m", "15m", "1h", "4h", "12h", "1d"];
	  const prices = [];
	  for (const tf of TFS) {
	    const c = await getKlines("BTCUSDT", tf, 250);
	    const a = analyzeCandles(c);
	    prices.push(a.currentPrice);
	    console.log("  ", tf, "price:" + a.currentPrice.toFixed(2), "rsi:" + a.momentum.rsi?.toFixed(1), "dir:" + a.trend.direction);
	  }
	  const allSame = prices.every(p => Math.abs(p - prices[0]) < 0.01);
	  if (allSame) {
	    console.log("   PROBLEM: ALL TIMEFRAMES IDENTICAL - binanceService.js needs per-TF seeds!");
	  } else {
	    console.log("   OK: Timeframes have different data");
	  }

	  // 5. HTF bias per coin
	  console.log("\n5. HTF Bias per coin...");
	  const coins = ["BTCUSDT","ETHUSDT","BNBUSDT","SOLUSDT","XRPUSDT","ADAUSDT","DOGEUSDT","AVAXUSDT","LINKUSDT","DOTUSDT","MATICUSDT","TRXUSDT","LTCUSDT","ATOMUSDT","APTUSDT","NEARUSDT","ARBUSDT","OPUSDT","SUIUSDT","INJUSDT"];
	  let nonNeutral = 0;
	  for (const coin of coins) {
	    const [c4h, c1h] = await Promise.all([getKlines(coin,"4h",250), getKlines(coin,"1h",250)]);
	    const a4h = analyzeCandles(c4h);
	    const a1h = analyzeCandles(c1h);
	    const bull4H = a4h.trend.direction === "BULLISH" && (a4h.trend.adx||0) >= 18;
	    const bear4H = a4h.trend.direction === "BEARISH" && (a4h.trend.adx||0) >= 18;
	    const bull1H = a1h.trend.direction !== "BEARISH" || (a1h.momentum.rsi||0) >= 45;
	    const bear1H = a1h.trend.direction !== "BULLISH" || (a1h.momentum.rsi||100) <= 55;
	    const bias = (bull4H && bull1H) ? "BULLISH" : (bear4H && bear1H) ? "BEARISH" : "NEUTRAL";
	    if (bias !== "NEUTRAL") nonNeutral++;
	    console.log("  ", coin, bias, "| 4H:" + a4h.trend.direction + "(adx:" + a4h.trend.adx?.toFixed(0) + ")", "1H:" + a1h.trend.direction + "(rsi:" + a1h.momentum.rsi?.toFixed(0) + ")");
	  }
	  if (nonNeutral === 0) {
	    console.log("\n   PROBLEM: ALL coins NEUTRAL - getHTFBias in signalEngine.js needs updating!");
	  } else {
	    console.log("\n   OK:", nonNeutral + "/20 coins have valid bias");
	  }

	  // 6. Full scan
	  console.log("\n6. Running full signal scan (clearing old signals first)...");
	  await mutateCollection("signals", () => ({ records: [], value: 0 }));
	  const { scanNow } = require("../services/signalEngine");
	  try {
	    const result = await scanNow({ source: "DIAGNOSE" });
	    console.log("   Generated:", result.generatedSignals.length, "| Errors:", result.errors.length);
	    result.generatedSignals.forEach(s =>
	      console.log("   SIGNAL:", s.coin, s.side, s.timeframe, "conf:" + s.confidence, "entry:" + s.entry, "tp1:" + s.tp1, "sl:" + s.stopLoss)
	    );
	    if (result.errors.length) {
	      result.errors.slice(0, 5).forEach(e => console.log("   ERROR", e.coin + ":", e.message));
	    }
	    if (result.generatedSignals.length === 0) {
	      console.log("\n   PROBLEM: 0 signals - check steps above for which part is failing");
	    }
	  } catch (e) {
	    console.log("   CRASH:", e.message);
	    console.log(e.stack);
	  }

	  console.log("\n========== END ==========\n");
	}

	run().catch(e => {
	  console.error("FATAL:", e.message);
	  process.exit(1);
	});
