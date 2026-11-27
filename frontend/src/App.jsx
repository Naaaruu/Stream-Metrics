import { useCallback, useEffect, useId, useRef, useState } from 'react';
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
  getLatest, getStats, initialHistory, makeSample, SCENARIOS,
} from './data/mockMetrics.js';
import { DEFAULT_CONDITIONS, simulateNetworkSample, validateConditions } from './data/networkExperiment.js';
import { applyNetem, clearNetem, proxiedVodUrl } from './data/netemApi.js';
import { alignByTimestamp, recordingCsv, summarizeRecording } from './data/comparison.js';
import './App.css';

const COLORS = { live: '#42cce5', vod: '#a68cff', good: '#55dda7', warning: '#f6b65f' };
const MODES = ['live', 'vod'];
const SSE_RETRY_MS = 2000;
const SSE_STATUS = {
  connecting: ['연결 중', 'neutral'],
  connected: ['연결됨', 'green'],
  reconnecting: ['연결 끊김 · 재연결 중', 'yellow'],
};

function FastApiStatus({ connections }) {
  return (
    <div className="source-status" role="status" aria-label="FastAPI 연결 상태">
      {MODES.map((mode) => {
        const [label, variant] = SSE_STATUS[connections[mode]];
        return <Badge key={mode} variant={variant} dot>FastAPI {mode.toUpperCase()} · {label}</Badge>;
      })}
    </div>
  );
}

function safeLatest(list) {
  return getLatest(list) ?? {};
}

function calcMovingAverage(samples, key, windowSize = 5) {
  const values = samples.slice(-windowSize).map((sample) => sample[key]).filter(Number.isFinite);
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function withMovingAverage(mergedData, windowSize = 5) {
  return mergedData.map((row, index, array) => {
    const start = Math.max(0, index - windowSize + 1);
    const slice = array.slice(start, index + 1);
    return {
      ...row,
      liveLatencyMA: Number.isFinite(row.liveLatency) ? calcMovingAverage(slice, 'liveLatency', windowSize) : null,
      vodLatencyMA: Number.isFinite(row.vodLatency) ? calcMovingAverage(slice, 'vodLatency', windowSize) : null,
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
  if (!Number.isFinite(value)) return 'N/A';
  return value.toLocaleString('ko-KR', {
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
          <div className="sidebar-help"><div className="sidebar-help-icon"><Zap size={17} /></div><strong>데이터 출처 안내</strong><p>외부 프로브, WebRTC 영상 실측, 로컬 데모의 출처를 화면에서 확인할 수 있습니다.</p></div>
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
      <div className="metric-number">{value}<small>{value !== 'N/A' && unit}</small></div>
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
        <div key={entry.dataKey}><span style={{ background: entry.color }} />{entry.name}<b>{format(entry.value, suffix === 'kbps' ? 0 : 2)}{suffix === '%' ? suffix : ` ${suffix}`}</b></div>
      ))}
    </div>
  );
}

function TrendChart({ data, lines, unit = 'ms', area = false, height = 224, legend = false, timeDomain, points = false }) {
  const gradientId = useId();
  if (!data.some((row) => lines.some(({ key }) => Number.isFinite(row[key])))) {
    return <div className="chart-empty" style={{ height }}>미측정 · 수집된 데이터 없음</div>;
  }
  const ChartComponent = area ? AreaChart : LineChart;
  return (
    <div className="chart-wrap" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%" minWidth={0}>
        <ChartComponent data={data} margin={{ top: 14, right: 10, left: 4, bottom: 0 }}>
          <defs>
            {lines.map(({ key, color }) => (
              <linearGradient id={`${gradientId}-${key}`} key={key} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={color} stopOpacity={0.24} /><stop offset="100%" stopColor={color} stopOpacity={0} /></linearGradient>
            ))}
          </defs>
          <CartesianGrid stroke="#1e2c40" strokeDasharray="4 6" vertical={false} />
          <XAxis dataKey="timestamp" type={timeDomain ? 'number' : 'category'} domain={timeDomain} tickFormatter={(ts) => clock(ts).slice(3)} stroke="#61748d" tick={{ fill: '#71829a', fontSize: 11 }} axisLine={false} tickLine={false} minTickGap={30} />
          <YAxis tick={{ fill: '#71829a', fontSize: 11 }} stroke="#61748d" axisLine={false} tickLine={false} width="auto" allowDecimals={unit !== '회'} domain={['auto', 'auto']} />
          <Tooltip content={<ChartTooltip suffix={unit} />} />
          {legend && <Legend iconType="circle" iconSize={7} wrapperStyle={{ fontSize: 12, color: '#91a3b9', paddingTop: 8 }} />}
          {lines.map(({ key, name, color, type = 'monotone', strokeWidth = 2.3 }) => area ? (
            <Area key={key} name={name} type={type} dataKey={key} stroke={color} strokeWidth={2.5} fill={`url(#${gradientId}-${key})`} dot={points} activeDot={{ r: 4 }} isAnimationActive={false} />
          ) : (
            <Line key={key} name={name} type={type} dataKey={key} stroke={color} strokeWidth={strokeWidth}
              dot={points && (strokeWidth === 0 ? { fill: color, r: 3 } : true)} activeDot={{ r: 4 }} isAnimationActive={false} />
          ))}
        </ChartComponent>
      </ResponsiveContainer>
    </div>
  );
}

function ChartCard({ title, description, data, lines, unit, area = false, legend = false, height = 220, className = '', timeDomain, points }) {
  return <Card className={`chart-card ${className}`}><div className="chart-card-head"><div><h3>{title}</h3>{description && <p>{description}</p>}</div><span className="chart-unit">{unit}</span></div><TrendChart data={data} lines={lines} unit={unit} area={area} height={height} legend={legend} timeDomain={timeDomain} points={points} /></Card>;
}

function StreamRow({ mode, latest, onOpen }) {
  const live = mode === 'live';
  return (
    <button className="stream-row" onClick={onOpen}>
      <div className={`stream-row-icon ${live ? 'stream-row-live' : 'stream-row-vod'}`}>{live ? <Radio size={19} /> : <Video size={19} />}</div>
      <div className="stream-row-name"><strong>{live ? 'Live Streaming' : 'VOD Streaming'}</strong><small>{live ? 'Real-time transport' : 'Adaptive playback'}</small></div>
      <Badge variant={Number.isFinite(latest.latency) ? "cyan" : "neutral"}>{Number.isFinite(latest.latency) ? "데이터 있음" : "N/A"}</Badge>
      <div className="stream-row-metric"><strong>{displayMeasurement(latest.latency, 'ms')}</strong><small>Latency</small></div>
      <div className="stream-row-metric"><strong>{displayMeasurement(latest.bitrate, 'kbps')}</strong><small>Bitrate</small></div>
      <ArrowRight className="stream-row-arrow" size={17} />
    </button>
  );
}

function DashboardPage({ live, vod, merged, onNavigate, now, demo }) {
  const liveLatest = safeLatest(live);
  const vodLatest = safeLatest(vod);
  return (
    <>
      <div className="welcome-row"><div><div className="eyebrow"><span /> OVERVIEW / LIVE MONITORING</div><h1>네트워크 상태를 한눈에.</h1><p>LIVE와 VOD 스트리밍의 주요 지표를 확인하고 전송 성능을 비교하세요.</p></div><div className="today-chip"><CalendarDays size={16} />{new Date(now).toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' })}</div></div>
      <div className="section-compact"><SectionTitle title="성능 요약" action={<Badge variant="cyan" dot>{demo ? "로컬 데모 · 시뮬레이션" : "FastAPI 외부 프로브 · 보정 포함"}</Badge>} /></div>
      <div className="metric-grid">
        <MetricCard label="LIVE 지연 시간" value={format(liveLatest.latency)} unit="ms" icon={Clock3} accent="cyan" helper={demo ? "시뮬레이션" : "서버 프로브 연결 시간"} />
        <MetricCard label="VOD 지연 시간" value={format(vodLatest.latency)} unit="ms" icon={Activity} accent="purple" helper={demo ? "시뮬레이션" : "모드 보정 적용"} />
        <MetricCard label="LIVE 프로브 실패율" value={format(liveLatest.packetLoss, 2)} unit="%" icon={Signal} accent="yellow" helper={demo ? "시뮬레이션" : "서버 프로브 시도 기준"} />
        <MetricCard label="VOD 프로브 처리량" value={format(vodLatest.bitrate)} unit="kbps" icon={Gauge} accent="green" helper={demo ? "시뮬레이션" : "서버 다운로드 프로브"} />
      </div>
      <div className="main-chart-layout">
        <ChartCard className="overview-main-chart" title="외부 네트워크 지연 비교" description={demo ? "로컬 데모 · 시뮬레이션" : "FastAPI 외부 프로브 · LIVE/VOD 보정 포함"} data={merged} lines={[{ key: 'liveLatency', name: 'LIVE', color: COLORS.live }, { key: 'vodLatency', name: 'VOD', color: COLORS.vod }]} unit="ms" legend area height={252} />
        <Card className="quality-card"><div className="quality-head"><div><span className="mini-eyebrow">NETWORK QUALITY</span><h3>시스템 모니터링</h3></div></div><div className="quality-graphic"><div className="quality-ring"><div><Wifi size={26} /><strong>{demo ? 'DEMO' : live.length || vod.length ? 'SSE' : 'N/A'}</strong><small>DATA SOURCE</small></div></div></div><p className="quality-note">{demo ? '로컬에서 생성한 시뮬레이션 데이터' : 'FastAPI 외부 프로브 기반 지표'}</p></Card>
      </div>
      <SectionTitle title="스트리밍 세션" subtitle="모니터링 화면을 선택해 상세 지표를 확인하세요." action={<button className="text-action" onClick={() => onNavigate('compare')}>비교 화면 보기 <ArrowRight size={15} /></button>} />
      <Card className="stream-list"><StreamRow mode="live" latest={liveLatest} onOpen={() => onNavigate('live')} /><StreamRow mode="vod" latest={vodLatest} onOpen={() => onNavigate('vod')} /></Card>
    </>
  );
}

const LIVE_CHARTS = [
  { key: 'packetLoss', name: '영상 RTP 패킷 손실률', unit: '%', color: COLORS.warning },
  { key: 'bitrate', name: '영상 수신 비트레이트', unit: 'kbps', color: COLORS.live },
  { key: 'jitter', name: '영상 RTP 지터', unit: 'ms', color: COLORS.vod },
];

const VOD_CHARTS = [
  { key: 'throughputKbps', name: '영상 세그먼트 다운로드 처리량', unit: 'kbps', color: COLORS.live, strokeWidth: 0, description: '요청 시작부터 다운로드 완료까지 · 세그먼트별 측정' },
  { key: 'buffer', name: '버퍼 잔여량', unit: 's', color: COLORS.vod },
  { key: 'bitrate', name: '선택 화질 명목 비트레이트', unit: 'kbps', color: COLORS.good, type: 'stepAfter' },
  { key: 'bufferingCount', name: '누적 버퍼링 횟수', unit: '회', color: COLORS.warning, type: 'stepAfter' },
  { key: 'bufferingSeconds', name: '누적 버퍼링 시간', unit: 's', color: COLORS.warning },
];

const SEGMENT_ROUTE_LINES = [
  { key: 'proxy', name: '프록시 경유', color: COLORS.live, strokeWidth: 0 },
  { key: 'direct', name: '프록시 우회', color: COLORS.warning, strokeWidth: 0 },
  { key: 'unknown', name: '경로 미확인', color: COLORS.vod, strokeWidth: 0 },
];

function PlayerMetricCharts({ mode, samples, latest, showSegmentRoutes = false, lossArea = false }) {
  const live = mode === 'live';
  const firstTimestamp = samples[0]?.timestamp;
  const timeDomain = firstTimestamp === undefined ? undefined
    : [firstTimestamp, Math.max(firstTimestamp + 1000, samples.at(-1).timestamp)];
  return (
    <div className="two-charts">
      {(live ? LIVE_CHARTS : VOD_CHARTS).map((metric) => {
        const byRoute = showSegmentRoutes && metric.key === 'throughputKbps';
        const data = byRoute ? samples.map((sample) => ({
          timestamp: sample.timestamp,
          [sample.segmentRoute]: sample.throughputKbps,
        })) : samples;
        return <ChartCard key={metric.key} points title={metric.name} description={metric.description}
          data={data} lines={byRoute ? SEGMENT_ROUTE_LINES : [metric]} legend={byRoute} unit={metric.unit}
          timeDomain={timeDomain} area={lossArea && metric.key === 'packetLoss'} height={214} />;
      })}
      {!live && <MetricCard label="첫 재생까지 걸린 시간" value={measurement(latest?.startupSec, 2)}
        unit={Number.isFinite(latest?.startupSec) ? 's' : undefined} icon={Clock3} accent="purple"
        helper="소스 로드 시작부터 첫 재생까지 · 재생 세션별 1회" />}
    </div>
  );
}

function MonitorPage({ mode, history, videoUrl, onNavigate, scenario, demo }) {
  const live = mode === 'live';
  const latest = safeLatest(history);
  const color = live ? COLORS.live : COLORS.vod;
  const [videoHistory, setVideoHistory] = useState([]);
  const onVideoMetrics = useCallback((sample) => {
    setVideoHistory((history) => sample ? [...history.slice(-71), sample] : []);
  }, []);
  const source = demo ? '로컬 데모 · 시뮬레이션' : 'FastAPI 외부 프로브 · 모드 및 시나리오 보정 포함';
  return (
    <>
      <div className="page-title-row"><div><div className="eyebrow"><span /> STREAMING / {live ? 'LIVE' : 'VOD'}</div><h1>{live ? 'LIVE 모니터링' : 'VOD 모니터링'}</h1><p>{live ? '실시간 송수신 환경의 지연과 패킷 손실을 관찰합니다.' : 'VOD 재생 상태와 비트레이트, 버퍼를 살펴봅니다.'}</p></div><Badge variant={live ? 'red' : 'purple'} dot>{live ? 'LIVE CHANNEL' : 'VOD CHANNEL'}</Badge></div>
      <div className="monitor-layout">
        <Card className="player-card"><div className="card-heading"><div><h3>{live ? 'Live Stream 01' : 'VOD Player 01'}</h3><p>{live ? 'MediaMTX · WebRTC' : videoUrl ? 'HLS / 미디어 스트림' : '영상 플레이어 · 소스 연결 대기'}</p></div><span className="card-heading-icon"><Video size={18} /></span></div>{live ? <LivePlayer url={videoUrl} onConnect={() => onNavigate('settings')} onMetrics={onVideoMetrics} /> : <VodPlayer url={videoUrl} onConnect={() => onNavigate('settings')} onMetrics={onVideoMetrics} />}<div className="player-footer"><span><span className={`dot ${videoUrl ? 'dot-green' : 'dot-yellow'}`} />{live ? '영상 수신과 서버 지표는 아래에서 각각 확인할 수 있습니다.' : videoUrl ? '플레이어 지표는 영상 아래에 표시됩니다.' : '영상 소스 미연결'}</span><span>전송 지표: 실시간</span></div></Card>
        <div className="monitor-sidebar">
          <Card className="stream-health">
            <div className="health-title"><span>네트워크 지표 출처</span><Badge variant={demo ? 'yellow' : 'cyan'}>{demo ? '데모' : '외부 프로브'}</Badge></div>
            <p>{source}</p>
            <div className="health-meta"><span>시나리오</span><b>{SCENARIOS.find((item) => item.id === (demo ? 'normal' : scenario))?.title}</b></div>
          </Card>
          <div className="monitor-metrics">
            <MetricCard compact label="프로브 연결 시간" value={format(latest.latency)} unit="ms" icon={Clock3} accent="cyan" />
            <MetricCard compact label="프로브 실패율" value={format(latest.packetLoss, 2)} unit="%" icon={Signal} accent="yellow" />
            <MetricCard compact label="프로브 처리량" value={format(latest.bitrate)} unit="kbps" icon={Gauge} accent="purple" />
            <MetricCard compact label="추정 버퍼" value={format(latest.buffer, 1)} unit="sec" icon={Activity} accent="green" />
          </div>
        </div>
      </div>
      <div className="two-charts">
        <ChartCard title="프로브 연결 시간 추이" description={source} data={history} lines={[{ key: 'latency', name: '연결 시간', color }]} unit="ms" area height={214} />
        <ChartCard title="프로브 실패율 추이" description={source} data={history} lines={[{ key: 'packetLoss', name: '실패율', color: COLORS.warning }]} unit="%" area height={214} />
      </div>
      <section className="comparison-section" aria-label={live ? 'WebRTC 영상 실측' : 'VOD 영상 실측'}>
        <SectionTitle title={live ? 'WebRTC 영상 실측' : 'VOD 영상 실측'}
          subtitle={live ? '브라우저에서 수신 중인 영상의 RTP 지표' : '브라우저 재생 지표와 hls.js 영상 세그먼트 측정'} />
        <PlayerMetricCharts mode={mode} samples={videoHistory} latest={videoHistory.at(-1)} />
      </section>
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

function measurement(value, digits, unit) {
  if (!Number.isFinite(value)) return '미측정';
  return unit ? `${format(value, digits)} ${unit}` : format(value, digits);
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
        <ChartCard title="FastAPI 외부 프로브 지연" description="최근 수신 기록 · 모드 및 시나리오 보정 포함" data={external} lines={[{ key: 'liveLatency', name: 'LIVE 모델', color: COLORS.live }, { key: 'vodLatency', name: 'VOD 모델', color: COLORS.vod }]} legend timeDomain={external.length ? ['dataMin', 'dataMax'] : undefined} />
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
  const latency = live.length ? getStats(live, 'latency') : {};
  const loss = live.length ? getStats(live, 'packetLoss') : {};
  const bitrate = vod.length ? getStats(vod, 'bitrate') : {};
  const buffer = getStats(vod, 'buffer');
  const summary = [
    ['LIVE Latency', 'ms', latency, calcMovingAverage(live, 'latency', 5)],
    ['LIVE Packet Loss', '%', loss, calcMovingAverage(live, 'packetLoss', 5)],
    ['VOD Bitrate', 'kbps', bitrate, calcMovingAverage(vod, 'bitrate', 5)],
    ['VOD Buffer', 'sec', buffer, calcMovingAverage(vod, 'buffer', 5)],
  ];
  return <><div className="page-title-row"><div><div className="eyebrow"><span /> ANALYTICS / STATISTICS</div><h1>통계 분석</h1><p>수집된 구간의 추세와 5초 이동 평균 통계를 정리했습니다.</p></div><Badge variant="cyan"><BarChart3 size={14} /> {live.length} SAMPLES</Badge></div><div className="metric-grid"><MetricCard label="LIVE 평균 지연" value={format(latency.average, 1)} unit="ms" icon={Clock3} accent="cyan" helper="최근 샘플 산술평균" /><MetricCard label="LIVE 5초 이동평균" value={format(calcMovingAverage(live, 'latency', 5), 1)} unit="ms" icon={ArrowUpRight} accent="green" helper="측정 오차 보정 추세" /><MetricCard label="LIVE 평균 손실" value={format(loss.average, 2)} unit="%" icon={Signal} accent="purple" helper="최근 샘플 산술평균" /><MetricCard label="VOD 평균 비트레이트" value={format(bitrate.average)} unit="kbps" icon={Gauge} accent="yellow" helper="최근 샘플 산술평균" /></div><div className="two-charts"><ChartCard title="Latency Distribution & Moving Average" description="실시간 지연 및 5초 이동 평균 추이" data={mergedWithMA} lines={[{ key: 'liveLatency', name: 'LIVE (실시간)', color: COLORS.live }, { key: 'liveLatencyMA', name: 'LIVE (5초 이동평균)', color: COLORS.good }, { key: 'vodLatency', name: 'VOD', color: COLORS.vod }]} unit="ms" legend height={252} /><ChartCard title="Packet Loss Over Time" description="LIVE와 VOD의 시간별 패킷 손실률 비교" data={mergedWithMA} lines={[{ key: 'liveLoss', name: 'LIVE', color: COLORS.warning }, { key: 'vodLoss', name: 'VOD', color: COLORS.vod }]} unit="%" legend height={252} /></div><Card className="stats-summary"><div className="card-heading"><div><h3>측정값 요약</h3><p>현재 모니터링 구간 기준 (5초 이동 평균 포함)</p></div><Badge variant="neutral">MOVING AVERAGE</Badge></div><div className="table-wrap"><table className="data-table"><thead><tr><th>지표</th><th>전체 평균</th><th>5초 이동평균</th><th>최솟값</th><th>최댓값</th><th>P95</th></tr></thead><tbody>{summary.map(([label, unit, s, ma]) => <tr key={label}><td>{label}</td><td>{displayMeasurement(s.average, unit)}</td><td><b>{displayMeasurement(ma, unit)}</b></td><td>{displayMeasurement(s.min, unit)}</td><td>{displayMeasurement(s.max, unit)}</td><td>{displayMeasurement(s.p95, unit)}</td></tr>)}</tbody></table></div></Card></>;
}

const EXPERIMENT_PRESETS = {
  normal: DEFAULT_CONDITIONS,
  bandwidth: { bandwidth: '1500', unit: 'kbps', delay: '30', loss: '0' },
  loss: { bandwidth: '5000', unit: 'kbps', delay: '50', loss: '5' },
};

const formatExperimentKbps = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 3 });

function VodProxyStatus({ running, busy, applied, counts, usesHls, blocked }) {
  if (!running || busy) return null;
  if (!applied) {
    return <p className="experiment-error" role="alert">VOD 프록시 미적용 · VOD 영상 주소와 FastAPI 연결을 확인하세요.</p>;
  }
  if (blocked) {
    return <p className="experiment-error" role="status">100% 손실 설정 · 프록시 요청을 HTTP 503으로 거부하므로 완료된 세그먼트를 확인할 수 없습니다.</p>;
  }
  if (usesHls === false) {
    return <p className="experiment-error" role="status">브라우저 기본 재생 모드에서는 영상 세그먼트 경유를 확인할 수 없습니다.</p>;
  }
  if (!counts.proxy && !counts.direct && !counts.unknown) {
    return <p role="status">VOD 영상 세그먼트 경유 미확인 · 첫 다운로드 응답 대기 중</p>;
  }
  return (
    <p className={counts.direct || counts.unknown ? 'experiment-error' : undefined} role="status">
      영상 세그먼트 응답 · 프록시 경유 {counts.proxy}건 · 우회 {counts.direct}건 · 미확인 {counts.unknown}건
      {counts.direct > 0 && ' · 우회한 세그먼트에는 프록시 제한이 적용되지 않았습니다.'}
    </p>
  );
}

const EMPTY_SEGMENT_COUNTS = { proxy: 0, direct: 0, unknown: 0 };

function TestsPage({ urls, external, onNavigate }) {
  const [fields, setFields] = useState(DEFAULT_CONDITIONS);
  const [conditions, setConditions] = useState(null);
  const [history, setHistory] = useState([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [applied, setApplied] = useState(null);
  const [applyError, setApplyError] = useState('');
  const [busy, setBusy] = useState(false);
  const [liveReal, setLiveReal] = useState(null);
  const [vodReal, setVodReal] = useState(null);
  const [liveRealHistory, setLiveRealHistory] = useState([]);
  const [vodRealHistory, setVodRealHistory] = useState([]);
  const [segmentCounts, setSegmentCounts] = useState(EMPTY_SEGMENT_COUNTS);
  const [vodRun, setVodRun] = useState(0);
  const capture = useRef(true);
  const skipLiveInterval = useRef(false);
  const onLiveMetrics = useCallback((sample) => {
    if (!capture.current) return;
    if (sample && skipLiveInterval.current) {
      // The first counter delta can span the condition change.
      skipLiveInterval.current = false;
      return;
    }
    setLiveReal(sample);
    if (sample) setLiveRealHistory((previous) => [...previous.slice(-71), sample]);
  }, []);
  const onVodMetrics = useCallback((sample) => {
    if (!capture.current) return;
    setVodReal(sample);
    if (!sample) return;
    setVodRealHistory((previous) => {
      const sameSession = previous.at(-1)?.sessionId === sample.sessionId;
      return sameSession ? [...previous.slice(-71), sample] : [sample];
    });
    if (sample.segmentRoute) {
      setSegmentCounts((previous) => ({
        ...previous,
        [sample.segmentRoute]: previous[sample.segmentRoute] + 1,
      }));
    }
  }, []);

  useEffect(() => {
    if (!running) return undefined;
    let index = 1;
    const timer = window.setInterval(() => {
      const sample = simulateNetworkSample(conditions, index++);
      setHistory((previous) => [...previous.slice(-71), sample]);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [conditions, running]);

  function clearMeasurements() {
    setLiveReal(null);
    setVodReal(null);
    setLiveRealHistory([]);
    setVodRealHistory([]);
    setSegmentCounts(EMPTY_SEGMENT_COUNTS);
  }

  function resumeMeasurements() {
    skipLiveInterval.current = true;
    capture.current = true;
    setVodRun((previous) => previous + 1);
  }

  async function start(event) {
    event.preventDefault();
    let next;
    try {
      next = validateConditions(fields);
    } catch (validationError) {
      setError(validationError.message);
      return;
    }
    setError('');
    setApplyError('');
    capture.current = false;
    clearMeasurements();
    setConditions(next);
    setHistory([simulateNetworkSample(next, 0)]);
    setRunning(true);
    setBusy(true);
    try {
      setApplied(await applyNetem(next, urls.vod));
    } catch (requestError) {
      setApplied(null);
      setApplyError(requestError.message);
    } finally {
      resumeMeasurements();
      setBusy(false);
    }
  }

  async function release(resumeBaseline = false) {
    setBusy(true);
    try {
      await clearNetem();
      setApplyError('');
    } catch (requestError) {
      setApplyError(`적용 해제 실패: ${requestError.message}`);
    } finally {
      setApplied(null);
      if (resumeBaseline) resumeMeasurements();
      setBusy(false);
    }
  }

  function stop() {
    capture.current = false;
    setRunning(false);
    void release();
  }

  function reset() {
    capture.current = false;
    setRunning(false);
    setFields(DEFAULT_CONDITIONS);
    setConditions(null);
    setHistory([]);
    setError('');
    clearMeasurements();
    void release(true);
  }

  function updateField(event) {
    const { name, value } = event.target;
    setFields((previous) => ({ ...previous, [name]: value }));
    setError('');
  }

  const latest = history.at(-1);
  const liveApplied = applied?.live?.ok === true;
  const vodApplied = applied?.vod?.ok === true;
  const vodUrl = proxiedVodUrl(applied) ?? urls.vod;
  const lastVodSample = vodRealHistory.at(-1);
  const externalLatency = alignByTimestamp(external.live, external.vod, (sample, mode) => ({
    [`${mode}Latency`]: sample.latency,
  }));
  let measurementStatus = '설정 전 재생 · 기준선';
  if (busy) measurementStatus = '조건 전환 중 · 수집 일시 정지';
  else if (running) measurementStatus = '실험 구간 · 대상별 적용 상태는 위에서 확인';
  else if (conditions) measurementStatus = '실험 중단 · 종료 전 기록';
  return (
    <>
      <div className="page-title-row">
        <div><h1>네트워크 실험</h1><p>입력한 조건을 실제 스트림에 적용하고, 계산한 예상값과 플레이어 실측값을 비교합니다.</p></div>
        <Badge variant="cyan"><FlaskConical size={14} /> {busy ? '조건 전환 중' : running ? '실험 실행 중' : '실험 대기'}</Badge>
      </div>
      <div className="test-banner">
        <div className="test-banner-icon"><FlaskConical size={24} /></div>
        <div>
          <strong>실험 조건 적용 상태</strong>
          {applied ? (
            <p>
              LIVE tc netem · {liveApplied ? '적용 성공' : '미적용'} · {applied.live.detail}<br />
              VOD 프록시 설정 · {vodApplied ? `성공 · 모델 처리량 상한 ${formatExperimentKbps.format(applied.vod.effectiveKbps)} kbps` : `실패 · ${applied.vod.detail}`}
            </p>
          ) : (
            <p>{applyError || (busy ? '백엔드 응답 대기 중' : '실험을 시작하면 LIVE tc netem과 VOD 프록시의 설정 결과가 표시됩니다.')}</p>
          )}
          <VodProxyStatus running={running} busy={busy} applied={vodApplied} counts={segmentCounts}
            usesHls={lastVodSample?.usesHls} blocked={conditions?.lossPercent === 100} />
        </div>
      </div>
      <Card className="settings-card experiment-form">
        <form noValidate onSubmit={start}>
          <fieldset disabled={running}>
            <legend>실험 설정값</legend>
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
          <p className="experiment-model-note">VOD 손실률은 Mathis 모델로 HTTP 처리량 상한을 낮추는 입력값입니다. 모델은 실제 TCP 패킷 손실을 발생시키거나 측정하지 않습니다. 100%는 HTTP 503으로 처리합니다.</p>
          {error && <p className="experiment-error" role="alert">{error}</p>}
          <div className="experiment-actions">
            <button className="primary-button" disabled={running || busy}>실험 시작</button>
            <button type="button" className="video-source-btn" disabled={!running || busy} onClick={stop}>중단</button>
            <button type="button" className="video-source-btn" disabled={busy} onClick={reset}>초기화</button>
            <span role="status">{measurementStatus}</span>
          </div>
        </form>
      </Card>
      <SectionTitle title="예상값 · 시뮬레이션" subtitle="데모 기준값에 입력 조건을 적용한 계산입니다. 영상 전송 계측과 VOD 프록시의 Mathis 모델은 별도입니다." />
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
      <section className="comparison-section" aria-label="FastAPI 외부 프로브">
        <SectionTitle title="외부 프로브 · FastAPI" subtitle="외부 연결 시간에 모드·시나리오 보정이 포함됩니다. 실험 플레이어의 전송 경로와 독립적으로 수집됩니다." />
        <ChartCard title="외부 프로브 연결 시간" data={externalLatency} lines={[
          { key: 'liveLatency', name: 'LIVE 모델', color: COLORS.live },
          { key: 'vodLatency', name: 'VOD 모델', color: COLORS.vod },
        ]} unit="ms" legend height={214} />
      </section>
      <section className="comparison-section" aria-label="플레이어 실측">
        <SectionTitle title="실제 플레이어 측정값" subtitle={measurementStatus} />
        <Card>
          <div className="card-heading"><div><h3>실측 요약</h3><p>브라우저의 WebRTC 수신 및 VOD 재생 지표</p></div></div>
          <div className="table-wrap"><table className="data-table">
            <thead><tr><th>대상</th><th>지표</th><th>실측값</th></tr></thead>
            <tbody>
              <tr><th>LIVE</th><td>RTP 패킷 손실률</td><td>{measurement(liveReal?.packetLoss, 2, '%')}</td></tr>
              <tr><th>LIVE</th><td>수신 비트레이트</td><td>{measurement(liveReal?.bitrate, 0, 'kbps')}</td></tr>
              <tr><th>LIVE</th><td>지터 / ICE RTT</td><td>{measurement(liveReal?.jitter, 1, 'ms')} / {measurement(liveReal?.rtt, 0, 'ms')}</td></tr>
              <tr><th>VOD</th><td>최근 영상 세그먼트 다운로드 처리량</td><td>{measurement(vodReal?.latestThroughputKbps, 0, 'kbps')}</td></tr>
              <tr><th>VOD</th><td>버퍼 잔여량</td><td>{measurement(vodReal?.buffer, 1, 's')}</td></tr>
              <tr><th>VOD</th><td>선택 화질 명목 비트레이트</td><td>{measurement(vodReal?.bitrate, 0, 'kbps')}</td></tr>
              <tr><th>VOD</th><td>누적 버퍼링 횟수 / 시간</td><td>{measurement(vodReal?.bufferingCount, 0, '회')} / {measurement(vodReal?.bufferingSeconds, 1, 's')}</td></tr>
            </tbody>
          </table></div>
        </Card>
        <div className="compare-video-grid comparison-section">
          <Card className="compare-video-card"><div className="card-heading"><div><h3>LIVE · WebRTC</h3></div></div><LivePlayer url={urls.live} onConnect={() => onNavigate('settings')} onMetrics={onLiveMetrics} /></Card>
          <Card className="compare-video-card"><div className="card-heading"><div><h3>VOD · {vodApplied ? '프록시 주소' : '원본 주소'}</h3></div></div><VodPlayer key={vodRun} url={vodUrl} onConnect={() => onNavigate('settings')} onMetrics={onVodMetrics} /></Card>
        </div>
        <section className="comparison-section" aria-label="LIVE 영상 실측">
          <SectionTitle title="LIVE 영상 실측" subtitle="WebRTC 영상 RTP · 최근 72개 샘플" />
          <PlayerMetricCharts mode="live" samples={liveRealHistory} lossArea />
        </section>
        <section className="comparison-section" aria-label="VOD 영상 실측">
          <SectionTitle title="VOD 영상 실측" subtitle="최근 재생 세션의 72개 샘플 · 버퍼링 집계에서 첫 재생 대기와 탐색 제외" />
          <PlayerMetricCharts mode="vod" samples={vodRealHistory} latest={lastVodSample} showSegmentRoutes={conditions !== null} />
        </section>
      </section>
    </>
  );
}

function downloadCsv(live, vod) {
  const header = 'timestamp,mode,latency_ms,packet_loss_percent,bitrate_kbps,buffer_sec,jitter_ms,source';
  const rows = [
    ...live.map((s) => [new Date(s.timestamp).toISOString(), 'LIVE', s.latency, s.packetLoss, s.bitrate, s.buffer, s.jitter, s.source]),
    ...vod.map((s) => [new Date(s.timestamp).toISOString(), 'VOD', s.latency, s.packetLoss, s.bitrate, s.buffer, s.jitter, s.source]),
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

function ReportsPage({ live, vod, demo }) {
  const latest = [...live.slice(-4).map((s) => ({ ...s, mode: 'LIVE' })), ...vod.slice(-4).map((s) => ({ ...s, mode: 'VOD' }))].sort((a, b) => b.timestamp - a.timestamp);
  return <><div className="page-title-row"><div><div className="eyebrow"><span /> ANALYTICS / REPORTS</div><h1>리포트</h1><p>측정 기록을 확인하고 데이터 파일을 내려받으세요.</p></div><button className="primary-button" onClick={() => downloadCsv(live, vod)}><Download size={17} /> CSV 다운로드</button></div><div className="report-summary"><Card><div className="report-icon accent-cyan"><Database size={20} /></div><strong>{live.length + vod.length}</strong><span>기록된 샘플</span></Card><Card><div className="report-icon accent-purple"><Activity size={20} /></div><strong>2</strong><span>스트리밍 모드</span></Card><Card><div className="report-icon accent-green"><CheckCircle2 size={20} /></div><strong>CSV</strong><span>지원 내보내기 형식</span></Card></div><Card className="report-table-card"><div className="card-heading"><div><h3>최근 샘플 기록</h3><p>최신 데이터 8건 미리보기</p></div><Badge variant={demo ? "yellow" : "cyan"}>{demo ? "로컬 데모 · 시뮬레이션" : "FastAPI 외부 프로브 · 보정 포함"}</Badge></div><div className="table-wrap"><table className="data-table"><thead><tr><th>측정 시각</th><th>스트리밍</th><th>Latency</th><th>Packet Loss</th><th>Bitrate</th><th>Buffer</th></tr></thead><tbody>{latest.map((s) => <tr key={`${s.mode}-${s.timestamp}`}><td>{clock(s.timestamp)}</td><td><Badge variant={s.mode === 'LIVE' ? 'cyan' : 'purple'}>{s.mode}</Badge></td><td>{format(s.latency)} ms</td><td>{format(s.packetLoss, 2)}%</td><td>{format(s.bitrate)} kbps</td><td>{format(s.buffer, 1)} sec</td></tr>)}</tbody></table></div></Card><div className="insight-note"><Info size={17} /><span>CSV의 source 열에는 현재 표시 중인 기록의 출처가 저장됩니다.</span></div></>;
} 

function SettingsPage({ urls, onUrlChange, refreshInterval, onRefreshChange, connections, demo, onToggleDemo }) {
  return <><div className="page-title-row"><div><div className="eyebrow"><span /> SYSTEM / SETTINGS</div><h1>대시보드 설정</h1><p>영상 소스와 모니터링 데이터 갱신 주기를 설정할 수 있습니다.</p></div><Badge variant="neutral"><Settings size={14} /> LOCAL SETTINGS</Badge></div><div className="settings-grid"><Card className="settings-card"><div className="card-heading"><div><h3>영상 소스</h3><p>LIVE는 MediaMTX 주소, VOD는 HLS(.m3u8) 또는 브라우저에서 재생 가능한 영상 URL을 입력하세요.</p></div><Video size={20} /></div><label className="field-label" htmlFor="live-url">LIVE 영상 URL</label><input id="live-url" type="url" value={urls.live} onChange={(e) => onUrlChange('live', e.target.value)} placeholder="http://localhost:8889/mystream" /><label className="field-label" htmlFor="vod-url">VOD 영상 URL</label><input id="vod-url" type="url" value={urls.vod} onChange={(e) => onUrlChange('vod', e.target.value)} placeholder="http://localhost:5173/vod/stage2-demo/master.m3u8" /><div className="settings-note"><Info size={16} /><span>HLS(.m3u8) 스트림을 입력하면 적응형 비트레이트(ABR) 재생 및 실제 버퍼 잔여량이 자동 측정됩니다.</span></div></Card><Card className="settings-card"><div className="card-heading"><div><h3>표시 설정</h3><p>로컬 데모의 업데이트 간격을 선택하세요.</p></div><SlidersHorizontal size={20} /></div><label className="field-label">데이터 갱신 간격</label><div className="segmented-row">{[1000, 2000, 5000].map((ms) => <button key={ms} className={refreshInterval === ms ? 'selected' : ''} onClick={() => onRefreshChange(ms)}>{ms / 1000}초</button>)}</div><div className="settings-status"><div><span className="dot dot-green" /><strong>프론트엔드</strong></div><Badge variant="green">실행 중</Badge></div><div className="settings-status"><FastApiStatus connections={connections} /></div><div className="settings-status"><label htmlFor="demo-mode">로컬 데모 데이터 표시</label><input id="demo-mode" type="checkbox" checked={demo} onChange={(event) => onToggleDemo(event.target.checked)} /></div><div className="settings-status"><div><span className={`dot ${urls.live || urls.vod ? 'dot-green' : 'dot-yellow'}`} /><strong>LIVE / VOD 소스</strong></div><Badge variant={urls.live || urls.vod ? 'green' : 'yellow'}>{urls.live || urls.vod ? '설정됨' : '설정 필요'}</Badge></div></Card></div><div className="insight-note"><Info size={17} /><span>변경된 영상 소스 URL과 데이터 갱신 간격은 현재 모니터링 세션에 즉시 반영됩니다.</span></div></>;
}

export default function App() {
  const [page, setPage] = useState('dashboard');
  const [sidebarVisible, setSidebarVisible] = useState(false);
  const [scenario, setScenario] = useState('normal');
  const [refreshInterval, setRefreshInterval] = useState(1000);
  const [videoUrls, setVideoUrls] = useState({ live: 'http://localhost:8889/mystream', vod: '' });
  const [recordings, setRecordings] = useState({});
  const [external, setExternal] = useState({ live: [], vod: [] });
  const [connections, setConnections] = useState({ live: 'connecting', vod: 'connecting' });
  const [demo, setDemo] = useState(false);
  const [demoHistory, setDemoHistory] = useState({ live: [], vod: [] });
  const [startedAt] = useState(Date.now);
  const demoTick = useRef(71);

  useEffect(() => {
    let stopped = false;

    function subscribe(mode) {
      let stream;
      let retryTimer;

      function reconnect() {
        stream?.close();
        setConnections((previous) => ({ ...previous, [mode]: 'reconnecting' }));
        retryTimer = window.setTimeout(connect, SSE_RETRY_MS);
      }

      function connect() {
        try {
          stream = new EventSource(`http://localhost:8000/api/metrics/stream?mode=${mode}`);
        } catch {
          reconnect();
          return;
        }

        const current = stream;
        if (mode === 'live') {
          current.addEventListener('hello', (event) => {
            if (!stopped && stream === current) setScenario(JSON.parse(event.data).scenario);
          });
        }
        current.onmessage = (event) => {
          if (stopped || stream !== current) return;
          const sample = { ...JSON.parse(event.data), source: 'external-probe' };
          setExternal((previous) => {
            const history = previous[mode];
            if (history.at(-1)?.timestamp === sample.timestamp) return previous;
            return { ...previous, [mode]: [...history.slice(-71), sample] };
          });
          setConnections((previous) => previous[mode] === 'connected' ? previous : { ...previous, [mode]: 'connected' });
        };
        current.onerror = () => {
          if (!stopped && stream === current) {
            current.onmessage = null;
            current.onerror = null;
            reconnect();
          }
        };
      }

      connect();
      return () => {
        stream?.close();
        window.clearTimeout(retryTimer);
      };
    }

    const unsubscribe = MODES.map(subscribe);
    return () => {
      stopped = true;
      unsubscribe.forEach((close) => close());
    };
  }, []);

  useEffect(() => {
    if (!demo) return undefined;
    const timer = window.setInterval(() => {
      demoTick.current += 1;
      const timestamp = Date.now();
      const samples = MODES.map((mode) => ({ ...makeSample(mode, demoTick.current, 'normal', timestamp), source: 'demo' }));
      setDemoHistory((previous) => ({
        live: [...previous.live.slice(-71), samples[0]],
        vod: [...previous.vod.slice(-71), samples[1]],
      }));
    }, refreshInterval);
    return () => window.clearInterval(timer);
  }, [demo, refreshInterval]);

  function toggleDemo(enabled) {
    if (enabled) {
      demoTick.current = 71;
      setDemoHistory({
        live: initialHistory('live').map((sample) => ({ ...sample, source: 'demo' })),
        vod: initialHistory('vod').map((sample) => ({ ...sample, source: 'demo' })),
      });
    }
    setDemo(enabled);
  }

  const live = demo ? demoHistory.live : connections.live === 'connected' ? external.live : [];
  const vod = demo ? demoHistory.vod : connections.vod === 'connected' ? external.vod : [];
  const now = Math.max(live.at(-1)?.timestamp ?? startedAt, vod.at(-1)?.timestamp ?? startedAt);
  const merged = alignByTimestamp(live, vod, (sample, mode) => ({
    [`${mode}Latency`]: sample.latency,
    [`${mode}Loss`]: sample.packetLoss,
  }));

  let content;
  switch (page) {
    case 'live': content = <MonitorPage key={`live:${videoUrls.live}`} demo={demo} mode="live" history={live} videoUrl={videoUrls.live} onNavigate={setPage} scenario={scenario} />; break;
    case 'vod': content = <MonitorPage key={`vod:${videoUrls.vod}`} demo={demo} mode="vod" history={vod} videoUrl={videoUrls.vod} onNavigate={setPage} scenario={scenario} />; break;
    case 'compare': content = <ComparePage live={external.live} vod={external.vod} urls={videoUrls} onNavigate={setPage} recordings={recordings} onRecording={(session) => setRecordings((previous) => ({ ...previous, [session.condition]: session }))} />; break;
    case 'statistics': content = <StatisticsPage live={live} vod={vod} merged={merged} />; break;
    case 'tests': content = <TestsPage urls={videoUrls} external={external} onNavigate={setPage} />; break;
    case 'reports': content = <ReportsPage live={demo ? demoHistory.live : external.live} vod={demo ? demoHistory.vod : external.vod} demo={demo} />; break;
    case 'settings': content = <SettingsPage connections={connections} demo={demo} onToggleDemo={toggleDemo} urls={videoUrls} onUrlChange={(mode, url) => setVideoUrls((old) => ({ ...old, [mode]: url }))} refreshInterval={refreshInterval} onRefreshChange={setRefreshInterval} />; break;
    default: content = <DashboardPage demo={demo} live={live} vod={vod} merged={merged} onNavigate={setPage} now={now} />;
  }

  return (
    <div className="app-shell">
      <Sidebar page={page} onNavigate={setPage} visible={sidebarVisible} onClose={() => setSidebarVisible(false)} />
      <div className="main-shell">
        <header className="topbar"><div className="topbar-left"><button className="icon-button menu-toggle" onClick={() => setSidebarVisible(true)} aria-label="메뉴 열기"><Menu size={21} /></button><div className="breadcrumb">Workspace <span>/</span> <strong>{PAGE_INFO[page][0]}</strong></div></div><div className="topbar-right"><FastApiStatus connections={connections} />{demo && <Badge variant="yellow">데모 선택됨</Badge>}</div></header>
        <main className="main-content" id="main-content">{content}<footer className="footer"><span>© 2026 Stream Metrics · 데이터통신 4팀</span><span>Stream Metrics <b>v1.0.0</b> · Real-time Network Monitoring</span></footer></main>
      </div>
    </div>
  );
}
