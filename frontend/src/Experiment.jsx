import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_CONDITIONS, simulateNetworkSample, validateConditions } from './data/networkExperiment.js';
import { clock, COLORS, duration, formatNumber, METRICS } from './data/metricDefinitions.js';
import { conditionApplied } from './data/experimentSessions.js';
import { proxiedVodUrl } from './data/netemApi.js';
import { usePlayerFeed } from './usePlayerFeed.js';
import { PlayerCharts, PlayerPane, PlayerSummary, ProbeDetail } from './Monitoring.jsx';
import { Badge, Card, Detail, MetricChart, PageTitle, SectionTitle } from './ui.jsx';

const PRESETS = {
  normal: { name: '일반 환경', fields: DEFAULT_CONDITIONS },
  bandwidth: { name: '대역폭 제한', fields: { bandwidth: '1500', unit: 'kbps', delay: '0', loss: '0' } },
  delay: { name: '지연 증가', fields: { ...DEFAULT_CONDITIONS, delay: '300' } },
  loss: { name: '패킷 손실 증가', fields: { ...DEFAULT_CONDITIONS, loss: '5' } },
};
const TABS = [{ id: 'core', label: '핵심 지표' }, { id: 'live', label: 'LIVE 상세' }, { id: 'vod', label: 'VOD 상세' }];
const modeSelect = { live: 'live', vod: 'vod' };

function ConditionResult({ session, counts, currentStatus }) {
  const { result, appliedAt, conditions } = session ?? {};
  return <div className="ui-apply">
    <div className="ui-actions">
      <strong>{currentStatus ? '현재 적용 상태' : '저장된 적용 결과'}</strong>
      {currentStatus && <span role="status">{currentStatus}</span>}
      {session && ['live', 'vod'].map((mode) => {
        const label = conditionApplied(result, mode);
        return <Badge key={mode} variant={result?.[mode]?.ok ? (mode === 'live' ? 'cyan' : 'purple') : result?.[mode]?.ok === false ? 'yellow' : 'neutral'}>
          {mode === 'live' ? 'LIVE netem' : 'VOD 프록시 설정'} · {label}
        </Badge>;
      })}
    </div>
    {session && appliedAt && <p>LIVE 적용 {clock(result?.live?.appliedAt ?? (result?.live?.ok ? appliedAt : null))}
      {' · '}VOD 설정 {clock(result?.vod?.appliedAt ?? (result?.vod?.ok ? appliedAt : null))}
      {' · '}새 측정 세션 {clock(session.startAt)}</p>}
    {session && <p>입력값 · {formatNumber(conditions.bandwidthKbps, 3)} kbps · +{formatNumber(conditions.delayMs, 2)} ms · {formatNumber(conditions.lossPercent, 2)} %</p>}
    {session && result?.live?.detail && <p>LIVE · {result.live.detail}</p>}
    {session && result?.vod?.ok && <p>VOD 유효 모델 상한 {formatNumber(result.vod.effectiveKbps, 2)} kbps</p>}
    {session && !result?.vod?.ok && <p className="experiment-error">VOD 프록시 미적용 · {result?.vod?.detail ?? '설정 결과 미확인'}</p>}
    {session && result?.vod?.ok && <p className={counts.direct || counts.unknown ? 'experiment-error' : ''}>
      {counts.proxy || counts.direct || counts.unknown
        ? `영상 세그먼트 · 프록시 경유 ${counts.proxy}건 · 우회 ${counts.direct}건 · 미확인 ${counts.unknown}건`
        : conditions.lossPercent === 100 ? '프록시 요청은 HTTP 503 처리 · 완료된 세그먼트 미확인' : '완료된 영상 세그먼트의 경유 여부 미확인'}
      {counts.direct > 0 && ' · 우회 요청에는 프록시 제한이 적용되지 않습니다.'}
    </p>}
    {session && (counts.cache || counts.unverified || counts.unmeasured) > 0 && <p>
      처리량 미집계 · 캐시 {counts.cache}건 · 전송 증거 미확인 {counts.unverified}건 · 시간·크기 미측정 {counts.unmeasured}건
    </p>}
  </div>;
}

function conditionStatus(phase, netem, result) {
  if (phase === 'applying') return '실험 조건 적용 확인 중';
  if (phase === 'releasing') return '실험 조건 해제 확인 중';
  if (phase === 'release-error') return '실험 조건 해제 여부 미확인';
  if (phase === 'running') {
    if (result?.live?.ok && result?.vod?.ok) return 'LIVE 적용 · VOD 프록시 설정 완료';
    if (result?.live?.ok || result?.vod?.ok) return '일부만 적용됨';
    return result ? '적용 성공 항목 없음' : '적용 결과 미확인';
  }
  if (netem === null) return '현재 적용 상태 조회 중';
  if (netem === false) return '현재 적용 상태를 확인할 수 없음';
  if (netem.active) return '백엔드에 적용 중인 조건이 있음';
  return '적용 중인 실험 조건 없음';
}

function ExperimentTabs({ tab, setTab }) {
  function changeTab(event, index) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1
      : (index + (event.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length;
    setTab(TABS[next].id);
    document.getElementById(`experiment-tab-${TABS[next].id}`)?.focus();
  }
  return <div className="ui-actions ui-tabs" role="tablist" aria-label="실측 그래프">
    {TABS.map(({ id, label }, index) => <button key={id} id={`experiment-tab-${id}`} className="video-source-btn"
      type="button" role="tab" aria-selected={tab === id} aria-controls="experiment-graphs" tabIndex={tab === id ? 0 : -1}
      onClick={() => setTab(id)} onKeyDown={(event) => changeTab(event, index)}>{label}</button>)}
  </div>;
}

function useElapsed(phase, session, completed) {
  const [tick, setTick] = useState(Date.now);
  useEffect(() => {
    if (phase !== 'running') return undefined;
    const timer = window.setInterval(() => setTick(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [phase]);
  const end = completed?.endAt ?? tick;
  return session ? Math.max(0, (end - session.startAt) / 1000) : null;
}

export default function ExperimentPage({ control, urls, probe, onConnect, playerStatus, onReport, netem }) {
  const [fields, setFields] = useState(DEFAULT_CONDITIONS);
  const [preset, setPreset] = useState('normal');
  const [name, setName] = useState('');
  const [validationError, setValidationError] = useState('');
  const [tab, setTab] = useState('core');
  const { phase, session, graphs, completed, saved, counts, error, start, stop, sample, reportStatus } = control;
  const busy = phase === 'applying' || phase === 'releasing';
  const capturing = phase === 'running';
  const activeId = capturing || phase === 'releasing' ? session?.id : undefined;
  const baselineLive = usePlayerFeed();
  const baselineVod = usePlayerFeed();
  const elapsed = useElapsed(phase, session, completed);
  const liveBaselineRecord = baselineLive.onMetrics;
  const vodBaselineRecord = baselineVod.onMetrics;
  const liveStatus = playerStatus.live;
  const vodStatus = playerStatus.vod;
  const recordLive = useCallback((value) => {
    if (activeId) sample('live', activeId, value);
    else liveBaselineRecord(value);
  }, [activeId, liveBaselineRecord, sample]);
  const recordVod = useCallback((value) => {
    if (activeId) sample('vod', activeId, value);
    else vodBaselineRecord(value);
  }, [activeId, vodBaselineRecord, sample]);
  const reportLive = useCallback((value) => {
    liveStatus(value);
    reportStatus('live', activeId, value);
  }, [liveStatus, reportStatus, activeId]);
  const reportVod = useCallback((value) => {
    vodStatus(value);
    reportStatus('vod', activeId, value);
  }, [vodStatus, reportStatus, activeId]);
  const vodUrl = (activeId && proxiedVodUrl(session.result)) || urls.vod;
  const graphSamples = session ? graphs : { live: baselineLive.samples, vod: baselineVod.samples };
  const displayed = completed && session ? '종료된 세션의 기록' : session ? '적용 응답 후 새 플레이어에서 수집' : '설정 전 재생 · 기준선';
  const markers = Object.fromEntries(['live', 'vod'].map((mode) => [mode,
    session?.result?.[mode]?.ok ? (session.result[mode].appliedAt ?? session.appliedAt) : null]));

  async function begin(event) {
    event.preventDefault();
    let conditions;
    try {
      conditions = validateConditions(fields);
    } catch (problem) {
      setValidationError(problem.message);
      return;
    }
    setValidationError('');
    await start({ conditions, urls, name: name.trim() || (PRESETS[preset]?.name ?? '사용자 설정 실험'), preset });
  }

  async function reset() {
    setFields(DEFAULT_CONDITIONS);
    setPreset('normal');
    setName('');
    setValidationError('');
    setTab('core');
    await stop({ reset: true });
  }

  function edit(event) {
    setFields({ ...fields, [event.target.name]: event.target.value });
    setPreset('custom');
    setValidationError('');
  }

  const phaseLabel = { idle: '대기', applying: '조건 적용 중', running: '측정 중', releasing: '조건 해제 및 저장 중',
    stopped: '종료', 'release-error': '조건 해제 미확인' }[phase];
  const count = Math.min(72, Math.floor(elapsed ?? 0) + 1);
  const expected = session ? Array.from({ length: count }, (_, index) => {
    const offset = Math.floor(elapsed ?? 0) - count + index + 1;
    return simulateNetworkSample(session.conditions, offset, session.startAt + offset * 1000);
  }) : [];
  const latestExpected = expected.at(-1);

  return <>
    <PageTitle title="네트워크 실험" detail="조건을 적용하고 두 플레이어의 실제 재생 반응을 기록합니다." />
    <Card className="ui-panel ui-experiment">
      <form noValidate onSubmit={begin}>
        <h2>실험 설정</h2>
        <fieldset disabled={busy || capturing || phase === 'release-error'}>
          <div className="ui-actions ui-presets" aria-label="실험 프리셋">
            {Object.entries(PRESETS).map(([id, item]) => <button type="button" key={id} aria-pressed={preset === id}
              className="video-source-btn" onClick={() => { setPreset(id); setFields(item.fields); setValidationError(''); }}>{item.name}</button>)}
          </div>
          <div className="experiment-fields">
            <label>실험명<input value={name} maxLength={100} onChange={(event) => setName(event.target.value)} placeholder={PRESETS[preset]?.name ?? '사용자 설정 실험'} /></label>
            <label>대역폭 제한<input name="bandwidth" type="number" step="any" value={fields.bandwidth} onChange={edit} /></label>
            <label>대역폭 단위<select name="unit" value={fields.unit} onChange={edit}><option>kbps</option><option>Mbps</option></select></label>
            <label>추가 지연 (ms)<input name="delay" type="number" step="any" min="0" max="10000" value={fields.delay} onChange={edit} /></label>
            <label>손실 입력 (%)<input name="loss" type="number" step="any" min="0" max="100" value={fields.loss} onChange={edit} /></label>
          </div>
        </fieldset>
        <div className="ui-actions ui-experiment-actions">
          <button className="primary-button" disabled={busy || capturing || phase === 'release-error'}>실험 시작</button>
          <button type="button" className="video-source-btn" disabled={busy || (!capturing && phase !== 'release-error')} onClick={() => void stop()}>중단</button>
          <button type="button" className="video-source-btn" disabled={busy} onClick={() => void reset()}>초기화</button>
          <span role="status">{phaseLabel}{elapsed !== null && ` · ${duration(elapsed)}`}</span>
        </div>
        {(validationError || error) && <p className="experiment-error" role="alert">{validationError || error}</p>}
      </form>
      <ConditionResult session={capturing ? session : null} counts={counts} currentStatus={conditionStatus(phase, netem, session?.result)} />
      <p className="ui-note">LIVE는 UDP 패킷에 tc netem을 적용합니다. VOD는 같은 설정값을 사용하더라도 Mathis 모델로 HTTP 처리량 상한을 낮춥니다. VOD의 손실 입력은 실제 TCP 패킷 손실률과 다르며, 100%는 HTTP 503으로 처리됩니다.</p>
    </Card>
    <SectionTitle title="현재 영상 재생과 실측 지표" detail={activeId ? '실험 플레이어의 현재 측정값' : '원본 영상의 현재 측정값 · 종료된 실험 결과는 아래에서 확인'} />
    <div className="compare-video-grid ui-experiment-players">
      <PlayerPane mode="live" url={urls.live} sessionKey={activeId} onConnect={onConnect} onMetrics={recordLive} onStatus={reportLive}>
        <PlayerSummary mode="live" samples={activeId ? graphs.live : baselineLive.samples} compact />
      </PlayerPane>
      <PlayerPane mode="vod" url={vodUrl} sourceUrl={urls.vod} sessionKey={activeId} onConnect={onConnect} onMetrics={recordVod} onStatus={reportVod}>
        <PlayerSummary mode="vod" samples={activeId ? graphs.vod : baselineVod.samples} compact />
      </PlayerPane>
    </div>
    {completed && <Card className="ui-panel ui-save-result">
      <h2>종료된 실험 · {completed.name}</h2>
      <p>{saved ? '완료된 실험 기록을 이 브라우저에 저장했습니다.' : '저장하지 못했습니다. 이 페이지를 닫기 전에 다시 시도하거나 리포트에서 CSV를 내려받으세요.'}
        {' '}{clock(completed.endAt)} 종료 · LIVE {completed.validCounts.live}개 · VOD {completed.validCounts.vod}개 유효 표본</p>
      {completed.releaseError && <p className="experiment-error">종료 시 조건 해제 미확인 · {completed.releaseError}</p>}
      <ConditionResult session={completed} counts={completed.routes} />
      <div className="ui-actions">
        {!saved && <button className="video-source-btn" onClick={control.retrySave}>저장 다시 시도</button>}
        <button className="video-source-btn" onClick={onReport}>리포트 열기</button>
      </div>
    </Card>}
    <SectionTitle title={completed && session ? '종료된 실험의 실측 그래프' : '플레이어 실측 그래프'} detail={`${displayed} · 최근 72개 표본${session?.appliedAt ? ` · 마지막 조건 적용 ${clock(session.appliedAt)}` : ''}. 플레이어 세션이 바뀌면 그래프 선이 끊어집니다.`} />
    <ExperimentTabs tab={tab} setTab={setTab} />
    <div id="experiment-graphs" role="tabpanel" aria-labelledby={`experiment-tab-${tab}`}>
      {tab === 'core' ? <>
        <PlayerCharts mode="live" samples={graphSamples.live} marker={markers.live} metrics={METRICS.live.slice(0, 2)} />
        <PlayerCharts mode="vod" samples={graphSamples.vod} marker={markers.vod} metrics={METRICS.vod.slice(0, 2)} withRoutes={Boolean(session)} />
      </> : <PlayerCharts mode={modeSelect[tab]} samples={graphSamples[tab]} marker={markers[tab]} withRoutes={tab === 'vod' && Boolean(session)} />}
    </div>
    <Detail title="보조 데이터 · 시뮬레이션 예상값">
      <p>데모 기준값과 입력 조건으로 계산한 예상값입니다. 실제 전송과 VOD 프록시의 Mathis 상한을 측정한 결과가 아닙니다.</p>
      <MetricChart metric={{ label: '모델 예상 연결 시간', unit: 'ms', digits: 1 }} samples={expected} lines={[
        { key: 'liveLatency', name: 'LIVE 예상', color: COLORS.live },
        { key: 'vodLatency', name: 'VOD 예상', color: COLORS.vod },
      ]} />
      {latestExpected && <div className="table-wrap"><table className="data-table">
        <thead><tr><th>시뮬레이션 모드</th><th>예상 연결 시간</th><th>모델 손실 확률</th><th>예상 처리량</th></tr></thead>
        <tbody>{['live', 'vod'].map((mode) => <tr key={mode}><th>{mode.toUpperCase()}</th>
          <td>{formatNumber(latestExpected[mode].latency, 1)} ms</td>
          <td>{formatNumber(latestExpected[mode].packetLoss, 2)} %</td>
          <td>{formatNumber(latestExpected[mode].bitrate, 1)} kbps</td>
        </tr>)}</tbody>
      </table></div>}
    </Detail>
    <ProbeDetail {...probe} />
  </>;
}
