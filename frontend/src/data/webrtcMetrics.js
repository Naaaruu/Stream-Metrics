const nonnegative = (value) => Number.isFinite(value) && value >= 0 ? value : null;

export function readVideoMetrics(report, previous) {
  const video = [...report.values()].find(
    (entry) => entry.type === 'inbound-rtp' && entry.kind === 'video',
  );
  if (!video) return { video: null, metrics: null };

  const transport = report.get(video.transportId);
  const pair = report.get(transport?.selectedCandidatePairId);
  const selected = pair?.state === 'succeeded' ? pair : null;
  const rttSeconds = nonnegative(selected?.currentRoundTripTime);
  let packetLoss = null;
  let bitrate = null;
  let receivedPackets = null;
  let lostPackets = null;

  if (previous?.id === video.id && previous.ssrc === video.ssrc && video.timestamp > previous.timestamp) {
    const received = video.packetsReceived - previous.packetsReceived;
    const lost = video.packetsLost - previous.packetsLost;
    const bytes = video.bytesReceived - previous.bytesReceived;
    if (Number.isFinite(received) && Number.isFinite(lost) && received >= 0 && lost >= 0 && received + lost > 0) {
      packetLoss = lost / (received + lost) * 100;
      receivedPackets = received;
      lostPackets = lost;
    }
    if (Number.isFinite(bytes) && bytes >= 0) {
      bitrate = bytes * 8 / (video.timestamp - previous.timestamp);
    }
  }

  return {
    video,
    metrics: {
      packetLoss,
      receivedPackets,
      lostPackets,
      bitrate,
      jitter: Number.isFinite(video.jitter) && video.jitter >= 0 ? video.jitter * 1000 : null,
      rtt: rttSeconds === null ? null : rttSeconds * 1000,
      icePairId: selected ? transport.selectedCandidatePairId : null,
      iceResponses: nonnegative(selected?.responsesReceived),
      iceTotalRttSeconds: nonnegative(selected?.totalRoundTripTime),
      videoStatsId: `${video.id}:${video.ssrc}`,
      freezeCount: nonnegative(video.freezeCount),
      freezeSeconds: nonnegative(video.totalFreezesDuration),
    },
  };
}
