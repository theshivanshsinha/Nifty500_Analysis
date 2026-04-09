const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const SHORT_CACHE_TTL = 20 * 1000;
const LONG_CACHE_TTL = 30 * 1000;
const cacheStore = new Map();

function parseCsvLine(line) {
  const values = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      values.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }

  values.push(current.trim());
  return values;
}

async function withCache(key, ttlMs, fetcher) {
  const now = Date.now();
  const cached = cacheStore.get(key);

  if (cached && cached.expiresAt > now && cached.data !== undefined) {
    return cached.data;
  }

  if (cached && cached.pendingPromise) {
    return cached.pendingPromise;
  }

  const pendingPromise = fetcher()
    .then((data) => {
      cacheStore.set(key, {
        data,
        expiresAt: Date.now() + ttlMs,
      });
      return data;
    })
    .catch((error) => {
      cacheStore.delete(key);
      throw error;
    });

  cacheStore.set(key, { pendingPromise, expiresAt: now + ttlMs });
  return pendingPromise;
}

function clearTransientCache() {
  const now = Date.now();
  for (const [key, entry] of cacheStore.entries()) {
    if (entry.expiresAt < now && !entry.pendingPromise) {
      cacheStore.delete(key);
    }
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchYahooChart(symbol, interval = '1d', range = '1y') {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol
  )}?range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}`;

  const attempts = 3;
  let lastError;

  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          'user-agent': DEFAULT_UA,
          accept: 'application/json',
          referer: `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}`,
          'accept-language': 'en-US,en;q=0.9',
        },
      });

      if (response.status === 429) {
        throw new Error('Yahoo rate limit reached');
      }

      if (!response.ok) {
        throw new Error(`Yahoo chart request failed: ${response.status}`);
      }

      return response.json();
    } catch (error) {
      lastError = error;
      if (i < attempts - 1) {
        await wait(500 * (i + 1));
      }
    }
  }

  throw lastError || new Error('Failed to fetch chart');
}

async function fetchNifty500Constituents() {
  return withCache('nifty500:constituents', LONG_CACHE_TTL, async () => {
    const response = await fetch(
      'https://archives.nseindia.com/content/indices/ind_nifty500list.csv',
      { headers: { 'user-agent': DEFAULT_UA } }
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch Nifty 500 list: ${response.status}`);
    }

    const csvText = await response.text();
    const lines = csvText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    if (lines.length <= 1) {
      return [];
    }

    const headers = parseCsvLine(lines[0]).map((h) => h.toLowerCase());
    const symbolIdx = headers.findIndex((h) => h === 'symbol');
    const companyIdx = headers.findIndex((h) => h === 'company name');
    const sectorIdx = headers.findIndex((h) => h === 'industry' || h === 'sector');

    if (symbolIdx < 0) {
      throw new Error('NSE CSV format changed: symbol column missing');
    }

    return lines.slice(1).map((line) => {
      const cols = parseCsvLine(line);
      const rawSymbol = cols[symbolIdx];
      const symbol = rawSymbol.endsWith('.NS') ? rawSymbol : `${rawSymbol}.NS`;
      return {
        symbol,
        companyName: companyIdx >= 0 && cols[companyIdx] ? cols[companyIdx] : rawSymbol,
        sector: sectorIdx >= 0 && cols[sectorIdx] ? cols[sectorIdx] : 'Unknown',
      };
    });
  });
}

function parseGoogleNewsRss(xmlText) {
  const items = xmlText.match(/<item>[\s\S]*?<\/item>/g) || [];

  return items.slice(0, 10).map((item) => {
    const title = (item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || item.match(/<title>(.*?)<\/title>/) || [])[1] || '';
    const link = (item.match(/<link>(.*?)<\/link>/) || [])[1] || '';
    const pubDate = (item.match(/<pubDate>(.*?)<\/pubDate>/) || [])[1] || '';
    const source = (item.match(/<source[^>]*>(.*?)<\/source>/) || [])[1] || 'Google News';

    return {
      title,
      link,
      publisher: source,
      providerPublishTime: pubDate ? Math.floor(new Date(pubDate).getTime() / 1000) : Math.floor(Date.now() / 1000),
    };
  });
}

function normalizeQuoteFromChart(chartResult, symbol) {
  const meta = chartResult?.meta || {};
  const quote = chartResult?.indicators?.quote?.[0] || {};
  const close = quote.close || [];
  const open = quote.open || [];
  const high = quote.high || [];
  const low = quote.low || [];
  const volume = quote.volume || [];

  const lastClose = close[close.length - 1];
  const previousClose = meta.chartPreviousClose ?? close[close.length - 2];
  const marketPrice = meta.regularMarketPrice ?? lastClose;
  const marketChange = Number.isFinite(marketPrice) && Number.isFinite(previousClose) ? marketPrice - previousClose : null;
  const marketChangePercent =
    Number.isFinite(marketChange) && Number.isFinite(previousClose) && previousClose !== 0
      ? (marketChange / previousClose) * 100
      : null;

  return {
    symbol,
    shortName: meta.shortName || symbol,
    quoteType: meta.instrumentType || 'EQUITY',
    regularMarketPrice: marketPrice ?? null,
    regularMarketChange: marketChange,
    regularMarketChangePercent: marketChangePercent,
    regularMarketPreviousClose: previousClose ?? null,
    regularMarketOpen: open[open.length - 1] ?? null,
    regularMarketDayHigh: high[high.length - 1] ?? null,
    regularMarketDayLow: low[low.length - 1] ?? null,
    regularMarketVolume: volume[volume.length - 1] ?? null,
  };
}

function toHistoryRows(chartResult) {
  if (!chartResult?.timestamp?.length || !chartResult?.indicators?.quote?.[0]) {
    return [];
  }

  const quote = chartResult.indicators.quote[0];
  return chartResult.timestamp
    .map((ts, idx) => ({
      date: new Date(ts * 1000).toISOString(),
      open: quote.open?.[idx],
      high: quote.high?.[idx],
      low: quote.low?.[idx],
      close: quote.close?.[idx],
      volume: quote.volume?.[idx],
    }))
    .filter(
      (row) =>
        typeof row.open === 'number' &&
        typeof row.high === 'number' &&
        typeof row.low === 'number' &&
        typeof row.close === 'number'
    );
}

function ema(values, period) {
  const k = 2 / (period + 1);
  const out = [];
  let prev;
  values.forEach((v, idx) => {
    if (typeof v !== 'number') {
      out.push(null);
      return;
    }
    if (idx === 0 || prev === undefined) {
      prev = v;
    } else {
      prev = v * k + prev * (1 - k);
    }
    out.push(prev);
  });
  return out;
}

function sma(values, period) {
  return values.map((_, idx) => {
    if (idx + 1 < period) return null;
    const window = values.slice(idx + 1 - period, idx + 1).filter((v) => typeof v === 'number');
    if (window.length !== period) return null;
    return window.reduce((sum, v) => sum + v, 0) / period;
  });
}

function stdDev(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function calculateRsi(values, period = 14) {
  if (values.length <= period) return { latest: null, previous: null, series: [] };
  const changes = [];
  for (let i = 1; i < values.length; i += 1) {
    changes.push(values[i] - values[i - 1]);
  }

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 0; i < period; i += 1) {
    const c = changes[i];
    if (c > 0) avgGain += c;
    else avgLoss += Math.abs(c);
  }
  avgGain /= period;
  avgLoss /= period;

  const rsiSeries = new Array(period).fill(null);
  for (let i = period; i < changes.length; i += 1) {
    const c = changes[i];
    const gain = c > 0 ? c : 0;
    const loss = c < 0 ? Math.abs(c) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    const rsi = 100 - 100 / (1 + rs);
    rsiSeries.push(rsi);
  }

  return {
    latest: rsiSeries[rsiSeries.length - 1] ?? null,
    previous: rsiSeries[rsiSeries.length - 2] ?? null,
    series: rsiSeries,
  };
}

function calculateTechnicals(history) {
  const closes = history.map((h) => h.close);
  const volumes = history.map((h) => h.volume ?? 0);
  const ma50Series = sma(closes, 50);
  const ma200Series = sma(closes, 200);
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const macdSeries = ema12.map((v, idx) => (v !== null && ema26[idx] !== null ? v - ema26[idx] : null));
  const signalSeries = ema(macdSeries.map((v) => (typeof v === 'number' ? v : 0)), 9);
  const histogramSeries = macdSeries.map((v, idx) => (typeof v === 'number' ? v - signalSeries[idx] : null));
  const rsi = calculateRsi(closes, 14);

  const bbMiddle = sma(closes, 20);
  const bbUpper = closes.map((_, idx) => {
    if (idx + 1 < 20) return null;
    const window = closes.slice(idx + 1 - 20, idx + 1);
    if (window.some((v) => typeof v !== 'number')) return null;
    return bbMiddle[idx] + 2 * stdDev(window);
  });
  const bbLower = closes.map((_, idx) => {
    if (idx + 1 < 20) return null;
    const window = closes.slice(idx + 1 - 20, idx + 1);
    if (window.some((v) => typeof v !== 'number')) return null;
    return bbMiddle[idx] - 2 * stdDev(window);
  });

  const latestVolume = volumes[volumes.length - 1] ?? null;
  const avg20Volume =
    volumes.length >= 20
      ? volumes.slice(-20).reduce((sum, v) => sum + v, 0) / 20
      : null;

  return {
    rsi14: rsi.latest,
    rsi14Prev: rsi.previous,
    macd: macdSeries[macdSeries.length - 1] ?? null,
    macdSignal: signalSeries[signalSeries.length - 1] ?? null,
    macdHistogram: histogramSeries[histogramSeries.length - 1] ?? null,
    ma50: ma50Series[ma50Series.length - 1] ?? null,
    ma200: ma200Series[ma200Series.length - 1] ?? null,
    bollingerUpper: bbUpper[bbUpper.length - 1] ?? null,
    bollingerMiddle: bbMiddle[bbMiddle.length - 1] ?? null,
    bollingerLower: bbLower[bbLower.length - 1] ?? null,
    latestVolume,
    avg20Volume,
    series: {
      ma50: history.map((h, idx) => ({ date: h.date, value: ma50Series[idx] })).filter((x) => typeof x.value === 'number'),
      ma200: history.map((h, idx) => ({ date: h.date, value: ma200Series[idx] })).filter((x) => typeof x.value === 'number'),
      bbUpper: history.map((h, idx) => ({ date: h.date, value: bbUpper[idx] })).filter((x) => typeof x.value === 'number'),
      bbMiddle: history.map((h, idx) => ({ date: h.date, value: bbMiddle[idx] })).filter((x) => typeof x.value === 'number'),
      bbLower: history.map((h, idx) => ({ date: h.date, value: bbLower[idx] })).filter((x) => typeof x.value === 'number'),
    },
  };
}

function classifySentiment(text) {
  const t = text.toLowerCase();
  const bullishWords = ['surge', 'jump', 'beat', 'growth', 'up', 'rally', 'strong', 'outperform', 'buy'];
  const bearishWords = ['fall', 'drop', 'miss', 'weak', 'down', 'lawsuit', 'loss', 'underperform', 'sell', 'risk'];
  let score = 0;
  bullishWords.forEach((w) => {
    if (t.includes(w)) score += 1;
  });
  bearishWords.forEach((w) => {
    if (t.includes(w)) score -= 1;
  });
  if (score > 0) return 'bullish';
  if (score < 0) return 'bearish';
  return 'neutral';
}

function correlation(a, b) {
  if (!a.length || !b.length || a.length !== b.length) return null;
  const n = a.length;
  const meanA = a.reduce((s, v) => s + v, 0) / n;
  const meanB = b.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let denA = 0;
  let denB = 0;
  for (let i = 0; i < n; i += 1) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  const den = Math.sqrt(denA * denB);
  if (den === 0) return null;
  return num / den;
}

function calcStatsFromCloses(closes) {
  const cleanCloses = closes.filter((v) => typeof v === 'number');
  if (cleanCloses.length < 3) {
    return { returnPct: null, volatilityPct: null };
  }

  const start = cleanCloses[0];
  const end = cleanCloses[cleanCloses.length - 1];
  const returnPct = start !== 0 ? ((end - start) / start) * 100 : null;

  const dailyReturns = [];
  for (let i = 1; i < cleanCloses.length; i += 1) {
    if (cleanCloses[i - 1] !== 0) {
      dailyReturns.push((cleanCloses[i] - cleanCloses[i - 1]) / cleanCloses[i - 1]);
    }
  }

  if (dailyReturns.length < 2) {
    return { returnPct, volatilityPct: null };
  }

  const mean = dailyReturns.reduce((sum, item) => sum + item, 0) / dailyReturns.length;
  const variance =
    dailyReturns.reduce((sum, item) => sum + (item - mean) ** 2, 0) / (dailyReturns.length - 1);
  const dailyStd = Math.sqrt(variance);
  const annualizedVolatilityPct = dailyStd * Math.sqrt(252) * 100;

  return { returnPct, volatilityPct: annualizedVolatilityPct };
}

function buildTopMovers(rows) {
  const withReturn = rows.filter((row) => typeof row.returnPct === 'number');
  const sorted = [...withReturn].sort((a, b) => b.returnPct - a.returnPct);
  return {
    gainers: sorted.slice(0, 3),
    losers: sorted.slice(-3).reverse(),
  };
}

async function runWithConcurrency(items, worker, concurrency = 6) {
  const results = [];
  let idx = 0;

  async function next() {
    if (idx >= items.length) return;
    const current = idx;
    idx += 1;
    results[current] = await worker(items[current]);
    return next();
  }

  const starters = [];
  for (let i = 0; i < Math.min(concurrency, items.length); i += 1) {
    starters.push(next());
  }
  await Promise.all(starters);
  return results;
}

async function fetchMarketNewsByWindow(window) {
  const queryByWindow = {
    day: 'India stock market today important financial news',
    month: 'India stock market monthly outlook important financial news',
    year: 'India economy annual market outlook major financial headlines',
  };

  const query = queryByWindow[window] || queryByWindow.day;
  const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-IN&gl=IN&ceid=IN:en`;
  const response = await fetch(rssUrl, {
    headers: {
      'user-agent': DEFAULT_UA,
      accept: 'application/rss+xml,application/xml,text/xml',
    },
  });

  if (!response.ok) {
    throw new Error(`Market news fetch failed: ${response.status}`);
  }

  const xmlText = await response.text();
  return parseGoogleNewsRss(xmlText);
}

// Routes
app.get('/api/symbols', async (req, res) => {
  try {
    const data = await fetchNifty500Constituents();
    res.json(data);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch live symbols' });
  }
});

app.get('/api/sectors', async (req, res) => {
  try {
    const symbols = await fetchNifty500Constituents();
    const sectors = {};

    symbols.forEach((item) => {
      if (!sectors[item.sector]) sectors[item.sector] = [];
      sectors[item.sector].push({ symbol: item.symbol, companyName: item.companyName });
    });

    res.json(sectors);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch live sectors' });
  }
});

app.get('/api/news/market', async (req, res) => {
  try {
    const window = String(req.query.window || 'day').toLowerCase();
    const normalizedWindow = ['day', 'month', 'year'].includes(window) ? window : 'day';
    const news = await withCache(`news:market:${normalizedWindow}`, LONG_CACHE_TTL, () =>
      fetchMarketNewsByWindow(normalizedWindow)
    );
    res.json({ window: normalizedWindow, items: news });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch market news' });
  }
});

app.get('/api/analytics/sectors', async (req, res) => {
  try {
    const payload = await withCache('analytics:sectors', LONG_CACHE_TTL, async () => {
      const symbols = await fetchNifty500Constituents();
      const bySector = symbols.reduce((acc, item) => {
        if (!acc[item.sector]) acc[item.sector] = [];
        acc[item.sector].push(item);
        return acc;
      }, {});

      const sectorEntries = Object.entries(bySector);
      const sectorAnalytics = await runWithConcurrency(
        sectorEntries,
        async ([sectorName, constituents]) => {
          const sampleSymbols = constituents.slice(0, 8);
          const stockAnalytics = await runWithConcurrency(
            sampleSymbols,
            async (item) => {
              try {
                const chartPayload = await withCache(
                  `chart:${item.symbol}:1d:3mo`,
                  SHORT_CACHE_TTL,
                  () => fetchYahooChart(item.symbol, '1d', '3mo')
                );
                const chartResult = chartPayload?.chart?.result?.[0];
                const quote = normalizeQuoteFromChart(chartResult, item.symbol);
                const closes = chartResult?.indicators?.quote?.[0]?.close || [];
                const { returnPct, volatilityPct } = calcStatsFromCloses(closes);

                return {
                  symbol: item.symbol,
                  companyName: item.companyName,
                  regularMarketPrice: quote.regularMarketPrice,
                  regularMarketChangePercent: quote.regularMarketChangePercent,
                  returnPct,
                  volatilityPct,
                };
              } catch (error) {
                return null;
              }
            },
            4
          );

          const valid = stockAnalytics.filter(Boolean);
          const avgReturn =
            valid.length > 0
              ? valid
                  .map((v) => (typeof v.returnPct === 'number' ? v.returnPct : 0))
                  .reduce((sum, v) => sum + v, 0) / valid.length
              : null;
          const avgVolatility =
            valid.length > 0
              ? valid
                  .map((v) => (typeof v.volatilityPct === 'number' ? v.volatilityPct : 0))
                  .reduce((sum, v) => sum + v, 0) / valid.length
              : null;

          return {
            sector: sectorName,
            companies: constituents.length,
            sampleSize: valid.length,
            avgReturnPct: avgReturn,
            avgVolatilityPct: avgVolatility,
            topMovers: buildTopMovers(valid),
          };
        },
        3
      );

      const ranked = sectorAnalytics
        .filter(Boolean)
        .sort((a, b) => (b.avgReturnPct ?? -Infinity) - (a.avgReturnPct ?? -Infinity));

      return {
        generatedAt: new Date().toISOString(),
        sectors: ranked,
      };
    });

    res.json(payload);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch sector analytics' });
  }
});

app.get('/api/analytics/sector-heatmap', async (req, res) => {
  try {
    const data = await withCache('analytics:sectors', LONG_CACHE_TTL, async () => {
      const symbols = await fetchNifty500Constituents();
      const bySector = symbols.reduce((acc, item) => {
        if (!acc[item.sector]) acc[item.sector] = [];
        acc[item.sector].push(item);
        return acc;
      }, {});
      return { bySector };
    });
    const sectorNames = Object.keys(data.bySector);
    const heatmap = await runWithConcurrency(
      sectorNames,
      async (sector) => {
        const sample = data.bySector[sector].slice(0, 6);
        const returns = [];
        for (const s of sample) {
          try {
            const chart = await withCache(`chart:${s.symbol}:1d:3mo`, SHORT_CACHE_TTL, () =>
              fetchYahooChart(s.symbol, '1d', '3mo')
            );
            const rows = toHistoryRows(chart?.chart?.result?.[0]);
            if (rows.length > 5) {
              const start = rows[0].close;
              const end = rows[rows.length - 1].close;
              returns.push(((end - start) / start) * 100);
            }
          } catch (e) {}
        }
        const avgReturn = returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
        return {
          sector,
          value: Number(avgReturn.toFixed(2)),
          color: avgReturn >= 2 ? '#16a34a' : avgReturn >= 0 ? '#22c55e' : avgReturn <= -2 ? '#dc2626' : '#f97316',
        };
      },
      3
    );
    res.json({ items: heatmap });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch sector heatmap' });
  }
});

app.get('/api/screener', async (req, res) => {
  try {
    const peMax = req.query.peMax ? Number(req.query.peMax) : null;
    const volumeSpikeMin = req.query.volumeSpikeMin ? Number(req.query.volumeSpikeMin) : null;
    const preset = String(req.query.preset || '').toLowerCase();
    const sector = String(req.query.sector || '').trim();

    const symbols = await fetchNifty500Constituents();
    const universe = symbols.slice(0, 120);
    const rows = await runWithConcurrency(
      universe,
      async (item) => {
        try {
          const chartPayload = await withCache(`chart:${item.symbol}:1d:3mo`, SHORT_CACHE_TTL, () =>
            fetchYahooChart(item.symbol, '1d', '3mo')
          );
          const chartResult = chartPayload?.chart?.result?.[0];
          const quote = normalizeQuoteFromChart(chartResult, item.symbol);
          const technicals = calculateTechnicals(toHistoryRows(chartResult));
          const pe = chartResult?.meta?.trailingPE ?? null;
          const volumeSpike =
            technicals.latestVolume && technicals.avg20Volume
              ? technicals.latestVolume / technicals.avg20Volume
              : null;

          return {
            symbol: item.symbol,
            companyName: item.companyName,
            sector: item.sector,
            pe,
            roe: null,
            debtToEquity: null,
            price: quote.regularMarketPrice,
            changePct: quote.regularMarketChangePercent,
            volumeSpike,
          };
        } catch (error) {
          return null;
        }
      },
      6
    );

    let filtered = rows.filter(Boolean);
    if (sector) filtered = filtered.filter((r) => r.sector === sector);
    if (peMax !== null) filtered = filtered.filter((r) => typeof r.pe === 'number' && r.pe <= peMax);
    if (volumeSpikeMin !== null) {
      filtered = filtered.filter((r) => typeof r.volumeSpike === 'number' && r.volumeSpike >= volumeSpikeMin);
    }

    if (preset === 'undervalued') {
      filtered = filtered.filter((r) => typeof r.pe === 'number' && r.pe < 20 && (r.changePct ?? 0) > -2);
    } else if (preset === 'momentum') {
      filtered = filtered.filter((r) => (r.changePct ?? 0) > 1.5 && (r.volumeSpike ?? 0) > 1.1);
    }

    filtered = filtered.sort((a, b) => (b.changePct ?? -Infinity) - (a.changePct ?? -Infinity));
    res.json({
      note: 'ROE and Debt/Equity are currently unavailable from free live endpoints and are returned as null.',
      items: filtered.slice(0, 80),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to run screener' });
  }
});

// Fetch historical data for candlestick charts
app.get('/api/stocks/:symbol/history', async (req, res) => {
  const { symbol } = req.params;
  const { interval } = req.query;

  try {
    const cacheKey = `chart:${symbol}:${interval || '1d'}:1y`;
    const chartData = await withCache(cacheKey, SHORT_CACHE_TTL, () =>
      fetchYahooChart(symbol, interval || '1d', '1y')
    );
    const result = chartData?.chart?.result?.[0];
    const rows = toHistoryRows(result);
    if (rows.length > 0) {
      return res.json(rows);
    }
    const fallback = await withCache(`chart:${symbol}:${interval || '1d'}:6mo`, SHORT_CACHE_TTL, () =>
      fetchYahooChart(symbol, interval || '1d', '6mo')
    );
    const fallbackRows = toHistoryRows(fallback?.chart?.result?.[0]);
    res.json(fallbackRows);
  } catch (error) {
    console.error('Error fetching historical data for', symbol, error);
    res.status(503).json({ error: 'Failed to fetch historical data (upstream throttled)' });
  }
});

// Fetch detailed quote and stats
app.get('/api/stocks/:symbol/quote', async (req, res) => {
  const { symbol } = req.params;
  try {
    const chartData = await withCache(`chart:${symbol}:1d:5d`, SHORT_CACHE_TTL, () =>
      fetchYahooChart(symbol, '1d', '5d')
    );
    const result = chartData?.chart?.result?.[0];
    if (!result) {
      return res.status(404).json({ error: 'No quote data found' });
    }
    res.json(normalizeQuoteFromChart(result, symbol));
  } catch (error) {
    res.status(503).json({ error: 'Failed to fetch quote (upstream throttled)' });
  }
});

// Fetch news for a specific stock
app.get('/api/stocks/:symbol/news', async (req, res) => {
  const { symbol } = req.params;
  try {
    const query = symbol.replace('.NS', '') + ' NSE stock';
    const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-IN&gl=IN&ceid=IN:en`;
    const response = await fetch(rssUrl, {
      headers: {
        'user-agent': DEFAULT_UA,
        accept: 'application/rss+xml,application/xml,text/xml',
      },
    });

    if (!response.ok) {
      throw new Error(`News RSS request failed: ${response.status}`);
    }

    const xmlText = await response.text();
    res.json(parseGoogleNewsRss(xmlText));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch news' });
  }
});

app.get('/api/stocks/:symbol/technicals', async (req, res) => {
  const { symbol } = req.params;
  try {
    const chartData = await withCache(`chart:${symbol}:1d:1y`, SHORT_CACHE_TTL, () =>
      fetchYahooChart(symbol, '1d', '1y')
    );
    const rows = toHistoryRows(chartData?.chart?.result?.[0]);
    const technicals = calculateTechnicals(rows);
    res.json(technicals);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch technical indicators' });
  }
});

app.get('/api/stocks/:symbol/sentiment-news', async (req, res) => {
  const { symbol } = req.params;
  try {
    const query = symbol.replace('.NS', '') + ' NSE stock';
    const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-IN&gl=IN&ceid=IN:en`;
    const response = await fetch(rssUrl, {
      headers: {
        'user-agent': DEFAULT_UA,
        accept: 'application/rss+xml,application/xml,text/xml',
      },
    });
    const xmlText = await response.text();
    const items = parseGoogleNewsRss(xmlText).map((item) => ({
      ...item,
      sentiment: classifySentiment(`${item.title} ${item.publisher}`),
    }));
    const counts = items.reduce(
      (acc, item) => {
        acc[item.sentiment] += 1;
        return acc;
      },
      { bullish: 0, bearish: 0, neutral: 0 }
    );
    res.json({ summary: counts, items });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch sentiment news' });
  }
});

app.get('/api/stocks/:symbol/alerts', async (req, res) => {
  const { symbol } = req.params;
  try {
    const chartData = await withCache(`chart:${symbol}:1d:6mo`, SHORT_CACHE_TTL, () =>
      fetchYahooChart(symbol, '1d', '6mo')
    );
    const rows = toHistoryRows(chartData?.chart?.result?.[0]);
    const technicals = calculateTechnicals(rows);
    const latest = rows[rows.length - 1];
    const prevRows = rows.slice(-21, -1);
    const resistance = prevRows.length ? Math.max(...prevRows.map((r) => r.high)) : null;
    const breakout = resistance !== null && latest?.close > resistance;
    const volumeSpike =
      technicals.latestVolume && technicals.avg20Volume
        ? technicals.latestVolume / technicals.avg20Volume > 1.5
        : false;
    const rsiCrossing =
      technicals.rsi14Prev !== null &&
      technicals.rsi14 !== null &&
      ((technicals.rsi14Prev < 70 && technicals.rsi14 >= 70) ||
        (technicals.rsi14Prev > 30 && technicals.rsi14 <= 30));

    res.json({
      breakout,
      volumeSpike,
      rsiCrossing,
      resistance,
      rsi14: technicals.rsi14,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to evaluate alerts' });
  }
});

app.get('/api/analytics/correlation', async (req, res) => {
  try {
    const provided = String(req.query.symbols || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const symbols =
      provided.length > 1
        ? provided.map((s) => (s.endsWith('.NS') ? s : `${s}.NS`)).slice(0, 10)
        : (await fetchNifty500Constituents()).slice(0, 8).map((s) => s.symbol);

    const series = {};
    for (const symbol of symbols) {
      try {
        const chart = await withCache(`chart:${symbol}:1d:3mo`, SHORT_CACHE_TTL, () =>
          fetchYahooChart(symbol, '1d', '3mo')
        );
        const rows = toHistoryRows(chart?.chart?.result?.[0]);
        const closes = rows.map((r) => r.close).filter((v) => typeof v === 'number');
        const rets = [];
        for (let i = 1; i < closes.length; i += 1) {
          rets.push((closes[i] - closes[i - 1]) / closes[i - 1]);
        }
        series[symbol] = rets;
      } catch (e) {}
    }

    const keys = Object.keys(series);
    const minLen = Math.min(...keys.map((k) => series[k].length));
    const matrix = keys.map((a) =>
      keys.map((b) => {
        const av = series[a].slice(-minLen);
        const bv = series[b].slice(-minLen);
        const c = correlation(av, bv);
        return c === null ? null : Number(c.toFixed(2));
      })
    );
    res.json({ symbols: keys, matrix });
  } catch (error) {
    res.status(500).json({ error: 'Failed to build correlation matrix' });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

setInterval(clearTransientCache, 30 * 1000);
