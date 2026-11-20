// zod validation for body / params / query. Parsed values go to req.valid / req.validParams / req.validQuery.
import { ApiError } from '../utils/errors.js';

function toError(zodError) {
  return new ApiError(
    422,
    'VALIDATION_ERROR',
    'Some fields are invalid',
    zodError.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  );
}

export const validateBody = (schema) => (req, _res, next) => {
  const r = schema.safeParse(req.body ?? {});
  if (!r.success) return next(toError(r.error));
  req.valid = r.data;
  next();
};

export const validateQuery = (schema) => (req, _res, next) => {
  const r = schema.safeParse(req.query ?? {});
  if (!r.success) return next(toError(r.error));
  req.validQuery = r.data;
  next();
};
