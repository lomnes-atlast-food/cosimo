import { expect, type Page, test } from "@playwright/test";
import { signIn } from "./auth.ts";

function orgBase(page: Page) {
  const m = /\/o\/([A-Z0-9]+)/.exec(page.url());
  return `/o/${m![1]}`;
}

// Terms and the due date stay in step (#66): a terms rule sets the due date, and a hand-set due
// date switches the terms to the matching preset or "On due date".
test("invoice terms and due date follow each other", async ({ page }) => {
  await signIn(page);
  await page.goto(`${orgBase(page)}/sales/invoices/new`);
  const terms = page.getByLabel("Terms");
  const due = page.getByLabel("Due date");

  await page.getByLabel("Date", { exact: true }).fill("2026-03-01");
  await expect(terms).toHaveValue("Net 30");
  await expect(due).toHaveValue("2026-03-31");

  await terms.selectOption("Net 15");
  await expect(due).toHaveValue("2026-03-16");

  await due.fill("2026-03-20");
  await expect(terms).toHaveValue("On due date");

  // "On due date" keeps the date when the invoice date moves.
  await page.getByLabel("Date", { exact: true }).fill("2026-03-05");
  await expect(due).toHaveValue("2026-03-20");

  // A hand-set date that fits a preset picks it.
  await due.fill("2026-04-04");
  await expect(terms).toHaveValue("Net 30");

  await terms.selectOption("Due end of month");
  await expect(due).toHaveValue("2026-03-31");

  await page.getByRole("combobox", { name: "Customer" }).fill("Terms Test Co");
  await page.getByRole("option", { name: '+ New customer "Terms Test Co"' }).click();
  await page.getByLabel("Line 1 description").fill("Consulting");
  await page.getByLabel("Line 1 rate").fill("100");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText("due Mar 31, 2026")).toBeVisible();
});
