export function newSessionId() {
  return Array.from(crypto.getRandomValues(new Uint32Array(4)), (part) => part.toString(16).padStart(8, '0')).join('');
}

// QoE uses the same media events and monotonic clock for LIVE and VOD.
export function createPlaybackMetrics(startedAt, now = () => performance.now()) {
  let startupSec = null;
  let runStart = null;
  let stallStart = null;
  let playingSeconds = 0;
  let bufferingSeconds = 0;
  let bufferingCount = 0;
  let seeking = false;

  function closeIntervals(time) {
    if (runStart !== null) playingSeconds += (time - runStart) / 1000;
    if (stallStart !== null) bufferingSeconds += (time - stallStart) / 1000;
    runStart = null;
    stallStart = null;
  }

  return {
    playing() {
      const time = now();
      startupSec ??= (time - startedAt) / 1000;
      seeking = false;
      if (runStart !== null) return;
      closeIntervals(time);
      runStart = time;
    },
    waiting() {
      if (seeking || runStart === null) return false;
      const time = now();
      closeIntervals(time);
      stallStart = time;
      bufferingCount += 1;
      return true;
    },
    pause() { closeIntervals(now()); },
    seeking() {
      seeking = true;
      closeIntervals(now());
    },
    snapshot() {
      const time = now();
      return {
        startupSec,
        bufferingCount: startupSec === null ? null : bufferingCount,
        bufferingSeconds: startupSec === null ? null : bufferingSeconds + (stallStart === null ? 0 : (time - stallStart) / 1000),
        playingSeconds: startupSec === null ? null : playingSeconds + (runStart === null ? 0 : (time - runStart) / 1000),
      };
    },
  };
}
