import { unknownCommand } from './errors.ts';

export type RouteContext = {
  params: Record<string, string>;
  /** Parsed JSON request body, `undefined` when the request had none. */
  body: unknown;
};

/** The answer of a handler whose response is not W3C-wrapped. */
export type Reply = { reply: { status: number; json: unknown } };
/** A handler resolves to the WebDriver `value`, or to a `Reply`. Only `isReply` tells them apart. */
export type Handler = (context: RouteContext) => Promise<unknown>;

export type Route = {
  method: string;
  /** A path with `:name` segments, such as `/session/:sessionId/source`. */
  path: string;
  handler: Handler;
};

type CompiledRoute = Route & { pattern: RegExp; names: string[] };

export const isReply = (result: unknown): result is Reply =>
  typeof result === 'object' && result !== null && 'reply' in result;

function compile(route: Route): CompiledRoute {
  const names: string[] = [];
  const source = route.path
    .split('/')
    .map((segment) => {
      if (!segment.startsWith(':')) return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      names.push(segment.slice(1));
      return '([^/]+)';
    })
    .join('/');
  return { ...route, pattern: new RegExp(`^${source}$`), names };
}

export type Router = {
  match(method: string, pathname: string): { route: Route; params: Record<string, string> };
};

/**
 * One matcher over a route table. An unknown path or method is the W3C `unknown command`
 * error, which clients read as "this driver does not implement that route".
 */
export function createRouter(routes: readonly Route[]): Router {
  const compiled = routes.map(compile);
  return {
    match(method, pathname) {
      for (const route of compiled) {
        if (route.method !== method) continue;
        const found = route.pattern.exec(pathname);
        if (!found) continue;
        const params = Object.fromEntries(
          route.names.map((name, index) => [name, decodeURIComponent(found[index + 1] ?? '')]),
        );
        return { route, params };
      }
      throw unknownCommand(`Unknown command: ${method} ${pathname}`);
    },
  };
}
