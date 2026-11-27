import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Play } from 'lucide-react';
import Hls from 'hls.js';
import { readHlsSegment } from './data/vodMetrics.js';
import { vodSegmentRoute } from './data/netemApi.js';
import { createPlaybackMetrics, newSessionId } from './data/playbackMetrics.js';
import { isBigBuckBunnySource } from './data/vodAttribution.js';

export default function VodPlayer({ url, sourceUrl = url, onConnect, small = false, onMetrics, onStatus, showMetrics = true }) {
  const showAttribution = isBigBuckBunnySource(sourceUrl, window.location.origin);
  return <VodSession key={url} {...{ url, onConnect, small, onMetrics, onStatus, showMetrics, showAttribution }} />;
}

function VodSession({ url, onConnect, small, onMetrics, onStatus, showMetrics, showAttribution }) {
  const [active, setActive] = useState(true);
  return (
    <div className={`video-panel video-vod ${small ? 'video-small' : ''}`}>
      {url && active ? (
        <VodPlayback url={url} onStop={() => setActive(false)} onMetrics={onMetrics} onStatus={onStatus}
          showMetrics={showMetrics} showAttribution={showAttribution} />
      ) : (
        <div className="video-placeholder">
          <div className="video-orbit video-orbit-one" /><div className="video-orbit video-orbit-two" />
          <div className="video-play-icon"><Play size={34} fill="currentColor" /></div>
          <strong>VOD 영상</strong>
          <p>{url ? '재생 종료' : '연결된 영상 소스가 없습니다'}</p>
          {url ? (
            <button className="video-source-btn" onClick={() => setActive(true)}>다시 재생 <Play size={15} /></button>
          ) : !small && (
            <button className="video-source-btn" onClick={onConnect}>영상 소스 설정 <ArrowRight size={15} /></button>
          )}
        </div>
      )}
      <div className="video-overlay"><span className="badge badge-purple"><span className="badge-dot" />VOD</span></div>
    </div>
  );
}

function VodPlayback({ url, onStop, onMetrics, onStatus, showMetrics, showAttribution }) {
  const videoRef = useRef(null);
  const [status, setStatus] = useState('불러오는 중');
  const [metrics, setMetrics] = useState(null);

  useEffect(() => {
    const video = videoRef.current;
    const sessionId = newSessionId();
    const playback = createPlaybackMetrics(performance.now());
    const usesHls = /\.m3u8(?:[?#]|$)/i.test(url) && Hls.isSupported();
    let hls;
    let failed = false;
    let latestThroughputKbps = null;
    let latestDelivery = null;
    let timingObserver;
    const recentTimings = [];
    const pendingSegments = new Set();

    function reportStatus(label, detail) {
      setStatus(detail ? `${label} · ${detail}` : label);
      onStatus?.({ label, detail });
    }

    reportStatus('연결 중');

    function measure({ bufferingEvent = false, segment = null } = {}) {
      if (failed) return;
      let buffer = null;
      if (video.readyState > 0) {
        buffer = 0;
        for (let index = 0; index < video.buffered.length; index += 1) {
          if (video.buffered.start(index) <= video.currentTime && video.currentTime < video.buffered.end(index)) {
            buffer = video.buffered.end(index) - video.currentTime;
            break;
          }
        }
      }
      const bitrate = Number(hls?.levels[hls.currentLevel]?.attrs.BANDWIDTH);
      const sample = {
        sessionId,
        usesHls,
        buffer,
        bitrate: Number.isFinite(bitrate) && bitrate > 0 ? bitrate / 1000 : null,
        segmentRoute: segment ? vodSegmentRoute(segment.responseUrl) : null,
        throughputKbps: segment?.throughputKbps ?? null,
        delivery: segment?.delivery ?? null,
        latestThroughputKbps,
        latestDelivery,
        ...playback.snapshot(),
        bufferingEvent,
        timestamp: Date.now(),
      };
      setMetrics(sample);
      onMetrics?.(sample);
    }

    function startPlayback() {
      // Attribute-based autoplay can be suspended outside the viewport.
      // If playback is blocked, the native controls still allow a manual start.
      void video.play().catch(() => {});
    }

    function fail(detail) {
      if (failed) return;
      playback.pause();
      measure();
      failed = true;
      hls?.stopLoad();
      reportStatus('연결 실패', detail);
      setMetrics(null);
      onMetrics?.(null);
    }

    const listeners = {
      loadedmetadata: () => {
        measure();
      },
      playing: () => {
        if (failed) return;
        playback.playing();
        reportStatus('재생 중');
        measure();
      },
      pause: () => {
        playback.pause();
        if (!failed && !video.ended) reportStatus('일시정지');
        measure();
      },
      waiting: () => {
        if (failed || video.paused || video.ended) return;
        reportStatus('버퍼링');
        if (!video.seeking && playback.waiting()) {
          measure({ bufferingEvent: true });
        }
      },
      seeking: () => {
        playback.seeking();
        if (!failed && !video.paused) reportStatus('탐색 중');
        measure();
      },
      seeked: () => {
        if (!failed && video.paused && !video.ended) reportStatus('일시정지');
        measure();
      },
      ended: () => {
        playback.pause();
        if (!failed) reportStatus('재생 완료');
        measure();
      },
      error: () => fail(video.error?.message || '영상 파일을 재생할 수 없습니다.'),
    };
    Object.entries(listeners).forEach(([event, handler]) => video.addEventListener(event, handler));

    if (usesHls) {
      if (window.PerformanceObserver?.supportedEntryTypes?.includes('resource')) {
        timingObserver = new PerformanceObserver((list) => {
          recentTimings.push(...list.getEntries());
          if (recentTimings.length > 256) recentTimings.splice(0, recentTimings.length - 256);
        });
        timingObserver.observe({ type: 'resource' });
      }
      hls = new Hls({ enableWorker: true });
      hls.once(Hls.Events.MEDIA_ATTACHED, startPlayback);
      hls.on(Hls.Events.LEVEL_SWITCHED, () => measure());
      hls.on(Hls.Events.FRAG_LOADED, (_, data) => {
        // Let the browser expose the completed request through Resource Timing.
        const timer = window.setTimeout(() => {
          pendingSegments.delete(timer);
          const segment = readHlsSegment(data, (url) =>
            [...recentTimings.filter((entry) => entry.name === url), ...performance.getEntriesByName(url, 'resource')]);
          if (!segment || failed) return;
          latestThroughputKbps = segment.throughputKbps;
          latestDelivery = segment.delivery;
          measure({ segment });
        }, 0);
        pendingSegments.add(timer);
      });
      hls.on(Hls.Events.LEVEL_LOADED, (_, data) => {
        if (data.details.live) fail('종료 지점이 있는 HLS VOD 주소를 입력하세요.');
      });
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) fail(`HLS 주소와 파일을 확인하세요. (${data.details})`);
      });
      hls.loadSource(url);
      hls.attachMedia(video);
    } else {
      video.src = url;
      startPlayback();
    }

    measure();
    const timer = window.setInterval(() => {
      if (!video.ended) measure();
    }, 1000);
    return () => {
      window.clearInterval(timer);
      pendingSegments.forEach((timer) => window.clearTimeout(timer));
      timingObserver?.disconnect();
      Object.entries(listeners).forEach(([event, handler]) => video.removeEventListener(event, handler));
      hls?.destroy();
      video.pause();
      video.removeAttribute('src');
      video.load();
      onMetrics?.(null);
      onStatus?.(null);
    };
  }, [url, onMetrics, onStatus]);

  return (
    <div className="vod-playback">
      <video ref={videoRef} className="stream-video" controls muted playsInline preload="metadata" aria-label="VOD 영상 재생" />
      <div className="vod-playback-details">
        <div className="player-footer">
          <span role="status">{status}</span>
          <button className="video-source-btn" onClick={onStop}>재생 종료</button>
        </div>
        {showMetrics && <dl aria-label="VOD 플레이어 지표">
          <div><dt>버퍼 잔여량 · 플레이어 측정</dt><dd>{metrics?.buffer == null ? '미측정' : `${metrics.buffer.toFixed(1)} s`}</dd></div>
          <div><dt>선택 화질 · HLS 명목 비트레이트</dt><dd>{metrics?.bitrate == null ? '미측정' : `${Math.round(metrics.bitrate).toLocaleString('ko-KR')} kbps`}</dd></div>
        </dl>}
        {showAttribution && <p className="vod-attribution">
          <a href="https://peach.blender.org/" target="_blank" rel="noopener noreferrer" title="공식 출처">Big Buck Bunny</a>
          {' © 2008 Blender Foundation · '}
          <a href="https://creativecommons.org/licenses/by/3.0/" target="_blank" rel="noopener noreferrer" title="라이선스">CC BY 3.0</a>
        </p>}
      </div>
    </div>
  );
}

