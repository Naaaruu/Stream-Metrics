import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarizeRecording } from '../src/data/comparison.js';
import { vodSegmentRoute } from '../src/data/netemApi.js';
import { readHlsSegment } from '../src/data/vodMetrics.js';

const stats = { loaded: 150_000, loading: { start: 100, first: 500, end: 1100 }, aborted: false };
const fragment = { type: 'main', sn: 0, stats };
const networkTiming = () => [{ initiatorType: 'xmlhttprequest', startTime: 101, responseEnd: 1090, transferSize: 150300, encodedBodySize: 150000 }];

test('calculates segment throughput from measured bytes and the full request duration', () => {
  assert.deepEqual(readHlsSegment({
    frag: fragment,
    networkDetails: { responseURL: 'http://localhost:8000/api/vod-proxy/0.ts' },
  }, networkTiming), {
    throughputKbps: 1200,
    delivery: 'network',
    responseUrl: 'http://localhost:8000/api/vod-proxy/0.ts',
  });
});

test('uses part timings for a part response and keeps unavailable throughput null', () => {
  const part = { stats: { loaded: 30_000, loading: { start: 600, end: 800 } } };
  assert.equal(readHlsSegment({ frag: fragment, part, networkDetails: { url: 'https://example.org/part.ts' } }, () => [
    { initiatorType: 'fetch', startTime: 610, responseEnd: 795, transferSize: 30300, encodedBodySize: 30000 },
  ]).throughputKbps, 1200);
  const incomplete = { ...fragment, stats: { loaded: 1000, loading: { start: 100, end: 100 } } };
  assert.deepEqual(readHlsSegment({ frag: incomplete }), { throughputKbps: null, delivery: 'unverified', responseUrl: null });
  assert.equal(readHlsSegment({ frag: { ...fragment, stats: undefined } }).throughputKbps, null);
});

test('distinguishes cache, inaccessible timing, and verified high network goodput without capping', () => {
  const data = { frag: { ...fragment, url: 'http://localhost/clip.ts', stats: { loaded: 1_000_000, loading: { start: 100, end: 102 } } } };
  const entry = { initiatorType: 'xmlhttprequest', startTime: 100, responseEnd: 101, encodedBodySize: 1_000_000 };
  assert.equal(readHlsSegment(data, () => [{ ...entry, transferSize: 1_000_300 }]).throughputKbps, 4_000_000);
  for (const transferSize of [0, 300]) {
    const result = readHlsSegment(data, () => [{ ...entry, transferSize }]);
    assert.equal(result.delivery, 'cache');
    assert.equal(result.throughputKbps, null);
  }
  assert.equal(readHlsSegment(data, () => [{ ...entry, encodedBodySize: 0, transferSize: 0 }]).delivery, 'unverified');
  assert.equal(readHlsSegment(data, () => [{ ...entry, startTime: 90, transferSize: 1_000_300 }]).throughputKbps, null);
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
