/**
 * Turning what a caller asked for into bytes, inside the worker.
 *
 * Everything the player can be pointed at funnels through here, so adding a
 * kind of input -- a caller's own `ReadableStream`, say, which transfers into
 * the worker as it is -- is a case in this file and a field in the load
 * command, and nothing else has to know.
 */

export interface Source {
  stream: ReadableStream<Uint8Array>;
  /** The size of the input, when the server said what it was. */
  totalBytes: number | null;
}

export async function openSource(
  url: string,
  signal: AbortSignal,
): Promise<Source> {
  let response: Response;
  try {
    response = await fetch(url, { signal });
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
  const length = Number(response.headers.get("content-length"));
  return {
    stream: response.body,
    totalBytes: Number.isFinite(length) && length > 0 ? length : null,
  };
}
