export function readHlsSegment({ frag, part, networkDetails }) {
  if (frag.type !== 'main' || !Number.isFinite(frag.sn) || frag.bitrateTest) return null;

  const { loaded, loading, aborted } = (part ?? frag).stats ?? {};
  if (aborted) return null;

  // Request-to-completion goodput includes the time waiting for the response.
  const elapsed = loading?.end - loading?.start;
  const throughputKbps = Number.isFinite(loaded) && loaded > 0 &&
    Number.isFinite(loading?.start) && loading.start > 0 && Number.isFinite(elapsed) && elapsed > 0
    ? loaded * 8 / elapsed
    : null;

  return {
    throughputKbps,
    responseUrl: networkDetails?.responseURL || networkDetails?.url || null,
  };
}
