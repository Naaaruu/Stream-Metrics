import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPlaybackMetrics } from '../src/data/playbackMetrics.js';
import { compareSessions, describeSeries, emptyTracks, measurementSeries, movingAverage, recentSamples, sessionCsv, stallRatio, summarizeIceChecks, summarizeSession } from '../src/data/experimentSessions.js';
import { deleteSession, listSessions, renameSession, storeSession } from '../src/data/sessionStore.js';
import { readVideoMetrics } from '../src/data/webrtcMetrics.js';

test('shared playback timing excludes initial loading, seek and manual pause', () => {
  let time = 100;
  const playback = createPlaybackMetrics(time, () => time);
  assert.equal(playback.waiting(), false);
  assert.equal(playback.snapshot().bufferingCount, null);
  time = 1100;
  playback.playing();
  time = 3100;
  assert.equal(playback.waiting(), true);
  assert.equal(playback.waiting(), false);
  time = 4100;
  assert.equal(playback.snapshot().bufferingSeconds, 1);
  playback.playing();
  time = 5100;
  playback.seeking();
  time = 6100;
  assert.equal(playback.waiting(), false);
  playback.playing();
  time = 7100;
  playback.pause();
  time = 8100;
  assert.deepEqual(playback.snapshot(), { startupSec: 1, bufferingCount: 1, bufferingSeconds: 1, playingSeconds: 4 });
  assert.equal(stallRatio(playback.snapshot()), 20);
});

test('WebRTC packet deltas support a packet-weighted loss aggregate', () => {
  const base = { type: 'inbound-rtp', kind: 'video', id: 'video', ssrc: 100, timestamp: 100, packetsReceived: 1, packetsLost: 0, bytesReceived: 0 };
  const a = { ...base, timestamp: 1100, packetsReceived: 2, packetsLost: 1, bytesReceived: 2000 };
  const b = { ...base, timestamp: 2100, packetsReceived: 100, packetsLost: 1, bytesReceived: 4000 };
  const samples = [[a, base], [b, a]].map(([now, previous]) => ({ ...readVideoMetrics(new Map([['video', now]]), previous).metrics, timestamp: now.timestamp }));
  assert.equal(samples[0].packetLoss, 50);
  assert.equal(samples[0].bitrate, 16);
  const metric = { key: 'packetLoss' };
  const series = measurementSeries(samples, metric);
  assert.equal(describeSeries(series, metric).avg, 1);
  assert.equal(movingAverage(series, true).at(-1).average, 1);
});

test('analysis uses actual 5-second windows and keeps player sessions separate', () => {
  const points = [
    { timestamp: 0, sessionId: 'a', value: 10 },
    { timestamp: 5000, sessionId: 'a', value: 20 },
    { timestamp: 5001, sessionId: 'a', value: 40 },
    { timestamp: 5002, sessionId: 'b', value: 5 },
  ];
  assert.deepEqual(movingAverage(points).map(({ average }) => average), [10, 15, 30, 5]);
  assert.deepEqual(describeSeries(points.slice(0, 2), {}), { avg: 15, min: 10, max: 20, p95: 20, std: 5, count: 2, total: null });
});

test('cumulative results use increments through reconnections and keep missing values null', () => {
  const samples = [
    { sessionId: 'a', timestamp: 1, startupSec: 1, bufferingCount: 0, bufferingSeconds: 0, playingSeconds: 3 },
    { sessionId: 'a', timestamp: 2, startupSec: 1, bufferingCount: 2, bufferingSeconds: 4, playingSeconds: 6 },
    { sessionId: 'b', timestamp: 3, startupSec: 3, bufferingCount: 1, bufferingSeconds: 1, playingSeconds: 9 },
  ];
  const metric = { key: 'bufferingCount', kind: 'cumulative' };
  const series = measurementSeries(samples, metric);
  assert.deepEqual(series.map(({ value }) => value), [0, 2, 1]);
  assert.equal(describeSeries(series, metric).total, 3);
  const { summary, validCounts } = summarizeSession({ samples: { vod: samples, live: [] } });
  assert.deepEqual(validCounts, { live: 0, vod: 3 });
  assert.equal(summary.vod.stallRatio.value, 25);
  assert.equal(summary.vod.startupSec.value, 1);
  assert.equal(summary.vod.throughputKbps.value, null);
  assert.equal(summary.live.packetLoss.value, null);
});

test('rolling graph window leaves the complete sample list intact', () => {
  const all = Array.from({ length: 100 }, (_, timestamp) => ({ timestamp }));
  const graph = all.reduce(recentSamples, []);
  assert.equal(graph.length, 72);
  assert.equal(graph[0].timestamp, 28);
  assert.equal(all.length, 100);
});

test('comparison prioritizes the normal preset, with a distinct comparison and manual override', () => {
  const newer = { id: 'loss', preset: 'loss' };
  const normal = { id: 'baseline', preset: 'normal' };
  const sessions = [newer, normal];
  assert.equal(compareSessions(sessions).base, normal);
  assert.equal(compareSessions(sessions).other, newer);
  assert.equal(compareSessions(sessions, 'loss', 'loss').other, normal);
  assert.equal(compareSessions([normal]).other, undefined);
});

test('ICE RTT is taken from the selected video pair in seconds and freezes are independent', () => {
  const video = { type: 'inbound-rtp', kind: 'video', transportId: 'transport', id: 'video', ssrc: 100 };
  const report = new Map([
    ['audio', { kind: 'audio', type: 'inbound-rtp', transportId: 'other' }],
    ['video', { ...video, freezeCount: 2, totalFreezesDuration: 1.25 }],
    ['transport', { selectedCandidatePairId: 'candidate' }],
    ['candidate', { type: 'candidate-pair', state: 'succeeded', currentRoundTripTime: 3.3422, responsesReceived: 8, totalRoundTripTime: 20 }],
    ['ignored', { type: 'candidate-pair', state: 'succeeded', currentRoundTripTime: 0.001 }],
  ]);
  const result = readVideoMetrics(report).metrics;
  assert.ok(Math.abs(result.rtt - 3342.2) < 1e-9);
  assert.equal(result.icePairId, 'candidate');
  assert.equal(result.iceResponses, 8);
  assert.equal(result.freezeCount, 2);
  assert.equal(result.freezeSeconds, 1.25);
  report.set('video', video);
  report.get('candidate').state = 'failed';
  const unsupported = readVideoMetrics(report).metrics;
  assert.equal(unsupported.rtt, null);
  assert.equal(unsupported.freezeCount, null);
  assert.equal(unsupported.freezeSeconds, null);
});

test('STUN response deltas ignore repeated polls and do not cross ICE pairs or sessions', () => {
  const first = { sessionId: 'a', icePairId: 'pair-a', iceResponses: 3, iceTotalRttSeconds: 1 };
  const samples = [first, first, { ...first, iceResponses: 5, iceTotalRttSeconds: 7 }, { ...first, icePairId: 'pair-b' },
    { ...first, icePairId: 'pair-b', iceResponses: 4, iceTotalRttSeconds: 5 }, { ...first, sessionId: 'b' }];
  assert.deepEqual(summarizeIceChecks(samples), { count: 3, meanMs: 10_000 / 3 });
  assert.deepEqual(summarizeIceChecks([{ rtt: 3342.2 }]), { count: 0, meanMs: null });
});

test('frame freeze totals handle stream replacement and do not change the waiting count', () => {
  const live = [2, 3, 1].map((freezeCount, timestamp) => ({
    timestamp, sessionId: 'a', videoStatsId: timestamp < 2 ? 'id-1' : 'id-2', freezeCount, bufferingCount: 0,
  }));
  const { summary } = summarizeSession({ samples: { live, vod: [] } });
  assert.equal(summary.live.freezeCount.value, 4);
  assert.equal(summary.live.bufferingCount.value, 0);
});

test('session CSV includes BOM, quoted names, provenance, units and missing values', () => {
  const samples = emptyTracks();
  samples.vod = [{ timestamp: 10, sessionId: 'vod-1', throughputKbps: 250, delivery: 'network', segmentRoute: 'proxy' }];
  const csv = sessionCsv({
    id: 'run-1', name: '=실험,"A"', startAt: 0, endAt: 20, appliedAt: 1, samples,
    conditions: { bandwidthKbps: 5000, delayMs: 300, lossPercent: 5 },
    result: { live: { ok: false }, vod: { ok: true, effectiveKbps: 480 } },
    sources: { live: '', vod: 'https://example.org/vod.m3u8' }, issues: { live: ['영상 소스 미설정'], vod: [] },
  });
  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.ok(csv.includes('"\'=실험,""A"""'));
  assert.match(csv, /"proxy","network".*"세그먼트 다운로드 처리량","kbps","250","측정"/);
  assert.match(csv, /"영상 RTP 패킷 손실률","%","","미측정"/);
  assert.match(csv, /"실패","성공","480"/);
  assert.ok(csv.includes('\r\n'));
});

test('browser persistence surfaces unavailable storage', async () => {
  await assert.rejects(listSessions(null), /IndexedDB/);
  await assert.rejects(storeSession({ id: 'session' }, null), /IndexedDB/);
});

test('storage renames and deletes one record without changing other records or samples', async () => {
  const records = new Map();
  const factory = {
    open() {
      const request = {};
      request.result = {
        close() {},
        createObjectStore() {},
        transaction() {
          const tx = {
            objectStore: () => ({
              getAll: () => ({ result: structuredClone([...records.values()]) }),
              get: (id) => {
                const request = { result: structuredClone(records.get(id)) };
                queueMicrotask(() => request.onsuccess());
                return request;
              },
              delete: (id) => { records.delete(id); return {}; },
              put: (value) => {
                records.set(value.id, structuredClone(value));
                return { result: value.id };
              },
            }),
          };
          queueMicrotask(() => queueMicrotask(() => tx.oncomplete()));
          return tx;
        },
      };
      queueMicrotask(() => {
        request.onupgradeneeded();
        request.onsuccess();
      });
      return request;
    },
  };
  const samples = { vod: Array.from({ length: 100 }, (_, timestamp) => ({ timestamp })), live: [] };
  await storeSession({ id: 'old', startAt: 1 }, factory);
  await storeSession({ id: 'new', startAt: 2, samples }, factory);
  await renameSession('new', ' updated ', factory);
  const loaded = await listSessions(factory);
  assert.deepEqual(loaded.map(({ id }) => id), ['new', 'old']);
  assert.equal(loaded[0].name, 'updated');
  assert.equal(loaded[0].samples.vod.length, 100);
  await assert.rejects(renameSession('new', ' ', factory), /1~100/);
  await assert.rejects(renameSession('missing', '이름', factory), /찾을 수 없습니다/);
  await deleteSession('new', factory);
  assert.deepEqual(await listSessions(factory), [{ id: 'old', startAt: 1 }]);
});
