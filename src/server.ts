import "dotenv/config";
import express, { Request, Response } from "express";
import axios from "axios";
import cors from "cors";
import nodemailer from "nodemailer";
import { RSI, EMA, MACD, BollingerBands, ATR } from "technicalindicators";

const app = express();

app.use(cors());
app.use(express.json());

interface Params {
  symbol: string;
}

interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ─── Safe JSON extractor ────────────────────────────────────────────────────
// Handles cases where the LLM wraps its answer in ```json ... ``` markdown fences
function extractJSON(text: string): any {
  // Try raw parse first
  try {
    return JSON.parse(text.trim());
  } catch {
    // Strip markdown code fences and retry
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenceMatch) {
      try {
        return JSON.parse(fenceMatch[1].trim());
      } catch {}
    }
    // Last resort: grab the first {...} block
    const objectMatch = text.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      try {
        return JSON.parse(objectMatch[0]);
      } catch {}
    }
    return null;
  }
}

// ─── Technical indicator helpers ────────────────────────────────────────────
function last<T>(arr: T[]): T {
  return arr[arr.length - 1];
}

function computeIndicators(candles: Candle[]) {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);

  /* RSI(14) */
  const rsiValues = RSI.calculate({ values: closes, period: 14 });
  const rsi = last(rsiValues);

  /* EMA(50) & EMA(200) for trend direction */
  const ema50Values = EMA.calculate({ values: closes, period: 50 });
  const ema200Values = EMA.calculate({ values: closes, period: 200 });
  const ema50 = last(ema50Values);
  const ema200 = last(ema200Values);

  /* MACD(12,26,9) */
  const macdResult = MACD.calculate({
    values: closes,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });
  const macdLatest = last(macdResult);
  const macdLine = macdLatest?.MACD ?? 0;
  const signalLine = macdLatest?.signal ?? 0;
  const histogram = macdLatest?.histogram ?? 0;

  /* Bollinger Bands(20, 2) */
  const bbResult = BollingerBands.calculate({
    values: closes,
    period: 20,
    stdDev: 2,
  });
  const bb = last(bbResult);

  /* ATR(14) — used for dynamic SL/TP */
  const atrValues = ATR.calculate({
    high: highs,
    low: lows,
    close: closes,
    period: 14,
  });
  const atr = last(atrValues);

  /* Volume trend: compare last 5 bars average vs previous 5 bars average */
  const recentVol = candles.slice(-5).reduce((s, c) => s + c.volume, 0) / 5;
  const prevVol = candles.slice(-10, -5).reduce((s, c) => s + c.volume, 0) / 5;
  const volumeTrend =
    recentVol > prevVol * 1.2
      ? "rising"
      : recentVol < prevVol * 0.8
        ? "falling"
        : "neutral";

  const price = last(closes);

  return {
    price,
    rsi,
    ema50,
    ema200,
    macdLine,
    signalLine,
    histogram,
    bb,
    atr,
    volumeTrend,
  };
}

// ─── Rule-based pre-signal (sanity guard) ───────────────────────────────────
// Returns a suggested direction that the AI result is validated against.
function ruleBasedSignal(
  ind: ReturnType<typeof computeIndicators>,
): "BUY" | "SELL" | "HOLD" {
  const { price, rsi, ema50, ema200, macdLine, signalLine, histogram, bb } =
    ind;

  const bullishTrend = price > ema50 && ema50 > ema200;
  const bearishTrend = price < ema50 && ema50 < ema200;
  const macdCrossUp = macdLine > signalLine && histogram > 0;
  const macdCrossDown = macdLine < signalLine && histogram < 0;
  const rsiOversold = rsi < 38;
  const rsiOverbought = rsi > 65;
  const nearLowerBB = bb ? price <= bb.lower * 1.005 : false;
  const nearUpperBB = bb ? price >= bb.upper * 0.995 : false;

  // Strong BUY: trend up + MACD up + RSI oversold or near lower BB
  if (bullishTrend && macdCrossUp && (rsiOversold || nearLowerBB)) return "BUY";
  // Strong SELL: trend down + MACD down + RSI overbought or near upper BB
  if (bearishTrend && macdCrossDown && (rsiOverbought || nearUpperBB))
    return "SELL";

  return "HOLD";
}

// ─── AI Prediction  ─────────────────────────────────────────────────────────
async function getAIPrediction(
  symbol: string,
  ind: ReturnType<typeof computeIndicators>,
  ruleSignal: string,
) {
  const {
    price,
    rsi,
    ema50,
    ema200,
    macdLine,
    signalLine,
    histogram,
    bb,
    atr,
    volumeTrend,
  } = ind;

  // Dynamic SL/TP based on ATR (1× ATR for SL, 2× ATR for TP)
  const slDist = atr ? atr * 1.0 : price * 0.003;
  const tpDist = atr ? atr * 2.0 : price * 0.006;

  const prompt = `
You are a professional crypto trading analyst. Analyze the following technical data and produce a strict JSON signal.

=== MARKET DATA ===
Pair: ${symbol}
Current Price: ${price.toFixed(6)}
RSI(14): ${rsi.toFixed(2)}
EMA(50): ${ema50.toFixed(6)}
EMA(200): ${ema200.toFixed(6)}
MACD Line: ${macdLine.toFixed(6)}
MACD Signal: ${signalLine.toFixed(6)}
MACD Histogram: ${histogram.toFixed(6)}
Bollinger Upper: ${bb?.upper?.toFixed(6) ?? "N/A"}
Bollinger Middle: ${bb?.middle?.toFixed(6) ?? "N/A"}
Bollinger Lower: ${bb?.lower?.toFixed(6) ?? "N/A"}
ATR(14): ${atr?.toFixed(6) ?? "N/A"}
Volume Trend: ${volumeTrend}

=== RULE-BASED PRE-SIGNAL ===
The technical rules suggest: ${ruleSignal}
Your signal should AGREE with this unless you have strong evidence otherwise.

=== SIGNAL RULES ===
BUY conditions (ALL should hold):
  - Price > EMA50 > EMA200 (uptrend)
  - MACD histogram positive and crossing up
  - RSI < 65 (not overbought)
  - Price near or below Bollinger Lower band OR RSI < 40

SELL conditions (ALL should hold):
  - Price < EMA50 < EMA200 (downtrend)
  - MACD histogram negative and crossing down
  - RSI > 35 (not oversold)
  - Price near or above Bollinger Upper band OR RSI > 63

HOLD if conditions are mixed, conflicting, or unclear.

=== RISK MANAGEMENT ===
- Stop Loss distance: ~${slDist.toFixed(6)} (≈1× ATR)
- Take Profit distance: ~${tpDist.toFixed(6)} (≈2× ATR)
- For BUY: stopLoss = price - SL distance, takeProfit = price + TP distance
- For SELL: stopLoss = price + SL distance, takeProfit = price - TP distance
- For HOLD: stopLoss and takeProfit = 0

=== TASK ===
1. Decide: BUY, SELL, or HOLD
2. Calculate stopLoss and takeProfit based on rules above
3. Provide confidence (integer 0-100). Be conservative — only give high confidence (>75) when ALL conditions strongly align.
4. Provide a brief reason.

=== OUTPUT FORMAT ===
Respond ONLY with raw JSON. No markdown, no code fences, no explanation outside the JSON.

{
  "signal": "BUY | SELL | HOLD",
  "stopLoss": number,
  "takeProfit": number,
  "confidence": number,
  "reason": "short explanation"
}
`;

  const response = await axios.post("http://127.0.0.1:11434/api/generate", {
    model: "llama3",
    prompt,
    stream: false,
  });

  return response.data.response as string;
}

// ─── Signal validation guard ─────────────────────────────────────────────────
// Ensures the AI return values make physical sense.
function validatePrediction(pred: any, price: number): any {
  if (!pred || !["BUY", "SELL", "HOLD"].includes(pred.signal)) {
    return {
      signal: "HOLD",
      stopLoss: 0,
      takeProfit: 0,
      confidence: 0,
      reason: "Invalid AI response — defaulting to HOLD.",
    };
  }

  const sl = Number(pred.stopLoss) || 0;
  const tp = Number(pred.takeProfit) || 0;
  const sig = pred.signal as "BUY" | "SELL" | "HOLD";

  if (sig === "BUY") {
    if (sl >= price) {
      return {
        ...pred,
        stopLoss: price * 0.997,
        reason: pred.reason + " [SL corrected: was above entry]",
      };
    }
    if (tp <= price) {
      return {
        ...pred,
        takeProfit: price * 1.005,
        reason: pred.reason + " [TP corrected: was below entry]",
      };
    }
  }

  if (sig === "SELL") {
    if (sl <= price) {
      return {
        ...pred,
        stopLoss: price * 1.003,
        reason: pred.reason + " [SL corrected: was below entry]",
      };
    }
    if (tp >= price) {
      return {
        ...pred,
        takeProfit: price * 0.995,
        reason: pred.reason + " [TP corrected: was above entry]",
      };
    }
  }

  return pred;
}

// ─── Core signal generator (shared by route + scheduler) ────────────────────
async function generateSignal(symbol: string) {
  // Fetch 15-minute candles (500 is enough for EMA200 + all indicators)
  const market = await axios.get(
    `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=15m&limit=500`,
  );

  const candles: Candle[] = market.data.map((c: any) => ({
    open: parseFloat(c[1]),
    high: parseFloat(c[2]),
    low: parseFloat(c[3]),
    close: parseFloat(c[4]),
    volume: parseFloat(c[5]),
  }));

  if (candles.length < 220) {
    throw new Error("Not enough candle data to compute indicators.");
  }

  const ind = computeIndicators(candles);

  if (!ind.rsi || !ind.ema50 || !ind.ema200 || !ind.bb || !ind.atr) {
    throw new Error("Failed to compute one or more indicators.");
  }

  const ruleSignal = ruleBasedSignal(ind);
  const aiText = await getAIPrediction(symbol, ind, ruleSignal);
  const parsed = extractJSON(aiText);
  const validated = validatePrediction(parsed, ind.price);

  // Confidence gate
  if (
    validated.signal !== ruleSignal &&
    ruleSignal !== "HOLD" &&
    validated.confidence < 70
  ) {
    validated.signal = "HOLD";
    validated.stopLoss = 0;
    validated.takeProfit = 0;
    validated.reason += ` [Overridden to HOLD: AI confidence too low to contradict rule signal '${ruleSignal}']`;
  }

  const payload = {
    pair: symbol,
    timeframe: "15m",
    price: ind.price,
    indicators: {
      rsi: ind.rsi,
      ema50: ind.ema50,
      ema200: ind.ema200,
      macd: {
        line: ind.macdLine,
        signal: ind.signalLine,
        histogram: ind.histogram,
      },
      bollingerBands: {
        upper: ind.bb.upper,
        middle: ind.bb.middle,
        lower: ind.bb.lower,
      },
      atr: ind.atr,
      volumeTrend: ind.volumeTrend,
    },
    ruleBasedSignal: ruleSignal,
    aiPrediction: validated,
  };

  // Fire-and-forget email for BUY / SELL
  if (validated.signal === "BUY" || validated.signal === "SELL") {
    sendSignalEmail({
      symbol,
      price: ind.price,
      signal: validated.signal,
      stopLoss: validated.stopLoss,
      takeProfit: validated.takeProfit,
      confidence: validated.confidence,
      reason: validated.reason ?? "",
      ruleSignal,
      rsi: ind.rsi,
      ema50: ind.ema50,
      ema200: ind.ema200,
      atr: ind.atr,
      volumeTrend: ind.volumeTrend,
    }).catch((err) =>
      console.error(`[Email] Failed to send for ${symbol}:`, err.message),
    );
  }

  return payload;
}

// ─── Route ───────────────────────────────────────────────────────────────────
app.get("/signal/:symbol", async (req: Request<Params>, res: Response) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    const result = await generateSignal(symbol);
    res.json(result);
  } catch (error: any) {
    console.error(error?.message ?? error);
    res
      .status(500)
      .json({ error: "Failed to generate prediction", detail: error?.message });
  }
});

// ─── Email Transporter ───────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  host: process.env.MAIL_HOST ?? "smtp.gmail.com",
  port: Number(process.env.MAIL_PORT ?? 587),
  secure: false, // true for port 465, false for 587 (STARTTLS)
  auth: {
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS,
  },
});

async function sendSignalEmail(payload: {
  symbol: string;
  price: number;
  signal: string;
  stopLoss: number;
  takeProfit: number;
  confidence: number;
  reason: string;
  ruleSignal: string;
  rsi: number;
  ema50: number;
  ema200: number;
  atr: number;
  volumeTrend: string;
}) {
  const isBuy = payload.signal === "BUY";
  const color = isBuy ? "#00c853" : "#d50000";
  const emoji = isBuy ? "🟢" : "🔴";
  const riskNote = isBuy
    ? `Stop Loss <b>${payload.stopLoss.toFixed(6)}</b> | Take Profit <b>${payload.takeProfit.toFixed(6)}</b>`
    : `Stop Loss <b>${payload.stopLoss.toFixed(6)}</b> | Take Profit <b>${payload.takeProfit.toFixed(6)}</b>`;

  const html = `
  <div style="font-family:Arial,sans-serif;max-width:540px;margin:auto;border:1px solid #ddd;border-radius:10px;overflow:hidden">
    <div style="background:${color};padding:20px 24px;color:#fff">
      <h1 style="margin:0;font-size:22px">${emoji} ${payload.signal} Signal — ${payload.symbol}</h1>
      <p style="margin:6px 0 0;opacity:.85">AI Crypto Predictor · 15m chart</p>
    </div>
    <div style="padding:24px;background:#fafafa">
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <tr><td style="padding:8px 0;color:#555">Current Price</td><td style="text-align:right;font-weight:bold">${payload.price.toFixed(6)}</td></tr>
        <tr><td style="padding:8px 0;color:#555">Signal</td><td style="text-align:right;font-weight:bold;color:${color}">${payload.signal}</td></tr>
        <tr><td style="padding:8px 0;color:#555">Rule Engine</td><td style="text-align:right">${payload.ruleSignal}</td></tr>
        <tr><td style="padding:8px 0;color:#555">Confidence</td><td style="text-align:right">${payload.confidence}%</td></tr>
        <tr><td colspan="2" style="border-top:1px solid #eee;padding-top:10px"></td></tr>
        <tr><td style="padding:8px 0;color:#555">Stop Loss</td><td style="text-align:right;color:#d50000">${payload.stopLoss.toFixed(6)}</td></tr>
        <tr><td style="padding:8px 0;color:#555">Take Profit</td><td style="text-align:right;color:#00c853">${payload.takeProfit.toFixed(6)}</td></tr>
        <tr><td colspan="2" style="border-top:1px solid #eee;padding-top:10px"></td></tr>
        <tr><td style="padding:8px 0;color:#555">RSI(14)</td><td style="text-align:right">${payload.rsi.toFixed(2)}</td></tr>
        <tr><td style="padding:8px 0;color:#555">EMA(50)</td><td style="text-align:right">${payload.ema50.toFixed(6)}</td></tr>
        <tr><td style="padding:8px 0;color:#555">EMA(200)</td><td style="text-align:right">${payload.ema200.toFixed(6)}</td></tr>
        <tr><td style="padding:8px 0;color:#555">ATR(14)</td><td style="text-align:right">${payload.atr.toFixed(6)}</td></tr>
        <tr><td style="padding:8px 0;color:#555">Volume Trend</td><td style="text-align:right">${payload.volumeTrend}</td></tr>
      </table>
      <div style="margin-top:16px;padding:12px;background:#fff;border-left:4px solid ${color};border-radius:4px">
        <b style="font-size:13px">AI Reason:</b><br/><span style="color:#444;font-size:13px">${payload.reason}</span>
      </div>
    </div>
    <div style="padding:12px 24px;background:#f0f0f0;font-size:11px;color:#999;text-align:center">
      This is not financial advice. Always do your own research.
    </div>
  </div>
  `;

  await transporter.sendMail({
    from: `"Crypto Signal Bot" <${process.env.MAIL_USER}>`,
    to: process.env.MAIL_TO,
    subject: `${emoji} ${payload.signal} — ${payload.symbol} @ ${payload.price.toFixed(4)} | Confidence: ${payload.confidence}%`,
    html,
  });

  console.log(
    `[Email] ${payload.signal} alert sent for ${payload.symbol} to ${process.env.MAIL_TO}`,
  );
}

const PORT = Number(process.env.PORT ?? 3000);
app.listen(PORT, () => {
  console.log(`AI Crypto Predictor running on http://localhost:${PORT}`);

  // ─── Auto-Scheduler ────────────────────────────────────────────────────────
  // Set WATCH_SYMBOLS=BTCUSDT,ETHUSDT in .env (comma-separated, no spaces)
  // Set POLL_INTERVAL_MS=30000 for 30-second polling (default)
  const watchSymbols = (process.env.WATCH_SYMBOLS ?? "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  const intervalMs = Number(process.env.POLL_INTERVAL_MS ?? 30_000);

  if (watchSymbols.length === 0) {
    console.log(
      "[Scheduler] No WATCH_SYMBOLS set in .env — scheduler is disabled.",
    );
    console.log(
      "[Scheduler] To enable, add: WATCH_SYMBOLS=BTCUSDT,ETHUSDT to .env",
    );
    return;
  }

  console.log(
    `[Scheduler] Watching: ${watchSymbols.join(", ")} every ${intervalMs / 1000}s`,
  );

  // Run once immediately on startup, then every intervalMs
  const runAll = () => {
    const timestamp = new Date().toISOString();
    console.log(
      `\n[Scheduler] ⏱  ${timestamp} — scanning ${watchSymbols.length} symbol(s)...`,
    );
    for (const sym of watchSymbols) {
      generateSignal(sym)
        .then((r) => {
          const sig = r.aiPrediction.signal;
          const conf = r.aiPrediction.confidence;
          const emoji = sig === "BUY" ? "🟢" : sig === "SELL" ? "🔴" : "⚪";
          console.log(
            `[Scheduler] ${emoji} ${sym}: ${sig} (confidence: ${conf}%) @ ${r.price}`,
          );
        })
        .catch((err) =>
          console.error(`[Scheduler] ❌ ${sym} failed:`, err.message),
        );
    }
  };

  runAll(); // first run immediately
  setInterval(runAll, intervalMs);
});
