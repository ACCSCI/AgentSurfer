// Structured logger — zero-dependency, works in both Service Worker and
// Side Panel. Output format: [AgentSurfer][ctx] msg {json}
//
// Playwright already captures SW console output to .e2e-logs/sw.log,
// so we just use console.* with structured formatting.

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORD: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const MAX_STRING_LEN = 200;

/** Truncate long string values to prevent log flooding (e.g. screenshots). */
function truncate(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return obj.length > MAX_STRING_LEN ? obj.slice(0, MAX_STRING_LEN) + '…' : obj;
  }
  if (Array.isArray(obj)) return obj.map(truncate);
  if (obj && typeof obj === 'object') {
    return Object.fromEntries(
      Object.entries(obj as Record<string, unknown>).map(([k, v]) => [k, truncate(v)]),
    );
  }
  return obj;
}

function format(ctx: string, msg: string, data?: Record<string, unknown>): string {
  const prefix = `[AgentSurfer][${ctx}] ${msg}`;
  if (!data || Object.keys(data).length === 0) return prefix;
  try {
    return `${prefix} ${JSON.stringify(truncate(data))}`;
  } catch {
    return `${prefix} [unserializable]`;
  }
}

export class Logger {
  /** Log at debug level. Use for high-frequency, low-value detail. */
  debug(ctx: string, msg: string, data?: Record<string, unknown>): void {
    console.log(format(ctx, msg, data));
  }

  /** Log at info level. Use for lifecycle events and normal operations. */
  info(ctx: string, msg: string, data?: Record<string, unknown>): void {
    console.log(format(ctx, msg, data));
  }

  /** Log at warn level. Use for known bugs, degraded behavior, conflicts. */
  warn(ctx: string, msg: string, data?: Record<string, unknown>): void {
    console.warn(format(ctx, msg, data));
  }

  /** Log at error level. Use for failures that need attention. */
  error(ctx: string, msg: string, data?: Record<string, unknown>): void {
    console.error(format(ctx, msg, data));
  }

  /**
   * Create a scoped logger that auto-injects `runId` and tracks elapsed time.
   * Use this inside an agent run so every log entry is correlated.
   */
  scope(runId: string): ScopedLogger {
    return new ScopedLogger(runId);
  }
}

export class ScopedLogger {
  private readonly runId: string;
  private readonly start: number;

  constructor(runId: string) {
    this.runId = runId;
    this.start = Date.now();
  }

  /** Milliseconds since this scope was created. */
  elapsed(): number {
    return Date.now() - this.start;
  }

  debug(msg: string, data?: Record<string, unknown>): void {
    log.debug('agent', msg, { ...data, runId: this.runId, elapsed: this.elapsed() });
  }

  info(msg: string, data?: Record<string, unknown>): void {
    log.info('agent', msg, { ...data, runId: this.runId, elapsed: this.elapsed() });
  }

  warn(msg: string, data?: Record<string, unknown>): void {
    log.warn('agent', msg, { ...data, runId: this.runId, elapsed: this.elapsed() });
  }

  error(msg: string, data?: Record<string, unknown>): void {
    log.error('agent', msg, { ...data, runId: this.runId, elapsed: this.elapsed() });
  }

  /**
   * Time an async operation. Logs entry, then exit with duration.
   * If the function throws, logs at error level and re-throws.
   */
  async timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
    this.debug(`${label} start`);
    const t0 = Date.now();
    try {
      const result = await fn();
      this.info(`${label} done`, { durationMs: Date.now() - t0 });
      return result;
    } catch (err) {
      this.error(`${label} failed`, {
        durationMs: Date.now() - t0,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }
}

/** Singleton logger — import and use directly. */
export const log = new Logger();
