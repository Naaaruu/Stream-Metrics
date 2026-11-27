import { PUBLIC_HLS } from './settings.js';

const publicSample = new URL(PUBLIC_HLS);
const localSamplePath = '/vod/stage2-demo/master.m3u8';

export function isBigBuckBunnySource(url, appOrigin) {
  if (!url) return false;
  try {
    const source = new URL(url, appOrigin);
    return (source.origin === publicSample.origin && source.pathname === publicSample.pathname)
      || (source.origin === appOrigin && source.pathname === localSamplePath);
  } catch {
    return false;
  }
}
