import { BrowserRouter as Router, Routes, Route, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { LayoutDashboard, PieChart, Activity, Search } from 'lucide-react';
import Dashboard from './components/Dashboard';
import Sectors from './components/Sectors';
import StockDetail from './components/StockDetail';

const Sidebar = () => {
  const location = useLocation();
  
  return (
    <div className="sidebar">
      <div className="sidebar-logo">
        <Activity size={28} />
        <span>Nifty500 Pro</span>
      </div>
      <nav className="nav-links">
        <NavLink to="/" className={`nav-item ${location.pathname === '/' ? 'active' : ''}`}>
          <LayoutDashboard size={20} />
          <span>Dashboard</span>
        </NavLink>
        <NavLink to="/sectors" className={`nav-item ${location.pathname === '/sectors' ? 'active' : ''}`}>
          <PieChart size={20} />
          <span>Sectors</span>
        </NavLink>
      </nav>
    </div>
  );
};

const Topbar = () => {
  const navigate = useNavigate();

  const onSearchSubmit = (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const raw = String(formData.get('symbol') || '').trim().toUpperCase();
    if (!raw) return;
    const cleanSymbol = raw.endsWith('.NS') ? raw.replace('.NS', '') : raw;
    navigate(`/stock/${cleanSymbol}`);
    event.currentTarget.reset();
  };

  return (
    <div className="topbar">
      <div className="page-title">Nifty 500 Analysis Tool</div>
      <form className="search-bar" onSubmit={onSearchSubmit}>
        <Search size={18} color="var(--text-muted)" />
        <input name="symbol" type="text" placeholder="Search symbol (e.g. RELIANCE)" />
      </form>
    </div>
  );
};

function App() {
  return (
    <Router>
      <div className="app-container">
        <Sidebar />
        <div className="main-content">
          <Topbar />
          <div className="content-area">
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/sectors" element={<Sectors />} />
              <Route path="/stock/:symbol" element={<StockDetail />} />
            </Routes>
            <footer className="app-footer">Author: Kumar Shivansh Sinha</footer>
          </div>
        </div>
      </div>
    </Router>
  );
}

export default App;
