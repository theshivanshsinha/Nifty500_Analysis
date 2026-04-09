import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowDownRight, ArrowUpRight } from 'lucide-react';

const API_BASE = '/api';

const Sectors = () => {
  const [analytics, setAnalytics] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${API_BASE}/analytics/sectors`)
      .then((res) => {
        if (!res.ok) {
          throw new Error('Failed to fetch sector analytics');
        }
        return res.json();
      })
      .then((data) => {
        setAnalytics(data?.sectors || []);
        setLoading(false);
      })
      .catch((error) => {
        console.error(error);
        setLoading(false);
      });
  }, []);

  if (loading) {
    return (
      <div className="loader-container">
        <div className="loader"></div>
      </div>
    );
  }

  return (
    <div className="dashboard-stack">
      <h1 className="section-title">Sector Analysis and Analytics</h1>
      <div className="grid-cards">
        {analytics.map((sector) => (
          <div key={sector.sector} className="premium-card sector-card">
            <div className="sector-card-header">
              <h3>{sector.sector}</h3>
              <p>{sector.companies} companies</p>
            </div>
            <div className="sector-metrics-row">
              <div>
                <div className="stat-title">Average Return</div>
                <div className={`metric-pill ${sector.avgReturnPct >= 0 ? 'text-positive' : 'text-negative'}`}>
                  {sector.avgReturnPct?.toFixed(2)}%
                </div>
              </div>
              <div>
                <div className="stat-title">Average Volatility</div>
                <div className="metric-pill">{sector.avgVolatilityPct?.toFixed(2)}%</div>
              </div>
              <div>
                <div className="stat-title">Sample Size</div>
                <div className="metric-pill">{sector.sampleSize}</div>
              </div>
            </div>

            <div className="sector-movers">
              <div>
                <div className="stat-title">Top Movers Up</div>
                {(sector.topMovers?.gainers || []).map((stock) => (
                  <Link key={stock.symbol} className="mover-link text-positive" to={`/stock/${stock.symbol.replace('.NS', '')}`}>
                    <ArrowUpRight size={14} /> {stock.symbol} ({stock.returnPct?.toFixed(2)}%)
                  </Link>
                ))}
              </div>
              <div>
                <div className="stat-title">Top Movers Down</div>
                {(sector.topMovers?.losers || []).map((stock) => (
                  <Link key={stock.symbol} className="mover-link text-negative" to={`/stock/${stock.symbol.replace('.NS', '')}`}>
                    <ArrowDownRight size={14} /> {stock.symbol} ({stock.returnPct?.toFixed(2)}%)
                  </Link>
                ))}
              </div>
            </div>
            <div className="sector-view-more">
              <Link to="/">View overall dashboard comparison</Link>
            </div>
          </div>
        ))}
        {analytics.length === 0 && (
          <div className="premium-card">
            <p style={{ color: 'var(--text-muted)' }}>
              Sector analytics are loading from live market data. Please refresh in a few seconds.
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

export default Sectors;
