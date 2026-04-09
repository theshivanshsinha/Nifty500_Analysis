import { useEffect, useState, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
import { createChart } from 'lightweight-charts';
import { ArrowLeft, TrendingUp, TrendingDown } from 'lucide-react';

const API_BASE = import.meta.env.VITE_API_BASE || 'https://nifty500-analysis.onrender.com/api';

const StockDetail = () => {
  const { symbol } = useParams();
  const fullSymbol = `${symbol}.NS`;
  const chartContainerRef = useRef();

  const [quote, setQuote] = useState(null);
  const [news, setNews] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let chart;
    let resizeHandler;

    // Fetch quote, history and news in parallel
    Promise.all([
      fetch(`${API_BASE}/stocks/${fullSymbol}/quote`).then((r) => {
        if (!r.ok) throw new Error('Failed to load quote');
        return r.json();
      }),
      fetch(`${API_BASE}/stocks/${fullSymbol}/history?interval=1d`).then((r) => {
        if (!r.ok) throw new Error('Failed to load price history');
        return r.json();
      }),
      fetch(`${API_BASE}/stocks/${fullSymbol}/news`).then((r) => {
        if (!r.ok) throw new Error('Failed to load news');
        return r.json();
      })
    ]).then(([quoteData, historyData, newsData]) => {
      setQuote(quoteData);
      setNews(newsData);
      setLoading(false);

      if (historyData && historyData.length > 0 && chartContainerRef.current) {
        // Clear previous chart if any
        chartContainerRef.current.innerHTML = '';
        
        chart = createChart(chartContainerRef.current, {
          layout: {
            background: { color: 'transparent' },
            textColor: '#94a3b8',
          },
          grid: {
            vertLines: { color: 'rgba(255, 255, 255, 0.05)' },
            horzLines: { color: 'rgba(255, 255, 255, 0.05)' },
          },
          width: chartContainerRef.current.clientWidth,
          height: 400,
        });

        const candlestickSeries = chart.addCandlestickSeries({
          upColor: '#10b981',
          downColor: '#ef4444',
          borderVisible: false,
          wickUpColor: '#10b981',
          wickDownColor: '#ef4444',
        });

        const formattedData = historyData.map(d => ({
          time: d.date.split('T')[0],
          open: d.open,
          high: d.high,
          low: d.low,
          close: d.close
        }));

        candlestickSeries.setData(formattedData);
        chart.timeScale().fitContent();

        resizeHandler = () => {
          chart.applyOptions({ width: chartContainerRef.current.clientWidth });
        };
        window.addEventListener('resize', resizeHandler);
      }
    }).catch(err => {
      console.error(err);
      setLoading(false);
    });

    return () => {
      if (resizeHandler) {
        window.removeEventListener('resize', resizeHandler);
      }
      if (chart) {
        chart.remove();
      }
    };
  }, [fullSymbol]);

  if (loading) {
    return (
      <div className="loader-container">
        <div className="loader"></div>
      </div>
    );
  }

  const isPositive = quote?.regularMarketChange >= 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      <div>
        <Link to="/" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', color: 'var(--text-muted)', textDecoration: 'none', marginBottom: '1rem' }}>
          <ArrowLeft size={16} /> Back to Dashboard
        </Link>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <h1 style={{ fontSize: '2rem', fontWeight: 700 }}>{quote?.shortName || symbol}</h1>
            <p style={{ color: 'var(--text-muted)' }}>{fullSymbol} • {quote?.quoteType}</p>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: '2.5rem', fontWeight: 700 }}>
              ₹{quote?.regularMarketPrice?.toFixed(2)}
            </div>
            <div style={{ 
              display: 'flex', 
              alignItems: 'center', 
              justifyContent: 'flex-end',
              gap: '0.5rem', 
              color: isPositive ? 'var(--accent-green)' : 'var(--accent-red)',
              fontWeight: 600
            }}>
              {isPositive ? <TrendingUp size={20} /> : <TrendingDown size={20} />}
              <span>{quote?.regularMarketChange?.toFixed(2)}</span>
              <span>({quote?.regularMarketChangePercent?.toFixed(2)}%)</span>
            </div>
          </div>
        </div>
      </div>

      <div className="grid-cards" style={{ gridTemplateColumns: '1fr 1fr 1fr 1fr' }}>
        <div className="premium-card stat-card">
          <div className="stat-title">Previous Close</div>
          <div className="stat-value" style={{ fontSize: '1.25rem' }}>₹{quote?.regularMarketPreviousClose?.toFixed(2)}</div>
        </div>
        <div className="premium-card stat-card">
          <div className="stat-title">Open</div>
          <div className="stat-value" style={{ fontSize: '1.25rem' }}>₹{quote?.regularMarketOpen?.toFixed(2)}</div>
        </div>
        <div className="premium-card stat-card">
          <div className="stat-title">Day&apos;s Range</div>
          <div className="stat-value" style={{ fontSize: '1.25rem' }}>₹{quote?.regularMarketDayLow?.toFixed(2)} - ₹{quote?.regularMarketDayHigh?.toFixed(2)}</div>
        </div>
        <div className="premium-card stat-card">
          <div className="stat-title">Volume</div>
          <div className="stat-value" style={{ fontSize: '1.25rem' }}>{quote?.regularMarketVolume?.toLocaleString()}</div>
        </div>
      </div>

      {/* Chart Section */}
      <div className="premium-card">
        <h2 style={{ fontSize: '1.25rem', marginBottom: '1rem', fontWeight: 600 }}>Price History (1 Year)</h2>
        <div ref={chartContainerRef} style={{ width: '100%' }}></div>
      </div>

      {/* News Section */}
      <div>
        <h2 style={{ fontSize: '1.5rem', marginBottom: '1rem', fontWeight: 600 }}>Recent News</h2>
        <div className="grid-cards" style={{ gridTemplateColumns: '1fr 1fr' }}>
          {news.length > 0 ? news.map((item, i) => (
             <div key={i} className="premium-card" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
               <div>
                  <h3 style={{ fontSize: '1.1rem', marginBottom: '0.5rem', fontWeight: 600, color: 'var(--accent-blue)' }}>
                    <a href={item.link} target="_blank" rel="noreferrer" style={{ color: 'inherit', textDecoration: 'none' }}>
                      {item.title}
                    </a>
                  </h3>
                  <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', marginBottom: '1rem' }}>
                     {item.publisher} • {new Date(item.providerPublishTime * 1000).toLocaleDateString()}
                  </p>
               </div>
             </div>
          )) : (
            <div className="premium-card" style={{ gridColumn: 'span 2', textAlign: 'center', color: 'var(--text-muted)' }}>
              No recent news found for this company.
            </div>
          )}
        </div>
      </div>

    </div>
  );
};

export default StockDetail;
