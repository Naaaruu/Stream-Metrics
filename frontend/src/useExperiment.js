import { useCallback, useEffect, useRef, useState } from 'react';
import { applyNetem, clearNetem, getNetemStatus } from './data/netemApi.js';
import { emptyTracks, recentSamples, sourceLabel, summarizeSession } from './data/experimentSessions.js';
import { newSessionId } from './data/playbackMetrics.js';
import { COMMON_METRICS, METRICS, MODES, SOURCE } from './data/metricDefinitions.js';

const emptyCounts = () => ({ proxy: 0, direct: 0, unknown: 0, cache: 0, unverified: 0, unmeasured: 0 });

function experimentLease() {
  if (!navigator.locks) return Promise.resolve(() => {});
  return new Promise((resolve, reject) => {
    navigator.locks.request('stream-metrics-netem', { ifAvailable: true }, (lock) => {
      if (!lock) { resolve(null); return; }
      return new Promise((release) => resolve(release));
    }).catch(reject);
  });
}

function addIssue(session, mode, issue) {
  if (!session.issues[mode].includes(issue)) session.issues[mode].push(issue);
}

export function useExperiment(persist, refreshSystem) {
  const [phase, setPhase] = useState('idle');
  const [session, setSession] = useState(null);
  const [graphs, setGraphs] = useState(emptyTracks);
  const [counts, setCounts] = useState(emptyCounts);
  const [error, setError] = useState('');
  const [completed, setCompleted] = useState(null);
  const [saved, setSaved] = useState(false);
  const capture = useRef(null);
  const operation = useRef(false);
  const unlock = useRef(null);
  const needsRelease = useRef(false);

  useEffect(() => {
    const protect = (event) => {
      if (!operation.current && !needsRelease.current && !capture.current) return;
      event.preventDefault();
      event.returnValue = true;
    };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, []);

  const sample = useCallback((mode, sessionId, value) => {
    if (!value || !sessionId || capture.current?.id !== sessionId) return;
    const track = capture.current.samples[mode];
    track.push(value);
    setGraphs((previous) => ({ ...previous, [mode]: recentSamples(previous[mode], value) }));
    if (mode === 'vod' && value.segmentRoute) {
      const route = value.segmentRoute;
      const delivery = value.delivery;
      capture.current.routes[route] += 1;
      if (delivery && delivery !== 'network') capture.current.routes[delivery] += 1;
      setCounts({ ...capture.current.routes });
    }
  }, []);

  const reportStatus = useCallback((mode, sessionId, value) => {
    if (!sessionId || capture.current?.id !== sessionId || value?.label !== '연결 실패') return;
    addIssue(capture.current, mode, value.detail || value.label);
  }, []);

  function clearView() {
    setSession(null);
    setCompleted(null);
    setSaved(false);
    setGraphs(emptyTracks());
    setCounts(emptyCounts());
  }

  async function start({ conditions, urls, name, preset }) {
    if (operation.current || capture.current || needsRelease.current) return;
    operation.current = true;
    setError('');
    setPhase('applying');
    try {
      unlock.current = await experimentLease();
      if (!unlock.current) throw new Error('다른 탭에서 네트워크 실험을 실행 중입니다.');
      const status = await getNetemStatus().catch(() => null);
      if (status?.active) throw new Error('백엔드에 적용된 실험이 있습니다. 먼저 중단 또는 초기화해 주세요.');
    } catch (problem) {
      unlock.current?.();
      unlock.current = null;
      operation.current = false;
      setPhase(completed ? 'stopped' : 'idle');
      setError(problem.message);
      return;
    }
    clearView();
    const requestAt = Date.now();
    let result = null;
    let applyError = '';
    try {
      result = await applyNetem(conditions, urls.vod);
    } catch (problem) {
      applyError = problem.message;
      setError(applyError);
    }
    // A failed or interrupted response does not confirm that the backend stayed unchanged.
    needsRelease.current = true;
    const startAt = Date.now();
    const appliedTimes = MODES.map((mode) => result?.[mode]?.appliedAt).filter(Number.isFinite);
    const next = {
      id: newSessionId(), name, preset, requestAt, startAt,
      appliedAt: appliedTimes.length ? Math.max(...appliedTimes) : result?.live?.ok || result?.vod?.ok ? startAt : null,
      conditions, result,
      sources: { live: sourceLabel(urls.live), vod: sourceLabel(urls.vod) },
      measurementSources: { ...SOURCE },
      samples: emptyTracks(), routes: emptyCounts(),
      issues: Object.fromEntries(MODES.map((mode) => [mode, [
        ...(!urls[mode] ? ['영상 소스 미설정'] : []),
        ...(applyError ? [applyError] : []),
        ...(result?.[mode]?.ok === false ? [result[mode].detail] : []),
      ].filter(Boolean)])),
    };
    capture.current = next;
    // The UI receives only session metadata and the separate 72-point windows.
    setSession({ id: next.id, name, preset, startAt, appliedAt: next.appliedAt, conditions, result });
    setPhase('running');
    operation.current = false;
    refreshSystem();
  }

  async function stop({ reset = false } = {}) {
    if (operation.current) return false;
    if (!capture.current && !needsRelease.current && !reset) return true;
    operation.current = true;
    setError('');
    const active = capture.current;
    const endAt = Date.now();
    capture.current = null;
    setPhase('releasing');
    let releaseResult = null;
    let releaseError = '';
    try {
      if (!unlock.current) {
        unlock.current = await experimentLease();
        if (!unlock.current) throw new Error('다른 탭에서 사용 중인 실험을 해제할 수 없습니다.');
      }
      releaseResult = await clearNetem();
      const liveWasApplied = (active ?? (needsRelease.current ? completed : null))?.result?.live?.ok;
      if (releaseResult?.active === true) throw new Error(releaseResult.live?.detail || '백엔드에 적용된 조건이 남아 있습니다.');
      if (releaseResult?.live?.ok === false && liveWasApplied !== false) {
        const status = await getNetemStatus();
        if (status?.liveAvailable !== false || liveWasApplied === true) {
          throw new Error(releaseResult.live.detail || 'LIVE 규칙 해제 미확인');
        }
      }
      needsRelease.current = false;
    } catch (problem) {
      needsRelease.current = Boolean(active) || needsRelease.current;
      releaseError = problem.message;
      setError(`조건 해제 미확인 · ${releaseError}`);
    } finally {
      if (!needsRelease.current) {
        unlock.current?.();
        unlock.current = null;
      }
    }
    if (active) {
      for (const mode of MODES) {
        if (releaseError) addIssue(active, mode, `조건 해제 미확인 · ${releaseError}`);
        const metrics = [...METRICS[mode], ...COMMON_METRICS.filter((metric) => metric.kind !== 'ratio')];
        for (const metric of metrics) {
          if (!active.samples[mode].some((point) => Number.isFinite(point[metric.key]))) addIssue(active, mode, `${metric.label} 미측정`);
        }
      }
      const finalized = { ...active, endAt, releaseResult, releaseError, ...summarizeSession(active) };
      setCompleted(finalized);
      setSaved(await persist(finalized));
    }
    if (reset && !releaseError) {
      setSession(null);
      setGraphs(emptyTracks());
      setCounts(emptyCounts());
      if (!active) {
        setCompleted(null);
        setSaved(false);
      }
    }
    setPhase(needsRelease.current ? 'release-error' : (active || completed) && !reset ? 'stopped' : 'idle');
    refreshSystem();
    operation.current = false;
    return !releaseError;
  }

  async function retrySave() {
    if (completed) setSaved(await persist(completed));
  }

  function updateCompleted(id, name) {
    if (completed?.id !== id || operation.current || capture.current || needsRelease.current) return;
    if (!name) {
      clearView();
      setPhase('idle');
      return;
    }
    setCompleted((previous) => previous?.id === id ? { ...previous, name } : previous);
    setSession((previous) => previous?.id === id ? { ...previous, name } : previous);
  }

  return { phase, session, graphs, counts, error, completed, saved, start, stop, sample, reportStatus, retrySave, updateCompleted };
}
