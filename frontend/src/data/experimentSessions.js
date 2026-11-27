import { COMMON_METRICS, formatNumber, METRICS, MODES, SOURCE } from './metricDefinitions.js';

export const GRAPH_SAMPLE_LIMIT = 72;
export const emptyTracks = () => ({ live: [], vod: [] });
export const recentSamples = (samples, sample) => [...samples.slice(1 - GRAPH_SAMPLE_LIMIT), sample];

const finite = Number.isFinite;

export function conditionText({ bandwidthKbps, delayMs, lossPercent }) {
  return `${formatNumber(bandwidthKbps, 3)} kbps · +${formatNumber(delayMs, 2)} ms · 손실 ${formatNumber(lossPercent, 2)}%`;
}

export function sessionDuration(session) {
  return (session.endAt - session.startAt) / 1000;
}

export function compareSessions(sessions, baseId, otherId) {
  const base = sessions.find((item) => item.id === baseId) ?? sessions.find((item) => item.preset === 'normal') ?? sessions[0];
  const alternatives = sessions.filter((item) => item.id !== base?.id);
  const other = alternatives.find((item) => item.id === otherId) ?? alternatives.find((item) => item.preset !== 'normal') ?? alternatives[0];
  return { base, other, alternatives };
}

export function summarizeIceChecks(samples) {
  let previous;
  let count = 0;
  let totalSeconds = 0;
  for (const sample of samples) {
    if (!sample.icePairId || !finite(sample.iceResponses) || !finite(sample.iceTotalRttSeconds)) continue;
    if (previous?.sessionId === sample.sessionId && previous?.icePairId === sample.icePairId) {
      const updates = sample.iceResponses - previous.iceResponses;
      const seconds = sample.iceTotalRttSeconds - previous.iceTotalRttSeconds;
      if (updates > 0 && seconds >= 0) {
        count += updates;
        totalSeconds += seconds;
      }
    }
    previous = sample;
  }
  return { count, meanMs: count ? totalSeconds / count * 1000 : null };
}

export function stallRatio(sample) {
  if (!finite(sample?.playingSeconds) || !finite(sample.bufferingSeconds)) return null;
  const total = sample.playingSeconds + sample.bufferingSeconds;
  return total > 0 ? sample.bufferingSeconds / total * 100 : null;
}

export function latestMetric(samples, metric) {
  if (metric.kind === 'ratio') return stallRatio(samples.at(-1));
  if (metric.scatter) {
    return samples.findLast((sample) => sample.delivery)?.throughputKbps ?? null;
  }
  return samples.findLast((sample) => finite(sample[metric.key]))?.[metric.key] ?? null;
}

export function measurementSeries(samples, metric) {
  const previous = new Map();
  const values = [];
  for (const sample of samples) {
    const { timestamp } = sample;
    const sessionId = metric.counter === 'video' && sample.videoStatsId
      ? JSON.stringify([sample.sessionId, sample.videoStatsId]) : sample.sessionId;
    const value = metric.kind === 'ratio' ? stallRatio(sample) : sample[metric.key];
    if (!finite(value)) continue;
    const last = previous.get(sessionId);
    previous.set(sessionId, value);
    if (metric.kind === 'startup' && last !== undefined) continue;
    if (metric.kind === 'cumulative' && last !== undefined && value < last) continue;
    values.push({
      timestamp, sessionId,
      value: metric.kind === 'cumulative' ? value - (last ?? 0) : value,
      receivedPackets: sample.receivedPackets,
      lostPackets: sample.lostPackets,
    });
  }
  return values;
}

function average(values, weighted) {
  if (!values.length) return null;
  if (weighted) {
    const totals = values.reduce(({ received, lost }, sample) => ({
      received: received + (sample.receivedPackets ?? 0), lost: lost + (sample.lostPackets ?? 0),
    }), { received: 0, lost: 0 });
    return totals.received + totals.lost > 0 ? totals.lost / (totals.received + totals.lost) * 100 : null;
  }
  return values.reduce((sum, point) => sum + point.value, 0) / values.length;
}

export function describeSeries(series, metric) {
  const sorted = series.map(({ value }) => value).sort((a, b) => a - b);
  const count = sorted.length;
  if (!count) return { count, avg: null, min: null, max: null, p95: null, std: null, total: null };
  const mean = average(series, false);
  return {
    count,
    avg: average(series, metric.key === 'packetLoss'),
    min: sorted[0],
    max: sorted.at(-1),
    p95: sorted[Math.ceil(count * 0.95) - 1],
    std: Math.sqrt(sorted.reduce((sum, value) => sum + (value - mean) ** 2, 0) / count),
    total: metric.kind === 'cumulative' ? sorted.reduce((sum, value) => sum + value, 0) : null,
  };
}

export function movingAverage(series, weighted = false) {
  let start = 0;
  return series.map((point, index) => {
    if (index > 0 && point.sessionId !== series[index - 1].sessionId) start = index;
    while (series[start].timestamp < point.timestamp - 5000) start += 1;
    return { ...point, average: average(series.slice(start, index + 1), weighted) };
  });
}

export function summarizeMode(samples, mode) {
  const finalByPlayer = new Map();
  for (const sample of samples) {
    if (finite(sample.startupSec)) finalByPlayer.set(sample.sessionId, sample);
  }
  const last = [...finalByPlayer.values()];
  const playback = last.reduce((result, sample) => ({
    playingSeconds: result.playingSeconds + sample.playingSeconds,
    bufferingSeconds: result.bufferingSeconds + sample.bufferingSeconds,
  }), { playingSeconds: 0, bufferingSeconds: 0 });
  return Object.fromEntries([...COMMON_METRICS, ...METRICS[mode]].map((metric) => {
    const stats = describeSeries(measurementSeries(samples, metric), metric);
    const value = metric.kind === 'ratio' ? stallRatio(playback)
      : metric.kind === 'cumulative' ? stats.total
        : metric.kind === 'startup' ? measurementSeries(samples, metric)[0]?.value ?? null
          : stats.avg;
    return [metric.key, { value, count: stats.count }];
  }));
}

export function summarizeSession(session) {
  const summary = Object.fromEntries(MODES.map((mode) => [mode, summarizeMode(session.samples[mode], mode)]));
  const validCounts = Object.fromEntries(MODES.map((mode) => [mode, session.samples[mode].filter((sample) =>
    [...METRICS[mode], ...COMMON_METRICS].some(({ key }) => finite(sample[key]))).length]));
  return { summary, validCounts };
}

export function conditionApplied(result, mode) {
  return typeof result?.[mode]?.ok === 'boolean' ? (result[mode].ok ? '성공' : '실패') : '미확인';
}

export function sourceLabel(url) {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    return parsed.origin + parsed.pathname;
  } catch {
    return '';
  }
}

const csvCell = (value) => {
  const text = value == null ? '' : String(value);
  const safe = typeof value === 'string' && /^[\t\r\n ]*[=+@-]/.test(text) ? "'" + text : text;
  return '"' + safe.replaceAll('"', '""') + '"';
};

export function encodeCsv(rows) {
  return '\uFEFF' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
}

export function sessionCsv(session) {
  const columns = ['실험 ID', '실험명', '실험 시작', '실험 종료', '적용 확인 시각', '측정 시간(초)', '측정 시각', '모드', '플레이어 세션 ID',
    '입력 대역폭(kbps)', '추가 지연(ms)', '입력 손실(%)', 'LIVE 적용', 'VOD 프록시 설정', 'VOD 유효 모델 상한(kbps)',
    'VOD 세그먼트 경로', '세그먼트 전송 증거', '영상 소스', '데이터 출처', '실험 요청 시각',
    '대상별 적용 시각', 'LIVE 적용 상한(kbps)', '지표', '단위', '값', '상태 및 메모'];
  const { conditions, result, samples } = session;
  const iso = (time) => finite(time) ? new Date(time).toISOString() : '';
  const fieldsFor = (mode, sample) => [
    session.id, session.name, iso(session.startAt), iso(session.endAt), iso(session.appliedAt),
    (session.endAt - session.startAt) / 1000, iso(sample.timestamp), mode.toUpperCase(), sample.sessionId,
    conditions.bandwidthKbps, conditions.delayMs, conditions.lossPercent,
    conditionApplied(result, 'live'), conditionApplied(result, 'vod'), result?.vod?.effectiveKbps,
    sample.segmentRoute, sample.delivery, session.sources[mode], session.measurementSources?.[mode] ?? SOURCE[mode], iso(session.requestAt),
    iso(result?.[mode]?.appliedAt), result?.live?.ok ? Math.max(1, Math.round(conditions.bandwidthKbps)) : null,
  ];
  const rows = [columns];
  for (const mode of MODES) {
    const metrics = [...METRICS[mode], ...COMMON_METRICS];
    const points = samples[mode].length ? samples[mode] : [{}];
    const startupSeen = new Set();
    for (const sample of points) {
      const fields = fieldsFor(mode, sample);
      for (const metric of metrics) {
        if (metric.scatter && !sample.delivery && samples[mode].length) continue;
        const value = metric.kind === 'ratio' ? stallRatio(sample) : sample[metric.key];
        if (metric.kind === 'startup' && finite(value)) {
          if (startupSeen.has(sample.sessionId)) continue;
          startupSeen.add(sample.sessionId);
        }
        rows.push([...fields, metric.label, metric.unit, finite(value) ? value : '', finite(value) ? '측정' : '미측정']);
      }
      if (finite(sample.receivedPackets) && finite(sample.lostPackets)) {
        rows.push([...fields, '수신 RTP 패킷 증분', '개', sample.receivedPackets, '측정']);
        rows.push([...fields, '손실 RTP 패킷 증분', '개', sample.lostPackets, '측정']);
      }
    }
    for (const issue of session.issues[mode] ?? []) rows.push([...fieldsFor(mode, {}), '', '', '', issue]);
  }
  return encodeCsv(rows);
}
