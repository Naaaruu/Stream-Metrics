"""VOD(HLS)용 네트워크 제한 프록시.

브라우저(hls.js)가 원본 대신 `/api/vod-proxy/<파일>`을 요청하면, 백엔드가 원본 서버에서
받아 오면서 (1) 추가 지연 (2) 유효 처리량 제한을 적용해서 내려준다.

- 여러 요청이 동시에 와도 하나의 '회선'을 나눠 쓰도록 전역 토큰 스케줄러를 사용한다.
- 매니페스트의 세그먼트 주소가 상대 경로여야 프록시를 그대로 통과한다. (README의 FFmpeg 변환 결과)
- 손실률은 TCP 특성을 반영해 처리량 감소로 환산한다. (shaping.effective_vod_rate_kbps)
- 손실률 100%는 모든 요청을 503으로 거부한다.
"""
from __future__ import annotations

import asyncio
import time
from typing import AsyncIterator
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

from .shaping import Conditions, effective_vod_rate_kbps

CHUNK_BYTES = 8192
PASS_HEADERS = ("content-type", "content-length", "content-range", "accept-ranges", "content-encoding", "etag", "last-modified")

router = APIRouter(tags=["netem"])


class VodShaper:
    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        self.base: str | None = None
        self.filename: str | None = None
        self.delay_ms = 0.0
        self.rate_kbps: float | None = None
        self.blocked = False
        self._next_free = 0.0
        self.requests = 0
        self.bytes_sent = 0
        self.rejected = 0

    @property
    def active(self) -> bool:
        return self.rate_kbps is not None

    def configure(self, c: Conditions, vod_url: str) -> str:
        """프록시를 설정하고, 프론트가 대신 재생해야 할 프록시 경로를 돌려준다."""
        parts = urlsplit(vod_url)
        if parts.scheme not in ("http", "https") or not parts.netloc:
            raise ValueError("VOD 주소는 http 또는 https여야 합니다.")
        filename = parts.path.rsplit("/", 1)[-1]
        if not filename:
            raise ValueError("VOD 주소 끝에 파일 이름(예: master.m3u8)이 필요합니다.")
        base_path = parts.path[: len(parts.path) - len(filename)]
        self.reset()
        self.base = f"{parts.scheme}://{parts.netloc}{base_path}"
        self.filename = filename
        self.delay_ms = c.delay_ms
        self.rate_kbps = effective_vod_rate_kbps(c)
        self.blocked = c.loss_percent >= 100
        return f"/api/vod-proxy/{filename}" + (f"?{parts.query}" if parts.query else "")

    async def throttle(self, nbytes: int) -> None:
        if self.rate_kbps is None:
            return
        bytes_per_sec = self.rate_kbps * 1000 / 8
        now = time.monotonic()
        start = max(now, self._next_free)
        self._next_free = start + nbytes / bytes_per_sec
        wait = self._next_free - now
        if wait > 0.001:
            await asyncio.sleep(wait)

    def stats(self) -> dict:
        return {"requests": self.requests, "bytesSent": self.bytes_sent, "rejected": self.rejected}


shaper = VodShaper()


@router.get("/api/vod-proxy/{path:path}")
async def vod_proxy(path: str, request: Request) -> StreamingResponse:
    if not shaper.active or shaper.base is None:
        raise HTTPException(status_code=409, detail="VOD 프록시가 설정되지 않았습니다. 실험을 먼저 시작하세요.")
    if ".." in path.split("/"):
        raise HTTPException(status_code=400, detail="잘못된 경로입니다.")

    shaper.requests += 1
    await asyncio.sleep(shaper.delay_ms / 1000)
    if shaper.blocked:
        shaper.rejected += 1
        raise HTTPException(status_code=503, detail="패킷 손실률 100%: 요청이 전달되지 않습니다.")

    target = shaper.base + path
    if request.url.query:
        target += "?" + request.url.query
    headers = {"range": request.headers["range"]} if "range" in request.headers else {}

    client = httpx.AsyncClient(timeout=httpx.Timeout(10.0, read=30.0))
    try:
        upstream = await client.send(client.build_request("GET", target, headers=headers), stream=True)
    except httpx.HTTPError as exc:
        await client.aclose()
        raise HTTPException(status_code=502, detail=f"원본 VOD 서버에 연결할 수 없습니다: {exc}") from exc

    async def body() -> AsyncIterator[bytes]:
        try:
            async for chunk in upstream.aiter_raw(CHUNK_BYTES):
                await shaper.throttle(len(chunk))
                shaper.bytes_sent += len(chunk)
                yield chunk
        finally:
            await upstream.aclose()
            await client.aclose()

    out_headers = {k: v for k, v in upstream.headers.items() if k.lower() in PASS_HEADERS}
    out_headers["Cache-Control"] = "no-store"
    return StreamingResponse(body(), status_code=upstream.status_code, headers=out_headers)
