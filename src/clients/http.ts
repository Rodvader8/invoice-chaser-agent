export class UpstreamError extends Error {}

/** GET a JSON document with a timeout. Throws UpstreamError on anything but a 200. */
export async function getJson(url: string, timeoutMs = 5000): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (res.status !== 200) throw new UpstreamError(`GET ${new URL(url).pathname} -> ${res.status}`);
  return res.json();
}
