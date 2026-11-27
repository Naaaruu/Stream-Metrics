import { useCallback, useState } from 'react';
import { recentSamples } from './data/experimentSessions.js';

export function usePlayerFeed(onStatus) {
  const [samples, setSamples] = useState([]);
  const record = useCallback((sample) => {
    setSamples((previous) => sample
      ? recentSamples(previous.at(-1)?.sessionId === sample.sessionId ? previous : [], sample)
      : []);
  }, []);
  return { samples, onMetrics: record, onStatus };
}
