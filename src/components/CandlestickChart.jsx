import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "../lib/api";

const CRYPTO_TIMEFRAMES = ["1m","5m","15m","1h","4h","12h","1d"];
const STOCK_TIMEFRAMES  = ["1m","5m","15m","30m","1h","4h","1d"];

// ─── EMA calculation ──────────────────────────────────────────────────────────
function calcEMA(closes, period) {
  if (closes.length < period) return [];
  const k = 2 / (period + 1);
  const result = new Array(closes.length).fill(null);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result[period - 1] = ema;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
    result[i] = ema;
  }
  return result;
}

// ─── Bollinger Bands ──────────────────────────────────────────────────────────
function calcBB(closes, period = 20, stdDev = 2) {
  const upper = [], middle = [], lower = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) { upper.push(null); middle.push(null); lower.push(null); continue; }
    const slice = closes.slice(i - period + 1, i + 1);
    const mean  = slice.reduce((a, b) => a + b, 0) / period;
    const std   = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period);
    upper.push(mean + std * stdDev);
    middle.push(mean);
    lower.push(mean - std * stdDev);
  }
  return { upper, middle, lower };
}

// ─── RSI ─────────────────────────────────────────────────────────────────────
function calcRSI(closes, period = 14) {
  const result = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return result;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  result[period] = 100 - 100 / (1 + avgGain / (avgLoss || 0.0001));
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
    result[i] = 100 - 100 / (1 + avgGain / (avgLoss || 0.0001));
  }
  return result;
}

// ─── Volume color ─────────────────────────────────────────────────────────────
function volColor(candle, alpha = 0.7) {
  return candle.close >= candle.open
    ? `rgba(52,211,153,${alpha})`
    : `rgba(248,113,113,${alpha})`;
}

const COLORS = {
  bg:        "#0e0e16",
  grid:      "rgba(255,255,255,0.06)",
  text:      "rgba(255,255,255,0.45)",
  textBright:"rgba(255,255,255,0.85)",
  bull:      "#34d399",
  bear:      "#f87171",
  ema9:      "#f59e0b",
  ema21:     "#818cf8",
  ema50:     "#38bdf8",
  bbUpper:   "rgba(139,92,246,0.6)",
  bbMiddle:  "rgba(139,92,246,0.3)",
  bbLower:   "rgba(139,92,246,0.6)",
  bbFill:    "rgba(139,92,246,0.06)",
  entry:     "#facc15",
  sl:        "#f87171",
  tp1:       "#34d399",
  tp2:       "#10b981",
  tp3:       "#059669",
  crosshair: "rgba(255,255,255,0.3)",
  rsiLine:   "#f59e0b",
  rsiOB:     "rgba(248,113,113,0.3)",
  rsiOS:     "rgba(52,211,153,0.3)",
};

export default function CandlestickChart({ coin, timeframe: initialTf = "15m", signal = null, onClose }) {
  const mainRef  = useRef(null);
  const rsiRef   = useRef(null);
  const volRef   = useRef(null);
  const [candles, setCandles]   = useState([]);
  const [tf, setTf]             = useState(initialTf);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(null);
  const [hover, setHover]       = useState(null);
  const [offset, setOffset]     = useState(0); // pan offset
  const [zoom, setZoom]         = useState(1);
  const isDragging = useRef(false);
  const dragStart  = useRef(0);
  const dragOffset = useRef(0);

  // ─── Fetch candles ──────────────────────────────────────────────────────────
  const fetchCandles = useCallback(async () => {
    if (!coin) return;
    setLoading(true);
    setError(null);
    try {
      const isStock = signal?.source === "SMART_ENGINE";
      let data;
      if (isStock) {
        const inst = signal?.scanMeta?.instrument;
        if (!inst?.token || !inst?.exchange) {
          throw new Error("Stock instrument token/exchange missing — cannot load chart.");
        }
        // Map frontend tf → SmartAPI days lookback
        const daysMap = { "1m": 2, "3m": 3, "5m": 3, "10m": 5, "15m": 5, "30m": 7, "1h": 10, "4h": 20, "1d": 60 };
        const days = daysMap[tf] || 5;
        data = await apiFetch(
          `/stocks/candles?exchange=${inst.exchange}&token=${inst.token}&interval=${tf}&days=${days}`
        );
      } else {
        data = await apiFetch(`/market/klines?symbol=${coin}&interval=${tf}&limit=200`);
      }
      setCandles(data.candles || []);
      setOffset(0);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [coin, tf, signal]);

  useEffect(() => { fetchCandles(); }, [fetchCandles]);

  // Auto-refresh every 30s
  useEffect(() => {
    const id = setInterval(fetchCandles, 30000);
    return () => clearInterval(id);
  }, [fetchCandles]);

  // ─── Draw Main Chart ────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = mainRef.current;
    if (!canvas || candles.length < 2) return;
    const ctx  = canvas.getContext("2d");
    const W    = canvas.width;
    const H    = canvas.height;
    const PAD  = { left: 70, right: 10, top: 20, bottom: 30 };
    const chartW = W - PAD.left - PAD.right;
    const chartH = H - PAD.top  - PAD.bottom;

    // Visible candles based on zoom + offset
    const baseVisible = Math.floor(80 / zoom);
    const visible = Math.max(20, Math.min(baseVisible, candles.length));
    const startIdx = Math.max(0, Math.min(candles.length - visible, candles.length - visible - offset));
    const slice    = candles.slice(startIdx, startIdx + visible);

    const closes = candles.map(c => c.close);
    const ema9   = calcEMA(closes, 9);
    const ema21  = calcEMA(closes, 21);
    const ema50  = calcEMA(closes, 50);
    const bb     = calcBB(closes, 20, 2);

    const sliceEma9  = ema9.slice(startIdx,  startIdx + visible);
    const sliceEma21 = ema21.slice(startIdx, startIdx + visible);
    const sliceEma50 = ema50.slice(startIdx, startIdx + visible);
    const sliceBbU   = bb.upper.slice(startIdx,  startIdx + visible);
    const sliceBbM   = bb.middle.slice(startIdx, startIdx + visible);
    const sliceBbL   = bb.lower.slice(startIdx,  startIdx + visible);

    // Price range
    const allPrices = slice.flatMap(c => [c.high, c.low]);
    const signalPrices = signal
      ? [signal.entry, signal.stopLoss, signal.tp1, signal.tp2, signal.tp3].filter(Number.isFinite)
      : [];
    [...signalPrices, ...sliceBbU.filter(Boolean), ...sliceBbL.filter(Boolean)].forEach(p => allPrices.push(p));

    const minP   = Math.min(...allPrices);
    const maxP   = Math.max(...allPrices);
    const range  = maxP - minP || 1;
    const padPct = 0.08;
    const lo     = minP - range * padPct;
    const hi     = maxP + range * padPct;

    const toY = p => PAD.top + chartH * (1 - (p - lo) / (hi - lo));
    const candleW = chartW / visible;
    const bodyW   = Math.max(1, candleW * 0.6);
    const toX     = i => PAD.left + i * candleW + candleW / 2;

    // Clear
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, W, H);

    // Grid
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth   = 1;
    const gridLines = 6;
    for (let i = 0; i <= gridLines; i++) {
      const y = PAD.top + (chartH / gridLines) * i;
      ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(W - PAD.right, y); ctx.stroke();
      const price = hi - ((hi - lo) / gridLines) * i;
      ctx.fillStyle   = COLORS.text;
      ctx.font        = "10px monospace";
      ctx.textAlign   = "right";
      ctx.fillText(price.toFixed(price > 100 ? 2 : 4), PAD.left - 4, y + 3);
    }

    // BB Fill
    ctx.beginPath();
    ctx.fillStyle = COLORS.bbFill;
    sliceBbU.forEach((v, i) => { if (v) i === 0 ? ctx.moveTo(toX(i), toY(v)) : ctx.lineTo(toX(i), toY(v)); });
    sliceBbL.slice().reverse().forEach((v, i) => { if (v) ctx.lineTo(toX(slice.length - 1 - i), toY(v)); });
    ctx.closePath(); ctx.fill();

    // BB Lines
    const drawLine = (data, color, dash = []) => {
      ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.setLineDash(dash);
      ctx.beginPath();
      let started = false;
      data.forEach((v, i) => {
        if (v === null) return;
        if (!started) { ctx.moveTo(toX(i), toY(v)); started = true; }
        else ctx.lineTo(toX(i), toY(v));
      });
      ctx.stroke(); ctx.setLineDash([]);
    };
    drawLine(sliceBbU,  COLORS.bbUpper, [3, 3]);
    drawLine(sliceBbM,  COLORS.bbMiddle, [2, 4]);
    drawLine(sliceBbL,  COLORS.bbLower, [3, 3]);

    // EMAs
    ctx.lineWidth = 1.5;
    drawLine(sliceEma9,  COLORS.ema9);
    drawLine(sliceEma21, COLORS.ema21);
    ctx.lineWidth = 2;
    drawLine(sliceEma50, COLORS.ema50);

    // Signal levels
    if (signal) {
      const drawLevel = (price, color, label) => {
        if (!Number.isFinite(price)) return;
        const y = toY(price);
        ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.setLineDash([6, 3]);
        ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(W - PAD.right, y); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = color;
        ctx.font = "bold 10px monospace";
        ctx.textAlign = "left";
        ctx.fillText(`${label}: ${price}`, PAD.left + 4, y - 3);
      };
      drawLevel(signal.entry,    COLORS.entry, "ENTRY");
      drawLevel(signal.stopLoss, COLORS.sl,    "SL");
      drawLevel(signal.tp1,      COLORS.tp1,   "TP1");
      drawLevel(signal.tp2,      COLORS.tp2,   "TP2");
      drawLevel(signal.tp3,      COLORS.tp3,   "TP3");
    }

    // Candles
    slice.forEach((c, i) => {
      const x     = toX(i);
      const oY    = toY(c.open);
      const cY    = toY(c.close);
      const hY    = toY(c.high);
      const lY    = toY(c.low);
      const bull  = c.close >= c.open;
      const color = bull ? COLORS.bull : COLORS.bear;

      // Wick
      ctx.strokeStyle = color; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, hY); ctx.lineTo(x, lY); ctx.stroke();

      // Body
      ctx.fillStyle = bull ? COLORS.bull : COLORS.bear;
      const bodyTop = Math.min(oY, cY);
      const bodyH   = Math.max(1, Math.abs(oY - cY));
      ctx.fillRect(x - bodyW / 2, bodyTop, bodyW, bodyH);
    });

    // Crosshair + hover info
    if (hover !== null && hover >= 0 && hover < slice.length) {
      const c = slice[hover];
      const x = toX(hover);
      ctx.strokeStyle = COLORS.crosshair; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(x, PAD.top); ctx.lineTo(x, H - PAD.bottom); ctx.stroke();
      ctx.setLineDash([]);

      // Tooltip
      const bull  = c.close >= c.open;
      const tipW  = 160, tipH = 90, tipX = x + 10 > W - tipW - 10 ? x - tipW - 10 : x + 10;
      ctx.fillStyle   = "rgba(15,15,25,0.92)";
      ctx.strokeStyle = bull ? COLORS.bull : COLORS.bear;
      ctx.lineWidth   = 1;
      ctx.beginPath(); ctx.roundRect(tipX, PAD.top + 4, tipW, tipH, 6); ctx.fill(); ctx.stroke();

      const fmt = n => Number.isFinite(n) ? (n > 100 ? n.toFixed(2) : n.toFixed(4)) : "-";
      const lines = [
        `O: ${fmt(c.open)}   C: ${fmt(c.close)}`,
        `H: ${fmt(c.high)}   L: ${fmt(c.low)}`,
        `Vol: ${(c.volume/1000).toFixed(1)}K`,
        new Date(c.openTime).toLocaleString("en-IN", { month:"short", day:"numeric", hour:"2-digit", minute:"2-digit", timeZone:"Asia/Kolkata" }),
      ];
      ctx.fillStyle = COLORS.textBright;
      ctx.font      = "11px monospace";
      ctx.textAlign = "left";
      lines.forEach((l, li) => ctx.fillText(l, tipX + 10, PAD.top + 22 + li * 18));
    }

    // Price axis current price
    const lastC = slice[slice.length - 1];
    if (lastC) {
      const y = toY(lastC.close);
      const bull = lastC.close >= lastC.open;
      ctx.fillStyle = bull ? COLORS.bull : COLORS.bear;
      ctx.beginPath(); ctx.roundRect(W - PAD.right - 65, y - 9, 65, 18, 3); ctx.fill();
      ctx.fillStyle = "#000"; ctx.font = "bold 10px monospace"; ctx.textAlign = "center";
      ctx.fillText(lastC.close.toFixed(lastC.close > 100 ? 2 : 4), W - PAD.right - 32, y + 4);
    }

    // Bottom time labels
    ctx.fillStyle = COLORS.text; ctx.font = "9px monospace"; ctx.textAlign = "center";
    const step = Math.max(1, Math.floor(visible / 6));
    slice.forEach((c, i) => {
      if (i % step !== 0) return;
      const d = new Date(c.openTime);
      const label = tf === "1d" ? d.toLocaleDateString("en-IN", {day:"2-digit",month:"short",timeZone:"Asia/Kolkata"})
        : d.toLocaleTimeString("en-IN", {hour:"2-digit", minute:"2-digit", timeZone:"Asia/Kolkata"});
      ctx.fillText(label, toX(i), H - 8);
    });

  }, [candles, hover, offset, signal, tf, zoom]);

  // ─── Volume Chart ───────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = volRef.current;
    if (!canvas || candles.length < 2) return;
    const ctx = canvas.getContext("2d");
    const W = canvas.width, H = canvas.height;
    const PAD = { left: 70, right: 10, top: 4, bottom: 16 };
    const chartW = W - PAD.left - PAD.right;
    const chartH = H - PAD.top - PAD.bottom;

    const baseVisible = Math.floor(80 / zoom);
    const visible  = Math.max(20, Math.min(baseVisible, candles.length));
    const startIdx = Math.max(0, Math.min(candles.length - visible, candles.length - visible - offset));
    const slice    = candles.slice(startIdx, startIdx + visible);

    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, W, H);

    const maxVol  = Math.max(...slice.map(c => c.volume));
    const barW    = chartW / visible;
    const bodyW   = Math.max(1, barW * 0.6);

    slice.forEach((c, i) => {
      const x = PAD.left + i * barW + barW / 2;
      const h = (c.volume / maxVol) * chartH;
      ctx.fillStyle = volColor(c, 0.6);
      ctx.fillRect(x - bodyW / 2, H - PAD.bottom - h, bodyW, h);
    });

    // Vol label
    ctx.fillStyle = COLORS.text; ctx.font = "9px monospace"; ctx.textAlign = "right";
    ctx.fillText("VOL", PAD.left - 4, H - PAD.bottom - 2);
  }, [candles, offset, zoom]);

  // ─── RSI Chart ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = rsiRef.current;
    if (!canvas || candles.length < 15) return;
    const ctx = canvas.getContext("2d");
    const W = canvas.width, H = canvas.height;
    const PAD = { left: 70, right: 10, top: 4, bottom: 16 };
    const chartW = W - PAD.left - PAD.right;
    const chartH = H - PAD.top - PAD.bottom;

    const baseVisible = Math.floor(80 / zoom);
    const visible  = Math.max(20, Math.min(baseVisible, candles.length));
    const startIdx = Math.max(0, Math.min(candles.length - visible, candles.length - visible - offset));

    const closes  = candles.map(c => c.close);
    const rsi     = calcRSI(closes, 14).slice(startIdx, startIdx + visible);

    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, W, H);

    // OB/OS zones
    const toY = v => PAD.top + chartH * (1 - (v - 0) / 100);
    ctx.fillStyle = COLORS.rsiOB;
    ctx.fillRect(PAD.left, toY(70), chartW, toY(100) - toY(70));
    ctx.fillStyle = COLORS.rsiOS;
    ctx.fillRect(PAD.left, toY(30), chartW, toY(0) - toY(30));

    // Lines at 70/50/30
    [70, 50, 30].forEach(v => {
      ctx.strokeStyle = v === 50 ? "rgba(255,255,255,0.2)" : "rgba(255,255,255,0.1)";
      ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(PAD.left, toY(v)); ctx.lineTo(W - PAD.right, toY(v)); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = COLORS.text; ctx.font = "9px monospace"; ctx.textAlign = "right";
      ctx.fillText(v, PAD.left - 4, toY(v) + 3);
    });

    // RSI line
    ctx.strokeStyle = COLORS.rsiLine; ctx.lineWidth = 1.5;
    ctx.beginPath();
    let started = false;
    rsi.forEach((v, i) => {
      if (v === null) return;
      const x = PAD.left + (i / visible) * chartW;
      if (!started) { ctx.moveTo(x, toY(v)); started = true; }
      else ctx.lineTo(x, toY(v));
    });
    ctx.stroke();

    // RSI label
    ctx.fillStyle = COLORS.rsiLine; ctx.font = "bold 9px monospace"; ctx.textAlign = "right";
    ctx.fillText("RSI", PAD.left - 4, PAD.top + 10);

    // Current RSI value
    const lastRsi = rsi.filter(Boolean).pop();
    if (lastRsi) {
      ctx.fillStyle = COLORS.rsiLine; ctx.font = "bold 10px monospace"; ctx.textAlign = "left";
      ctx.fillText(lastRsi.toFixed(1), PAD.left + 4, PAD.top + 10);
    }
  }, [candles, offset, zoom]);

  // ─── Mouse events for hover + pan ─────────────────────────────────────────
  const handleMouseMove = useCallback((e) => {
    const canvas = mainRef.current;
    if (!canvas) return;
    const rect  = canvas.getBoundingClientRect();
    const x     = e.clientX - rect.left;
    const PAD   = { left: 70, right: 10 };
    const chartW = canvas.width - PAD.left - PAD.right;
    const visible = Math.max(20, Math.min(Math.floor(80 / zoom), candles.length));
    const i = Math.floor((x - PAD.left) / (chartW / visible));
    setHover(i >= 0 && i < visible ? i : null);

    if (isDragging.current) {
      const dx    = e.clientX - dragStart.current;
      const candleW = chartW / visible;
      const newOffset = dragOffset.current + Math.round(dx / candleW);
      setOffset(Math.max(0, Math.min(candles.length - visible, newOffset)));
    }
  }, [candles.length, zoom]);

  const handleMouseDown = (e) => {
    isDragging.current = true;
    dragStart.current  = e.clientX;
    dragOffset.current = offset;
  };
  const handleMouseUp = () => { isDragging.current = false; };

  // ─── Touch events (mobile swipe = pan, pinch = zoom) ───────────────────────
  const touchStartX    = useRef(0);
  const touchStartDist = useRef(0);
  const touchStartZoom = useRef(1);

  const handleTouchStart = (e) => {
    if (e.touches.length === 1) {
      isDragging.current = true;
      dragStart.current  = e.touches[0].clientX;
      dragOffset.current = offset;
      touchStartX.current = e.touches[0].clientX;
    } else if (e.touches.length === 2) {
      // Pinch — record initial distance between two fingers
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      touchStartDist.current = Math.sqrt(dx * dx + dy * dy);
      touchStartZoom.current = zoom;
    }
  };

  const handleTouchMove = useCallback((e) => {
    e.preventDefault(); // prevent page scroll while panning chart
    const canvas = mainRef.current;
    if (!canvas) return;

    if (e.touches.length === 1 && isDragging.current) {
      // Single finger pan
      const PAD     = { left: 70, right: 10 };
      const chartW  = canvas.width - PAD.left - PAD.right;
      const visible = Math.max(20, Math.min(Math.floor(80 / zoom), candles.length));
      const dx      = e.touches[0].clientX - dragStart.current;
      const candleW = chartW / visible;
      const newOff  = dragOffset.current + Math.round(dx / candleW);
      setOffset(Math.max(0, Math.min(candles.length - visible, newOff)));

      // Hover position for tooltip
      const rect = canvas.getBoundingClientRect();
      const x    = e.touches[0].clientX - rect.left;
      const i    = Math.floor((x - PAD.left) / (chartW / visible));
      setHover(i >= 0 && i < visible ? i : null);

    } else if (e.touches.length === 2) {
      // Pinch zoom
      const dx   = e.touches[0].clientX - e.touches[1].clientX;
      const dy   = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const ratio = dist / (touchStartDist.current || 1);
      const newZoom = Math.max(0.3, Math.min(3, touchStartZoom.current * ratio));
      setZoom(newZoom);
    }
  }, [candles.length, zoom]);

  const handleTouchEnd = () => {
    isDragging.current = false;
    setHover(null);
  };

  const handleWheel = (e) => {
    e.preventDefault();
    setZoom(z => Math.max(0.3, Math.min(3, z + (e.deltaY < 0 ? 0.1 : -0.1))));
  };

  // ─── Keyboard ESC ──────────────────────────────────────────────────────────
  useEffect(() => {
    const fn = e => { if (e.key === "Escape") onClose?.(); };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [onClose]);

  const lastCandle = candles[candles.length - 1];
  const priceChange = candles.length >= 2
    ? ((candles[candles.length-1].close - candles[candles.length-2].close) / candles[candles.length-2].close * 100)
    : 0;

  return (
    <div className="chart-modal-backdrop" onClick={onClose}>
      <div className="chart-modal-box" onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="chart-header">
          <div className="chart-title-group">
            <span className="chart-symbol">{coin}</span>
            {lastCandle && (
              <>
                <span className="chart-price" style={{ color: priceChange >= 0 ? COLORS.bull : COLORS.bear }}>
                  {lastCandle.close > 100 ? lastCandle.close.toFixed(2) : lastCandle.close.toFixed(4)}
                </span>
                <span className="chart-change" style={{ color: priceChange >= 0 ? COLORS.bull : COLORS.bear }}>
                  {priceChange >= 0 ? "▲" : "▼"} {Math.abs(priceChange).toFixed(2)}%
                </span>
              </>
            )}
          </div>

          <div className="chart-tf-group">
            {(signal?.source === "SMART_ENGINE" ? STOCK_TIMEFRAMES : CRYPTO_TIMEFRAMES).map(t => (
              <button
                key={t}
                className={`chart-tf-btn${tf === t ? " active" : ""}`}
                onClick={() => setTf(t)}
              >{t}</button>
            ))}
          </div>

          <div className="chart-legend">
            <span style={{ color: COLORS.ema9 }}>● EMA9</span>
            <span style={{ color: COLORS.ema21 }}>● EMA21</span>
            <span style={{ color: COLORS.ema50 }}>● EMA50</span>
            <span style={{ color: COLORS.bbUpper }}>● BB</span>
          </div>

          <button className="chart-close-btn" onClick={onClose}>✕</button>
        </div>

        {/* Chart area */}
        <div className="chart-body">
          {loading && (
            <div className="chart-loading">
              <div className="chart-spinner" />
              <span>Loading {coin} {tf}…</span>
            </div>
          )}
          {error && (
            <div className="chart-error">⚠ {error}</div>
          )}
          {!loading && !error && (
            <>
              <canvas
                ref={mainRef}
                width={900} height={380}
                className="chart-canvas"
                style={{ cursor: isDragging.current ? "grabbing" : "crosshair", touchAction: "none" }}
                onMouseMove={handleMouseMove}
                onMouseDown={handleMouseDown}
                onMouseUp={handleMouseUp}
                onMouseLeave={() => { setHover(null); isDragging.current = false; }}
                onWheel={handleWheel}
                onTouchStart={handleTouchStart}
                onTouchMove={handleTouchMove}
                onTouchEnd={handleTouchEnd}
              />
              <canvas ref={volRef} width={900} height={60} className="chart-canvas chart-vol" />
              <canvas ref={rsiRef} width={900} height={70} className="chart-canvas chart-rsi" />
            </>
          )}
        </div>

        {/* Signal info bar */}
        {signal && (
          <div className="chart-signal-bar">
            <span className={`pill ${signal.side === "LONG" ? "pill-success" : "pill-danger"}`}>{signal.side}</span>
            <span style={{ color: COLORS.entry }}>Entry: {signal.entry}</span>
            <span style={{ color: COLORS.sl }}>SL: {signal.stopLoss}</span>
            <span style={{ color: COLORS.tp1 }}>TP1: {signal.tp1}</span>
            <span style={{ color: COLORS.tp2 }}>TP2: {signal.tp2}</span>
            <span style={{ color: COLORS.tp3 }}>TP3: {signal.tp3}</span>
            <span style={{ color: "#a78bfa" }}>Conf: {signal.confidence}%</span>
          </div>
        )}

        <div className="chart-hint">Scroll to zoom · Drag to pan · ESC to close</div>
      </div>
    </div>
  );
}
