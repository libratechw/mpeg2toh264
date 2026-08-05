/**
 * Turning what a caller asked for into bytes, inside the worker.
 *
 * Everything the player can be pointed at funnels through here, so adding a
 * kind of input -- a caller's own `ReadableStream`, say, which transfers into
 * the worker as it is -- is a case in this file and a field in the load
 * command, and nothing else has to know.
 *
 * The other thing that lives here is the byte range: a file whose end can be
 * asked for separately is a file that can be seeked in, and both halves of
 * that -- reading the tail to find the length, and opening the stream partway
 * through -- are HTTP requests with a `Range` header on them.
 */

export interface Source {
  stream: ReadableStream<Uint8Array>;
  /** The size of the whole input, when the server said what it was. */
  totalBytes: number | null;
  /** Where in the input this stream begins. */
  offset: number;
}

/** The end of a file, when the server was willing to serve just the end. */
export interface Tail {
  data: Uint8Array;
  /** The size of the whole input, which the range response states outright. */
  totalBytes: number;
}

/** One byte range as it came back, whatever was asked for. */
interface Range {
  data: Uint8Array;
  start: number;
  totalBytes: number;
}

export async function openSource(
  url: string,
  signal: AbortSignal,
  offset = 0,
): Promise<Source> {
  const headers = offset > 0 ? { Range: `bytes=${offset}-` } : undefined;
  let response: Response;
  try {
    response = await fetch(url, { signal, headers });
  } catch (error) {
    if (signal.aborted) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `could not fetch the input: ${reason} (check the origin's CORS headers)`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `could not fetch the input: HTTP ${response.status} ${response.statusText}`,
    );
  }
  if (!response.body)
    throw new Error("the response cannot be read as a stream");
  const range = contentRange(response);
  if (offset > 0 && (response.status !== 206 || range?.start !== offset)) {
    // Seeking was offered on the strength of an earlier range request, so
    // anything but the bytes asked for is the server changing its mind.
    // Playing what came instead would play the wrong part of the file.
    await response.body.cancel();
    throw new Error(
      `the server would not serve the byte range asked for (HTTP ${response.status})`,
    );
  }
  const length = Number(response.headers.get("content-length"));
  const totalBytes =
    range?.totalBytes ??
    (Number.isFinite(length) && length > 0 ? length : null);
  return { stream: response.body, totalBytes, offset };
}

/**
 * Read the last `length` bytes of the input, or nothing when they cannot be
 * had on their own.
 *
 * Anything short of a range response -- a server that ignores the header, one
 * that refuses, a URL that cannot be fetched twice -- is a `null` rather than
 * a failure: it only means this input is one to play as it arrives.
 */
export async function readTail(
  url: string,
  length: number,
  signal: AbortSignal,
): Promise<Tail | null> {
  const suffix = await readRange(url, `bytes=-${length}`, signal);
  if (!suffix) return null;
  if (endsTheFile(suffix)) return suffix;
  // The suffix form is the one servers get wrong -- Vite's own dev server
  // answers it with the beginning of the file -- and what came back says how
  // long the file is, which is all it takes to ask again by position.
  const start = Math.max(0, suffix.totalBytes - length);
  const absolute = await readRange(
    url,
    `bytes=${start}-${suffix.totalBytes - 1}`,
    signal,
  );
  if (!absolute || !endsTheFile(absolute)) return null;
  return absolute;
}

/**
 * Read `length` bytes from `start`, or nothing when the server will not.
 *
 * This is what a seek reads to find out what time it is at a byte, so it is
 * deliberately small: the answer is in the first PES header it contains.
 */
export async function readSlice(
  url: string,
  start: number,
  length: number,
  signal: AbortSignal,
): Promise<Uint8Array | null> {
  const range = await readRange(
    url,
    `bytes=${start}-${start + length - 1}`,
    signal,
  );
  // A server that answered with some other part of the file would have the
  // seek aiming at a timestamp that is not there.
  return range && range.start === start ? range.data : null;
}

/** Whether what came back really is the end of the file. */
function endsTheFile(range: Range): boolean {
  return range.start + range.data.byteLength === range.totalBytes;
}

/**
 * One byte range, or nothing when the server would not serve one.
 *
 * Anything short of a range response -- a server that ignores the header, one
 * that refuses, a URL that cannot be fetched twice -- is a `null` rather than
 * a failure: it only means this input is one to play as it arrives.
 */
async function readRange(
  url: string,
  range: string,
  signal: AbortSignal,
): Promise<Range | null> {
  let response: Response;
  try {
    response = await fetch(url, { signal, headers: { Range: range } });
  } catch {
    return null;
  }
  const served = contentRange(response);
  if (response.status !== 206 || !served) {
    // A 200 carries the whole file, which is exactly what must not be read
    // twice.
    await response.body?.cancel();
    return null;
  }
  try {
    return { data: new Uint8Array(await response.arrayBuffer()), ...served };
  } catch {
    return null;
  }
}

/** Where a `Content-Range: bytes start-end/total` says its bytes came from. */
function contentRange(
  response: Response,
): { start: number; totalBytes: number } | null {
  const parts = response.headers
    .get("content-range")
    ?.match(/bytes\s+(\d+)-\d+\/(\d+)/);
  if (!parts) return null;
  const start = Number(parts[1]);
  const totalBytes = Number(parts[2]);
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(totalBytes) ||
    totalBytes <= 0
  )
    return null;
  return { start, totalBytes };
}
