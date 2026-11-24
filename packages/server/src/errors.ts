/**
 * A W3C WebDriver error. `error` is the spec's error code and the HTTP status follows the
 * spec's table, so clients can tell "this route does not exist" from "this request is bad".
 */
export class WebDriverError extends Error {
  readonly error: string;
  readonly status: number;

  constructor(error: string, status: number, message: string) {
    super(message);
    this.name = 'WebDriverError';
    this.error = error;
    this.status = status;
  }
}

export const unknownCommand = (message: string) => new WebDriverError('unknown command', 404, message);
export const invalidArgument = (message: string) => new WebDriverError('invalid argument', 400, message);
export const invalidSessionId = (id: string) =>
  new WebDriverError('invalid session id', 404, `No active session with id ${id}`);
export const noSuchElement = (message: string) => new WebDriverError('no such element', 404, message);
export const sessionNotCreated = (message: string) => new WebDriverError('session not created', 500, message);
export const unsupportedOperation = (message: string) => new WebDriverError('unsupported operation', 500, message);
export const unknownError = (message: string) => new WebDriverError('unknown error', 500, message);
