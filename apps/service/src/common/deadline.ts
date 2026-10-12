/** Settle with `work`, or reject with `timeoutError()` once `ms` pass; `work` keeps running and its rejection stays handled. */
export async function withDeadline<T>(work: Promise<T>, ms: number, timeoutError: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(timeoutError()), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
