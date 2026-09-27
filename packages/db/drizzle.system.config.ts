import { defineConfig } from "drizzle-kit";
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/system/schema.ts",
  out: "./src/system/drizzle",
});
