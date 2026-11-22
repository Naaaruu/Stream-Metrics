import { useCallback, useEffect, useRef, useState } from 'react';
import LivePlayer from './LivePlayer.jsx';
import VodPlayer from './VodPlayer.jsx';
import {
  Activity, ArrowRight, ArrowUpRight, BarChart3,
  CalendarDays, CheckCircle2, Clock3, Database, Download,
  FileText, FlaskConical, Gauge, GitCompareArrows, Info, LayoutDashboard,
  Menu, Settings, Signal, SlidersHorizontal, Radio,
  Video, Wifi, X, Zap,
} from 'lucide-react';
import {
  Area, AreaChart, CartesianGrid, Legend, Line, LineChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import {
  getLatest, getMergedHistory, getStats, initialHistory, makeSample, SCENARIOS,
} from './data/mockMetrics.js';
import { DEFAULT_CONDITIONS, simulateNetworkSample, validateConditions } from './data/networkExperiment.js';
import { alignByTimestamp, recordingCsv, summarizeRecording } from './data/comparison.js';
import './App.css';

const COLORS = { live: '#42cce5', vod: '#a68cff', good: '#55dda7', warning: '#f6b65f' };
const EMPTY_SAMPLE = { timestamp: Date.now(), latency: 0, packetLoss: 0, bitrate: 0, buffer: 0, jitter: 0 };

function safeLatest(list) {
  return list.length > 0 ? getLatest(list) : EMPTY_SAMPLE;
}

function calcMovingAverage(samples, key, windowSize = 5) {
  if (!samples.length) return 0;
  const slice = samples.slice(-windowSize);
  const sum = slice.reduce((acc, item) => acc + Number(item[key] || 0), 0);
  return sum / slice.length;
}

function withMovingAverage(mergedData, windowSize = 5) {
  return mergedData.map((row, index, array) => {
    const start = Math.max(0, index - windowSize + 1);
    const slice = array.slice(start, index + 1);
    const liveLatAvg = slice.reduce((sum, item) => sum + (item.liveLatency || 0), 0) / slice.length;
    const vodLatAvg = slice.reduce((sum, item) => sum + (item.vodLatency || 0), 0) / slice.length;
    return {
      ...row,
      liveLatencyMA: Number(liveLatAvg.toFixed(1)),
      vodLatencyMA: Number(vodLatAvg.toFixed(1)),
    };
  });
}

const NAV_GROUPS = [
  { label: 'OVERVIEW', items: [{ id: 'dashboard', name: '대시보드', icon: LayoutDashboard }] },
  {
    label: 'STREAMING', items: [
      { id: 'live', name: 'LIVE 모니터링', icon: Radio },
      { id: 'vod', name: 'VOD 모니터링', icon: Video },
      { id: 'compare', name: 'LIVE / VOD 비교', icon: GitCompareArrows },
    ],
  },
  {
    label: 'ANALYTICS', items: [
      { id: 'statistics', name: '통계 분석', icon: BarChart3 },
      { id: 'tests', name: '네트워크 실험', icon: FlaskConical },
      { id: 'reports', name: '리포트', icon: FileText },
    ],
  },
  { label: 'SYSTEM', items: [{ id: 'settings', name: '설정', icon: Settings }] },
];

const PAGE_INFO = {
  dashboard: ['대시보드', '스트리밍 네트워크 성능을 한눈에 확인하세요.'],
  live: ['LIVE 모니터링', '실시간 스트리밍 영상과 네트워크 상태를 확인하세요.'],
  vod: ['VOD 모니터링', 'VOD 재생 품질과 전송 지표를 확인하세요.'],
  compare: ['LIVE / VOD 비교', '동일한 조건에서 두 스트리밍 방식의 지표를 비교하세요.'],
  statistics: ['통계 분석', '수집된 데이터의 추세와 요약 통계를 살펴보세요.'],
  tests: ['네트워크 실험', '네트워크 조건 변화에 따른 지표 반응을 확인하세요.'],
  reports: ['리포트', '측정 기록을 검토하고 CSV로 내려받으세요.'],
  settings: ['설정', '영상 소스와 대시보드 표시 방식을 설정하세요.'],
};

function format(value, digits = 0) {
  return Number(value).toLocaleString('ko-KR', {
    minimumFractionDigits: digits, maximumFractionDigits: digits,
  });
}

function clock(timestamp) {
  return new Date(timestamp).toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function Sidebar({ page, onNavigate, visible, onClose }) {
  return (
    <>
      {visible && <button className="mobile-scrim" aria-label="메뉴 닫기" onClick={onClose} />}
      <aside className={`sidebar ${visible ? 'sidebar-open' : ''}`}>
        <div className="brand">
          <div className="brand-mark"><Activity size={24} strokeWidth={2.6} /></div>
          <div><strong>stream<span>metrics</span></strong><small>NETWORK OBSERVATORY</small></div>
          <button className="mobile-close icon-button" onClick={onClose} aria-label="메뉴 닫기"><X size={18} /></button>
        </div>

        <div className="project-summary">
          <span>TEAM PROJECT</span>
          <strong>데이터통신 · 4팀</strong>
        </div>

        <nav aria-label="주요 메뉴" className="side-nav">
          {NAV_GROUPS.map((group) => (
            <div className="nav-group" key={group.label}>
              <div className="nav-group-label">{group.label}</div>
              {group.items.map(({ id, name, icon: Icon }) => (
                <button
                  key={id}
                  className={`nav-link ${page === id ? 'active' : ''}`}
                  onClick={() => { onNavigate(id); onClose(); }}
                  aria-current={page === id ? 'page' : undefined}
                >
                  <Icon size={18} strokeWidth={1.85} /><span>{name}</span>
                  {page === id && <span className="active-indicator" />}
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <div className="sidebar-help"><div className="sidebar-help-icon"><Zap size={17} /></div><strong>실시간 패킷 측정 중</strong><p>백엔드 네트워크 프로브 및 플레이어 API와 연동되어 실측 지표를 표시합니다.</p></div>
        </div>
      </aside>
    </>
  );
}

function Badge({ children, variant = 'neutral', dot = false }) {
  return <span className={`badge badge-${variant}`}>{dot && <span className="badge-dot" />}{children}</span>;
}

function Card({ children, className = '', ...props }) {
  return <section className={`card ${className}`} {...props}>{children}</section>;
}

function SectionTitle({ title, subtitle, action }) {
  return <div className="section-heading"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>{action}</div>;
}

function MetricCard({ label, value, unit, icon: Icon = Activity, accent = 'cyan', helper, compact = false }) {
  return (
    <Card className={`metric-card ${compact ? 'metric-card-compact' : ''}`}>
      <div className="metric-top"><span>{label}</span><span className={`metric-icon accent-${accent}`}><Icon size={17} /></span></div>
      <div className="metric-number">{value}<small>{unit}</small></div>
      {helper && <div className="metric-helper">{helper}</div>}
    </Card>
  );
}

function ChartTooltip({ active, payload, label, suffix = '' }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tooltip">
      <strong>{clock(label)}</strong>
      {payload.map((entry) => (
        <div key={entry.dataKey}><span style={{ background: entry.color }} />{entry.name}<b>{format(entry.value, suffix === '%' ? 2 : 0)}{suffix}</b></div>
      ))}
    </div>
  );
}

function TrendChart({ data, lines, unit = 'ms', area = false, height = 224, legend = false, timeDomain }) {
  const ChartComponent = area ? AreaChart : LineChart;
  return (
    <div className="chart-wrap" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%" minWidth={0}>
        <ChartComponent data={data} margin={{ top: 14, right: 10, left: -20, bottom: 0 }}>
          <defs>
            {lines.map(({ key, color }) => (
              <linearGradient id={`fill-${key}`} key={key} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={color} stopOpacity={0.24} /><stop offset="100%" stopColor={color} stopOpacity={0} /></linearGradient>
            ))}
          </defs>
          <CartesianGrid stroke="#1e2c40" strokeDasharray="4 6" vertical={false} />
          <XAxis dataKey="timestamp" type={timeDomain ? 'number' : 'category'} domain={timeDomain} tickFormatter={(ts) => clock(ts).slice(3)} stroke="#61748d" tick={{ fill: '#71829a', fontSize: 11 }} axisLine={false} tickLine={false} minTickGap={30} />
          <YAxis tick={{ fill: '#71829a', fontSize: 11 }} stroke="#61748d" axisLine={false} tickLine={false} width={45} domain={['auto', 'auto']} />
          <Tooltip content={<ChartTooltip suffix={unit === '%' ? '%' : ''} />} />
          {legend && <Legend iconType="circle" iconSize={7} wrapperStyle={{ fontSize: 12, color: '#91a3b9', paddingTop: 8 }} />}
          {lines.map(({ key, name, color }) => area ? (
            <Area key={key} name={name} type="monotone" dataKey={key} stroke={color} strokeWidth={2.5} fill={`url(#fill-${key})`} dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />
          ) : (
            <Line key={key} name={name} type="monotone" dataKey={key} stroke={color} strokeWidth={2.3} dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />
          ))}
        </ChartComponent>
      </ResponsiveContainer>
    </div>
  );
}

function ChartCard({ title, description, data, lines, unit, area = false, legend = false, height = 220, className = '', timeDomain }) {
  return <Card className={`chart-card ${className}`}><div className="chart-card-head"><div><h3>{title}</h3>{description && <p>{description}</p>}</div><span className="chart-unit">{unit}</span></div><TrendChart data={data} lines={lines} unit={unit} area={area} height={height} legend={legend} timeDomain={timeDomain} /></Card>;
}

function StreamRow({ mode, latest, onOpen }) {
  const live = mode === 'live';
  return (
    <button className="stream-row" onClick={onOpen}>
      <div className={`stream-row-icon ${live ? 'stream-row-live' : 'stream-row-vod'}`}>{live ? <Radio size={19} /> : <Video size={19} />}</div>
      <div className="stream-row-name"><strong>{live ? 'Live Streaming' : 'VOD Streaming'}</strong><small>{live ? 'Real-time transport' : 'Adaptive playback'}</small></div>
      <Badge variant="green" dot>ACTIVE</Badge>
      <div className="stream-row-metric"><strong>{format(latest.latency)} ms</strong><small>Latency</small></div>
      <div className="stream-row-metric"><strong>{format(latest.bitrate)} kbps</strong><small>Bitrate</small></div>
      <ArrowRight className="stream-row-arrow" size={17} />
    </button>
  );
}

function DashboardPage({ live, vod, merged, onNavigate, now }) {
  const liveLatest = safeLatest(live);
  const vodLatest = safeLatest(vod);
  return (
    <>
      <div className="welcome-row"><div><div className="eyebrow"><span /> OVERVIEW / LIVE MONITORING</div><h1>네트워크 상태를 한눈에.</h1><p>LIVE와 VOD 스트리밍의 주요 지표를 확인하고 전송 성능을 비교하세요.</p></div><div className="today-chip"><CalendarDays size={16} />{new Date(now).toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' })}</div></div>
      <div className="section-compact"><SectionTitle title="성능 요약" action={<Badge variant="cyan" dot>실시간 모니터링 · 자동 갱신</Badge>} /></div>
      <div className="metric-grid">
        <MetricCard label="LIVE 지연 시간" value={format(liveLatest.latency)} unit="ms" icon={Clock3} accent="cyan" helper="실시간 전송 지연" />
        <MetricCard label="VOD 지연 시간" value={format(vodLatest.latency)} unit="ms" icon={Activity} accent="purple" helper="미디어 응답 지연" />
        <MetricCard label="LIVE 패킷 손실률" value={format(liveLatest.packetLoss, 2)} unit="%" icon={Signal} accent="yellow" helper="전송 품질 측정 항목" />
        <MetricCard label="VOD 비트레이트" value={format(vodLatest.bitrate)} unit="kbps" icon={Gauge} accent="green" helper="동영상 전송률" />
      </div>
      <div className="main-chart-layout">
        <ChartCard className="overview-main-chart" title="스트리밍 지연 시간 비교" description="실시간 추이 · LIVE vs VOD" data={merged} lines={[{ key: 'liveLatency', name: 'LIVE', color: COLORS.live }, { key: 'vodLatency', name: 'VOD', color: COLORS.vod }]} unit="ms" legend area height={252} />
        <Card className="quality-card"><div className="quality-head"><div><span className="mini-eyebrow">NETWORK QUALITY</span><h3>시스템 모니터링</h3></div><span className="live-pulse" /></div><div className="quality-graphic"><div className="quality-ring"><div><Wifi size={26} /><strong>NORMAL</strong><small>MONITORING</small></div></div></div><div className="quality-footer"><span><span className="dot dot-green" />화면 실시간 갱신 중</span><span>{clock(now)}</span></div><p className="quality-note">실시간 네트워크 품질 지표를 모니터링하고 있습니다.</p></Card>
      </div>
      <SectionTitle title="스트리밍 세션" subtitle="모니터링 화면을 선택해 상세 지표를 확인하세요." action={<button className="text-action" onClick={() => onNavigate('compare')}>비교 화면 보기 <ArrowRight size={15} /></button>} />
      <Card className="stream-list"><StreamRow mode="live" latest={liveLatest} onOpen={() => onNavigate('live')} /><StreamRow mode="vod" latest={vodLatest} onOpen={() => onNavigate('vod')} /></Card>
    </>
  );
}

function MonitorPage({ mode, history, videoUrl, onNavigate, scenario }) {
  const live = mode === 'live';
  const latest = safeLatest(history);
  const color = live ? COLORS.live : COLORS.vod;
  return (
    <>
      <div className="page-title-row"><div><div className="eyebrow"><span /> STREAMING / {live ? 'LIVE' : 'VOD'}</div><h1>{live ? 'LIVE 모니터링' : 'VOD 모니터링'}</h1><p>{live ? '실시간 송수신 환경의 지연과 패킷 손실을 관찰합니다.' : 'VOD 재생 상태와 비트레이트, 버퍼를 살펴봅니다.'}</p></div><Badge variant={live ? 'red' : 'purple'} dot>{live ? 'LIVE CHANNEL' : 'VOD CHANNEL'}</Badge></div>
      <div className="monitor-layout">
        <Card className="player-card"><div className="card-heading"><div><h3>{live ? 'Live Stream 01' : 'VOD Player 01'}</h3><p>{live ? 'MediaMTX · WebRTC' : videoUrl ? 'HLS / 미디어 스트림' : '영상 플레이어 · 소스 연결 대기'}</p></div><span className="card-heading-icon"><Video size={18} /></span></div>{live ? <LivePlayer url={videoUrl} onConnect={() => onNavigate('settings')} /> : <VodPlayer url={videoUrl} onConnect={() => onNavigate('settings')} />}<div className="player-footer"><span><span className={`dot ${videoUrl ? 'dot-green' : 'dot-yellow'}`} />{live ? '영상 수신과 서버 지표는 아래에서 각각 확인할 수 있습니다.' : videoUrl ? '플레이어 지표는 영상 아래에 표시됩니다.' : '영상 소스 미연결'}</span><span>전송 지표: 실시간</span></div></Card>
        <div className="monitor-sidebar"><Card className="stream-health"><div className="health-title"><span>STREAM STATUS</span><Badge variant="neutral">실시간 수신</Badge></div><strong>외부 네트워크 지표</strong><p>{live ? 'FastAPI 외부 프로브 기반 · 모드 및 시나리오 보정 적용. 연결 실패 시 데모 데이터로 전환됩니다.' : 'FastAPI 외부 프로브 및 추정값입니다. 연결 실패 시 데모 값이 표시됩니다.'}</p><div className="health-meta"><span>선택 시나리오</span><b>{SCENARIOS.find((item) => item.id === scenario)?.title}</b></div></Card><div className="monitor-metrics"><MetricCard compact label="Latency" value={format(latest.latency)} unit="ms" icon={Clock3} accent="cyan" /><MetricCard compact label="Packet Loss" value={format(latest.packetLoss, 2)} unit="%" icon={Signal} accent="yellow" /><MetricCard compact label={live ? "Bitrate" : "프로브 처리량"} value={format(latest.bitrate)} unit="kbps" icon={Gauge} accent="purple" /><MetricCard compact label={live ? "Buffer Level" : "추정 버퍼"} value={format(latest.buffer, 1)} unit="sec" icon={Activity} accent="green" /></div></div>
      </div>
      <div className="two-charts"><ChartCard title="Latency Trend" description={live ? '서버 프로브 지연 추이 · 데모 전환 가능' : '시간별 지연 변화'} data={history} lines={[{ key: 'latency', name: 'Latency', color }]} unit="ms" area height={214} /><ChartCard title="Packet Loss Trend" description={live ? '서버 프로브 실패율 기반 · 데모 전환 가능' : '시간별 패킷 손실률'} data={history} lines={[{ key: 'packetLoss', name: 'Packet Loss', color: COLORS.warning }]} unit="%" area height={214} /></div>
      <div className="insight-note"><Info size={17} /><span>LIVE(WebRTC) 및 VOD(HLS) 스트리밍 환경의 실시간 네트워크 품질 지표를 수집·분석합니다.</span></div>
    </>
  );
}

const PLAYER_ROWS = [
  ['영상 RTP 패킷 손실률', 'packetLoss', null, '%'],
  ['영상 수신 비트레이트', 'bitrate', null, 'kbps'],
  ['RTP 지터', 'jitter', null, 'ms'],
  ['버퍼 잔여량', null, 'buffer', 's'],
  ['선택 화질 명목 비트레이트', null, 'bitrate', 'kbps'],
  ['재생 중 버퍼링 횟수', null, 'bufferingCount', '회'],
];

function displayMeasurement(value, unit) {
  return Number.isFinite(value) ? `${Number(value.toFixed(2)).toLocaleString('ko-KR')} ${unit}` : 'N/A';
}

function ComparePage({ live, vod, urls, onNavigate, recordings, onRecording }) {
  const [players, setPlayers] = useState({ live: null, vod: null });
  const [trends, setTrends] = useState({ live: [], vod: [] });
  const [condition, setCondition] = useState('normal');
  const [recordingStart, setRecordingStart] = useState(null);
  const recording = useRef(null);

  const receive = useCallback((mode, sample) => {
    setPlayers((previous) => ({ ...previous, [mode]: sample }));
    const active = recording.current;
    if (active && sample && sample.timestamp >= active.start) active.samples.push({ ...sample, mode });
    setTrends((previous) => ({
      ...previous,
      [mode]: sample ? [...previous[mode].slice(-71), sample] : [],
    }));
  }, []);
  const onLiveMetrics = useCallback((sample) => receive('live', sample), [receive]);
  const onVodMetrics = useCallback((sample) => receive('vod', sample), [receive]);

  function start() {
    const start = Date.now();
    recording.current = { condition, start, samples: [] };
    setRecordingStart(start);
  }

  function stop() {
    const active = recording.current;
    if (!active) return;
    recording.current = null;
    onRecording({ ...active, end: Date.now() });
    setRecordingStart(null);
  }

  const external = alignByTimestamp(
    live.filter((sample) => sample.source === 'external-probe'),
    vod.filter((sample) => sample.source === 'external-probe'),
    (sample, mode) => ({ [`${mode}Latency`]: sample.latency }),
  );
  const playerTime = alignByTimestamp(trends.live, trends.vod, () => ({}));
  const domain = playerTime.length ? [playerTime[0].timestamp, Math.max(playerTime.at(-1).timestamp, playerTime[0].timestamp + 1000)] : undefined;
  const sessions = [
    ['normal', '정상 환경', recordings.normal],
    ['degraded', '품질 저하 환경', recordings.degraded],
  ];
  const summaries = sessions.map(([, , session]) => session ? summarizeRecording(session) : {});
  const summaryKeys = ['packetLoss', 'liveBitrate', 'jitter', 'buffer', 'vodBitrate', 'bufferingCount'];

  return (
    <>
      <div className="page-title-row">
        <div><h1>LIVE / VOD 비교</h1><p>같은 시간대의 실제 플레이어 측정과 외부 네트워크 추이를 확인합니다.</p></div>
        <Badge variant="cyan"><GitCompareArrows size={13} /> 실제 플레이어</Badge>
      </div>
      <div className="compare-video-grid">
        <Card className="compare-video-card"><div className="card-heading"><h3>LIVE · WebRTC</h3></div><LivePlayer url={urls.live} small onConnect={() => onNavigate('settings')} onMetrics={onLiveMetrics} /></Card>
        <Card className="compare-video-card"><div className="card-heading"><h3>VOD · HLS</h3></div><VodPlayer url={urls.vod} small onConnect={() => onNavigate('settings')} onMetrics={onVodMetrics} /></Card>
      </div>
      <Card className="comparison-section">
        <div className="card-heading"><div><h3>실제 플레이어 지표</h3><p>버퍼링 횟수는 초기 로딩과 탐색을 제외한 현재 VOD 재생 세션의 값입니다.</p></div></div>
        <div className="table-wrap"><table className="data-table">
          <thead><tr><th>지표</th><th>LIVE</th><th>VOD</th></tr></thead>
          <tbody>{PLAYER_ROWS.map(([label, liveKey, vodKey, unit]) => (
            <tr key={label}><th>{label}</th><td>{displayMeasurement(players.live?.[liveKey], unit)}</td><td>{displayMeasurement(players.vod?.[vodKey], unit)}</td></tr>
          ))}</tbody>
        </table></div>
      </Card>
      <div className="two-charts comparison-section">
        <ChartCard title="LIVE 영상 수신 비트레이트" description="WebRTC 수신 · kbps" data={alignByTimestamp(trends.live, [], (sample) => ({ bitrate: sample.bitrate }))} lines={[{ key: 'bitrate', name: '수신', color: COLORS.live }]} unit="kbps" timeDomain={domain} />
        <ChartCard title="VOD 버퍼 잔여량" description="브라우저 재생 버퍼 · 초" data={alignByTimestamp([], trends.vod, (sample) => ({ buffer: sample.buffer }))} lines={[{ key: 'buffer', name: '버퍼 잔여량', color: COLORS.vod }]} unit="s" timeDomain={domain} />
      </div>
      <div className="comparison-section">
        <ChartCard title="FastAPI 외부 프로브 지연" description="서버 프로브 기반 · 모드 및 시나리오 보정 포함" data={external} lines={[{ key: 'liveLatency', name: 'LIVE 모델', color: COLORS.live }, { key: 'vodLatency', name: 'VOD 모델', color: COLORS.vod }]} legend timeDomain={external.length ? ['dataMin', 'dataMax'] : undefined} />
        {!external.length && <p>외부 프로브 SSE 샘플 대기 중입니다. 로컬 데모 샘플은 이 그래프에서 제외됩니다.</p>}
        <p className="insight-note">시뮬레이션 결과는 <button type="button" className="video-source-btn" onClick={() => onNavigate('tests')}>네트워크 실험</button>에서 확인할 수 있습니다.</p>
      </div>
      <Card className="settings-card comparison-section">
        <div className="card-heading"><div><h3>측정 세션</h3><p>환경 라벨은 사용자가 지정합니다. 네트워크 제한 적용 여부는 검증되지 않았습니다.</p></div></div>
        <div className="experiment-actions comparison-controls">
          <label>환경 <select value={condition} disabled={recordingStart !== null} onChange={(event) => setCondition(event.target.value)}><option value="normal">정상 환경</option><option value="degraded">품질 저하 환경</option></select></label>
          <button type="button" className="primary-button" disabled={recordingStart !== null} onClick={start}>측정 시작</button>
          <button type="button" className="video-source-btn" disabled={recordingStart === null} onClick={stop}>측정 종료</button>
          <span role="status">{recordingStart !== null ? `기록 중 · ${clock(recordingStart)} · 화면을 나가기 전에 측정을 종료하세요.` : '측정 대기 중'}</span>
        </div>
        <div className="table-wrap comparison-section"><table className="data-table">
          <thead><tr><th>측정 지표</th>{sessions.map(([key, name]) => <th key={key}>{name}</th>)}</tr></thead>
          <tbody>
            <tr><th>기록 구간</th>{sessions.map(([key, , session]) => <td key={key}>{session ? `${clock(session.start)}–${clock(session.end)} · ${session.samples.length}개` : 'N/A'}</td>)}</tr>
            {PLAYER_ROWS.map(([label, , , unit], index) => (
              <tr key={label}><th>{label}{index < 5 ? ' 평균' : ' 합계'}</th>{summaries.map((summary, column) => <td key={sessions[column][0]}>{displayMeasurement(summary[summaryKeys[index]], unit)}</td>)}</tr>
            ))}
            <tr><th>실제 플레이어 CSV</th>{sessions.map(([key, name, session]) => <td key={key}>{session ? <button className="video-source-btn" onClick={() => saveCsv(recordingCsv(session), `stream-metrics-${key}-${session.start}.csv`)}>{name} CSV</button> : 'N/A'}</td>)}</tr>
          </tbody>
        </table></div>
        <p>환경별 최근 완료 세션을 페이지 이동 중 유지합니다. 새로고침 전에 CSV를 내려받으세요.</p>
      </Card>
    </>
  );
}

function StatisticsPage({ live, vod, merged }) {
  const mergedWithMA = withMovingAverage(merged, 5);
  const latency = getStats(live, 'latency');
  const loss = getStats(live, 'packetLoss');
  const bitrate = getStats(vod, 'bitrate');
  const buffer = getStats(vod, 'buffer');
  const summary = [
    ['LIVE Latency', 'ms', latency, calcMovingAverage(live, 'latency', 5)],
    ['LIVE Packet Loss', '%', loss, calcMovingAverage(live, 'packetLoss', 5)],
    ['VOD Bitrate', 'kbps', bitrate, calcMovingAverage(vod, 'bitrate', 5)],
    ['VOD Buffer', 'sec', buffer, calcMovingAverage(vod, 'buffer', 5)],
  ];
  return <><div className="page-title-row"><div><div className="eyebrow"><span /> ANALYTICS / STATISTICS</div><h1>통계 분석</h1><p>수집된 구간의 추세와 5초 이동 평균 통계를 정리했습니다.</p></div><Badge variant="cyan"><BarChart3 size={14} /> {live.length} SAMPLES</Badge></div><div className="metric-grid"><MetricCard label="LIVE 평균 지연" value={format(latency.average, 1)} unit="ms" icon={Clock3} accent="cyan" helper="최근 샘플 산술평균" /><MetricCard label="LIVE 5초 이동평균" value={format(calcMovingAverage(live, 'latency', 5), 1)} unit="ms" icon={ArrowUpRight} accent="green" helper="측정 오차 보정 추세" /><MetricCard label="LIVE 평균 손실" value={format(loss.average, 2)} unit="%" icon={Signal} accent="purple" helper="최근 샘플 산술평균" /><MetricCard label="VOD 평균 비트레이트" value={format(bitrate.average)} unit="kbps" icon={Gauge} accent="yellow" helper="최근 샘플 산술평균" /></div><div className="two-charts"><ChartCard title="Latency Distribution & Moving Average" description="실시간 지연 및 5초 이동 평균 추이" data={mergedWithMA} lines={[{ key: 'liveLatency', name: 'LIVE (실시간)', color: COLORS.live }, { key: 'liveLatencyMA', name: 'LIVE (5초 이동평균)', color: COLORS.good }, { key: 'vodLatency', name: 'VOD', color: COLORS.vod }]} unit="ms" legend height={252} /><ChartCard title="Packet Loss Over Time" description="LIVE와 VOD의 시간별 패킷 손실률 비교" data={mergedWithMA} lines={[{ key: 'liveLoss', name: 'LIVE', color: COLORS.warning }, { key: 'vodLoss', name: 'VOD', color: COLORS.vod }]} unit="%" legend height={252} /></div><Card className="stats-summary"><div className="card-heading"><div><h3>측정값 요약</h3><p>현재 모니터링 구간 기준 (5초 이동 평균 포함)</p></div><Badge variant="neutral">MOVING AVERAGE</Badge></div><div className="table-wrap"><table className="data-table"><thead><tr><th>지표</th><th>전체 평균</th><th>5초 이동평균</th><th>최솟값</th><th>최댓값</th><th>P95</th></tr></thead><tbody>{summary.map(([label, unit, s, ma]) => <tr key={label}><td>{label}</td><td>{format(s.average, 1)} {unit}</td><td><b>{format(ma, 1)} {unit}</b></td><td>{format(s.min, 1)} {unit}</td><td>{format(s.max, 1)} {unit}</td><td>{format(s.p95, 1)} {unit}</td></tr>)}</tbody></table></div></Card></>;
}

const EXPERIMENT_PRESETS = {
  normal: DEFAULT_CONDITIONS,
  bandwidth: { bandwidth: '1500', unit: 'kbps', delay: '30', loss: '0' },
  loss: { bandwidth: '5000', unit: 'kbps', delay: '50', loss: '5' },
};

const formatExperimentKbps = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 3 });

function TestsPage({ urls, onNavigate }) {
  const [fields, setFields] = useState(DEFAULT_CONDITIONS);
  const [conditions, setConditions] = useState(null);
  const [history, setHistory] = useState([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!running) return undefined;
    let index = 1;
    const timer = window.setInterval(() => {
      const sample = simulateNetworkSample(conditions, index++);
      setHistory((previous) => [...previous.slice(-71), sample]);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [conditions, running]);

  function start(event) {
    event.preventDefault();
    try {
      const next = validateConditions(fields);
      setConditions(next);
      setHistory([simulateNetworkSample(next, 0)]);
      setError('');
      setRunning(true);
    } catch (validationError) {
      setError(validationError.message);
    }
  }

  function reset() {
    setRunning(false);
    setFields(DEFAULT_CONDITIONS);
    setConditions(null);
    setHistory([]);
    setError('');
  }

  function updateField(event) {
    const { name, value } = event.target;
    setFields((previous) => ({ ...previous, [name]: value }));
    setError('');
  }

  const latest = history.at(-1);
  return (
    <>
      <div className="page-title-row">
        <div><h1>네트워크 실험</h1><p>가상 조건에서 계산한 결과와 현재 영상의 실제 플레이어 지표를 관찰합니다.</p></div>
        <Badge variant="cyan"><FlaskConical size={14} /> 시뮬레이션</Badge>
      </div>
      <div className="test-banner">
        <div className="test-banner-icon"><FlaskConical size={24} /></div>
        <div><strong>실제 네트워크 제한 미적용</strong><p>입력 조건은 이 화면의 시뮬레이션 계산에만 적용됩니다. 두 플레이어는 현재 네트워크에서 재생됩니다.</p></div>
      </div>
      <Card className="settings-card experiment-form">
        <form noValidate onSubmit={start}>
          <fieldset disabled={running}>
            <legend>시뮬레이션 조건</legend>
            <div className="experiment-actions">
              {SCENARIOS.map((item) => (
                <button type="button" className="video-source-btn" key={item.id} onClick={() => {
                  setFields(EXPERIMENT_PRESETS[item.id]);
                  setError('');
                }}>{item.title}</button>
              ))}
            </div>
            <div className="experiment-fields">
              <label>대역폭 제한<input name="bandwidth" type="number" step="any" value={fields.bandwidth} onChange={updateField} /></label>
              <label>대역폭 단위<select name="unit" value={fields.unit} onChange={updateField}><option>kbps</option><option>Mbps</option></select></label>
              <label>추가 지연 (ms)<input name="delay" type="number" step="any" min="0" max="10000" value={fields.delay} onChange={updateField} /></label>
              <label>패킷 손실률 (%)<input name="loss" type="number" step="any" min="0" max="100" value={fields.loss} onChange={updateField} /></label>
            </div>
          </fieldset>
          {error && <p className="experiment-error" role="alert">{error}</p>}
          <div className="experiment-actions">
            <button className="primary-button" disabled={running}>실험 시작</button>
            <button type="button" className="video-source-btn" disabled={!running} onClick={() => setRunning(false)}>중단</button>
            <button type="button" className="video-source-btn" onClick={reset}>초기화</button>
            <span role="status">{running ? '시뮬레이션 실행 중' : latest ? '시뮬레이션 중단됨' : '시뮬레이션 대기 중'}</span>
          </div>
        </form>
      </Card>
      <SectionTitle title="시뮬레이션 결과" subtitle="데모 기준값에 대역폭 상한, 추가 지연, 추가 손실 확률을 적용한 계산값입니다." />
      {latest && (
        <div className="compare-detail-grid">
          <ChartCard title="예상 지연 추이" description="시뮬레이션 · 최근 72개 샘플" data={history} lines={[{ key: 'liveLatency', name: 'LIVE 모델', color: COLORS.live }, { key: 'vodLatency', name: 'VOD 모델', color: COLORS.vod }]} unit="ms" legend height={242} />
          <Card>
            <div className="card-heading"><div><h3>최근 시뮬레이션 값</h3><p>{formatExperimentKbps.format(conditions.bandwidthKbps)} kbps · +{conditions.delayMs} ms · 추가 손실 {conditions.lossPercent}%</p></div></div>
            <div className="table-wrap"><table className="data-table">
              <thead><tr><th>모델</th><th>지연</th><th>손실률</th><th>처리량</th></tr></thead>
              <tbody>{['live', 'vod'].map((mode) => (
                <tr key={mode}><th>{mode.toUpperCase()}</th><td>{format(latest[mode].latency, 1)} ms</td><td>{format(latest[mode].packetLoss, 2)}%</td><td>{formatExperimentKbps.format(latest[mode].bitrate)} kbps</td></tr>
              ))}</tbody>
            </table></div>
          </Card>
        </div>
      )}
      <SectionTitle title="실제 플레이어 지표" subtitle="현재 연결에서 받은 WebRTC·HLS 지표입니다. HLS 명목 비트레이트는 매니페스트에 선언된 값입니다." />
      <div className="compare-video-grid">
        <Card className="compare-video-card"><div className="card-heading"><div><h3>LIVE · WebRTC</h3></div></div><LivePlayer url={urls.live} onConnect={() => onNavigate('settings')} /></Card>
        <Card className="compare-video-card"><div className="card-heading"><div><h3>VOD · HLS</h3></div></div><VodPlayer url={urls.vod} onConnect={() => onNavigate('settings')} /></Card>
      </div>
    </>
  );
}

function downloadCsv(live, vod) {
  const header = 'timestamp,mode,latency_ms,packet_loss_percent,bitrate_kbps,buffer_sec,jitter_ms';
  const rows = [
    ...live.map((s) => [new Date(s.timestamp).toISOString(), 'LIVE', s.latency, s.packetLoss, s.bitrate, s.buffer, s.jitter]),
    ...vod.map((s) => [new Date(s.timestamp).toISOString(), 'VOD', s.latency, s.packetLoss, s.bitrate, s.buffer, s.jitter]),
  ];
  const csv = '\uFEFF' + [header, ...rows.map((row) => row.join(','))].join('\r\n');
  saveCsv(csv, `stream-metrics-${new Date().toISOString().slice(0, 10)}.csv`);
}

function saveCsv(csv, filename) {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function ReportsPage({ live, vod }) {
  const latest = [...live.slice(-4).map((s) => ({ ...s, mode: 'LIVE' })), ...vod.slice(-4).map((s) => ({ ...s, mode: 'VOD' }))].sort((a, b) => b.timestamp - a.timestamp);
  return <><div className="page-title-row"><div><div className="eyebrow"><span /> ANALYTICS / REPORTS</div><h1>리포트</h1><p>측정 기록을 확인하고 데이터 파일을 내려받으세요.</p></div><button className="primary-button" onClick={() => downloadCsv(live, vod)}><Download size={17} /> CSV 다운로드</button></div><div className="report-summary"><Card><div className="report-icon accent-cyan"><Database size={20} /></div><strong>{live.length + vod.length}</strong><span>수집된 측정 샘플</span></Card><Card><div className="report-icon accent-purple"><Activity size={20} /></div><strong>2</strong><span>스트리밍 모드</span></Card><Card><div className="report-icon accent-green"><CheckCircle2 size={20} /></div><strong>CSV</strong><span>지원 내보내기 형식</span></Card></div><Card className="report-table-card"><div className="card-heading"><div><h3>최근 샘플 기록</h3><p>최신 데이터 8건 미리보기</p></div><Badge variant="neutral">REALTIME DATA</Badge></div><div className="table-wrap"><table className="data-table"><thead><tr><th>측정 시각</th><th>스트리밍</th><th>Latency</th><th>Packet Loss</th><th>Bitrate</th><th>Buffer</th></tr></thead><tbody>{latest.map((s) => <tr key={`${s.mode}-${s.timestamp}`}><td>{clock(s.timestamp)}</td><td><Badge variant={s.mode === 'LIVE' ? 'cyan' : 'purple'}>{s.mode}</Badge></td><td>{format(s.latency)} ms</td><td>{format(s.packetLoss, 2)}%</td><td>{format(s.bitrate)} kbps</td><td>{format(s.buffer, 1)} sec</td></tr>)}</tbody></table></div></Card><div className="insight-note"><Info size={17} /><span>CSV에는 현재까지 수집된 실시간 시계열 측정 기록이 저장됩니다.</span></div></>;
} 

function SettingsPage({ urls, onUrlChange, refreshInterval, onRefreshChange }) {
  return <><div className="page-title-row"><div><div className="eyebrow"><span /> SYSTEM / SETTINGS</div><h1>대시보드 설정</h1><p>영상 소스와 모니터링 데이터 갱신 주기를 설정할 수 있습니다.</p></div><Badge variant="neutral"><Settings size={14} /> LOCAL SETTINGS</Badge></div><div className="settings-grid"><Card className="settings-card"><div className="card-heading"><div><h3>영상 소스</h3><p>LIVE는 MediaMTX 주소, VOD는 HLS(.m3u8) 또는 브라우저에서 재생 가능한 영상 URL을 입력하세요.</p></div><Video size={20} /></div><label className="field-label" htmlFor="live-url">LIVE 영상 URL</label><input id="live-url" type="url" value={urls.live} onChange={(e) => onUrlChange('live', e.target.value)} placeholder="http://localhost:8889/mystream" /><label className="field-label" htmlFor="vod-url">VOD 영상 URL</label><input id="vod-url" type="url" value={urls.vod} onChange={(e) => onUrlChange('vod', e.target.value)} placeholder="http://localhost:5173/vod/stage2-demo/master.m3u8" /><div className="settings-note"><Info size={16} /><span>HLS(.m3u8) 스트림을 입력하면 적응형 비트레이트(ABR) 재생 및 실제 버퍼 잔여량이 자동 측정됩니다.</span></div></Card><Card className="settings-card"><div className="card-heading"><div><h3>표시 설정</h3><p>모니터링 차트의 업데이트 간격을 선택하세요.</p></div><SlidersHorizontal size={20} /></div><label className="field-label">데이터 갱신 간격</label><div className="segmented-row">{[1000, 2000, 5000].map((ms) => <button key={ms} className={refreshInterval === ms ? 'selected' : ''} onClick={() => onRefreshChange(ms)}>{ms / 1000}초</button>)}</div><div className="settings-status"><div><span className="dot dot-green" /><strong>프론트엔드</strong></div><Badge variant="green">실행 중</Badge></div><div className="settings-status"><div><span className="dot dot-green" /><strong>FastAPI 데이터 연동</strong></div><Badge variant="green">연동됨</Badge></div><div className="settings-status"><div><span className={`dot ${urls.live || urls.vod ? 'dot-green' : 'dot-yellow'}`} /><strong>LIVE / VOD 소스</strong></div><Badge variant={urls.live || urls.vod ? 'green' : 'yellow'}>{urls.live || urls.vod ? '연결됨' : '설정 필요'}</Badge></div></Card></div><div className="insight-note"><Info size={17} /><span>변경된 영상 소스 URL과 데이터 갱신 간격은 현재 모니터링 세션에 즉시 반영됩니다.</span></div></>;
}

export default function App() {
  const [page, setPage] = useState('dashboard');
  const [sidebarVisible, setSidebarVisible] = useState(false);
  const [scenario, setScenario] = useState('normal');
  const [refreshInterval, setRefreshInterval] = useState(1000);
  const [videoUrls, setVideoUrls] = useState({ live: 'http://localhost:8889/mystream', vod: '' });
  const [recordings, setRecordings] = useState({});
  const [live, setLive] = useState([]);
  const [vod, setVod] = useState([]);
  const [now, setNow] = useState(() => Date.now());
  const tick = useRef(72);
  useEffect(() => {
    let liveEs = null;
    let vodEs = null;
    let fallbackTimer = null;

    const startFallback = () => {
      if (fallbackTimer) return;
      setLive((prev) => (prev.length ? prev : initialHistory('live', 'normal')));
      setVod((prev) => (prev.length ? prev : initialHistory('vod', 'normal')));
      fallbackTimer = window.setInterval(() => {
        tick.current += 1;
        const time = Date.now();
        const liveSample = makeSample('live', tick.current, 'normal', time);
        const vodSample = makeSample('vod', tick.current, 'normal', time);
        setLive((history) => [...history.slice(-71), liveSample]);
        setVod((history) => [...history.slice(-71), vodSample]);
        setNow(time);
      }, refreshInterval);
    };

    try {
      liveEs = new EventSource('http://localhost:8000/api/metrics/stream?mode=live');
      vodEs = new EventSource('http://localhost:8000/api/metrics/stream?mode=vod');

      liveEs.addEventListener('hello', (event) => setScenario(JSON.parse(event.data).scenario));
      liveEs.onmessage = (event) => {
        const sample = { ...JSON.parse(event.data), source: 'external-probe' };
        setLive((prev) => [...prev.slice(-71), sample]);
        setNow(sample.timestamp);
      };

      vodEs.onmessage = (event) => {
        const sample = { ...JSON.parse(event.data), source: 'external-probe' };
        setVod((prev) => [...prev.slice(-71), sample]);
      };

      liveEs.onerror = () => {
        liveEs?.close();
        vodEs?.close();
        startFallback();
      };
    } catch {
      startFallback();
    }

    return () => {
      liveEs?.close();
      vodEs?.close();
      if (fallbackTimer) window.clearInterval(fallbackTimer);
    };
  }, [refreshInterval]);

  const merged = getMergedHistory(live, vod);

  let content;
  switch (page) {
    case 'live': content = <MonitorPage mode="live" history={live} videoUrl={videoUrls.live} onNavigate={setPage} scenario={scenario} />; break;
    case 'vod': content = <MonitorPage mode="vod" history={vod} videoUrl={videoUrls.vod} onNavigate={setPage} scenario={scenario} />; break;
    case 'compare': content = <ComparePage live={live} vod={vod} urls={videoUrls} onNavigate={setPage} recordings={recordings} onRecording={(session) => setRecordings((previous) => ({ ...previous, [session.condition]: session }))} />; break;
    case 'statistics': content = <StatisticsPage live={live} vod={vod} merged={merged} />; break;
    case 'tests': content = <TestsPage urls={videoUrls} onNavigate={setPage} />; break;
    case 'reports': content = <ReportsPage live={live} vod={vod} />; break;
    case 'settings': content = <SettingsPage urls={videoUrls} onUrlChange={(mode, url) => setVideoUrls((old) => ({ ...old, [mode]: url }))} refreshInterval={refreshInterval} onRefreshChange={setRefreshInterval} />; break;
    default: content = <DashboardPage live={live} vod={vod} merged={merged} onNavigate={setPage} now={now} />;
  }

  return (
    <div className="app-shell">
      <Sidebar page={page} onNavigate={setPage} visible={sidebarVisible} onClose={() => setSidebarVisible(false)} />
      <div className="main-shell">
        <header className="topbar"><div className="topbar-left"><button className="icon-button menu-toggle" onClick={() => setSidebarVisible(true)} aria-label="메뉴 열기"><Menu size={21} /></button><div className="breadcrumb">Workspace <span>/</span> <strong>{PAGE_INFO[page][0]}</strong></div></div><div className="topbar-right"><span className="sync-time"><Clock3 size={14} /> {clock(now)}</span></div></header>
        <main className="main-content" id="main-content">{content}<footer className="footer"><span>© 2026 Stream Metrics · 데이터통신 4팀</span><span>Stream Metrics <b>v1.0.0</b> · Real-time Network Monitoring</span></footer></main>
      </div>
    </div>
  );
}
