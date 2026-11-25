export const API_BASE = 'http://localhost:8000';

async function request(method, body) {
  let response;
  try {
    response = await fetch(`${API_BASE}/api/netem`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('백엔드(FastAPI)에 연결할 수 없습니다. localhost:8000 실행 상태를 확인하세요.');
  }
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(typeof data.detail === 'string' ? data.detail : `요청 실패 (${response.status})`);
  }
  return response.json();
}

export function applyNetem(conditions, vodUrl) {
  return request('POST', {
    bandwidthKbps: conditions.bandwidthKbps,
    delayMs: conditions.delayMs,
    lossPercent: conditions.lossPercent,
    vodUrl: vodUrl || null,
  });
}

export const clearNetem = () => request('DELETE');
export const getNetemStatus = () => request('GET');

export const proxiedVodUrl = (result) => (result?.vod?.ok ? `${API_BASE}${result.vod.proxyPath}` : null);
