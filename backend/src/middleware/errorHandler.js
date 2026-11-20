import { ApiError, fromPgError } from '../utils/errors.js';
import { isTest } from '../config/env.js';

export function notFoundHandler(req, _res, next) {
  next(new ApiError(404, 'NOT_FOUND', `No route ${req.method} ${req.originalUrl}`));
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  let e = err instanceof ApiError ? err : fromPgError(err);
  if (!e && err?.type === 'entity.parse.failed') e = new ApiError(400, 'BAD_JSON', 'Malformed JSON body');
  if (!e && err?.code === 'LIMIT_FILE_SIZE') e = new ApiError(413, 'FILE_TOO_LARGE', 'Uploaded file is too large');
  if (!e) {
    if (!isTest) console.error('[error]', err);
    e = new ApiError(500, 'INTERNAL_ERROR', 'Something went wrong on the server');
  }
  res.status(e.status).json({ error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) } });
}
