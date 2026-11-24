import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { WebDriverError, invalidArgument, unknownError } from './errors.ts';
import { createRouter, isReply } from './router.ts';
import type { Route } from './router.ts';
import { requireActiveSession, webDriverRoutes } from './routes.ts';
import type { SessionStore } from './routes.ts';
import type { Backend } from './types.ts';

export type ServerOptions = {
  backend: Backend;
  /** Routes beside the WebDriver ones, such as a fake backend's debug endpoints. */
  extraRoutes?: readonly Route[];
  /** Receives one line per request. Defaults to stderr. */
  log?: (line: string) => void;
};

const BODY_LOG_LIMIT = 160;

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw invalidArgument('Request body is not valid JSON.');
  }
}

function send(response: ServerResponse, status: number, json: unknown): void {
  const payload = JSON.stringify(json);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

function errorReply(error: unknown): { status: number; json: unknown } {
  const failure = error instanceof WebDriverError ? error : unknownError(String(error));
  return {
    status: failure.status,
    json: { value: { error: failure.error, message: failure.message, stacktrace: '' } },
  };
}

function bodySummary(body: unknown): string {
  if (body === undefined) return '';
  const text = JSON.stringify(body);
  return ` ${text.length > BODY_LOG_LIMIT ? `${text.slice(0, BODY_LOG_LIMIT)}...` : text}`;
}

export function createServer(options: ServerOptions): Server {
  const sessions: SessionStore = { current: undefined };
  const router = createRouter([...webDriverRoutes(options.backend, sessions), ...(options.extraRoutes ?? [])]);
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));

  return createHttpServer(async (request, response) => {
    const started = Date.now();
    const method = request.method ?? 'GET';
    const { pathname } = new URL(request.url ?? '/', 'http://localhost');
    let body: unknown;
    let reply: { status: number; json: unknown };
    try {
      body = await readJson(request);
      const { route, params } = router.match(method, pathname);
      if (params.sessionId !== undefined) requireActiveSession(sessions, params.sessionId);
      const result = await route.handler({ params, body });
      reply = isReply(result) ? result.reply : { status: 200, json: { value: result ?? null } };
    } catch (error) {
      reply = errorReply(error);
    }
    send(response, reply.status, reply.json);
    log(`${method} ${pathname} -> ${reply.status} ${Date.now() - started}ms${bodySummary(body)}`);
  });
}
