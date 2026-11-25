"""실제 네트워크 조건 적용 모듈 (대역폭 제한 / 추가 지연 / 패킷 손실).

- LIVE(WebRTC): Docker 사이드카에서 `tc netem`으로 MediaMTX의 UDP 미디어 패킷에 적용 (shaping.py)
- VOD(HLS)    : FastAPI 프록시가 응답을 느리게/제한해서 적용 (vod_proxy.py)
"""
from .shaping import Conditions, TcController, effective_vod_rate_kbps
from .vod_proxy import router as vod_router
from .vod_proxy import shaper

__all__ = ["Conditions", "TcController", "effective_vod_rate_kbps", "vod_router", "shaper"]
