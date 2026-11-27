export const MODES = ['live', 'vod'];
export const PROTOCOL = { live: 'WebRTC', vod: 'HLS' };
export const SOURCE = { live: 'WebRTC getStats + 브라우저 재생', vod: 'hls.js + Resource Timing + 브라우저 재생' };
export const COLORS = { live: '#42cce5', vod: '#a68cff', warning: '#f6b65f', average: '#55dda7', muted: '#8ea1b9' };

export const COMMON_METRICS = [
  { key: 'startupSec', label: '첫 재생 시간', unit: '초', digits: 2, kind: 'startup' },
  { key: 'bufferingCount', label: '재생 중 끊김 이벤트', unit: '회', digits: 0, kind: 'cumulative', warning: true, type: 'stepAfter' },
  { key: 'bufferingSeconds', label: '누적 끊김 시간', unit: '초', digits: 2, kind: 'cumulative', warning: true },
  { key: 'stallRatio', label: '끊김 시간 비율', unit: '%', digits: 2, kind: 'ratio', warning: true },
];

export const METRICS = {
  live: [
    { key: 'bitrate', label: '영상 수신 비트레이트', unit: 'kbps', digits: 0 },
    { key: 'packetLoss', label: '영상 RTP 패킷 손실률', unit: '%', digits: 2, warning: true },
    { key: 'jitter', label: '영상 RTP 지터', unit: 'ms', digits: 2 },
    { key: 'rtt', label: 'ICE RTT', unit: 'ms', digits: 1, note: 'ICE 연결 후보 쌍의 왕복 시간' },
    { key: 'freezeCount', label: 'WebRTC 프레임 정지 횟수', unit: '회', digits: 0, kind: 'cumulative', counter: 'video', warning: true, type: 'stepAfter', note: '수신 영상 프레임 간격 기준 · 브라우저 재생 이벤트와 별도' },
    { key: 'freezeSeconds', label: 'WebRTC 누적 프레임 정지 시간', unit: '초', digits: 2, kind: 'cumulative', counter: 'video', warning: true, type: 'stepAfter' },
  ],
  vod: [
    { key: 'throughputKbps', label: '세그먼트 다운로드 처리량', unit: 'kbps', digits: 0, scatter: true, note: '네트워크 전송이 확인된 다운로드 · 요청 시작부터 완료까지' },
    { key: 'buffer', label: '브라우저 버퍼 잔여량', unit: '초', digits: 1 },
    { key: 'bitrate', label: '선택 화질의 HLS 명목 비트레이트', unit: 'kbps', digits: 0, type: 'stepAfter' },
  ],
};

export function formatNumber(value, digits = 0) {
  return Number.isFinite(value) ? value.toLocaleString('ko-KR', { maximumFractionDigits: digits }) : '미측정';
}

export function metricText(value, metric) {
  return Number.isFinite(value) ? `${formatNumber(value, metric.digits)} ${metric.unit}` : '미측정';
}

export function clock(time) {
  return Number.isFinite(time) ? new Date(time).toLocaleTimeString('ko-KR', { hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
}

export function dateTime(time) {
  return Number.isFinite(time) ? new Date(time).toLocaleString('ko-KR', { hourCycle: 'h23' }) : '—';
}

export function duration(seconds) {
  if (!Number.isFinite(seconds)) return '미측정';
  const value = Math.floor(Math.max(0, seconds));
  const parts = [Math.floor(value / 3600), Math.floor(value / 60) % 60, value % 60];
  return parts.map((part) => String(part).padStart(2, '0')).join(':');
}
