import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { signIn } from "./auth.ts";

const FIX = join(import.meta.dirname, "../packages/core/src/importers/fixtures");

test.describe.configure({ mode: "serial" });

test("admin status: back up now", async ({ page }) => {
  await signIn(page);
  await page.goto("/admin");
  await page.getByRole("tab", { name: "Status" }).click();
  await expect(page.getByText("Version")).toBeVisible();
  await page.getByRole("button", { name: "Back up now" }).click();
  await expect(page.getByText(/Backup written: cosimo-backup-/)).toBeVisible();
  await expect(page.getByText(/Last backup/)).toBeVisible();
});

test("import from Xero into a new org: preview, then import", async ({ page }) => {
  await signIn(page);
  await page.goto("/orgs");
  await page.getByLabel("Business name").fill("Xero Import Co");
  await page.getByRole("button", { name: "Create organization" }).click();
  await expect(page).toHaveURL(/\/o\/[A-Z0-9]+/);

  const base = /\/o\/[A-Z0-9]+/.exec(page.url())![0];
  await page.goto(`${base}/settings`);
  await page.getByRole("tab", { name: "Import & export" }).click();
  await page
    .getByLabel("CSV files")
    .setInputFiles(["xero-accounts.csv", "xero-contacts.csv", "xero-journal.csv"].map((f) => join(FIX, f)));
  await page.getByRole("button", { name: "Preview" }).click();
  const report = page.getByTestId("import-report");
  await expect(report.getByText("Xero", { exact: true })).toBeVisible();
  await expect(report.getByText(/Entries: 8 new/)).toBeVisible();
  await page.getByRole("button", { name: "Import 8 entries" }).click();
  await expect(page.getByText(/The 8 entries wait in/)).toBeVisible();
  await page.getByRole("link", { name: "Review", exact: true }).click();
  await expect(page.getByText(/8 entries dated/)).toBeVisible();
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByText(/8 entries dated/)).toBeHidden();

  await page.goto(`${base}/settings`);

  await page.getByRole("tab", { name: "Integrity" }).click();
  await page.getByRole("button", { name: "Verify now" }).click();
  await expect(page.getByText(/Both chains verified/)).toBeVisible();
});
