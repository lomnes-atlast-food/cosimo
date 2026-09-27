import { expect, type Page, test } from "@playwright/test";
import { signIn } from "./auth.ts";
import { pick } from "./pick.ts";

function orgBase(page: Page) {
  const m = /\/o\/([A-Z0-9]+)/.exec(page.url());
  return `/o/${m![1]}`;
}

async function newAccount(page: Page, code: string, name: string, parent?: string) {
  await page.getByRole("button", { name: "New account" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Code", { exact: true }).fill(code);
  await dialog.getByLabel("Name", { exact: true }).fill(name);
  if (parent) {
    await dialog.getByLabel("Parent account").selectOption({ label: parent });
    // The parent sets the type, detail type, and tax line.
    await expect(dialog.getByLabel("Type", { exact: true })).toBeDisabled();
    await expect(dialog.getByLabel("Tax line")).toBeDisabled();
  }
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toHaveCount(0);
}

async function postExpense(page: Page, base: string, account: string, option: string, amount: string) {
  await page.goto(`${base}/accounting/entries/new`);
  await page.getByLabel("Date").fill("2026-06-10");
  await page.getByLabel("Memo").fill(`Sub-account test ${option}`);
  await pick(page.getByLabel("Line 1 account"), account, option);
  await page.getByLabel("Line 1 debit").fill(amount);
  await pick(page.getByLabel("Line 2 account"), "1000", "1000 · Business Checking");
  await page.getByLabel("Line 2 credit").fill(amount);
  await expect(page.getByText("Balanced")).toBeVisible();
  await page.getByRole("button", { name: "Post entry" }).click();
  await expect(page.getByText("Posted", { exact: true }).first()).toBeVisible();
}

test("sub-accounts roll up into their parent on the P&L and the chart of accounts", async ({ page }) => {
  await signIn(page);
  const base = orgBase(page);
  // Unique per run, so a retry against the same database starts clean.
  const run = Date.now().toString(36).slice(-5);
  const n = 70000 + Math.floor(Math.random() * 9000);
  const parent = `Studio ${run}`;
  const child = `Props ${run}`;

  await page.goto(`${base}/accounting/accounts`);
  await newAccount(page, `${n}0`, parent);
  await newAccount(page, `${n}1`, child, `${n}0 · ${parent}`);

  // The picker labels sub-accounts with their path.
  await postExpense(page, base, child, `${n}1 · ${parent} › ${child}`, "40");
  await postExpense(page, base, `${n}0`, `${n}0 · ${parent}`, "15");

  await page.goto(`${base}/reports?report=profit_and_loss&from=2026-06-01&to=2026-06-30`);
  const header = page.getByRole("row", { name: new RegExp(`^Collapse ${parent}`) });
  await expect(header).toBeVisible();
  await expect(page.getByRole("row", { name: new RegExp(child) })).toContainText("40.00");
  await expect(page.getByRole("row", { name: new RegExp(`${parent} \\(Other\\)`) })).toContainText("15.00");
  await expect(page.getByRole("row", { name: new RegExp(`^Total ${parent}`) })).toContainText("55.00");

  // Collapsed, the group is one row carrying its subtotal.
  await page.getByRole("button", { name: `Collapse ${parent}` }).click();
  await expect(page.getByRole("row", { name: new RegExp(`^Expand ${parent}`) })).toContainText("55.00");
  await expect(page.getByRole("row", { name: new RegExp(child) })).toHaveCount(0);
  await expect(page.getByRole("row", { name: new RegExp(`^Total ${parent}`) })).toHaveCount(0);
  await page.getByRole("button", { name: `Expand ${parent}` }).click();
  await expect(page.getByRole("row", { name: new RegExp(`^Total ${parent}`) })).toBeVisible();

  // The chart of accounts shows the rolled-up balance on the parent and its own under (Other).
  await page.goto(`${base}/accounting/accounts`);
  await expect(page.getByRole("row", { name: new RegExp(`Collapse ${parent}`) })).toContainText("55.00");
  await expect(page.getByRole("row", { name: new RegExp(`${parent} \\(Other\\)`) })).toContainText("15.00");
});
