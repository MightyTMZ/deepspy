/** Stop waiting now; dispose any resource that arrives after cancellation. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal, dispose?: (value: T) => Promise<void>): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("Cancelled"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    promise.then(async (value) => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) { await dispose?.(value); return; }
      resolve(value);
    }, (error) => { signal.removeEventListener("abort", abort); reject(error); }).catch(reject);
  });
}
