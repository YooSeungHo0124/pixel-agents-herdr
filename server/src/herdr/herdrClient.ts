import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

/**
 * Minimal client for herdr's local socket API: one newline-delimited JSON
 * request per connection (`{id, method, params}` → `{id, result}` or
 * `{id, error}`). herdr closes a plain request connection right after it
 * replies, so every call opens its own connection.
 */

export type HerdrRequest = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

export class HerdrRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HerdrRequestError';
  }
}

/** The herdr socket to talk to: $HERDR_SOCKET_PATH, else herdr's default location when it exists. */
export function resolveHerdrSocketPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const fromEnv = env.HERDR_SOCKET_PATH?.trim();
  if (fromEnv) return fromEnv;
  const configHome = env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), '.config');
  const fallback = path.join(configHome, 'herdr', 'herdr.sock');
  return fs.existsSync(fallback) ? fallback : undefined;
}

let nextRequestId = 1;

export function createHerdrRequest(socketPath: string, timeoutMs: number): HerdrRequest {
  return (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = `pixel-agents-${nextRequestId++}`;
      const socket = net.createConnection(socketPath);
      let buffer = '';
      let settled = false;
      const finish = (err: Error | null, value?: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (err) reject(err);
        else resolve(value);
      };
      const timer = setTimeout(
        () => finish(new HerdrRequestError('timeout', `herdr ${method} timed out`)),
        timeoutMs,
      );
      socket.setEncoding('utf-8');
      socket.on('connect', () => socket.write(JSON.stringify({ id, method, params }) + '\n'));
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          let msg: { id?: string; result?: unknown; error?: { code?: string; message?: string } };
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          if (msg.id !== id) continue;
          if (msg.error) {
            finish(
              new HerdrRequestError(
                msg.error.code ?? 'error',
                msg.error.message ?? `herdr ${method} failed`,
              ),
            );
          } else {
            finish(null, msg.result);
          }
          return;
        }
      });
      socket.on('error', (err) => finish(err));
      socket.on('close', () =>
        finish(new HerdrRequestError('closed', `herdr closed the connection during ${method}`)),
      );
    });
}
