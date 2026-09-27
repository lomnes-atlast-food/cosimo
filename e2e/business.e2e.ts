import { expect, type Page, test } from "@playwright/test";
import { signIn } from "./auth.ts";

function orgBase(page: Page) {
  const m = /\/o\/([A-Z0-9]+)/.exec(page.url());
  return `/o/${m![1]}`;
}

test("fill in the business profile and add a bookkeeping note", async ({ page }) => {
  await signIn(page);
  const base = orgBase(page);

  await page.goto(`${base}/settings`);
  await page.getByRole("tab", { name: "Business profile" }).click();
  await expect(page.getByText(/AI assistants read this profile/)).toBeVisible();

  const description = "Software consulting for small law firms.";
  await page.getByLabel("What the business does").fill(description);
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(page.getByText("Business profile saved.")).toBeVisible();

  await page.reload();
  await page.getByRole("tab", { name: "Business profile" }).click();
  await expect(page.getByLabel("What the business does")).toHaveValue(description);

  const note = `Payments from Acme are retainer billing, account 4010 (run ${Date.now().toString(36)})`;
  await page.getByLabel("Add a note").fill(note);
  await page.getByRole("button", { name: "Add note" }).click();
  await expect(page.getByTestId("note").filter({ hasText: note })).toBeVisible();
  await expect(page.getByLabel("Add a note")).toHaveValue("");
});
