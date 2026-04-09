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
    res.json(toHistoryRows(result));
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

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

setInterval(clearTransientCache, 30 * 1000);
