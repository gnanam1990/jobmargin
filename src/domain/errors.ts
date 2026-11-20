/** Domain/API error carrying an HTTP status and a stable decision code. */
export class JmError extends Error {
  status: number;
  code: string;
  detail: Record<string, unknown>;
  constructor(status: number, code: string, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export const unauthorized = (msg = 'authentication required') =>
  new JmError(401, 'UNAUTHORIZED', msg);
export const forbidden = (msg = 'action not permitted for this role') =>
  new JmError(403, 'FORBIDDEN', msg);
export const notFound = (msg = 'resource not found') =>
  new JmError(404, 'NOT_FOUND', msg);
export const conflict = (code: string, msg: string, detail: Record<string, unknown> = {}) =>
  new JmError(409, code, msg, detail);
export const unprocessable = (code: string, msg: string, detail: Record<string, unknown> = {}) =>
  new JmError(422, code, msg, detail);
export const badRequest = (code: string, msg: string, detail: Record<string, unknown> = {}) =>
  new JmError(400, code, msg, detail);
