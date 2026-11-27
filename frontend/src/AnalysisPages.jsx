import { useState } from 'react';
import { compareSessions, conditionApplied, conditionText, describeSeries, encodeCsv, GRAPH_SAMPLE_LIMIT, measurementSeries, movingAverage, sessionCsv, sessionDuration, summarizeIceChecks } from './data/experimentSessions.js';
import { clock, COLORS, COMMON_METRICS, dateTime, duration, formatNumber, METRICS, metricText, MODES, PROTOCOL, SOURCE } from './data/metricDefinitions.js';
import { saveCsv } from './data/downloadCsv.js';
import { PlayerPane, ProbeComparison, ProbeDetail } from './Monitoring.jsx';
import { Badge, Card, ComparisonBars, Detail, Empty, Metric, MetricChart, PageTitle, SectionTitle } from './ui.jsx';

function SessionPicker({ label, sessions, selected, onSelect }) {
  return <label className="ui-select-label">{label}
    <select value={selected?.id ?? ''} onChange={(event) => onSelect(event.target.value)}>
      {!selected && <option value="">저장된 실험 없음</option>}
      {sessions.map((session) => <option key={session.id} value={session.id}>{session.name} · {dateTime(session.startAt)}</option>)}
    </select>
  </label>;
}

function SessionEmpty({ onExperiment }) {
  return <Empty action={<button className="primary-button" onClick={onExperiment}>네트워크 실험 열기</button>}>
    완료된 실험이 없습니다. 실험을 시작하고 중단하면 측정 결과를 확인할 수 있습니다.
  </Empty>;
}

function Conditions({ session }) {
  if (!session) return <p className="ui-note">실험을 선택하세요.</p>;
  const { conditions, result, routes } = session;
  return <dl className="ui-status-list ui-condition-list">
    <div><dt>입력 조건</dt><dd>{conditionText(conditions)}</dd></div>
    <div><dt>측정 시간</dt><dd>{duration(sessionDuration(session))}</dd></div>
    <div><dt>LIVE netem</dt><dd>{conditionApplied(result, 'live')}{result?.live?.ok &&
      ` · ${formatNumber(Math.max(1, Math.round(conditions.bandwidthKbps)))} kbps · +${formatNumber(conditions.delayMs, 2)} ms · ${formatNumber(conditions.lossPercent, 2)} %`}</dd></div>
    <div><dt>VOD 프록시</dt><dd>{conditionApplied(result, 'vod')}{Number.isFinite(result?.vod?.effectiveKbps) &&
      ` · 모델 상한 ${formatNumber(result.vod.effectiveKbps, 2)} kbps · 요청당 +${formatNumber(conditions.delayMs, 2)} ms`}</dd></div>
    <div><dt>세그먼트 응답</dt><dd>{routes.proxy || routes.direct || routes.unknown
      ? `경유 ${routes.proxy} · 우회 ${routes.direct} · 미확인 ${routes.unknown}` : '미확인'}</dd></div>
    <div><dt>처리량 미집계</dt><dd>캐시 {routes.cache} · 전송 증거 미확인 {routes.unverified} · 시간·크기 미측정 {routes.unmeasured}</dd></div>
  </dl>;
}

function ResultTable({ sessions, metrics, modes, compare = false }) {
  const rows = modes.flatMap((mode) => metrics.map((metric) => ({
    mode, metric, values: sessions.map((session) => session?.summary[mode][metric.key]?.value),
  }))).filter(({ values }) => values.some(Number.isFinite));
  if (!rows.length) return <p className="ui-note">선택한 실험에서 측정된 항목이 없습니다.</p>;
  return <div className="table-wrap"><table className="data-table">
    <thead><tr><th>모드</th><th>지표</th><th>{compare ? '기준' : '결과'}</th>{compare && <><th>비교</th><th>변화</th></>}</tr></thead>
    <tbody>{rows.map(({ mode, metric, values }) => {
      const delta = Number.isFinite(values[0]) && Number.isFinite(values[1]) ? values[1] - values[0] : null;
      return <tr key={mode + metric.key}><th>{mode.toUpperCase()}</th><td>{metric.label}</td>
        {values.map((value, index) => <td key={index}>{metricText(value, metric)}</td>)}
        {compare && <td className={metric.warning && delta > 0 ? 'experiment-error' : undefined}>
          {Number.isFinite(delta) ? `${delta > 0 ? '+' : ''}${formatNumber(delta, metric.digits)} ${metric.unit === '%' ? '%p' : metric.unit}` : '—'}
        </td>}</tr>;
    })}</tbody>
  </table></div>;
}

function ComparisonCharts({ pair }) {
  const labels = ['기준 실험', '비교 실험'];
  const playback = COMMON_METRICS.filter(({ key }) => ['startupSec', 'stallRatio'].includes(key));
  const protocol = [
    ['live', METRICS.live.filter(({ key }) => ['bitrate', 'packetLoss', 'rtt'].includes(key))],
    ['vod', METRICS.vod],
  ];
  return <div className="ui-comparison-bars">
    {playback.map((metric) => <ComparisonBars key={metric.key} metric={metric}
      data={pair.map((item, index) => ({ label: labels[index], live: item?.summary.live[metric.key]?.value, vod: item?.summary.vod[metric.key]?.value }))}
      series={MODES.map((mode) => ({ key: mode, name: mode.toUpperCase(), color: COLORS[mode] }))} />)}
    {protocol.flatMap(([mode, metrics]) => metrics.map((metric) => {
      const label = `${mode.toUpperCase()} · ${metric.label}`;
      return <ComparisonBars key={mode + metric.key} metric={{ ...metric, label }}
        data={pair.map((item, index) => ({ label: labels[index], value: item?.summary[mode][metric.key]?.value }))}
        series={[{ key: 'value', name: label, color: COLORS[metric.warning ? 'warning' : mode] }]} />;
    }))}
  </div>;
}

export function ComparePage({ sessions, urls, probe, onConnect, onExperiment, playerStatus }) {
  const [baseId, setBaseId] = useState('');
  const [otherId, setOtherId] = useState('');
  const { base, other, alternatives } = compareSessions(sessions, baseId, otherId);
  const pair = [base, other];
  const differentDuration = other && sessionDuration(base) !== sessionDuration(other);
  return <>
    <PageTitle title="LIVE / VOD 비교" detail="저장된 기준 실험과 비교 실험의 재생 품질 변화를 같은 정의로 분석합니다." />
    {sessions.length ? <>
      <div className="two-charts">
        {pair.map((session, index) => <Card className="ui-panel" key={index}>
          <SessionPicker label={index ? '비교 실험' : '기준 실험'} sessions={index ? alternatives : sessions}
            selected={session} onSelect={index ? setOtherId : setBaseId} />
          <Conditions session={session} />
        </Card>)}
      </div>
      {differentDuration && <p className="ui-note ui-comparison-duration" role="note">
        측정 시간이 다릅니다. 기준 {formatNumber(sessionDuration(base), 3)}초 · 비교 {formatNumber(sessionDuration(other), 3)}초.
        끊김 횟수와 누적 시간은 각 실험의 관측 길이에 영향을 받습니다.
      </p>}
      {other && <><SectionTitle title="주요 지표 비교" detail="막대 하나는 선택한 실험의 저장 결과입니다. 미측정값은 막대를 표시하지 않습니다." />
        <ComparisonCharts pair={pair} /></>}
      <SectionTitle title="공통 재생 품질" detail="실험마다 LIVE와 VOD를 같은 구간에서 관측합니다. 끊김 이벤트는 요소의 waiting으로 집계합니다. 초기 로딩, 일시정지, 탐색은 집계에서 제외합니다." />
      <Card className="ui-panel"><ResultTable sessions={pair} metrics={COMMON_METRICS} modes={MODES} compare /></Card>
      <SectionTitle title="프로토콜별 지표" detail="WebRTC 영상 수신률, HLS 다운로드 처리량과 명목 화질 비트레이트는 각자의 단위와 정의로 봅니다." />
      <div className="two-charts">{MODES.map((mode) => <Card className="ui-panel" key={mode}>
        <h3>{mode.toUpperCase()} · {PROTOCOL[mode]}</h3><ResultTable sessions={pair} metrics={METRICS[mode]} modes={[mode]} compare />
      </Card>)}</div>
    </> : <SessionEmpty onExperiment={onExperiment} />}
    <SectionTitle title="현재 영상 재생" detail="설정에 등록된 영상의 동시 재생입니다. 위 비교표는 저장된 실험 결과입니다." />
    <div className="compare-video-grid">{MODES.map((mode) =>
      <PlayerPane key={mode} mode={mode} url={urls[mode]} onConnect={onConnect} onStatus={playerStatus[mode]} />)}</div>
    <ProbeDetail {...probe} />
  </>;
}

function StatsTable({ series, metric }) {
  const result = describeSeries(series, metric);
  const meanLabel = metric.key === 'packetLoss' ? '평균 · 패킷 가중' : '평균';
  return <div className="ui-stats-summary">
    {[[meanLabel, 'avg'], ['최소', 'min'], ['최대', 'max'], ['P95', 'p95'], ['표준편차', 'std'],
      ...(metric.kind === 'cumulative' ? [['측정 구간 합계', 'total']] : []), ['유효 표본', 'count']].map(([label, key]) =>
      <Metric key={key} label={label} unit={key === 'count' ? '개' : metric.unit} digits={key === 'count' ? 0 : metric.digits} value={result[key]} />)}
  </div>;
}

const PROBE_METRICS = [
  { key: 'latency', label: '외부 연결 시간', unit: 'ms', digits: 2 },
  { key: 'packetLoss', label: '외부 프로브 실패율', unit: '%', digits: 2 },
  { key: 'bitrate', label: '외부 처리량', unit: 'kbps', digits: 0 },
  { key: 'buffer', label: '모델 추정 버퍼', unit: '초', digits: 2 },
  { key: 'jitter', label: '외부 연결 시간 변동', unit: 'ms', digits: 2 },
];

export function StatisticsPage({ sessions, probe, onExperiment }) {
  const [id, select] = useState('');
  const [mode, setMode] = useState('live');
  const [key, setKey] = useState('bitrate');
  const session = sessions.find((item) => item.id === id) ?? sessions[0];
  const metrics = [...METRICS[mode], ...COMMON_METRICS];
  const metric = metrics.find((item) => item.key === key) ?? metrics[0];
  const series = session ? measurementSeries(session.samples[mode], metric) : [];
  const chart = movingAverage(series, metric.key === 'packetLoss').slice(-GRAPH_SAMPLE_LIMIT);
  const color = COLORS[metric.warning ? 'warning' : mode];
  return <>
    <PageTitle title="통계 분석" detail="저장된 전체 실측을 집계합니다. 차트는 마지막 72개 유효 표본을 표시합니다." />
    {session ? <>
      <Card className="ui-panel ui-filter-grid">
        <SessionPicker label="실험 세션" sessions={sessions} selected={session} onSelect={select} />
        <label className="ui-select-label">분석 대상<select value={mode} onChange={(event) => { setMode(event.target.value); setKey(METRICS[event.target.value][0].key); }}>
          {MODES.map((item) => <option key={item} value={item}>{item.toUpperCase()} · {PROTOCOL[item]}</option>)}
        </select></label>
        <label className="ui-select-label">지표<select value={metric.key} onChange={(event) => setKey(event.target.value)}>
          {metrics.map((item) => <option value={item.key} key={item.key}>{item.label}</option>)}
        </select></label>
      </Card>
      {!series.length && <Empty>선택한 실험에서 이 항목을 측정하지 못했습니다. 다른 실험이나 지표를 선택하세요.</Empty>}
      <StatsTable series={series} metric={metric} />
      <MetricChart samples={chart} metric={{ ...metric, label: metric.kind === 'cumulative' ? `${metric.label} · 표본 간 증가량` : metric.label }}
        lines={[
          { key: 'value', name: '실제 측정', color, scatter: metric.scatter || metric.kind === 'startup', type: metric.type },
          { key: 'average', name: '최근 5초 이동평균', color: COLORS.average },
        ]} marker={session.result?.[mode]?.ok ? session.result[mode].appliedAt ?? session.appliedAt : null} />
      <p className="ui-note">P95는 최근접 순위, 표준편차는 관측 구간 값으로 계산합니다. RTP 손실률 평균과 이동평균은 유효 패킷 수로 가중합니다. 누적값 통계는 플레이어 세션별 증가량을 합산합니다.</p>
    </> : <SessionEmpty onExperiment={onExperiment} />}
    <Detail title="보조 통계 · FastAPI 외부 프로브">
      <p>외부 네트워크 관측과 모드·시나리오 보정값의 통계입니다.</p>
      <ProbeComparison external={probe.external} />
      <div className="table-wrap"><table className="data-table">
        <thead><tr><th>모드</th><th>항목</th><th>평균</th><th>최소</th><th>최대</th><th>P95</th><th>최근 5초 평균</th><th>표본</th></tr></thead>
        <tbody>{MODES.flatMap((item) => PROBE_METRICS.map((definition) => {
          const series = measurementSeries(probe.external[item], definition);
          const result = describeSeries(series, {});
          return <tr key={item + definition.key}><th>{item.toUpperCase()}</th><td>{definition.label}</td>
            {['avg', 'min', 'max', 'p95'].map((column) => <td key={column}>{metricText(result[column], definition)}</td>)}
            <td>{metricText(movingAverage(series).at(-1)?.average, definition)}</td><td>{result.count}</td></tr>;
        }))}</tbody>
      </table></div>
    </Detail>
  </>;
}

function downloadProbe(external) {
  const rows = [['측정 시각', '모드', '외부 연결 시간(ms)', '외부 프로브 실패율(%)', '외부 처리량(kbps)', '모델 추정 버퍼(초)', '외부 연결 시간 변동(ms)', '출처']];
  for (const mode of MODES) {
    for (const sample of external[mode]) rows.push([new Date(sample.timestamp).toISOString(), mode.toUpperCase(),
      sample.latency, sample.packetLoss, sample.bitrate, sample.buffer, sample.jitter, 'FastAPI 외부 프로브 · 모델 보정 포함']);
  }
  saveCsv(encodeCsv(rows), 'stream-metrics-external-probe.csv');
}

function ReportActions({ session, onRename, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(session.name);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  async function rename(event) {
    event.preventDefault();
    setError('');
    setPending(true);
    try {
      await onRename(session.id, name);
      setEditing(false);
    } catch (problem) {
      setError(problem.message);
    } finally {
      setPending(false);
    }
  }
  async function remove() {
    if (!window.confirm(`‘${session.name}’ 실험과 이 실험의 저장 표본을 삭제할까요? 삭제하면 복구할 수 없습니다.`)) return;
    setError('');
    setPending(true);
    try {
      await onDelete(session.id);
    } catch (problem) {
      setError(problem.message);
      setPending(false);
    }
  }
  return <>
    <div className="ui-actions">
      <button className="primary-button" onClick={() => saveCsv(sessionCsv(session), `stream-metrics-${session.id}.csv`)}>선택 실험 CSV</button>
      <button className="video-source-btn" disabled={pending || editing} onClick={() => {
        setName(session.name); setError(''); setEditing(true);
      }}>이름 변경</button>
      <button className="video-source-btn ui-danger-button" disabled={pending || editing} onClick={remove}>기록 삭제</button>
      <Badge variant="cyan">브라우저 플레이어 실측</Badge>
    </div>
    {editing && <form className="ui-form ui-report-name" onSubmit={rename}>
      <label htmlFor="report-name">새 실험 이름</label>
      <input id="report-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={100} required />
      <div className="ui-actions">
        <button className="primary-button" disabled={pending || !name.trim()}>이름 저장</button>
        <button type="button" className="video-source-btn" disabled={pending} onClick={() => { setEditing(false); setError(''); }}>취소</button>
      </div>
    </form>}
    {error && <p className="experiment-error" role="alert">{error}</p>}
  </>;
}

function LiveDiagnostics({ samples }) {
  const metric = METRICS.live.find(({ key }) => key === 'rtt');
  const rtt = describeSeries(measurementSeries(samples, metric), metric);
  const ice = summarizeIceChecks(samples);
  return <div className="ui-note ui-live-diagnostics">
    {rtt.count > 0 && <p>ICE RTT · {rtt.count}개 샘플 평균 {metricText(rtt.avg, metric)} · 범위 {metricText(rtt.min, metric)}~{metricText(rtt.max, metric)}.
      브라우저가 같은 STUN 측정값을 연속 표본에 반환할 수 있습니다.</p>}
    {ice.count > 0 && <p>응답 카운터 증분 기준 · STUN 응답 {ice.count}건 · 왕복 시간 평균 {metricText(ice.meanMs, metric)}</p>}
    {samples.length > 0 && !samples.some((sample) => Number.isFinite(sample.freezeCount)) &&
      <p>WebRTC 프레임 정지 횟수 미측정. 저장된 기록에 브라우저 프레임 카운터가 없습니다.</p>}
  </div>;
}

export function ReportsPage({ sessions, selectedId, select, probe, onExperiment, onRename, onDelete }) {
  const session = sessions.find((item) => item.id === selectedId) ?? sessions[0];
  const valid = sessions.reduce((sum, item) => sum + item.validCounts.live + item.validCounts.vod, 0);
  const elapsed = sessions.reduce((sum, item) => sum + (item.endAt - item.startAt) / 1000, 0);
  return <>
    <PageTitle title="실험 리포트" detail="이 브라우저에 저장된 실험과 실제 플레이어 표본을 확인합니다." />
    <div className="ui-stats-summary">
      <Metric label="완료 실험" value={sessions.length} unit="건" />
      <Metric label="유효 실측 표본" value={valid} unit="개" />
      <Card className="ui-metric"><div className="metric-top">전체 측정 시간</div><div className="metric-number">{duration(elapsed)}</div></Card>
    </div>
    {session ? <>
      <Card className="ui-panel">
        <SessionPicker label="상세 실험 선택" sessions={sessions} selected={session} onSelect={select} />
        <ReportActions key={session.id} session={session} onRename={onRename} onDelete={onDelete} />
        <Conditions session={session} />
        <p className="ui-note">ID {session.id} · {dateTime(session.startAt)} 시작 · {clock(session.endAt)} 종료</p>
        {MODES.map((mode) => <div className="ui-report-source" key={mode}>
          <strong>{mode.toUpperCase()} · {session.measurementSources?.[mode] ?? SOURCE[mode]} · 유효 표본 {formatNumber(session.validCounts[mode])}개</strong>
          <p>{session.sources[mode] || '소스 미설정'}</p>
          {session.issues[mode].length > 0 && <ul>{session.issues[mode].map((issue) => <li key={issue}>{issue}</li>)}</ul>}
        </div>)}
      </Card>
      <Card className="ui-panel ui-report-results">
        <h2>측정 결과</h2>
        <ResultTable sessions={[session]} metrics={COMMON_METRICS} modes={MODES} />
        {MODES.map((mode) => <ResultTable key={mode} sessions={[session]} metrics={METRICS[mode]} modes={[mode]} />)}
        <LiveDiagnostics samples={session.samples.live} />
      </Card>
      <Detail title="전체 실험 기록">
        <div className="table-wrap"><table className="data-table">
          <thead><tr><th>실험</th><th>시작</th><th>측정 시간</th><th>입력 조건</th><th>LIVE</th><th>VOD</th><th>유효 표본</th></tr></thead>
          <tbody>{sessions.map((item) => <tr key={item.id}><th><button className="text-action" onClick={() => select(item.id)}>{item.name}</button></th>
            <td>{dateTime(item.startAt)}</td><td>{duration((item.endAt - item.startAt) / 1000)}</td>
            <td>{formatNumber(item.conditions.bandwidthKbps, 3)} kbps · {item.conditions.delayMs} ms · {item.conditions.lossPercent} %</td>
            <td>{conditionApplied(item.result, 'live')}</td><td>{conditionApplied(item.result, 'vod')}</td>
            <td>{item.validCounts.live + item.validCounts.vod}</td></tr>)}</tbody>
        </table></div>
      </Detail>
    </> : <SessionEmpty onExperiment={onExperiment} />}
    <Detail title="보조 리포트 · FastAPI 외부 프로브 CSV">
      <p>외부 서버 측정과 모델 보정 표본의 내보내기입니다.</p>
      <button className="video-source-btn" disabled={!MODES.some((mode) => probe.external[mode].length)} onClick={() => downloadProbe(probe.external)}>외부 프로브 CSV</button>
    </Detail>
  </>;
}
