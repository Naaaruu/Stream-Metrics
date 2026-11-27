"""Stream Metrics 백엔드 — FastAPI 지표 API.

2차 회의 1차 마일스톤: FastAPI 환경 구축 + API 구현, 임시(mock) 데이터로 응답 확인.
모의 지표 생성기는 frontend/src/data/mockMetrics.js 수식을 그대로 이식해
프론트엔드와 동일한 값을 보인다. 실제 측정(WebRTC getStats, PyShark)은
metrics/generator.py의 make_sample()만 교체해 확장한다.

실행:
    cd backend
    .venv\\Scripts\\python -m uvicorn main:app --reload --port 8000
"""
from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager
from datetime import date, datetime
from typing import Literal

from fastapi import FastAPI, HTTPException, Query
from pydantic import BaseModel, Field
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse

from metrics import generator
from netem import Conditions, TcController, effective_vod_rate_kbps, shaper, vod_router
from metrics.schemas import (
    HistoryResponse,
    LatestResponse,
    MergedRow,
    ScenarioInfo,
    ScenarioUpdate,
    ScenarioUpdateResponse,
    ScenariosResponse,
    StatResponse,
    StatValues,
)
from metrics.store import MetricsStore, TICK_INTERVAL_SEC

store = MetricsStore()
tc = TcController()


@asynccontextmanager
async def lifespan(_: FastAPI):
    await store.start()
    yield
    await store.stop()


app = FastAPI(
    title="Stream Metrics API",
    description="LIVE/VOD 스트리밍 전송 지표 수집·시각화 백엔드 (현재: mock 데이터)",
    version="0.1.0",
    lifespan=lifespan,
)

# 프론트엔드(Vite dev server)가 LAN 어디서든 접속할 수 있도록 전체 허용 (데모 기준)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


app.include_router(vod_router)


# -- 헬스체크 ---------------------------------------------------------------


@app.get("/api/health", tags=["system"])
def health() -> dict:
    """서비스 상태 확인."""
    return {
        "status": "ok",
        "service": "stream-metrics-backend",
        "source": "mock",
        "modes": list(generator.MODES),
        "scenario": store.scenario,
        "historySize": generator.HISTORY_SIZE,
        "seed": store.seed,
    }


# -- 지표 조회 ----------------------------------------------------------------


@app.get("/api/metrics/latest", response_model=LatestResponse, tags=["metrics"])
def metrics_latest(mode: Literal["live", "vod"] = "live") -> LatestResponse:
    """가장 최근 1개 샘플. (frontend getLatest 대응)"""
    return LatestResponse(
        mode=mode,
        scenario=store.scenario,
        sample=store.latest(mode),
    )


@app.get("/api/metrics/history", response_model=HistoryResponse, tags=["metrics"])
def metrics_history(
    mode: Literal["live", "vod"] = "live",
    count: int = Query(default=generator.HISTORY_SIZE, ge=1, le=generator.HISTORY_SIZE),
) -> HistoryResponse:
    """최근 count초 롤링 히스토리. (frontend initialHistory 대응)"""
    samples = store.history(mode, count)
    return HistoryResponse(
        mode=mode,
        scenario=store.scenario,
        count=len(samples),
        samples=samples,
    )


@app.get("/api/metrics/merged", response_model=list[MergedRow], tags=["metrics"])
def metrics_merged() -> list[MergedRow]:
    """LIVE/VOD 비교 차트용 병합 히스토리. (frontend getMergedHistory 대응)"""
    return [MergedRow(**row) for row in store.merged()]


@app.get("/api/metrics/stream", tags=["metrics"])
async def metrics_stream(mode: Literal["live", "vod"] = "live") -> StreamingResponse:
    """SSE 실시간 스트림 — 1초마다 최신 샘플을 발행한다.

    프론트엔드가 실시간 대시보드로 전환할 때 EventSource로 구독:
        new EventSource('/api/metrics/stream?mode=live')
    """

    async def events():
        meta = json.dumps(
            {"mode": mode, "source": "mock", "scenario": store.scenario},
            ensure_ascii=False,
        )
        yield f"event: hello\ndata: {meta}\n\n"
        while True:
            await asyncio.sleep(TICK_INTERVAL_SEC)
            sample = store.latest(mode)
            yield f"data: {json.dumps(sample, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# -- 통계 ---------------------------------------------------------------------


@app.get("/api/stats", response_model=StatResponse, tags=["analytics"])
def stats(
    mode: Literal["live", "vod"] = "live",
    key: Literal["latency", "packetLoss", "bitrate", "buffer", "jitter"] = "latency",
) -> StatResponse:
    """최근 히스토리의 average/max/min/p95. (frontend getStats 대응)"""
    samples = store.history(mode)
    return StatResponse(
        mode=mode,
        key=key,
        scenario=store.scenario,
        count=len(samples),
        stats=StatValues(**generator.compute_stats(samples, key)),
    )


# -- 시나리오 (스트레스 테스트) -------------------------------------------------


@app.get("/api/scenarios", response_model=ScenariosResponse, tags=["analytics"])
def scenarios() -> ScenariosResponse:
    """사용 가능한 스트레스 테스트 시나리오 목록."""
    return ScenariosResponse(
        current=store.scenario,
        scenarios=[ScenarioInfo(**item) for item in generator.SCENARIOS],
    )


@app.post("/api/scenarios", response_model=ScenarioUpdateResponse, tags=["analytics"])
def set_scenario(payload: ScenarioUpdate) -> ScenarioUpdateResponse:
    """시나리오 변경 — 모든 mode 히스토리가 새 조건으로 재초기화된다.

    (frontend handleScenarioChange 대응)
    """
    try:
        store.set_scenario(payload.scenario)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return ScenarioUpdateResponse(
        scenario=store.scenario,
        samples=generator.HISTORY_SIZE,
        message=f"시나리오가 '{store.scenario}'(으)로 변경되었습니다.",
    )


# -- 네트워크 실험 (실제 조건 적용) -----------------------------------------------


class NetemRequest(BaseModel):
    bandwidthKbps: float = Field(gt=0, le=1_000_000)
    delayMs: float = Field(ge=0, le=10_000)
    lossPercent: float = Field(ge=0, le=100)
    vodUrl: str | None = None


netem_state: dict = {"active": False, "conditions": None, "liveApplied": False}


def _netem_snapshot() -> dict:
    return {**netem_state, "vodProxy": shaper.stats()}


@app.post("/api/netem", tags=["netem"])
async def netem_apply(payload: NetemRequest) -> dict:
    """LIVE는 tc netem, VOD는 프록시로 조건을 실제 적용한다. 대상별 성공 여부를 각각 돌려준다."""
    try:
        cond = Conditions(payload.bandwidthKbps, payload.delayMs, payload.lossPercent)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    live = await asyncio.to_thread(tc.apply, cond)
    live_applied_at = int(datetime.now().timestamp() * 1000) if live.ok else None

    vod: dict
    if payload.vodUrl:
        try:
            proxy_path = shaper.configure(cond, payload.vodUrl)
            vod = {
                "ok": True,
                "appliedAt": int(datetime.now().timestamp() * 1000),
                "proxyPath": proxy_path,
                "effectiveKbps": round(effective_vod_rate_kbps(cond), 1),
                "detail": "프록시 적용됨 · 손실률은 TCP 처리량 감소로 환산",
            }
        except ValueError as exc:
            shaper.reset()
            vod = {"ok": False, "detail": str(exc)}
    else:
        shaper.reset()
        vod = {"ok": False, "detail": "VOD 영상 주소가 설정되지 않아 프록시를 켜지 않았습니다."}

    netem_state.update(
        active=live.ok or vod["ok"],
        liveApplied=live.ok,
        conditions={"bandwidthKbps": cond.bandwidth_kbps, "delayMs": cond.delay_ms, "lossPercent": cond.loss_percent},
    )
    return {**_netem_snapshot(), "live": {"ok": live.ok, "detail": live.detail, "appliedAt": live_applied_at}, "vod": vod}


@app.delete("/api/netem", tags=["netem"])
async def netem_clear() -> dict:
    """적용한 조건을 모두 해제한다."""
    live = await asyncio.to_thread(tc.clear)
    shaper.reset()
    live_remains = netem_state["liveApplied"] and not live.ok
    netem_state.update(active=live_remains, liveApplied=live_remains)
    if not live_remains:
        netem_state["conditions"] = None
    return {**_netem_snapshot(), "live": {"ok": live.ok, "detail": live.detail}}


@app.get("/api/netem", tags=["netem"])
async def netem_status() -> dict:
    """현재 적용 상태와 VOD 프록시 통계, LIVE 사이드카 컨테이너 상태."""
    live = await asyncio.to_thread(tc.available)
    return {**_netem_snapshot(), "liveAvailable": live.ok, "liveDetail": live.detail}


# -- 리포트 ---------------------------------------------------------------------


@app.get("/api/export/csv", tags=["analytics"])
def export_csv() -> Response:
    """최근 LIVE+VOD 히스토리를 CSV로 내보낸다.

    (frontend downloadCsv와 동일한 헤더·인코딩: BOM + CRLF, mode 대문자)
    """
    header = "timestamp,mode,latency_ms,packet_loss_percent,bitrate_kbps,buffer_sec,jitter_ms"
    rows: list[str] = []
    for mode, label in (("live", "LIVE"), ("vod", "VOD")):
        for s in store.history(mode):
            iso = datetime.fromtimestamp(s["timestamp"] / 1000).isoformat()
            rows.append(
                f"{iso},{label},{s['latency']},{s['packetLoss']},{s['bitrate']},{s['buffer']},{s['jitter']}"
            )
    body = "\uFEFF" + "\r\n".join([header, *rows])
    filename = f"stream-metrics-{date.today().isoformat()}.csv"
    return Response(
        content=body,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
