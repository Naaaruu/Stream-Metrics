import LivePlayer from './LivePlayer.jsx';
import VodPlayer from './VodPlayer.jsx';
import { alignByTimestamp } from './data/comparison.js';
import { conditionText, latestMetric, sessionDuration } from './data/experimentSessions.js';
import { clock, COLORS, COMMON_METRICS, dateTime, duration, formatNumber, METRICS, MODES, PROTOCOL } from './data/metricDefinitions.js';
import { Badge, Card, Detail, Metric, MetricChart, PageTitle, SectionTitle, Status } from './ui.jsx';
import { usePlayerFeed } from './usePlayerFeed.js';

export function PlayerPane({ mode, url, sourceUrl, onConnect, onMetrics, onStatus, sessionKey, children }) {
  const Player = mode === 'live' ? LivePlayer : VodPlayer;
  return <Card className="player-card ui-player">
    <div className="card-heading"><h3>{mode.toUpperCase()} · {PROTOCOL[mode]}</h3></div>
    <Player key={sessionKey} url={url} sourceUrl={sourceUrl} onConnect={onConnect} onMetrics={onMetrics} onStatus={onStatus} showMetrics={false} />
    {children}
  </Card>;
}

const deliveryLabels = {
  cache: '캐시 응답 · 처리량 집계 제외',
  unverified: '캐시 정보 미확인. 원본 서버의 Timing-Allow-Origin 헤더가 없거나 브라우저가 응답 크기·타이밍을 제공하지 않으면 처리량을 계산할 수 없습니다.',
  unmeasured: '전송 소요 시간 또는 크기 미측정',
};

export function PlayerSummary({ mode, samples, compact = false }) {
  const vod = mode === 'vod';
  const [startup, stalls, stallTime] = COMMON_METRICS;
  const last = samples.at(-1);
  const selected = vod ? METRICS.vod : compact
    ? METRICS.live.filter(({ key }) => ['bitrate', 'packetLoss', 'rtt', 'freezeCount'].includes(key))
    : METRICS.live.slice(0, 4);
  const wanted = vod ? [...selected, startup] : selected;
  return <div className={`ui-player-metrics ${compact ? 'ui-player-metrics-compact' : ''}`}>
    {wanted.map((metric) => <Metric key={metric.key} label={metric.label} unit={metric.unit} digits={metric.digits} color={metric.warning ? 'warning' : mode}
      value={metric.scatter ? last?.latestThroughputKbps : latestMetric(samples, metric)}
      note={metric.scatter ? deliveryLabels[last?.latestDelivery] ?? metric.note : metric.note} />)}
    {vod && <Card className="ui-metric ui-buffering">
      <div className="metric-top">재생 중 버퍼링</div>
      <div className="ui-buffering-values">
        {[stalls, stallTime].map((metric, index) => {
          const value = latestMetric(samples, metric);
          return <span key={metric.key}>{index === 0 ? '횟수' : '누적 시간'} <strong>{formatNumber(value, metric.digits)}</strong>
            {Number.isFinite(value) && ` ${metric.unit}`}</span>;
        })}
      </div>
    </Card>}
  </div>;
}

const ROUTE_SERIES = [
  { key: 'proxy', name: '프록시 경유', color: COLORS.vod, scatter: true },
  { key: 'direct', name: '프록시 우회', color: COLORS.warning, scatter: true },
  { key: 'unknown', name: '경로 미확인', color: COLORS.muted, scatter: true },
];

export function PlayerCharts({ mode, samples, marker, withRoutes = false, metrics }) {
  const selected = metrics ?? [...METRICS[mode], ...(mode === 'vod' ? COMMON_METRICS.slice(1, 3) : [])];
  return <div className="two-charts ui-chart-grid">{selected.map((metric) => {
    const withRouteSeries = withRoutes && metric.scatter;
    const chartSamples = withRouteSeries ? samples.map((sample) => ({
      ...sample,
      ...(sample.segmentRoute ? { [sample.segmentRoute]: sample.throughputKbps } : {}),
    })) : samples;
    return <MetricChart key={metric.key} metric={metric} samples={chartSamples} color={mode} marker={marker}
      lines={withRouteSeries ? ROUTE_SERIES : undefined} />;
  })}</div>;
}

export function ProbeDetail({ external, demoHistory, mode }) {
  const modes = mode ? [mode] : MODES;
  return <Detail title="보조 데이터 · FastAPI 외부 프로브와 로컬 데모">
    <p>외부 서버를 대상으로 측정한 연결·다운로드 표본에 모드 및 시나리오 보정과 초기 대체값이 포함됩니다. 실패율은 외부 요청 실패율이고 버퍼는 추정값입니다.</p>
    <div className="two-charts ui-chart-grid">{modes.map((item) => <MetricChart key={item} color={item}
      metric={{ key: 'latency', label: `${item.toUpperCase()} 모델의 외부 연결 시간`, unit: 'ms', digits: 1 }}
      samples={external[item]} />)}</div>
    <div className="table-wrap"><table className="data-table"><thead><tr><th>모드</th><th>외부 프로브 실패율</th><th>외부 처리량</th><th>모델 추정 버퍼</th><th>표본 시각</th></tr></thead>
      <tbody>{modes.map((item) => {
        const sample = external[item].at(-1);
        return <tr key={item}><th>{item.toUpperCase()}</th><td>{formatNumber(sample?.packetLoss, 2)}{sample && ' %'}</td>
          <td>{formatNumber(sample?.bitrate)}{sample && ' kbps'}</td><td>{formatNumber(sample?.buffer, 1)}{sample && ' 초'}</td>
          <td>{clock(sample?.timestamp)}</td></tr>;
      })}</tbody></table></div>
    {demoHistory && <div className="two-charts ui-chart-grid">{modes.map((item) =>
      <MetricChart key={item} metric={{ key: 'latency', label: `${item.toUpperCase()} 로컬 데모 지연`, unit: 'ms', digits: 1 }}
        samples={demoHistory[item]} color={item} />)}</div>}
  </Detail>;
}

export function MonitorPage({ mode, url, probe, onConnect, onStatus }) {
  const feed = usePlayerFeed(onStatus);
  const label = mode.toUpperCase();
  const primary = METRICS[mode].slice(0, 2);
  const secondary = [...METRICS[mode].slice(2), ...(mode === 'vod' ? COMMON_METRICS.slice(1, 3) : [])];
  return <>
    <PageTitle title={`${label} 모니터링`} detail={`${PROTOCOL[mode]} 영상의 실제 전송 및 재생 상태`}
      action={<Badge variant={mode === 'live' ? 'cyan' : 'purple'}>{PROTOCOL[mode]}</Badge>} />
    <div className="monitor-layout">
      <PlayerPane mode={mode} url={url} onConnect={onConnect} onMetrics={feed.onMetrics} onStatus={feed.onStatus} />
      <div className="ui-monitor-rail">
        <PlayerSummary mode={mode} samples={feed.samples} />
        <section aria-label="영상 옆 핵심 그래프" className="ui-monitor-charts">
          <PlayerCharts mode={mode} samples={feed.samples} metrics={primary} />
        </section>
      </div>
    </div>
    <SectionTitle title={`${label} 추가 실측 지표`} detail="최근 72개 표본 · 기기 현지 시각" />
    <PlayerCharts mode={mode} samples={feed.samples} metrics={secondary} />
    <ProbeDetail {...probe} mode={mode} />
  </>;
}

export function SystemStatus({ system, players = {}, urls }) {
  return <Card className="ui-panel">
    <h2>시스템 연결 상태</h2>
    <dl className="ui-status-list">
      <div><dt>FastAPI</dt><dd><Status label={system.api} /></dd></div>
      {MODES.map((mode) => <div key={mode}><dt>{mode.toUpperCase()} 영상</dt><dd>
        <Status {...(players[mode] ?? { label: urls[mode] ? '재생 대기' : '소스 미설정' })} />
      </dd></div>)}
      <div><dt>네트워크 실험</dt><dd><Status label={system.netem === null ? '확인 대기' :
        system.netem === false ? '적용 상태 확인 실패' : system.netem.active ? '실험 조건 적용 중' : '적용 중인 실험 조건 없음'} /></dd></div>
    </dl>
  </Card>;
}

export function DashboardPage({ sessions, probe, system, players, urls, onNavigate, onReport }) {
  const recent = [...sessions].sort((a, b) => b.endAt - a.endAt).slice(0, 4);
  const session = recent[0];
  return <>
    <PageTitle title="스트리밍 네트워크 모니터링" detail={session
      ? `종료된 실험 · ${session.name} · ${dateTime(session.endAt)} 종료 · 실험 구간 집계`
      : '저장된 재생 실측이 없습니다. 네트워크 실험에서 실제 영상 측정을 시작할 수 있습니다.'}
      action={<button className="primary-button" onClick={() => onNavigate('tests')}>네트워크 실험</button>} />
    <div className="metric-grid">
      {MODES.flatMap((mode) => METRICS[mode].slice(0, 2).map((metric) => <Metric key={mode + metric.key}
        unit={metric.unit} digits={metric.digits} label={`${mode.toUpperCase()} · ${metric.label}`} color={metric.warning ? 'warning' : mode}
        value={session?.summary[mode][metric.key]?.value} />))}
    </div>
    <div className="two-charts ui-status-grid">
      <SystemStatus system={system} players={players} urls={urls} />
      <Card className="ui-panel">
        <h2>스트리밍 세션</h2>
        {MODES.map((mode) => <button key={mode} className="stream-row ui-stream" onClick={() => onNavigate(mode)}>
          <Badge variant={mode === 'live' ? 'cyan' : 'purple'}>{mode.toUpperCase()}</Badge>
          <span><strong>{PROTOCOL[mode]}</strong><small>{players[mode]?.label ?? (urls[mode] ? '재생 대기' : '소스 미설정')}</small></span>
          <span>모니터링 열기</span>
        </button>)}
      </Card>
    </div>
    <Card className="ui-panel ui-recent-experiments">
      <div className="card-heading"><h2>최근 완료 실험</h2>
        <button className="text-action" onClick={() => onNavigate('reports')}>전체 기록 보기</button></div>
      {recent.length ? <div className="table-wrap"><table className="data-table">
        <thead><tr><th>실험</th><th>입력 조건</th><th>종료 시각</th><th>측정 시간</th></tr></thead>
        <tbody>{recent.map((item) => <tr key={item.id}>
          <th scope="row"><button className="text-action" onClick={() => onReport(item.id)}>{item.name}</button></th>
          <td>{conditionText(item.conditions)}</td><td>{dateTime(item.endAt)}</td><td>{duration(sessionDuration(item))}</td>
        </tr>)}</tbody>
      </table></div> : <p>완료된 실험을 이곳에서 바로 열 수 있습니다.</p>}
    </Card>
    <ProbeDetail {...probe} />
  </>;
}

export function ProbeComparison({ external }) {
  const data = alignByTimestamp(external.live, external.vod, (sample, mode) => ({ [mode]: sample.latency }));
  return <MetricChart metric={{ label: '외부 연결 시간 · 모드 보정 포함', unit: 'ms', digits: 1 }}
    samples={data} lines={MODES.map((mode) => ({ key: mode, color: COLORS[mode], name: `${mode.toUpperCase()} 모델` }))} />;
}
