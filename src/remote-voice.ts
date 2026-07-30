/** Strict raw PCM envelope validation; returns null instead of accepting
 * Buffer's permissive/truncating base64 decoder. */
export function decodePcmBase64(data: string, maxBytes: number): Buffer | null {
  if (
    !data ||
    data.length > Math.ceil(maxBytes / 3) * 4 ||
    data.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(data)
  ) return null;
  const bytes = Buffer.from(data, "base64");
  if (!bytes.length || bytes.byteLength % 2 !== 0 || bytes.byteLength > maxBytes) return null;
  return bytes.toString("base64") === data ? bytes : null;
}

export type RemotePcmAccept =
  | { kind: "write"; bytes: Buffer }
  | { kind: "buffered" }
  | { kind: "invalid" }
  | { kind: "limit" }
  | { kind: "unowned" };

type ScheduleTimeout = (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
type CancelTimeout = (timer: ReturnType<typeof setTimeout>) => void;

/**
 * Per-client PCM ingress accounting. It owns the host-side lifetime timer,
 * validates every chunk, enforces the cumulative cap, and holds audio while a
 * hands-free stream reconnects.
 */
export class RemotePcmIngress {
  private phase: "connecting" | "listening" | "restarting" | "closed" = "connecting";
  private readonly pending: Buffer[] = [];
  private totalBytes = 0;
  private readonly timer: ReturnType<typeof setTimeout>;

  constructor(
    private readonly maxChunkBytes: number,
    private readonly maxBytes: number,
    timeoutMs: number,
    onTimeout: () => void,
    schedule: ScheduleTimeout = setTimeout,
    private readonly cancelTimeout: CancelTimeout = clearTimeout,
  ) {
    this.timer = schedule(onTimeout, timeoutMs);
  }

  accept(data: string): RemotePcmAccept {
    if (this.phase === "closed") return { kind: "unowned" };
    const bytes = decodePcmBase64(data, this.maxChunkBytes);
    if (!bytes) return { kind: "invalid" };
    this.totalBytes += bytes.byteLength;
    if (this.totalBytes > this.maxBytes) return { kind: "limit" };
    if (this.phase !== "listening") {
      this.pending.push(bytes);
      return { kind: "buffered" };
    }
    return { kind: "write", bytes };
  }

  restarting(): boolean {
    if (this.phase !== "listening") return false;
    this.phase = "restarting";
    return true;
  }

  ready(): Buffer[] {
    if (this.phase === "closed") return [];
    this.phase = "listening";
    return this.pending.splice(0);
  }

  close(): void {
    if (this.phase === "closed") return;
    this.phase = "closed";
    this.pending.length = 0;
    this.cancelTimeout(this.timer);
  }

  get bytes(): number {
    return this.totalBytes;
  }
}

export function acceptRemotePcm(ingress: RemotePcmIngress | undefined, data: string): RemotePcmAccept {
  return ingress ? ingress.accept(data) : { kind: "unowned" };
}
