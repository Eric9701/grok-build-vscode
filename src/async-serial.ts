/**
 * Promise tail that runs async work one-at-a-time.
 *
 * Used wherever two concurrent callers must not interleave after an await
 * (local project switch, remote session transitions). Callers capture their
 * target id *inside* the action so a later queued run cannot mutate shared
 * state mid-flight.
 */
export class AsyncSerialQueue {
  private tail: Promise<void> = Promise.resolve();

  run<R>(action: () => Promise<R>): Promise<R> {
    const run = this.tail.catch(() => undefined).then(action);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
