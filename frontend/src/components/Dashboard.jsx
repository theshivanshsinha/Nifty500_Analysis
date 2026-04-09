import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, Newspaper, Star, TrendingUp, Users } from 'lucide-react';

const API_BASE = import.meta.env.VITE_API_BASE || 'https://nifty500-analysis.onrender.com/api';

const WINDOW_OPTIONS = ['day', 'month', 'year'];

const Dashboard = () => {
  const [symbols, setSymbols] = useState([]);
  const [sectorAnalytics, setSectorAnalytics] = useState([]);
  const [marketNews, setMarketNews] = useState([]);
  const [newsWindow, setNewsWindow] = useState('day');
  const [heatmap, setHeatmap] = useState([]);
  const [screener, setScreener] = useState([]);
  const [correlation, setCorrelation] = useState({ symbols: [], matrix: [] });
  const [loading, setLoading] = useState(true);
  const [loadingProgress, setLoadingProgress] = useState(0);
  const [searchTerm, setSearchTerm] = useState('');
  const [sectorFilter, setSectorFilter] = useState('All');
  const [sortBy, setSortBy] = useState('symbol');
  const [screenerPreset, setScreenerPreset] = useState('momentum');
  const [peMax, setPeMax] = useState('');
  const [volumeSpikeMin, setVolumeSpikeMin] = useState('1.1');
  const [watchlist, setWatchlist] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('nifty500_watchlist') || '[]');
    } catch {
      return [];
    }
  });

  const sectorMomentumMap = useMemo(() => {
    const map = {};
    sectorAnalytics.forEach((item) => {
      map[item.sector] = item.avgReturnPct ?? 0;
    });
    return map;
  }, [sectorAnalytics]);

  const sectorOptions = useMemo(() => {
    const all = new Set(symbols.map((s) => s.sector));
    return ['All', ...Array.from(all).sort()];
  }, [symbols]);

  const filteredSymbols = useMemo(() => {
    const normalized = searchTerm.toLowerCase();
    let result = symbols.filter((stock) => {
      const inSearch =
        !normalized ||
        stock.symbol.toLowerCase().includes(normalized) ||
        stock.companyName.toLowerCase().includes(normalized);
      const inSector = sectorFilter === 'All' || stock.sector === sectorFilter;
      return inSearch && inSector;
    });

    if (sortBy === 'sectorMomentum') {
      result = [...result].sort((a, b) => (sectorMomentumMap[b.sector] ?? 0) - (sectorMomentumMap[a.sector] ?? 0));
    } else if (sortBy === 'companyName') {
      result = [...result].sort((a, b) => a.companyName.localeCompare(b.companyName));
    } else {
      result = [...result].sort((a, b) => a.symbol.localeCompare(b.symbol));
    }

    return result;
  }, [symbols, searchTerm, sectorFilter, sortBy, sectorMomentumMap]);

  const recommendations = useMemo(() => {
    const topSectors = [...sectorAnalytics]
      .filter((s) => typeof s.avgReturnPct === 'number')
      .sort((a, b) => b.avgReturnPct - a.avgReturnPct)
      .slice(0, 3);
    const weakSectors = [...sectorAnalytics]
      .filter((s) => typeof s.avgReturnPct === 'number')
      .sort((a, b) => a.avgReturnPct - b.avgReturnPct)
      .slice(0, 2);
    return { topSectors, weakSectors };
  }, [sectorAnalytics]);

  const fetchDashboardData = useCallback((currentNewsWindow = newsWindow, includeHeavy = true) => {
    let completed = 0;
    const total = includeHeavy ? 4 : 2;
    const bumpProgress = () => {
      completed += 1;
      setLoadingProgress(Math.min(100, Math.round((completed / total) * 100)));
    };

    const symbolsReq = fetch(`${API_BASE}/symbols`)
      .then((res) => {
        if (!res.ok) throw new Error('Failed symbols');
        return res.json();
      })
      .finally(bumpProgress);
    const sectorReq = includeHeavy
      ? fetch(`${API_BASE}/analytics/sectors`)
          .then((res) => {
            if (!res.ok) throw new Error('Failed sector analytics');
            return res.json();
          })
          .finally(bumpProgress)
      : Promise.resolve(null);
    const newsReq = fetch(`${API_BASE}/news/market?window=${currentNewsWindow}`)
      .then((res) => {
        if (!res.ok) throw new Error('Failed market news');
        return res.json();
      })
      .finally(bumpProgress);

    const heatmapReq = includeHeavy
      ? fetch(`${API_BASE}/analytics/sector-heatmap`)
          .then((res) => (res.ok ? res.json() : { items: [] }))
          .finally(bumpProgress)
      : Promise.resolve(null);
    return Promise.all([symbolsReq, sectorReq, newsReq, heatmapReq]).then(([symbolsData, sectorData, newsData, heatmapData]) => {
      setSymbols(symbolsData);
      if (sectorData?.sectors) {
        setSectorAnalytics(sectorData.sectors || []);
      }
      setMarketNews(newsData?.items || []);
      if (heatmapData?.items) {
        setHeatmap(heatmapData.items || []);
      }
      setLoadingProgress(100);
    });
  }, [newsWindow]);

  const fetchScreener = useCallback(() => {
    const params = new URLSearchParams({ preset: screenerPreset });
    if (peMax !== '') params.set('peMax', String(peMax));
    if (volumeSpikeMin !== '') params.set('volumeSpikeMin', String(volumeSpikeMin));
    return fetch(`${API_BASE}/screener?${params.toString()}`)
      .then((res) => (res.ok ? res.json() : { items: [] }))
      .then((data) => setScreener(data.items || []));
  }, [peMax, screenerPreset, volumeSpikeMin]);

  const fetchCorrelation = useCallback((syms) => {
    if (!syms.length) return;
    const param = syms.map((s) => s.replace('.NS', '')).join(',');
    fetch(`${API_BASE}/analytics/correlation?symbols=${encodeURIComponent(param)}`)
      .then((res) => (res.ok ? res.json() : { symbols: [], matrix: [] }))
      .then((data) => setCorrelation(data));
  }, []);

  useEffect(() => {
    fetchDashboardData('day')
      .catch((error) => {
        console.error(error);
      })
      .finally(() => {
        setLoading(false);
      });

    // Keep refresh light to avoid upstream throttling.
    const intervalId = setInterval(() => {
      fetchDashboardData(newsWindow, false).catch((error) => {
        console.error(error);
      });
    }, 60 * 1000);

    return () => clearInterval(intervalId);
  }, [fetchDashboardData, newsWindow]);

  useEffect(() => {
    fetch(`${API_BASE}/news/market?window=${newsWindow}`)
      .then((res) => {
        if (!res.ok) throw new Error('Failed market news');
        return res.json();
      })
      .then((data) => setMarketNews(data?.items || []))
      .catch((error) => console.error(error));
  }, [newsWindow]);

  useEffect(() => {
    fetchScreener().catch((e) => console.error(e));
  }, [fetchScreener]);

  useEffect(() => {
    const seed = watchlist.length ? watchlist.slice(0, 8) : symbols.slice(0, 8).map((s) => s.symbol);
    fetchCorrelation(seed);
  }, [watchlist, symbols, fetchCorrelation]);

  if (loading) {
    return (
      <div className="loader-container">
        <div className="loader"></div>
        <div className="loader-progress-text">Loading market intelligence... {loadingProgress}%</div>
      </div>
    );
  }

  const sectorCount = new Set(symbols.map((s) => s.sector)).size;
  const leadingSector = sectorAnalytics[0];

  const toggleWatchlist = (symbol) => {
    const updated = watchlist.includes(symbol)
      ? watchlist.filter((item) => item !== symbol)
      : [...watchlist, symbol];
    setWatchlist(updated);
    localStorage.setItem('nifty500_watchlist', JSON.stringify(updated));
  };

  return (
    <div className="dashboard-stack">
      <div className="grid-cards">
        <div className="premium-card stat-card">
          <div className="stat-title">Total Nifty 500 Listed</div>
          <div className="stat-value">{symbols.length}</div>
          <div className="stat-change text-positive">
            <Users size={16} /> Market Active
          </div>
        </div>
        <div className="premium-card stat-card">
          <div className="stat-title">Market Sectors</div>
          <div className="stat-value">{sectorCount}</div>
          <div className="stat-change text-positive">
            <Activity size={16} /> Diversified
          </div>
        </div>
        <div className="premium-card stat-card">
          <div className="stat-title">Leading Sector (Short-term)</div>
          <div className="stat-value">{leadingSector?.sector || 'N/A'}</div>
          <div className="stat-change text-positive">
            <TrendingUp size={16} />
            {typeof leadingSector?.avgReturnPct === 'number'
              ? `${leadingSector.avgReturnPct.toFixed(2)}% avg return`
              : 'Refreshing...'}
          </div>
        </div>
      </div>

      <div className="premium-card">
        <h2 className="section-title">Sector Heatmap</h2>
        <div className="heatmap-grid">
          {heatmap.map((item) => (
            <div key={item.sector} className="heatmap-cell" style={{ backgroundColor: item.color }}>
              <div>{item.sector}</div>
              <strong>{item.value}%</strong>
            </div>
          ))}
        </div>
      </div>

      <div className="premium-card">
        <div className="dashboard-controls">
          <input
            className="control-input"
            type="text"
            placeholder="Search by company or symbol"
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
          />
          <select className="control-select" value={sectorFilter} onChange={(event) => setSectorFilter(event.target.value)}>
            {sectorOptions.map((sector) => (
              <option key={sector} value={sector}>
                {sector}
              </option>
            ))}
          </select>
          <select className="control-select" value={sortBy} onChange={(event) => setSortBy(event.target.value)}>
            <option value="symbol">Sort: Symbol</option>
            <option value="companyName">Sort: Company</option>
            <option value="sectorMomentum">Sort: Sector Momentum</option>
          </select>
        </div>
        <div className="filter-recommendation">
          Recommendation: filter by top sectors first, then shortlist by individual stock chart and risk appetite.
        </div>
      </div>

      <div className="grid-cards">
        <div className="premium-card">
          <h2 className="section-title">Trader Suggestions</h2>
          <div className="suggestions-list">
            {recommendations.topSectors.map((item) => (
              <div key={item.sector} className="suggestion-chip text-positive">
                Momentum candidate: {item.sector} ({item.avgReturnPct.toFixed(2)}%)
              </div>
            ))}
            {recommendations.weakSectors.map((item) => (
              <div key={item.sector} className="suggestion-chip text-negative">
                Caution zone: {item.sector} ({item.avgReturnPct.toFixed(2)}%)
              </div>
            ))}
          </div>
        </div>
        <div className="premium-card">
          <h2 className="section-title">Watchlist</h2>
          <p className="news-item-meta">
            Tracked symbols: {watchlist.length > 0 ? watchlist.join(', ') : 'No symbols added yet'}
          </p>
        </div>
      </div>

      <div className="premium-card dashboard-news-card">
        <div className="dashboard-news-header">
          <h2 className="section-title">Important Financial News</h2>
          <div className="window-switcher">
            {WINDOW_OPTIONS.map((window) => (
              <button
                key={window}
                type="button"
                className={`window-btn ${newsWindow === window ? 'active' : ''}`}
                onClick={() => setNewsWindow(window)}
              >
                {window}
              </button>
            ))}
          </div>
        </div>
        <div className="news-grid">
          {marketNews.slice(0, 6).map((item, idx) => (
            <a
              key={`${item.link}-${idx}`}
              href={item.link}
              target="_blank"
              rel="noreferrer"
              className="news-item"
            >
              <div className="news-item-title">
                <Newspaper size={14} /> {item.title}
              </div>
              <div className="news-item-meta">
                {item.publisher} • {new Date(item.providerPublishTime * 1000).toLocaleString()}
              </div>
            </a>
          ))}
        </div>
      </div>

      <div className="premium-card">
        <div className="dashboard-news-header">
          <h2 className="section-title">Smart Stock Screener</h2>
          <div className="window-switcher">
            <button type="button" className={`window-btn ${screenerPreset === 'undervalued' ? 'active' : ''}`} onClick={() => setScreenerPreset('undervalued')}>Undervalued</button>
            <button type="button" className={`window-btn ${screenerPreset === 'momentum' ? 'active' : ''}`} onClick={() => setScreenerPreset('momentum')}>Momentum stocks</button>
          </div>
        </div>
        <div className="dashboard-controls">
          <input className="control-input" type="number" value={peMax} onChange={(e) => setPeMax(e.target.value)} placeholder="PE Max (optional)" />
          <input className="control-input" type="number" step="0.1" value={volumeSpikeMin} onChange={(e) => setVolumeSpikeMin(e.target.value)} placeholder="Volume spike min" />
          <button className="watch-btn" type="button" onClick={() => fetchScreener()}>Run Screener</button>
        </div>
        <div style={{ overflowX: 'auto', marginTop: '0.8rem' }}>
          <table className="premium-table">
            <thead>
              <tr>
                <th>Symbol</th><th>PE</th><th>ROE</th><th>Debt/Equity</th><th>Vol Spike</th><th>Change%</th>
              </tr>
            </thead>
            <tbody>
              {screener.slice(0, 20).map((r) => (
                <tr key={r.symbol}>
                  <td>{r.symbol}</td>
                  <td>{r.pe?.toFixed?.(2) ?? 'N/A'}</td>
                  <td>{r.roe?.toFixed?.(2) ?? 'N/A'}</td>
                  <td>{r.debtToEquity?.toFixed?.(2) ?? 'N/A'}</td>
                  <td>{r.volumeSpike?.toFixed?.(2) ?? 'N/A'}x</td>
                  <td className={(r.changePct ?? 0) >= 0 ? 'text-positive' : 'text-negative'}>{r.changePct?.toFixed?.(2) ?? 'N/A'}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="premium-card">
        <h2 className="section-title">Correlation Matrix</h2>
        <div style={{ overflowX: 'auto', marginTop: '0.7rem' }}>
          <table className="premium-table">
            <thead>
              <tr>
                <th>Symbol</th>
                {correlation.symbols.map((s) => <th key={s}>{s.replace('.NS', '')}</th>)}
              </tr>
            </thead>
            <tbody>
              {correlation.symbols.map((rowSym, i) => (
                <tr key={rowSym}>
                  <td>{rowSym.replace('.NS', '')}</td>
                  {correlation.matrix[i]?.map((v, j) => (
                    <td key={`${i}-${j}`} className={v >= 0.5 ? 'text-positive' : v <= -0.5 ? 'text-negative' : ''}>
                      {typeof v === 'number' ? v.toFixed(2) : '-'}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="premium-card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '1.5rem', borderBottom: '1px solid var(--border-color)' }}>
          <h2 style={{ fontSize: '1.25rem', fontWeight: 600 }}>
            Constituents Overview ({filteredSymbols.length} shown from 500)
          </h2>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table className="premium-table">
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Company Name</th>
                <th>Sector</th>
                <th>Sector Momentum</th>
                <th>Signal</th>
                <th>Watchlist</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {filteredSymbols.map((stock, i) => {
                const momentum = sectorAnalytics.find((s) => s.sector === stock.sector)?.avgReturnPct ?? 0;
                return (
                <tr key={`${stock.symbol}-${i}`}>
                  <td style={{ fontWeight: 600 }}>{stock.symbol}</td>
                  <td>{stock.companyName}</td>
                  <td>
                    <span style={{ 
                      padding: '0.25rem 0.5rem', 
                      backgroundColor: 'rgba(59, 130, 246, 0.1)', 
                      color: 'var(--accent-blue)', 
                      borderRadius: '1rem', 
                      fontSize: '0.75rem',
                      fontWeight: 600
                    }}>
                      {stock.sector}
                    </span>
                  </td>
                  <td>
                    {momentum.toFixed(2)}%
                  </td>
                  <td>
                    <span className={momentum >= 0 ? 'text-positive' : 'text-negative'}>
                      {momentum >= 0 ? 'Bullish sector' : 'Defensive'}
                    </span>
                  </td>
                  <td>
                    <button className="watch-btn" type="button" onClick={() => toggleWatchlist(stock.symbol)}>
                      {watchlist.includes(stock.symbol) ? 'Added' : 'Add'}
                      <Star size={14} />
                    </button>
                  </td>
                  <td>
                    <Link 
                      to={`/stock/${stock.symbol.split('.NS')[0]}`} 
                      style={{ 
                        color: 'var(--accent-blue)', 
                        textDecoration: 'none', 
                        fontWeight: 600 
                      }}
                    >
                      View Details &rarr;
                    </Link>
                  </td>
                </tr>
              )})}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export default Dashboard;
