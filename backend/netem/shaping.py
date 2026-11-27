"""네트워크 조건 모델 + tc netem 컨트롤러.

tc netem은 리눅스 커널 기능이라 Windows에서는 Docker(WSL2) 컨테이너 안에서 실행한다.
docker-compose.yml의 `netem` 사이드카가 MediaMTX와 네트워크 네임스페이스를 공유하므로,
이 컨테이너에서 건 규칙이 MediaMTX가 브라우저로 보내는 패킷에 그대로 적용된다.
"""
from __future__ import annotations

import math
import os
import shutil
import subprocess
from dataclasses import dataclass
from typing import Callable

NETEM_CONTAINER = os.environ.get("NETEM_CONTAINER", "stream-metrics-netem")
NETEM_IFACE = os.environ.get("NETEM_IFACE", "eth0")
# MediaMTX WebRTC 미디어(UDP) 포트. 이 포트에서 나가는 패킷에만 규칙을 건다.
WEBRTC_MEDIA_PORT = int(os.environ.get("NETEM_MEDIA_PORT", "8189"))

# VOD(HLS/TCP) 손실 모델 파라미터
MSS_BYTES = 1460
BASE_RTT_MS = 20.0


@dataclass(frozen=True)
class Conditions:
    bandwidth_kbps: float
    delay_ms: float
    loss_percent: float

    def __post_init__(self) -> None:
        if not (0 < self.bandwidth_kbps <= 1_000_000):
            raise ValueError("대역폭은 0 kbps 초과, 1,000 Mbps 이하여야 합니다.")
        if not (0 <= self.delay_ms <= 10_000):
            raise ValueError("추가 지연은 0~10,000 ms여야 합니다.")
        if not (0 <= self.loss_percent <= 100):
            raise ValueError("패킷 손실률은 0~100%여야 합니다.")


def effective_vod_rate_kbps(c: Conditions) -> float:
    """HLS(TCP)에 적용할 유효 처리량 상한(kbps).

    TCP는 손실된 패킷을 재전송으로 가리기 때문에, 손실은 '영상 조각이 깨지는 것'이 아니라
    '처리량 감소 + 지연 증가'로 나타난다. 이를 Mathis 공식으로 근사한다.
        throughput ≈ 1.22 * MSS / (RTT * sqrt(p))
    설정한 대역폭 상한과 비교해 더 작은 값을 쓴다.
    """
    cap = c.bandwidth_kbps
    p = c.loss_percent / 100
    if p > 0:
        rtt_s = (BASE_RTT_MS + 2 * c.delay_ms) / 1000
        mathis_kbps = 1.22 * MSS_BYTES * 8 / (rtt_s * math.sqrt(p)) / 1000
        cap = min(cap, mathis_kbps)
    return cap


def tc_apply_commands(c: Conditions, iface: str = NETEM_IFACE, port: int = WEBRTC_MEDIA_PORT) -> list[list[str]]:
    """UDP source port `port`의 패킷에만 netem을 거는 tc 명령 목록.

    prio qdisc의 3번 밴드에 netem을 붙이고, u32 필터로 해당 UDP 패킷만 그 밴드로 보낸다.
    (RTMP/WHEP 같은 TCP 시그널링은 영향을 받지 않는다.)
    """
    rate = max(1, round(c.bandwidth_kbps))
    netem = ["delay", f"{c.delay_ms:g}ms", "loss", f"{c.loss_percent:g}%", "rate", f"{rate}kbit"]
    return [
        ["tc", "qdisc", "add", "dev", iface, "root", "handle", "1:", "prio"],
        ["tc", "qdisc", "add", "dev", iface, "parent", "1:3", "handle", "30:", "netem", *netem],
        [
            "tc", "filter", "add", "dev", iface, "protocol", "ip", "parent", "1:0", "prio", "3",
            "u32", "match", "ip", "protocol", "17", "0xff", "match", "ip", "sport", str(port), "0xffff",
            "flowid", "1:3",
        ],
    ]


def tc_clear_command(iface: str = NETEM_IFACE) -> list[str]:
    return ["tc", "qdisc", "del", "dev", iface, "root"]


Runner = Callable[[list[str]], "subprocess.CompletedProcess[str]"]


def _docker_runner(argv: list[str]) -> "subprocess.CompletedProcess[str]":
    return subprocess.run(argv, capture_output=True, text=True, timeout=10)


@dataclass(frozen=True)
class TargetResult:
    ok: bool
    detail: str


class TcController:
    """docker exec로 사이드카 컨테이너 안에서 tc를 실행한다."""

    def __init__(self, container: str = NETEM_CONTAINER, runner: Runner | None = None) -> None:
        self.container = container
        self._runner = runner or _docker_runner

    def _exec(self, cmd: list[str]) -> "subprocess.CompletedProcess[str]":
        return self._runner(["docker", "exec", self.container, *cmd])

    def _precheck(self) -> TargetResult | None:
        if self._runner is _docker_runner and shutil.which("docker") is None:
            return TargetResult(False, "docker 명령을 찾을 수 없습니다. Docker Desktop이 설치·실행 중인지 확인하세요.")
        try:
            info = self._runner(["docker", "inspect", "-f", "{{.State.Running}}", self.container])
        except (OSError, subprocess.SubprocessError) as exc:
            return TargetResult(False, f"docker 실행 실패: {exc}")
        if info.returncode != 0 or info.stdout.strip() != "true":
            return TargetResult(
                False,
                f"컨테이너 '{self.container}'가 실행 중이 아닙니다. `docker compose up -d`로 먼저 실행하세요.",
            )
        return None

    def available(self) -> TargetResult:
        return self._precheck() or TargetResult(True, f"컨테이너 '{self.container}' 실행 중")

    def apply(self, c: Conditions) -> TargetResult:
        problem = self._precheck()
        if problem:
            return problem
        try:
            self._exec(tc_clear_command())  # 기존 규칙 제거 (없으면 실패해도 무시)
            for cmd in tc_apply_commands(c):
                done = self._exec(cmd)
                if done.returncode != 0:
                    self._exec(tc_clear_command())
                    msg = (done.stderr or done.stdout).strip() or f"종료 코드 {done.returncode}"
                    return TargetResult(False, f"tc 적용 실패 ({' '.join(cmd[1:4])}): {msg}")
        except (OSError, subprocess.SubprocessError) as exc:
            return TargetResult(False, f"tc 실행 실패: {exc}")
        return TargetResult(True, f"tc netem 적용됨 · UDP {WEBRTC_MEDIA_PORT} 미디어 패킷")

    def clear(self) -> TargetResult:
        problem = self._precheck()
        if problem:
            return problem
        try:
            done = self._exec(tc_clear_command())
        except (OSError, subprocess.SubprocessError) as exc:
            return TargetResult(False, f"tc 해제 실패: {exc}")
        if done.returncode == 0:
            return TargetResult(True, "tc 규칙 제거됨")
        detail = (done.stderr or done.stdout).strip()
        if "cannot delete qdisc with handle of zero" in detail.lower() or "no such file or directory" in detail.lower():
            return TargetResult(True, "적용된 tc 규칙 없음")
        return TargetResult(False, f"tc 해제 실패: {detail or done.returncode}")
