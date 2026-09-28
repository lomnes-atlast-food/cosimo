import { expect, type Page, test } from "@playwright/test";
import { signIn } from "./auth.ts";
import { pick } from "./pick.ts";

function orgBase(page: Page) {
  const m = /\/o\/([A-Z0-9]+)/.exec(page.url());
  return `/o/${m![1]}`;
}

test.describe.configure({ mode: "serial" });

test("a recurring bill: monthly on the last day, pause, resume, skip and run now", async ({ page }) => {
  await signIn(page);
  const base = orgBase(page);

  await page.goto(`${base}/expenses/bills`);
  await page.getByRole("tab", { name: "Recurring" }).click();
  await expect(page).toHaveURL(/\/expenses\/bills\/recurring$/);
  await page.getByRole("button", { name: "New recurring bill" }).click();
  await expect(page).toHaveURL(/\/expenses\/bills\/recurring\/new$/);

  await page.getByLabel("Name").fill("Monthly hosting");
  await page.getByRole("combobox", { name: "Vendor" }).fill("Hostwell Inc");
  await page.getByRole("option", { name: '+ New vendor "Hostwell Inc"' }).click();
  await page.getByLabel("Day of the month").selectOption("last");
  await expect(page.getByText("Monthly on the last day", { exact: true })).toBeVisible();

  await page.getByLabel("Line 1 description").fill("Server hosting");
  await pick(page.getByLabel("Line 1 account"), "supplies", "6150 · Supplies");
  await page.getByLabel("Line 1 amount").fill("40");
  await page.getByRole("button", { name: "Save", exact: true }).click();

  await expect(page).toHaveURL(/\/expenses\/bills\/recurring\/[A-Z0-9]+$/);
  await expect(page.getByRole("heading", { name: "Monthly hosting" })).toBeVisible();
  await expect(page.getByText("Monthly on the last day", { exact: true })).toBeVisible();
  await expect(page.getByText("Nothing created yet.")).toBeVisible();

  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByText("Paused", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Resume" }).click();
  await expect(page.getByText("Active", { exact: true })).toBeVisible();

  const scheduleCard = page.locator("section", { has: page.getByRole("heading", { name: "Schedule" }) });
  const firstDateBefore = await scheduleCard.locator("li").first().textContent();
  await page.getByRole("button", { name: "Skip next" }).click();
  await expect(scheduleCard.locator("li").first()).not.toHaveText(firstDateBefore ?? "");
  await expect(page.getByText("Skipped", { exact: true })).toBeVisible();
  await expect(page.getByText("Nothing created yet.")).toHaveCount(0);

  await page.getByRole("button", { name: "Run now" }).click();
  await expect(page.getByRole("link", { name: "View" })).toBeVisible();
});

test("the old /sales/recurring URL redirects to the Invoices Recurring tab", async ({ page }) => {
  await signIn(page);
  await page.goto(`${orgBase(page)}/sales/recurring`);
  await expect(page).toHaveURL(/\/sales\/invoices\/recurring$/);
  await expect(page.getByRole("tab", { name: "Recurring", selected: true })).toBeVisible();
});

test('"Make recurring" on an invoice prefills the recurring form', async ({ page }) => {
  await signIn(page);
  const base = orgBase(page);

  await page.goto(`${base}/sales/invoices/new`);
  await page.getByRole("combobox", { name: "Customer" }).fill("Prefill Testing Co");
  await page.getByRole("option", { name: '+ New customer "Prefill Testing Co"' }).click();
  await page.getByLabel("Line 1 description").fill("Consulting retainer");
  await page.getByLabel("Line 1 quantity").fill("2");
  await page.getByLabel("Line 1 rate").fill("100");
  await page.getByRole("button", { name: "Save draft" }).click();

  await page.getByRole("button", { name: "Make recurring" }).click();
  await expect(page).toHaveURL(/\/sales\/invoices\/recurring\/new\?from=/);
  await expect(page.getByRole("combobox", { name: "Customer" })).toHaveValue("Prefill Testing Co");
  await expect(page.getByLabel("Line 1 description")).toHaveValue("Consulting retainer");
  await expect(page.getByRole("radio", { name: "Post and email" })).toBeVisible();
});
