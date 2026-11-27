import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PUBLIC_HLS } from '../src/data/settings.js';
import { isBigBuckBunnySource } from '../src/data/vodAttribution.js';

const origin = 'http://localhost:5173';
const localSample = '/vod/stage2-demo/master.m3u8';

test('recognizes the provided public and same-origin local Big Buck Bunny samples', () => {
  assert.equal(isBigBuckBunnySource(PUBLIC_HLS, origin), true);
  assert.equal(isBigBuckBunnySource(`${origin}${localSample}?v=1`, origin), true);
});

test('does not infer credits from paths on other hosts or from the proxy URL', () => {
  for (const url of [
    'https://example.com/x36xhzz/x36xhzz.m3u8',
    `https://example.com${localSample}`,
    'http://localhost:8000/api/vod-proxy/master.m3u8',
    `${origin}/vod/team/master.m3u8`,
    'https://test-streams.mux.dev/other/x36xhzz.m3u8',
    '',
  ]) {
    assert.equal(isBigBuckBunnySource(url, origin), false);
  }
});
