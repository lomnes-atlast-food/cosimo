import { OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "./types.ts";

export { z };

export const ErrorSchema = z
  .object({
    error: z.object({
      code: z.string(),
      message: z.string(),
      details: z.record(z.string(), z.unknown()).optional(),
    }),
  })
  .openapi("Error");

const err = (description: string) => ({
  content: { "application/json": { schema: ErrorSchema } },
  description,
});

export const errorResponses = {
  400: err("Invalid request"),
  401: err("Not authenticated"),
  403: err("Forbidden"),
  404: err("Not found"),
  409: err("Conflict"),
  422: err("Rule or invariant violation"),
  429: err("Rate limited"),
} as const;

export const json = <T extends z.ZodType>(schema: T, description = "OK") => ({
  content: { "application/json": { schema } },
  description,
});

export const jsonBody = <T extends z.ZodType>(schema: T) => ({
  content: { "application/json": { schema } },
  required: true,
});

export const Id = z.string().min(1).max(64).openapi({ example: "01J9Z3K5Q7W8X9Y0A1B2C3D4E5" });
export const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD")
  .openapi({ example: "2026-01-31", format: "date" });
export const Cents = z
  .number()
  .int("Money must be integer cents")
  .refine((n) => Number.isSafeInteger(n), "Out of range")
  .openapi({ description: "Integer minor units (cents)", example: 12345 });
export const Currency = z.string().length(3).openapi({ example: "USD" });
export const RoleSchema = z.enum(["owner", "bookkeeper", "accountant", "viewer"]).openapi("Role");
export const Timestamp = z.string().openapi({ format: "date-time" });

export const OrgParams = z.object({
  orgId: Id.openapi({ param: { name: "orgId", in: "path" } }),
});

export const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100).optional(),
  cursor: z.string().optional(),
});

export const page = <T extends z.ZodType>(item: T) =>
  z.object({ data: z.array(item), next_cursor: z.string().nullable() });

export const OkSchema = z.object({ ok: z.literal(true) }).openapi("Ok");

/** Cursor pagination over ULID-ordered rows: cursor is the last id seen. */
export function paginate<T extends { id: string }>(rows: T[], limit = 100) {
  const data = rows.slice(0, limit);
  return { data, next_cursor: rows.length > limit ? (data[data.length - 1]?.id ?? null) : null };
}

export function newRouter() {
  return new OpenAPIHono<AppEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json(
          {
            error: {
              code: "validation_error",
              message: result.error.issues
                .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
                .join("; "),
              details: { issues: result.error.issues },
            },
          },
          400,
        );
      }
    },
  });
}

export const bearerSecurity: Record<string, string[]>[] = [{ bearerAuth: [] }, { cookieAuth: [] }];
