import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Radio } from 'lucide-react';
import { readVideoMetrics } from './data/webrtcMetrics.js';
import { createPlaybackMetrics, newSessionId } from './data/playbackMetrics.js';

const CONNECT_TIMEOUT_MS = 15000;

function whepUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('HTTP 또는 HTTPS 주소를 입력하세요.');
  }
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith('/whep') ? path : `${path}/whep`;
  url.hash = '';
  return url;
}

export default function LivePlayer(props) {
  return <LiveSession key={props.url} {...props} />;
}

function LiveSession({ url, onConnect, small = false, onMetrics, onStatus, showMetrics = true }) {
  const videoRef = useRef(null);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState({ label: '연결 중' });
  const [metrics, setMetrics] = useState(null);

  useEffect(() => {
    if (!url) return undefined;

    const video = videoRef.current;
    const stream = new MediaStream();
    const sessionId = newSessionId();
    const playback = createPlaybackMetrics(performance.now());
    let peer;
    let sessionUrl;
    let stopped = false;
    let gatheringDone;
    let statsTimer;
    let previousVideo = null;
    const timeout = window.setTimeout(() => fail('영상 수신 시간이 초과됐습니다.'), CONNECT_TIMEOUT_MS);

    function reportStatus(label, detail) {
      const next = { label, detail };
      setStatus(next);
      onStatus?.(next);
    }

    function emit(sample, bufferingEvent = false) {
      onMetrics?.({ ...sample, ...playback.snapshot(), sessionId, bufferingEvent, timestamp: Date.now() });
    }

    async function collectStats() {
      try {
        const report = await peer.getStats();
        if (stopped) return;
        const result = readVideoMetrics(report, previousVideo);
        previousVideo = result.video;
        setMetrics(result.metrics);
        emit(result.metrics);
      } catch {
        if (stopped) return;
        previousVideo = null;
        setMetrics(null);
        emit();
      }
      statsTimer = window.setTimeout(collectStats, 1000);
    }

    function deleteSession() {
      if (!sessionUrl) return;
      void fetch(sessionUrl, { method: 'DELETE', keepalive: true }).catch(() => {});
      sessionUrl = undefined;
    }

    function close() {
      if (stopped) return;
      stopped = true;
      window.clearTimeout(timeout);
      window.clearTimeout(statsTimer);
      previousVideo = null;
      gatheringDone?.();
      deleteSession();
      Object.entries(listeners).forEach(([event, handler]) => video.removeEventListener(event, handler));
      if (peer) {
        peer.ontrack = null;
        peer.onconnectionstatechange = null;
        peer.close();
      }
      stream.getTracks().forEach((track) => track.stop());
      video.srcObject = null;
      onMetrics?.(null);
    }

    function fail(detail) {
      if (stopped) return;
      playback.pause();
      emit();
      close();
      setMetrics(null);
      reportStatus('연결 실패', detail);
    }

    function playing() {
      window.clearTimeout(timeout);
      playback.playing();
      reportStatus('재생 중');
      emit();
      if ((!small || onMetrics) && statsTimer === undefined) {
        statsTimer = window.setTimeout(collectStats, 1000);
      }
    }

    function mediaError() {
      fail('브라우저에서 수신한 영상을 재생할 수 없습니다.');
    }

    const listeners = {
      playing,
      pause: () => {
        playback.pause();
        reportStatus('일시정지');
        emit();
      },
      waiting: () => {
        if (video.paused) return;
        reportStatus('버퍼링');
        if (!video.seeking && playback.waiting()) emit(null, true);
      },
      error: mediaError,
    };

    async function connect() {
      const endpoint = whepUrl(url);
      peer = new RTCPeerConnection();
      peer.addTransceiver('video', { direction: 'recvonly' });
      peer.addTransceiver('audio', { direction: 'recvonly' });
      peer.ontrack = ({ track }) => {
        stream.addTrack(track);
        if (video.srcObject) return;
        video.srcObject = stream;
        // Attribute-based autoplay can be suspended outside the viewport.
        void video.play().catch(() => {});
      };
      peer.onconnectionstatechange = () => {
        if (['failed', 'disconnected'].includes(peer.connectionState)) {
          fail('WebRTC 연결이 끊겼습니다.');
        }
      };
      Object.entries(listeners).forEach(([event, handler]) => video.addEventListener(event, handler));

      const offer = await peer.createOffer();
      if (stopped) return;
      await peer.setLocalDescription(offer);
      if (stopped) return;
      // Send all local ICE candidates in the SDP for the local MediaMTX setup.
      if (peer.iceGatheringState !== 'complete') {
        await new Promise((resolve) => {
          function onIceState() {
            if (peer.iceGatheringState === 'complete') gatheringDone();
          }
          gatheringDone = () => {
            peer.removeEventListener('icegatheringstatechange', onIceState);
            gatheringDone = undefined;
            resolve();
          };
          peer.addEventListener('icegatheringstatechange', onIceState);
        });
      }
      if (stopped) return;

      // Read late responses after unmount so their server sessions can also be deleted.
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp' },
        body: peer.localDescription.sdp,
        signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
      });
      if (response.status !== 201) throw new Error(`MediaMTX 응답 HTTP ${response.status}`);
      const location = response.headers.get('Location');
      if (!location) throw new Error('WHEP 세션 주소를 받지 못했습니다.');
      sessionUrl = new URL(location, response.url || endpoint);
      if (stopped) {
        deleteSession();
        return;
      }
      const sdp = await response.text();
      if (!stopped) await peer.setRemoteDescription({ type: 'answer', sdp });
    }

    reportStatus('연결 중');
    connect().catch((error) => fail(error.message));
    return () => {
      close();
      onStatus?.(null);
    };
  }, [url, attempt, small, onMetrics, onStatus]);

  return (
    <>
      <div className={`video-panel video-live ${small ? 'video-small' : ''}`}>
        {url ? (
          <video ref={videoRef} className="stream-video" controls muted playsInline aria-label="LIVE 영상 재생" />
        ) : (
          <div className="video-placeholder">
            <div className="video-orbit video-orbit-one" /><div className="video-orbit video-orbit-two" />
            <div className="video-play-icon"><Radio size={32} /></div>
            <strong>LIVE 영상</strong>
            <p>연결된 영상 소스가 없습니다</p>
            {!small && <button className="video-source-btn" onClick={onConnect}>영상 소스 설정 <ArrowRight size={15} /></button>}
          </div>
        )}
        <div className="video-overlay"><span className="badge badge-cyan"><span className="badge-dot" />LIVE</span></div>
      </div>
      {url && (
        <div className="player-footer">
          <span role="status">WebRTC · {status.label}{status.detail && ` · ${status.detail}`}</span>
          {status.detail && <button className="video-source-btn" onClick={() => {
            setMetrics(null);
            setStatus({ label: '연결 중' });
            setAttempt((previous) => previous + 1);
          }}>다시 연결</button>}
        </div>
      )}
      {!small && showMetrics && (
        <section className="live-receiver-metrics" aria-label="WebRTC 영상 수신 지표">
          <strong>WebRTC 영상 수신 지표</strong>
          <span>MediaMTX → 브라우저</span>
          <dl>
            <ReceiverMetric label="영상 패킷 손실률" value={metrics?.packetLoss} unit="%" />
            <ReceiverMetric label="영상 수신 비트레이트" value={metrics?.bitrate} unit="kbps" digits={0} />
            <ReceiverMetric label="RTP 지터" value={metrics?.jitter} unit="ms" />
            {metrics?.rtt != null && <ReceiverMetric label="ICE RTT" value={metrics.rtt} unit="ms" />}
          </dl>
        </section>
      )}
    </>
  );
}

function ReceiverMetric({ label, value, unit, digits = 2 }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value == null ? '미측정' : `${value.toLocaleString('ko-KR', { maximumFractionDigits: digits })} ${unit}`}</dd>
    </div>
  );
}
