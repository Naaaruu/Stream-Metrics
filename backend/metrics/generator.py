"""실제 네트워크 지표 수집기 (MetricsGenerator).

백그라운드 스레드가 주기적으로 타겟 서버와의 실제 네트워크 상태(RTT, Jitter, 손실률, 대역폭)를
측정하고, store.py가 1초마다 next_sample()을 호출할 때 최신 실측값을 반환한다.
"""
from __future__ import annotations

import math
import os
import socket
import threading
import time
import urllib.request
from collections import deque

MODES: tuple[str, ...] = ("live", "vod")
HISTORY_SIZE = 72

# 초기 워밍업 및 측정 실패 시 사용할 기준값
BASE: dict[str, dict[str, float]] = {
    "live": {"latency": 35.0, "packetLoss": 0.0, "bitrate": 2450, "buffer": 2.4, "jitter": 2.0},
    "vod": {"latency": 48.0, "packetLoss": 0.0, "bitrate": 3850, "buffer": 15.0, "jitter": 1.5},
}

# 프론트엔드 '네트워크 실험' 탭 호환용 계수
EFFECTS: dict[str, dict[str, float]] = {
    "normal": {"latency": 1.0, "packetLoss": 1.0, "bitrate": 1.0, "buffer": 1.0, "jitter": 1.0},
    "bandwidth": {"latency": 1.55, "packetLoss": 1.8, "bitrate": 0.55, "buffer": 0.57, "jitter": 1.6},
    "loss": {"latency": 1.35, "packetLoss": 7.0, "bitrate": 0.8, "buffer": 0.72, "jitter": 2.2},
}

SCENARIOS: list[dict[str, str]] = [
    {"id": "normal", "title": "일반 환경", "caption": "기본 대역폭과 안정적인 연결"},
    {"id": "bandwidth", "title": "대역폭 제한", "caption": "비트레이트 감소 상황 시뮬레이션"},
    {"id": "loss", "title": "패킷 손실 증가", "caption": "손실률 증가 상황 시뮬레이션"},
]

METRIC_KEYS: tuple[str, ...] = ("latency", "packetLoss", "bitrate", "buffer", "jitter")

# ==============================================================================
# [설정] 실제 네트워크 측정 대상 (방화벽 차단을 피하기 위해 도메인 기반 측정)
# ==============================================================================
TARGET_HOST = "www.google.com"
TARGET_PORT = 443
HTTP_PROBE_URL = "https://www.google.com/generate_204"
SPEED_TEST_URL = "https://speed.cloudflare.com/__down?bytes=250000"  # 250KB 청크 대역폭 측정
PROBE_TIMEOUT_SEC = 1.5


def clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


def now_ms() -> int:
    return int(time.time() * 1000)


def seed_from_env() -> int | None:
    raw = os.environ.get("STREAM_METRICS_SEED", "").strip()
    return int(raw) if raw.isdigit() else None


class RealNetworkProbe:
    """백그라운드에서 실제 네트워크 상태를 측정하는 수집기."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._rtt_history: deque[float] = deque(maxlen=20)
        self._loss_window: deque[int] = deque(maxlen=30)  # 0: 성공, 1: 손실
        self._latest = {
            "latency": 28.0,
            "packetLoss": 0.0,
            "bitrate": 4200.0,
            "jitter": 1.2,
        }
        self._vod_buffer = 12.0
        self._tick_count = 0

        self._thread = threading.Thread(target=self._measure_loop, daemon=True)
        self._thread.start()

    def _measure_rtt(self) -> float | None:
        """TCP 소켓 연결 왕복 시간(RTT)을 측정하고, 차단 시 HTTP HEAD로 대체 측정한다."""
        start = time.perf_counter()
        try:
            with socket.create_connection((TARGET_HOST, TARGET_PORT), timeout=PROBE_TIMEOUT_SEC):
                return (time.perf_counter() - start) * 1000.0
        except OSError:
            pass

        # TCP 소켓이 프록시/방화벽에 막힌 경우 HTTP 응답 시간으로 RTT 측정
        start = time.perf_counter()
        try:
            req = urllib.request.Request(HTTP_PROBE_URL, method="HEAD")
            with urllib.request.urlopen(req, timeout=PROBE_TIMEOUT_SEC):
                return (time.perf_counter() - start) * 1000.0
        except Exception:
            return None

    def _measure_download_bitrate(self) -> float | None:
        """실제 HTTP 청크 다운로드를 통해 가용 대역폭(kbps)을 측정한다."""
        start = time.perf_counter()
        try:
            req = urllib.request.Request(SPEED_TEST_URL, headers={"User-Agent": "StreamMetrics/1.0"})
            with urllib.request.urlopen(req, timeout=2.5) as resp:
                data = resp.read()
                elapsed = time.perf_counter() - start
                if elapsed > 0 and len(data) > 0:
                    return (len(data) * 8.0) / elapsed / 1000.0
        except Exception:
            pass
        return None

    def _measure_loop(self) -> None:
        while True:
            loop_start = time.perf_counter()
            self._tick_count += 1

            # 1. 실제 RTT & 패킷 손실률 측정 (매 1초마다)
            rtt = self._measure_rtt()
            if rtt is not None:
                self._loss_window.append(0)
                self._rtt_history.append(rtt)
            else:
                self._loss_window.append(1)

            loss_pct = (sum(self._loss_window) / len(self._loss_window)) * 100.0 if self._loss_window else 0.0

            # 2. Jitter 계산 (연속된 RTT 차이의 평균)
            if len(self._rtt_history) >= 2:
                diffs = [
                    abs(self._rtt_history[i] - self._rtt_history[i - 1])
                    for i in range(1, len(self._rtt_history))
                ]
                jitter = sum(diffs) / len(diffs)
            else:
                jitter = 1.2

            current_rtt = self._rtt_history[-1] if self._rtt_history else 35.0

            # 3. 대역폭(Bitrate) 실측 (3초마다 1회 실측 갱신)
            bitrate = self._latest["bitrate"]
            if self._tick_count % 3 == 1:
                measured_kbps = self._measure_download_bitrate()
                if measured_kbps is not None:
                    bitrate = clamp(measured_kbps, 300.0, 25000.0)

            # 4. VOD 버퍼 상태 갱신
            if bitrate >= 2500 and loss_pct < 5.0:
                self._vod_buffer = min(30.0, self._vod_buffer + 0.4)
            else:
                self._vod_buffer = max(0.5, self._vod_buffer - 1.2)

            with self._lock:
                self._latest = {
                    "latency": current_rtt,
                    "packetLoss": loss_pct,
                    "bitrate": bitrate,
                    "jitter": jitter,
                }

            elapsed = time.perf_counter() - loop_start
            time.sleep(max(0.1, 1.0 - elapsed))

    def snapshot(self) -> tuple[dict[str, float], float]:
        with self._lock:
            return dict(self._latest), self._vod_buffer


class MetricsGenerator:
    """store.py와 연결되는 실제 네트워크 지표 생성기 인터페이스."""

    def __init__(self, seed: int | None = None) -> None:
        self.seed = seed
        self._scenario = "normal"
        self._probe = RealNetworkProbe()

    @property
    def scenario(self) -> str:
        return self._scenario

    def set_scenario(self, scenario: str) -> None:
        if scenario not in EFFECTS:
            raise ValueError(f"알 수 없는 시나리오: {scenario} ({', '.join(EFFECTS)})")
        self._scenario = scenario

    def next_sample(self, mode: str, timestamp_ms: int | None = None) -> dict:
        """store.py가 1초마다 호출하는 함수 — 백그라운드 실측값을 즉시 반환한다."""
        ts = timestamp_ms if timestamp_ms is not None else now_ms()
        raw, vod_buf = self._probe.snapshot()
        eff = EFFECTS[self._scenario]

        if mode == "live":
            latency = raw["latency"] * eff["latency"]
            bitrate = (raw["bitrate"] * 0.65) * eff["bitrate"]
            buffer = clamp(2.5 * eff["buffer"] - (raw["packetLoss"] * 0.2), 0.2, 5.0)
            jitter = raw["jitter"] * eff["jitter"]
        else:
            latency = (raw["latency"] + 12.0) * eff["latency"]
            bitrate = raw["bitrate"] * eff["bitrate"]
            buffer = clamp(vod_buf * eff["buffer"], 0.0, 30.0)
            jitter = (raw["jitter"] * 0.6) * eff["jitter"]

        packet_loss = raw["packetLoss"] * eff["packetLoss"]
        if self._scenario == "loss" and packet_loss == 0.0:
            packet_loss = 3.5

        return {
            "timestamp": ts,
            "latency": round(clamp(latency, 1, 500), 1),
            "packetLoss": round(clamp(packet_loss, 0, 100), 2),
            "bitrate": round(clamp(bitrate, 0, 30000)),
            "buffer": round(clamp(buffer, 0, 60), 1),
            "jitter": round(clamp(jitter, 0, 100), 1),
        }

    def warmup(self, mode: str, count: int = HISTORY_SIZE) -> list[dict]:
        """서버 시작 시 과거 72초 히스토리를 블로킹 없이 초기값으로 채운다."""
        now = now_ms()
        base = BASE[mode]
        return [
            {
                "timestamp": now - (count - 1 - i) * 1000,
                "latency": base["latency"],
                "packetLoss": base["packetLoss"],
                "bitrate": base["bitrate"],
                "buffer": base["buffer"],
                "jitter": base["jitter"],
            }
            for i in range(count)
        ]


def compute_stats(samples: list[dict], key: str) -> dict[str, float]:
    """average/max/min/p95 통계. (frontend getStats() 대응)"""
    if not samples:
        return {"average": 0, "max": 0, "min": 0, "p95": 0}
    values = [float(s[key]) for s in samples]
    ordered = sorted(values)
    return {
        "average": round(sum(values) / len(values), 1),
        "max": max(values),
        "min": min(values),
        "p95": ordered[max(0, math.ceil(len(ordered) * 0.95) - 1)],
    }