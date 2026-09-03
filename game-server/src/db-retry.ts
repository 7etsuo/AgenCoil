export interface RetryDbOptions {
  attempts?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Retry transient database failures without discarding pending player state. */
export async function retryDb<T>(
  operation: () => Promise<T>,
  options: RetryDbOptions = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 4);
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? 250);
  const sleep = options.sleep ?? defaultSleep;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await sleep(baseDelayMs * 2 ** attempt);
    }
  }

  throw lastError;
}
