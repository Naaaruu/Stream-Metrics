export function alignByTimestamp(live, vod, project) {
  const rows = new Map();
  for (const [mode, samples] of [['live', live], ['vod', vod]]) {
    for (const sample of samples) {
      const { timestamp } = sample;
      rows.set(timestamp, { ...rows.get(timestamp), timestamp, ...project(sample, mode) });
    }
  }
  return [...rows.values()].sort((a, b) => a.timestamp - b.timestamp);
}

export function summarizeRecording(recording) {
  const average = (mode, key) => {
    const values = recording.samples.filter((sample) => sample.mode === mode).map((sample) => sample[key]).filter(Number.isFinite);
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  };
  return {
    packetLoss: average('live', 'packetLoss'),
    liveBitrate: average('live', 'bitrate'),
    jitter: average('live', 'jitter'),
    buffer: average('vod', 'buffer'),
    vodBitrate: average('vod', 'bitrate'),
    bufferingCount: recording.samples.some((sample) => sample.mode === 'vod' && Number.isFinite(sample.bufferingCount))
      ? recording.samples.filter((sample) => sample.mode === 'vod' && sample.bufferingEvent).length : null,
  };
}

export function recordingCsv(recording) {
  const header = 'condition,condition_verification,event,timestamp,source,mode,rtp_loss_percent,rtp_receive_kbps,rtp_jitter_ms,hls_buffer_sec,hls_nominal_kbps,hls_buffering_event';
  const rows = [
    ['start', recording.start],
    ...[...recording.samples].sort((a, b) => a.timestamp - b.timestamp).map((sample) => ['sample', sample.timestamp, sample]),
    ['stop', recording.end],
  ].map(([event, timestamp, sample]) => {
    const live = sample?.mode === 'live';
    return [
      recording.condition, 'user_label_unverified', event, new Date(timestamp).toISOString(),
      sample && (live ? 'webrtc_inbound' : 'hls_player'), sample?.mode,
      sample?.packetLoss, live ? sample.bitrate : null, sample?.jitter, sample?.buffer,
      sample && !live ? sample.bitrate : null,
      sample && !live && Number.isFinite(sample.bufferingCount) ? Number(sample.bufferingEvent) : null,
    ].map((value) => value ?? 'N/A').join(',');
  });
  return '\uFEFF' + [header, ...rows].join('\r\n');
}
