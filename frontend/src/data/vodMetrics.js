export function readHlsSegment({ frag, part, networkDetails }, timingEntries = () => []) {
  if (frag.type !== 'main' || !Number.isFinite(frag.sn) || frag.bitrateTest) return null;

  const { loaded, loading, aborted } = (part ?? frag).stats ?? {};
  if (aborted) return null;

  // Request-to-completion goodput includes the time waiting for the response.
  const elapsed = loading?.end - loading?.start;
  const responseUrl = networkDetails?.responseURL || networkDetails?.url || null;
  const requestUrl = part?.url || frag.url || responseUrl;
  const entry = requestUrl && loading && timingEntries(requestUrl).findLast((item) =>
    ['xmlhttprequest', 'fetch'].includes(item.initiatorType) &&
    item.startTime >= loading.start && item.responseEnd <= loading.end &&
    item.responseEnd > item.startTime);
  let delivery = 'unverified';
  if (entry?.deliveryType === 'cache' || entry?.responseStatus === 304 ||
      (entry?.encodedBodySize > 0 && entry.transferSize < entry.encodedBodySize)) {
    delivery = 'cache';
  } else if (entry?.transferSize > 0 && entry.encodedBodySize > 0 && !entry.workerStart) {
    delivery = 'network';
  }
  const timed = Number.isFinite(loaded) && loaded > 0 && Number.isFinite(loading?.start) &&
    loading.start >= 0 && Number.isFinite(elapsed) && elapsed > 0;

  return {
    throughputKbps: timed && delivery === 'network' ? loaded * 8 / elapsed : null,
    delivery: !timed && delivery === 'network' ? 'unmeasured' : delivery,
    responseUrl,
  };
}
