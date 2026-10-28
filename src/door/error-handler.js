import { logRefused } from './refused.js';

/**
 * Central error handler. Express recognises it by its four parameters.
 * Express 5 forwards rejected promises from async handlers here automatically.
 *
 * A copy of anossoftware's src/middleware/error-handler.js, with one mapping
 * added: the error Express's raw body parser raises when a body is over the
 * route's cap (type entity.too.large) is answered 413
 * { "error": "request body too large" } and logged as a refusal line, like
 * a refusal from a check, not as a stack trace. Every other error keeps the
 * copied behaviour.
 */
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  if (err.type === 'entity.too.large') {
    const reason = 'request body too large';
    logRefused(req, 413, reason);
    res.status(413).json({ error: reason });
    return;
  }
  console.error(err);
  const status = err.status ?? 500;
  res.status(status).json({
    error: status === 500 ? 'Internal Server Error' : err.message,
  });
}
