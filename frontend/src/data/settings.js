export const SETTINGS_KEY = 'stream-metrics-settings';
export const PUBLIC_HLS = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';
export const DEFAULT_SETTINGS = { urls: { live: 'http://localhost:8889/mystream', vod: '' }, refreshInterval: 1000, demo: false };

export function validateSource(value, mode) {
  const text = value.trim();
  if (!text) return '';
  if (!/^https?:\/\//i.test(text)) throw new Error(`${mode.toUpperCase()} 영상의 HTTP 또는 HTTPS 전체 주소를 입력하세요.`);
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${mode.toUpperCase()} 영상의 전체 URL을 입력하세요.`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`${mode.toUpperCase()} 영상은 HTTP 또는 HTTPS 주소를 사용하세요.`);
  if (url.username || url.password) throw new Error('사용자 이름과 비밀번호는 URL에서 제거하세요.');
  return url.href;
}

export function readSettings() {
  try {
    const value = JSON.parse(localStorage.getItem(SETTINGS_KEY));
    if (!value) return DEFAULT_SETTINGS;
    return {
      urls: {
        live: validateSource(value.urls.live, 'live'),
        vod: validateSource(value.urls.vod, 'vod'),
      },
      demo: value.demo === true,
      refreshInterval: [1000, 2000, 5000].includes(value.refreshInterval) ? value.refreshInterval : 1000,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}
