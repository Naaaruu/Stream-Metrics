import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarizeRecording } from '../src/data/comparison.js';
import { vodSegmentRoute } from '../src/data/netemApi.js';
import { readHlsSegment } from '../src/data/vodMetrics.js';

const stats = { loaded: 150_000, loading: { start: 100, first: 500, end: 1100 }, aborted: false };
const fragment = { type: 'main', sn: 0, stats };

test('calculates segment throughput from measured bytes and the full request duration', () => {
  assert.deepEqual(readHlsSegment({
    frag: fragment,
    networkDetails: { responseURL: 'http://localhost:8000/api/vod-proxy/0.ts' },
  }), {
    throughputKbps: 1200,
    responseUrl: 'http://localhost:8000/api/vod-proxy/0.ts',
  });
});

test('uses part timings for a part response and keeps unavailable throughput null', () => {
  const part = { stats: { loaded: 30_000, loading: { start: 600, end: 800 } } };
  assert.equal(readHlsSegment({ frag: fragment, part }).throughputKbps, 1200);
  const incomplete = { ...fragment, stats: { loaded: 1000, loading: { start: 100, end: 100 } } };
  assert.deepEqual(readHlsSegment({ frag: incomplete }), { throughputKbps: null, responseUrl: null });
  assert.equal(readHlsSegment({ frag: { ...fragment, stats: undefined } }).throughputKbps, null);
});

test('skips non-video, initialization, aborted, and bandwidth test fragments', () => {
  for (const frag of [
    { ...fragment, type: 'audio' },
    { ...fragment, sn: 'initSegment' },
    { ...fragment, bitrateTest: true },
    { ...fragment, stats: { ...stats, aborted: true } },
  ]) {
    assert.equal(readHlsSegment({ frag }), null);
  }
});

test('uses the response origin and path for proxy verification', () => {
  assert.equal(vodSegmentRoute('http://localhost:8000/api/vod-proxy/sub/0.ts?part=1'), 'proxy');
  assert.equal(vodSegmentRoute('https://cdn.example/api/vod-proxy/0.ts'), 'direct');
  assert.equal(vodSegmentRoute('http://localhost:8000/api/vod-proxy-extra/0.ts'), 'direct');
  assert.equal(vodSegmentRoute('/api/vod-proxy/0.ts'), 'unknown');
  assert.equal(vodSegmentRoute(null), 'unknown');
});

test('comparison counts VOD stalls only after playback has been observed', () => {
  const loading = { mode: 'vod', bufferingCount: null, bufferingEvent: false };
  const playing = { mode: 'vod', bufferingCount: 0, bufferingEvent: false };
  const waiting = { mode: 'vod', bufferingCount: 1, bufferingEvent: true };
  assert.equal(summarizeRecording({ samples: [loading] }).bufferingCount, null);
  assert.equal(summarizeRecording({ samples: [loading, playing] }).bufferingCount, 0);
  assert.equal(summarizeRecording({ samples: [loading, playing, waiting] }).bufferingCount, 1);
});
