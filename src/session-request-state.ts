/** Values keyed by both a live session object and a process-local request id. */
export class SessionRequestState<S extends object, V> {
  private readonly bySession = new WeakMap<S, Map<string, V>>();

  set(session: S, requestId: number | string, value: V): V | undefined {
    let requests = this.bySession.get(session);
    if (!requests) {
      requests = new Map();
      this.bySession.set(session, requests);
    }
    const key = String(requestId);
    const previous = requests.get(key);
    requests.set(key, value);
    return previous;
  }

  take(session: S, requestId: number | string): V | undefined {
    const requests = this.bySession.get(session);
    if (!requests) return undefined;
    const key = String(requestId);
    const value = requests.get(key);
    requests.delete(key);
    if (requests.size === 0) this.bySession.delete(session);
    return value;
  }
}
