import { makeSample } from './mockMetrics.js';

export const DEFAULT_CONDITIONS = { bandwidth: '5000', unit: 'kbps', delay: '0', loss: '0' };

export function validateConditions(fields) {
  const bandwidthKbps = Number(fields.bandwidth) * (fields.unit === 'Mbps' ? 1000 : 1);
  const delayMs = Number(fields.delay);
  const lossPercent = Number(fields.loss);
  if (!fields.bandwidth.trim() || !Number.isFinite(bandwidthKbps) || bandwidthKbps <= 0 || bandwidthKbps > 1_000_000) {
    throw new Error('대역폭은 0 kbps 초과, 1,000 Mbps 이하로 입력하세요.');
  }
  if (!fields.delay.trim() || !Number.isFinite(delayMs) || delayMs < 0 || delayMs > 10_000) {
    throw new Error('추가 지연은 0~10,000 ms로 입력하세요.');
  }
  if (!fields.loss.trim() || !Number.isFinite(lossPercent) || lossPercent < 0 || lossPercent > 100) {
    throw new Error('패킷 손실률은 0~100%로 입력하세요.');
  }
  return { bandwidthKbps, delayMs, lossPercent };
}

export function simulateNetworkSample(conditions, index, timestamp = Date.now()) {
  const row = { timestamp };
  for (const mode of ['live', 'vod']) {
    const baseline = makeSample(mode, index, 'normal', timestamp);
    const { bandwidthKbps, delayMs, lossPercent } = conditions;
    row[mode] = {
      latency: baseline.latency + delayMs,
      packetLoss: baseline.packetLoss + (100 - baseline.packetLoss) * lossPercent / 100,
      bitrate: Math.min(baseline.bitrate, bandwidthKbps),
    };
  }
  return { ...row, liveLatency: row.live.latency, vodLatency: row.vod.latency };
}
