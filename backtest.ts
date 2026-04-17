import "dotenv/config";
import axios from "axios";
import { RSI, EMA, MACD, BollingerBands, ATR } from "technicalindicators";

interface Candle {
  timestamp?: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
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
function ruleBasedSignal(
  ind: ReturnType<typeof computeIndicators>,
): "BUY" | "SELL" | "HOLD" {
  const { price, rsi, ema50, ema200, macdLine, signalLine, histogram, bb } =
    ind;

  const bullishTrend = price > ema50 && ema50 > ema200;
  const bearishTrend = price < ema50 && ema50 < ema200;
  const macdCrossUp = macdLine > signalLine && histogram > 0;
  const macdCrossDown = macdLine < signalLine && histogram < 0;
  const rsiOversold = rsi < 45;
  const rsiOverbought = rsi > 60;
  const nearLowerBB = bb ? price <= bb.lower * 1.005 : false;
  const nearUpperBB = bb ? price >= bb.upper * 0.995 : false;

  // BUY: (Confirmed uptrend + MACD up) OR (MACD up + RSI oversold)
  if ((bullishTrend && macdCrossUp) || (macdCrossUp && rsiOversold))
    return "BUY";
  // SELL: (Confirmed downtrend + MACD down) OR (MACD down + RSI overbought)
  if ((bearishTrend && macdCrossDown) || (macdCrossDown && rsiOverbought))
    return "SELL";

  return "HOLD";
}

// ─── Backtest Function ──────────────────────────────────────────────────────
async function backtest(symbol: string, daysBack: number = 7) {
  console.log(
    `\n📊 Starting backtest for ${symbol} (last ${daysBack} days)...\n`,
  );

  try {
    // Fetch historical 15-minute candles
    // Note: limit=500 fetches the last 500 candles (~5.2 days if 15m)
    const market = await axios.get(
      `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=15m&limit=500`,
    );

    const candles: Candle[] = market.data.map((c: any) => ({
      timestamp: new Date(c[0]).toISOString(),
      open: parseFloat(c[1]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4]),
      volume: parseFloat(c[5]),
    }));

    if (candles.length < 220) {
      console.error(
        `❌ Not enough candle data (received ${candles.length}, need 220+)`,
      );
      return;
    }

    console.log(`✓ Fetched ${candles.length} candles`);
    console.log(
      `  From: ${candles[0].timestamp} → To: ${candles[candles.length - 1].timestamp}\n`,
    );

    // Test every 15 candles to see how signals evolve
    const testInterval = 15;
    let buySignals = 0;
    let sellSignals = 0;
    let holdSignals = 0;
    const signals: any[] = [];

    for (let i = 220; i < candles.length; i += testInterval) {
      const historySlice = candles.slice(0, i + 1);
      const ind = computeIndicators(historySlice);

      if (!ind.rsi || !ind.ema50 || !ind.ema200 || !ind.bb || !ind.atr) {
        continue;
      }

      const signal = ruleBasedSignal(ind);

      const emoji = signal === "BUY" ? "🟢" : signal === "SELL" ? "🔴" : "⚪";

      // Debug: Log detailed condition checks
      const bullishTrend = ind.price > ind.ema50 && ind.ema50 > ind.ema200;
      const bearishTrend = ind.price < ind.ema50 && ind.ema50 < ind.ema200;
      const macdCrossUp = ind.macdLine > ind.signalLine && ind.histogram > 0;
      const macdCrossDown = ind.macdLine < ind.signalLine && ind.histogram < 0;
      const rsiOversold = ind.rsi < 38;
      const rsiOverbought = ind.rsi > 65;
      const nearLowerBB = ind.bb ? ind.price <= ind.bb.lower * 1.005 : false;
      const nearUpperBB = ind.bb ? ind.price >= ind.bb.upper * 0.995 : false;

      const signalData = {
        timestamp: historySlice[i].timestamp,
        candle_index: i,
        price: ind.price,
        signal,
        rsi: ind.rsi,
        ema50: ind.ema50,
        ema200: ind.ema200,
        macdLine: ind.macdLine,
        macdSignal: ind.signalLine,
        macdHistogram: ind.histogram,
        volatility: {
          bullishTrend,
          bearishTrend,
          macdCrossUp,
          macdCrossDown,
          rsiOversold,
          rsiOverbought,
          nearLowerBB,
          nearUpperBB,
        },
      };

      signals.push(signalData);

      if (signal === "BUY") buySignals++;
      else if (signal === "SELL") sellSignals++;
      else holdSignals++;

      console.log(
        `${emoji} [${historySlice[i].timestamp}] ${signal.padEnd(4)} @ ${ind.price.toFixed(6)} | RSI: ${ind.rsi.toFixed(2)} | EMA50: ${ind.ema50.toFixed(6)} | EMA200: ${ind.ema200.toFixed(6)}`,
      );
    }

    console.log("\n📈 SUMMARY");
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`🟢 BUY signals:  ${buySignals}`);
    console.log(`🔴 SELL signals: ${sellSignals}`);
    console.log(`⚪ HOLD signals: ${holdSignals}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

    if (buySignals === 0 && sellSignals === 0) {
      console.log("\n⚠️  WARNING: No BUY or SELL signals generated!");
      console.log("   The conditions are too strict. Recent analysis:");

      // Show last condition state
      if (signals.length > 0) {
        const last_signal = signals[signals.length - 1];
        console.log(`\n   Last analysis (${last_signal.timestamp}):`);
        console.log(`     Price: ${last_signal.price.toFixed(6)}`);
        console.log(`     RSI: ${last_signal.rsi.toFixed(2)}`);
        console.log(`     EMA50: ${last_signal.ema50.toFixed(6)}`);
        console.log(`     EMA200: ${last_signal.ema200.toFixed(6)}`);
        console.log(
          `     Bullish Trend: ${last_signal.volatility.bullishTrend}`,
        );
        console.log(
          `     Bearish Trend: ${last_signal.volatility.bearishTrend}`,
        );
        console.log(
          `     MACD Cross Up: ${last_signal.volatility.macdCrossUp}`,
        );
        console.log(
          `     MACD Cross Down: ${last_signal.volatility.macdCrossDown}`,
        );
        console.log(
          `     RSI Oversold (<38): ${last_signal.volatility.rsiOversold}`,
        );
        console.log(
          `     RSI Overbought (>65): ${last_signal.volatility.rsiOverbought}`,
        );
      }
    } else {
      console.log("\n✅ System is generating signals correctly!");
    }

    // Show last 5 signals
    console.log(`\n📍 Last 5 signals:`);
    const lastFive = signals.slice(-5);
    lastFive.forEach((s) => {
      const emoji =
        s.signal === "BUY" ? "🟢" : s.signal === "SELL" ? "🔴" : "⚪";
      console.log(
        `   ${emoji} ${s.timestamp} → ${s.signal.padEnd(4)} @ ${s.price.toFixed(6)}`,
      );
    });
  } catch (error: any) {
    console.error("❌ Backtest failed:", error?.message ?? error);
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────
const symbol = process.argv[2]?.toUpperCase() || "BTCUSDT";
backtest(symbol);
