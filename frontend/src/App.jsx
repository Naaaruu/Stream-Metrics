import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, BarChart3, FileText, FlaskConical, GitCompareArrows, LayoutDashboard, Menu, Radio, Settings, Video, X } from 'lucide-react';
import { ComparePage, ReportsPage, StatisticsPage } from './AnalysisPages.jsx';
import ExperimentPage from './Experiment.jsx';
import { DashboardPage, MonitorPage } from './Monitoring.jsx';
import SettingsPage from './Settings.jsx';
import { deleteSession, listSessions, renameSession, storeSession } from './data/sessionStore.js';
import { readSettings, SETTINGS_KEY } from './data/settings.js';
import { useExperiment } from './useExperiment.js';
import { useProbe, useSystem } from './useSystem.js';
import { Status } from './ui.jsx';
import './App.css';

const NAV = [
  { label: '개요', links: [['dashboard', '대시보드', LayoutDashboard]] },
  { label: '스트리밍', links: [['live', 'LIVE 모니터링', Radio], ['vod', 'VOD 모니터링', Video], ['compare', 'LIVE / VOD 비교', GitCompareArrows]] },
  { label: '실험 및 분석', links: [['tests', '네트워크 실험', FlaskConical], ['statistics', '통계 분석', BarChart3], ['reports', '리포트', FileText]] },
  { label: '환경', links: [['settings', '설정', Settings]] },
];
const TITLES = Object.fromEntries(NAV.flatMap(({ links }) => links.map(([id, title]) => [id, title])));

function Sidebar({ page, navigate, visible, close }) {
  return <>
    {visible && <button className="mobile-scrim" aria-label="메뉴 닫기" onClick={close} />}
    <aside className={`sidebar ${visible ? 'sidebar-open' : ''}`}>
      <div className="brand">
        <div className="brand-mark"><Activity size={24} strokeWidth={2.6} /></div>
        <div><strong>stream<span>metrics</span></strong><small>스트리밍 네트워크 모니터링</small></div>
        <button className="mobile-close icon-button" onClick={close} aria-label="메뉴 닫기"><X size={18} /></button>
      </div>
      <div className="project-summary"><strong>데이터통신 · 4팀</strong></div>
      <nav aria-label="주요 메뉴" className="side-nav">
        {NAV.map(({ label, links }) => <div className="nav-group" key={label}>
          <div className="nav-group-label">{label}</div>
          {links.map(([id, name, Icon]) => <button key={id} className={`nav-link ${page === id ? 'active' : ''}`}
            onClick={() => void navigate(id)} aria-current={page === id ? 'page' : undefined}>
            <Icon size={18} strokeWidth={1.85} /><span>{name}</span>{page === id && <span className="active-indicator" />}
          </button>)}
        </div>)}
      </nav>
    </aside>
  </>;
}

function mergeSessions(current, incoming) {
  const unique = new Map([...current, ...incoming].map((session) => [session.id, session]));
  return [...unique.values()].sort((a, b) => b.startAt - a.startAt);
}

export default function App() {
  const [page, setPage] = useState('dashboard');
  const [sidebarVisible, setSidebarVisible] = useState(false);
  const [notice, setNotice] = useState('');
  const [settings, setSettings] = useState(readSettings);
  const [settingsError, setSettingsError] = useState('');
  const [sessions, setSessions] = useState([]);
  const [storageError, setStorageError] = useState('');
  const [reportId, setReportId] = useState('');
  const [players, setPlayers] = useState({});
  const navPending = useRef(false);
  const { status: system, refreshStatus } = useSystem();
  const probe = useProbe(settings.demo, settings.refreshInterval);

  useEffect(() => {
    let closed = false;
    listSessions().then((stored) => {
      if (!closed) setSessions((previous) => mergeSessions(stored, previous));
    }).catch((problem) => {
      if (!closed) setStorageError(`브라우저에서 실험 기록을 읽지 못했습니다. ${problem.message}`);
    });
    return () => { closed = true; };
  }, []);

  const persist = useCallback(async (session) => {
    setSessions((previous) => mergeSessions(previous, [session]));
    setReportId(session.id);
    try {
      await storeSession(session);
      setStorageError('');
      return true;
    } catch (problem) {
      setStorageError(`실험 기록을 브라우저에 저장하지 못했습니다. 현재 탭에서 CSV를 내려받을 수 있습니다. ${problem.message}`);
      return false;
    }
  }, []);
  const control = useExperiment(persist, refreshStatus);
  async function renameReport(id, name) {
    const session = await renameSession(id, name);
    setSessions((previous) => mergeSessions(previous, [session]));
    control.updateCompleted(id, session.name);
  }

  async function deleteReport(id) {
    await deleteSession(id);
    setSessions((previous) => previous.filter((session) => session.id !== id));
    setReportId((current) => current === id ? '' : current);
    control.updateCompleted(id);
  }
  const liveStatus = useCallback((live) => setPlayers((previous) => ({ ...previous, live })), []);
  const vodStatus = useCallback((vod) => setPlayers((previous) => ({ ...previous, vod })), []);
  const playerStatus = { live: liveStatus, vod: vodStatus };

  function updateSettings(value) {
    setSettings(value);
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(value));
      setSettingsError('');
    } catch {
      setSettingsError('설정을 이 브라우저에 저장하지 못했습니다. 현재 탭에는 적용했습니다.');
    }
  }

  async function navigate(next) {
    if (navPending.current || next === page) {
      setSidebarVisible(false);
      return;
    }
    setNotice('');
    if (page === 'tests') {
      if (control.phase === 'applying' || control.phase === 'releasing') {
        setNotice('조건 적용 또는 해제가 끝나면 이동할 수 있습니다.');
        setSidebarVisible(false);
        return;
      }
      if (control.phase === 'running' || control.phase === 'release-error') {
        navPending.current = true;
        const released = await control.stop();
        navPending.current = false;
        if (!released) {
          setNotice('실험 조건 해제를 확인할 수 없습니다. 이 화면에서 다시 중단해 주세요.');
          setSidebarVisible(false);
          return;
        }
      }
    }
    setPage(next);
    setSidebarVisible(false);
    window.scrollTo(0, 0);
  }

  const onConnect = () => void navigate('settings');
  const onExperiment = () => void navigate('tests');
  let content;
  switch (page) {
    case 'live':
    case 'vod':
      content = <MonitorPage key={page + settings.urls[page]} mode={page} url={settings.urls[page]} probe={probe} onConnect={onConnect} onStatus={playerStatus[page]} />;
      break;
    case 'compare':
      content = <ComparePage sessions={sessions} urls={settings.urls} probe={probe} onConnect={onConnect} onExperiment={onExperiment} playerStatus={playerStatus} />;
      break;
    case 'statistics':
      content = <StatisticsPage sessions={sessions} probe={probe} onExperiment={onExperiment} />;
      break;
    case 'reports':
      content = <ReportsPage sessions={sessions} selectedId={reportId} select={setReportId} probe={probe}
        onExperiment={onExperiment} onRename={renameReport} onDelete={deleteReport} />;
      break;
    case 'tests':
      content = <ExperimentPage control={control} urls={settings.urls} probe={probe} onConnect={onConnect}
        playerStatus={playerStatus} netem={system.netem} onReport={() => void navigate('reports')} />;
      break;
    case 'settings':
      content = <SettingsPage settings={settings} updateSettings={updateSettings} system={system} players={players} storageError={settingsError} />;
      break;
    default:
      content = <DashboardPage sessions={sessions} probe={probe} system={system} players={players} urls={settings.urls}
        onNavigate={navigate} onReport={(id) => { setReportId(id); void navigate('reports'); }} />;
  }

  return <div className="app-shell">
    <Sidebar page={page} navigate={navigate} visible={sidebarVisible} close={() => setSidebarVisible(false)} />
    <div className="main-shell">
      <header className="topbar">
        <div className="topbar-left"><button className="icon-button menu-toggle" onClick={() => setSidebarVisible(true)} aria-label="메뉴 열기"><Menu size={21} /></button>
          <strong className="breadcrumb">{TITLES[page]}</strong></div>
        <div className="topbar-right"><span className="ui-topbar-api">FastAPI</span><Status label={system.api} /></div>
      </header>
      <main className="main-content" id="main-content">
        {notice && <p className="experiment-error ui-notice" role="alert">{notice}</p>}
        {storageError && <p className="experiment-error ui-notice" role="status">{storageError}</p>}
        {content}
        <footer className="footer"><span>© 2026 Stream Metrics · 데이터통신 4팀</span></footer>
      </main>
    </div>
  </div>;
}
