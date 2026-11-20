import { z } from 'zod';

/** Standard success envelope */
export const ok = (res, data, meta, status = 200) => res.status(status).json(meta ? { data, meta } : { data });
export const created = (res, data) => ok(res, data, undefined, 201);

/** Pagination query schema shared by list endpoints */
export const pageQuery = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
};
export const paging = (q) => ({ limit: q.pageSize, offset: (q.page - 1) * q.pageSize });
export const pageMeta = (q, total) => ({ page: q.page, pageSize: q.pageSize, total: Number(total) });

// ---- reusable field validators ----
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine((s) => !Number.isNaN(Date.parse(s)), 'Invalid date');
export const text = (max, min = 1) => z.string().trim().min(min, 'Required').max(max);
export const optText = (max) => z.string().trim().max(max).optional().nullable().transform((v) => (v ? v : null));
/** decimal given as number or string -> fixed string with `scale` decimals */
export const decimal = (min, max, scale = 2) =>
  z.union([z.number(), z.string().trim().regex(/^-?\d+(\.\d+)?$/, 'Must be a number')])
    .transform((v) => Number(v))
    .refine((n) => Number.isFinite(n) && n >= min && n <= max, `Must be between ${min} and ${max}`)
    .transform((n) => n.toFixed(scale));
export const optDecimal = (min, max, scale = 2) =>
  z.union([decimal(min, max, scale), z.null(), z.literal('').transform(() => null)]).optional().transform((v) => v ?? null);
export const intRange = (min, max) => z.coerce.number().int().min(min).max(max);
export const code = z.string().trim().min(3).max(30).transform((s) => s.toUpperCase());
