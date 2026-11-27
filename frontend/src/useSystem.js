import { useCallback, useEffect, useRef, useState } from 'react';
import { emptyTracks, recentSamples } from './data/experimentSessions.js';
import { MODES } from './data/metricDefinitions.js';
import { initialHistory, makeSample } from './data/mockMetrics.js';
import { API_BASE, getNetemStatus } from './data/netemApi.js';

export function useSystem() {
  const [status, setStatus] = useState({ api: '확인 대기', netem: null });
  const refresh = useRef(null);

  useEffect(() => {
    let closed = false;
    let timer;
    let pending = false;
    async function poll() {
      if (pending || closed) return;
      window.clearTimeout(timer);
      pending = true;
      await Promise.all([
        fetch(`${API_BASE}/api/health`, { signal: AbortSignal.timeout(4000) }).then(async (response) => {
          if (!response.ok || (await response.json()).status !== 'ok') throw new Error('Unavailable');
          if (!closed) setStatus((previous) => ({ ...previous, api: '응답 확인' }));
        }).catch(() => { if (!closed) setStatus((previous) => ({ ...previous, api: '확인 실패' })); }),
        getNetemStatus().then((netem) => {
          if (!closed) setStatus((previous) => ({ ...previous, netem: typeof netem.active === 'boolean' ? netem : false }));
        }).catch(() => { if (!closed) setStatus((previous) => ({ ...previous, netem: false })); }),
      ]);
      pending = false;
      if (!closed) timer = window.setTimeout(poll, 5000);
    }
    refresh.current = poll;
    void poll();
    return () => {
      closed = true;
      refresh.current = null;
      window.clearTimeout(timer);
    };
  }, []);
  const refreshStatus = useCallback(() => { void refresh.current?.(); }, []);
  return { status, refreshStatus };
}

export function useProbe(demo, interval) {
  const [external, setExternal] = useState(emptyTracks);
  const [demoSamples, setDemoSamples] = useState(null);
  useEffect(() => {
    const subscriptions = MODES.map((mode) => {
      // EventSource retries by itself; historical samples retain their original timestamps.
      const stream = new EventSource(`${API_BASE}/api/metrics/stream?mode=${mode}`);
      stream.onmessage = (event) => {
        let data;
        try { data = JSON.parse(event.data); } catch { return; }
        if (!Number.isFinite(data?.timestamp)) return;
        setExternal((previous) => previous[mode].at(-1)?.timestamp === data.timestamp ? previous
          : { ...previous, [mode]: recentSamples(previous[mode], { ...data, source: 'external-probe' }) });
      };
      return stream;
    });
    return () => subscriptions.forEach((stream) => stream.close());
  }, []);

  useEffect(() => {
    if (!demo) return undefined;
    let tick = 72;
    let tracks = Object.fromEntries(MODES.map((mode) => [mode, initialHistory(mode)]));
    const publish = () => {
      const time = Date.now();
      tracks = Object.fromEntries(MODES.map((mode) => [
        mode, recentSamples(tracks[mode], makeSample(mode, tick, 'normal', time)),
      ]));
      tick += 1;
      setDemoSamples(tracks);
    };
    const first = window.setTimeout(publish, 0);
    const timer = window.setInterval(publish, interval);
    return () => { window.clearTimeout(first); window.clearInterval(timer); };
  }, [demo, interval]);
  return { external, demoHistory: demo ? demoSamples : null };
}
