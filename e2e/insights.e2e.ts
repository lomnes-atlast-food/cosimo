import { expect, type Page, test } from "@playwright/test";
import { signIn } from "./auth.ts";

function orgBase(page: Page) {
  const m = /\/o\/([A-Z0-9]+)/.exec(page.url());
  return `/o/${m![1]}`;
}

test.describe.configure({ mode: "serial" });

test("dashboard shows cash, income and expense, and what needs attention", async ({ page }) => {
  await signIn(page);
  const base = orgBase(page);
  await page.goto(base);
  await expect(page.getByRole("heading", { name: "Cash" })).toBeVisible();
  await expect(page.getByTestId("cash-total")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Income and expense" })).toBeVisible();
  await expect(page.getByRole("cell", { name: /This month/ })).toBeVisible();
  await expect(page.getByRole("cell", { name: /Year to date/ })).toBeVisible();
  await expect(page.getByText("Transactions to categorize")).toBeVisible();
  await expect(page.getByText("Waiting for approval")).toBeVisible();
  await expect(page.getByText("Overdue invoices").first()).toBeVisible();

  await page.getByRole("main").getByRole("link", { name: "Review queue" }).click();
  await expect(page).toHaveURL(/\/accounting\/review/);
});

test("download the year-end package from Reports", async ({ page }) => {
  await signIn(page);
  const base = orgBase(page);
  await page.goto(`${base}/reports`);
  await page.getByRole("button", { name: "Year-end package" }).click();
  const year = new Date().getFullYear() - 1;
  await page.getByLabel("Fiscal year").selectOption(String(year));
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe(`e2e-studio-llc-${year}-year-end.zip`);
});
