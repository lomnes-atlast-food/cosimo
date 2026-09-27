import type { DbHandle, OrgSchema, SystemSchema } from "@cosimo/db";

export type SystemHandle = DbHandle<SystemSchema>;
export type OrgHandle = DbHandle<OrgSchema>;
