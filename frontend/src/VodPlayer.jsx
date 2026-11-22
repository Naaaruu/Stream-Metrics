import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Play } from 'lucide-react';
import Hls from 'hls.js';

export default function VodPlayer({ url, onConnect, small = false, onMetrics }) {
  return <VodSession key={url} url={url} onConnect={onConnect} small={small} onMetrics={onMetrics} />;
}

function VodSession({ url, onConnect, small, onMetrics }) {
  const [active, setActive] = useState(true);
  return (
    <div className={`video-panel video-vod ${small ? 'video-small' : ''}`}>
      {url && active ? (
        <VodPlayback url={url} onStop={() => setActive(false)} onMetrics={onMetrics} />
      ) : (
        <div className="video-placeholder">
          <div className="video-orbit video-orbit-one" /><div className="video-orbit video-orbit-two" />
          <div className="video-play-icon"><Play size={34} fill="currentColor" /></div>
          <strong>ON-DEMAND VIDEO</strong>
          <p>{url ? '재생 종료' : '연결된 영상 소스가 없습니다'}</p>
          {url ? (
            <button className="video-source-btn" onClick={() => setActive(true)}>다시 재생 <Play size={15} /></button>
          ) : !small && (
            <button className="video-source-btn" onClick={onConnect}>영상 소스 설정 <ArrowRight size={15} /></button>
          )}
        </div>
      )}
      <div className="video-overlay"><span className="badge badge-purple"><span className="badge-dot" />VOD</span><span>STREAM 02</span></div>
      {!url && <div className="video-corner-mark">NO SIGNAL</div>}
    </div>
  );
}

function VodPlayback({ url, onStop, onMetrics }) {
  const videoRef = useRef(null);
  const [status, setStatus] = useState('불러오는 중');
  const [metrics, setMetrics] = useState(null);

  useEffect(() => {
    const video = videoRef.current;
    let hls;
    let failed = false;
    let hasPlayed = false;
    let buffering = false;
    let bufferingCount = 0;

    function measure(bufferingEvent = false) {
      if (failed || video.readyState === 0) return;
      let buffer = 0;
      for (let index = 0; index < video.buffered.length; index += 1) {
        if (video.buffered.start(index) <= video.currentTime && video.currentTime < video.buffered.end(index)) {
          buffer = video.buffered.end(index) - video.currentTime;
          break;
        }
      }
      const bandwidth = hls?.levels[hls.currentLevel]?.attrs.BANDWIDTH;
      const bitrate = Number(bandwidth);
      const sample = { buffer, bitrate: Number.isFinite(bitrate) && bitrate > 0 ? bitrate / 1000 : null, bufferingCount };
      setMetrics(sample);
      onMetrics?.({ ...sample, bufferingEvent: bufferingEvent === true, timestamp: Date.now() });
    }

    function fail(detail) {
      if (failed) return;
      failed = true;
      hls?.stopLoad();
      setStatus(`오류 · ${detail}`);
      setMetrics(null);
      onMetrics?.(null);
    }

    const listeners = {
      loadedmetadata: () => {
        if (!failed && video.paused) setStatus('일시정지');
        measure();
      },
      playing: () => {
        if (failed) return;
        hasPlayed = true;
        buffering = false;
        setStatus('재생 중');
        measure();
      },
      pause: () => {
        buffering = false;
        if (!failed && !video.ended) setStatus('일시정지');
      },
      waiting: () => {
        if (failed || video.paused) return;
        setStatus('버퍼링');
        if (hasPlayed && !video.seeking && !buffering) {
          buffering = true;
          bufferingCount += 1;
          measure(true);
        }
      },
      seeking: () => { if (!failed && !video.paused) setStatus('버퍼링'); },
      seeked: () => {
        if (!failed) setStatus(video.ended ? '재생 완료' : video.paused ? '일시정지' : video.readyState < 3 ? '버퍼링' : '재생 중');
        measure();
      },
      ended: () => { if (!failed) setStatus('재생 완료'); measure(); },
      error: () => fail(video.error?.message || '영상 파일을 재생할 수 없습니다.'),
    };
    Object.entries(listeners).forEach(([event, handler]) => video.addEventListener(event, handler));

    if (/\.m3u8(?:[?#]|$)/i.test(url) && Hls.isSupported()) {
      hls = new Hls({ enableWorker: true });
      hls.on(Hls.Events.LEVEL_SWITCHED, measure);
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
    }

    const timer = window.setInterval(measure, 1000);
    return () => {
      window.clearInterval(timer);
      Object.entries(listeners).forEach(([event, handler]) => video.removeEventListener(event, handler));
      hls?.destroy();
      video.pause();
      video.removeAttribute('src');
      video.load();
      onMetrics?.(null);
    };
  }, [url, onMetrics]);

  return (
    <div className="vod-playback">
      <video ref={videoRef} className="stream-video" controls autoPlay muted playsInline preload="metadata" aria-label="VOD 영상 재생" />
      <div className="vod-playback-details">
        <div className="player-footer">
          <span role="status">{status}</span>
          <button className="video-source-btn" onClick={onStop}>재생 종료</button>
        </div>
        <dl aria-label="VOD 플레이어 지표">
          <div><dt>버퍼 잔여량 · 플레이어 측정</dt><dd>{metrics ? `${metrics.buffer.toFixed(1)} s` : '미측정'}</dd></div>
          <div><dt>선택 화질 · HLS 명목 비트레이트</dt><dd>{metrics?.bitrate == null ? '미측정' : `${Math.round(metrics.bitrate).toLocaleString('ko-KR')} kbps`}</dd></div>
        </dl>
      </div>
    </div>
  );
}

