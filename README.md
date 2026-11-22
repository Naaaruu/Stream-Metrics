# Stream-Metrics
Team Project for Stream Metrics

## Windows 11 · LIVE와 VOD 실행

VS Code에서 프로젝트 루트를 열고 PowerShell 터미널 두 개를 사용합니다. 백엔드 개발 문서의 Python은 3.14이며 3.13에서도 실행을 확인했습니다. 프론트엔드는 Node.js 24와 npm으로 검증했습니다.

```powershell
py -3.13 -m venv backend\.venv
.\backend\.venv\Scripts\python.exe -m pip install -r backend\requirements.txt
Set-Location backend
.\.venv\Scripts\python.exe -m uvicorn main:app --reload --port 8000
```

```powershell
Set-Location frontend
npm.cmd ci
npm.cmd run dev -- --port 5173 --strictPort
```

- LIVE는 OBS에서 MediaMTX의 `rtmp://localhost:1935/mystream`으로 송출합니다. 대시보드는 기본적으로 `http://localhost:8889/mystream/whep`을 사용합니다.
- 준비된 파일 기반 HLS 주소가 있다면 대시보드 **설정 → VOD 영상 URL**에 입력합니다. 공개 샘플로 확인하려면 [Mux Big Buck Bunny VOD](https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8)를 사용할 수 있습니다.
- 로컬에 2단계 검증용 파일이 있는 경우 주소는 `http://localhost:5173/vod/stage2-demo/master.m3u8`입니다. 이 샘플은 Mux가 제공하는 Blender Foundation의 Big Buck Bunny 영상 앞부분을 사용합니다. 다운로드한 파일은 로컬 생성물이며 저장소에 포함하지 않습니다.

### 팀 MP4를 로컬 HLS VOD로 변환

MP4 파일과 [FFmpeg](https://ffmpeg.org/download.html)가 필요합니다. 이미 만들어진 HLS 파일을 사용할 때는 FFmpeg가 필요 없습니다. FFmpeg는 변환할 때만 사용하며, Vite가 `frontend/public/vod`의 매니페스트와 세그먼트를 제공하므로 별도 HTTP 서버가 필요 없습니다. MediaMTX 녹화 재생 엔드포인트는 [MP4/fMP4](https://mediamtx.org/docs/features/playback)를 제공합니다.

프로젝트 루트에서 `C:\Videos\team.mp4`를 실제 파일 경로로 바꿔 실행합니다.

```powershell
New-Item -ItemType Directory -Force frontend\public\vod\team
ffmpeg -i 'C:\Videos\team.mp4' -map '0:v:0' -map '0:a:0?' -c:v libx264 -pix_fmt yuv420p -b:v 1400k -c:a aac -b:a 128k -force_key_frames 'expr:gte(t,n_forced*4)' -f hls -hls_time 4 -hls_playlist_type vod -hls_flags independent_segments -master_pl_name master.m3u8 -hls_segment_filename 'frontend/public/vod/team/segment-%03d.ts' 'frontend/public/vod/team/index.m3u8'
```

VOD 설정에 `http://localhost:5173/vod/team/master.m3u8`을 입력합니다. 마스터 매니페스트의 `BANDWIDTH`가 제공될 때 선택 화질의 명목 비트레이트가 표시됩니다. 재생 위치에서 이어지는 버퍼 잔여량은 브라우저에서 읽고, FastAPI 지표는 별도 카드와 이력으로 표시합니다.
