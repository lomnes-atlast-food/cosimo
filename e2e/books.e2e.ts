import { expect, type Page, test } from "@playwright/test";
import { signIn } from "./auth.ts";
import { pick } from "./pick.ts";

const CSV = `Date,Description,Amount
2026-01-05,CLIENT PAYMENT ACME,1200.00
2026-01-06,ADOBE CREATIVE CLOUD,-54.99
2026-01-07,STAPLES 00123,-45.10
`;

function orgBase(page: Page) {
  const m = /\/o\/([A-Z0-9]+)/.exec(page.url());
  return `/o/${m![1]}`;
}

test.describe.configure({ mode: "serial" });

test("sign in, post a journal entry, and see it on the reports", async ({ page }) => {
  await signIn(page);
  const base = orgBase(page);

  await page.goto(`${base}/accounting/entries/new`);
  await page.getByLabel("Memo").fill("Owner investment");
  await pick(page.getByLabel("Line 1 account"), "1000", "1000 · Business Checking");
  await page.getByLabel("Line 1 debit").fill("2000");
  await pick(page.getByLabel("Line 2 account"), "owner contrib", "3100 · Owner's Contributions");
  await page.getByLabel("Line 2 credit").fill("2000");
  await expect(page.getByText("Balanced")).toBeVisible();
  await page.getByRole("button", { name: "Post entry" }).click();
  await expect(page.getByText("Posted", { exact: true }).first()).toBeVisible();

  await page.goto(`${base}/reports?report=balance_sheet`);
  await expect(page.getByRole("heading", { name: "Balance Sheet" })).toBeVisible();
  await expect(page.getByText("Business Checking")).toBeVisible();
  await expect(page.getByText(/Ledger chain head #\d+/)).toBeVisible();

  await page.goto(`${base}/settings`);
  await page.getByRole("tab", { name: "Integrity" }).click();
  await expect(page.getByText("Independent timestamps")).toBeVisible();
  await expect(page.getByText("Timestamping is off (anchoring.enabled in the config).")).toBeVisible();
  await expect(page.getByRole("button", { name: "Timestamp now" })).toHaveCount(0);
  await page.getByRole("button", { name: "Verify now" }).click();
  await expect(page.getByText(/Both chains verified/)).toBeVisible();
});

test("import a CSV, categorize it, and see the P&L", async ({ page }) => {
  await signIn(page);
  const base = orgBase(page);

  await page.goto(`${base}/banking/accounts`);
  await page.getByRole("button", { name: "Add account" }).click();
  await page.getByLabel("Name").fill("Main checking");
  await pick(page.getByLabel("Ledger account"), "checking", "1000 · Business Checking");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("cell", { name: "Main checking" })).toBeVisible();

  await page.goto(`${base}/banking/import`);
  await page
    .getByLabel("Statement file")
    .setInputFiles({ name: "jan.csv", mimeType: "text/csv", buffer: Buffer.from(CSV) });
  await expect(page.getByText("3 new")).toBeVisible();
  await page.getByRole("button", { name: "Import 3 transactions" }).click();
  await expect(page.getByText(/Imported 3/)).toBeVisible();

  // re-importing the same file finds only duplicates
  await page
    .getByLabel("Statement file")
    .setInputFiles({ name: "jan-again.csv", mimeType: "text/csv", buffer: Buffer.from(CSV) });
  await expect(page.getByText("0 new")).toBeVisible();

  // the old "Bank review" URL still lands on Categorize
  await page.goto(`${base}/banking/review`);
  await expect(page).toHaveURL(/\/banking\/categorize/);
  await expect(page.getByRole("heading", { name: "Categorize" })).toBeVisible();
  // Categorize opens on All; work from "To categorize", where a saved row leaves the list
  await page.getByRole("button", { name: /^To categorize/ }).click();
  await expect(page).toHaveURL(/status=todo/);
  await page.getByText("CLIENT PAYMENT ACME").click();
  // keyboard only: a new customer name plus Enter creates it; type to search, Enter picks the top
  // match, Enter again saves
  await page.getByRole("combobox", { name: "Customer" }).fill("Acme Inc");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("combobox", { name: "Customer" })).toHaveValue("Acme Inc");
  await page.getByLabel("Category").fill("sales");
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Category")).toHaveValue("4000 · Sales");
  await page.keyboard.press("Enter");
  await expect(page.getByText("CLIENT PAYMENT ACME")).toHaveCount(0);

  await page.getByText("ADOBE CREATIVE CLOUD").click();
  await page.getByRole("tab", { name: "split" }).click();
  await pick(page.getByLabel("Split 1 account"), "software", "6100 · Software and Subscriptions");
  await page.getByLabel("Split 1 amount").fill("50.00");
  await pick(page.getByLabel("Split 2 account"), "6150", "6150 · Supplies");
  await page.getByLabel("Split 2 amount").fill("4.99");
  await expect(page.getByText("Splits add up")).toBeVisible();
  // Layout: the amount keeps its narrow width and the account picker gets the rest of the row.
  const amountBox = await page.getByLabel("Split 1 amount").boundingBox();
  const accountBox = await page.getByLabel("Split 1 account").boundingBox();
  expect(amountBox?.width).toBeLessThan(140);
  expect(accountBox?.width).toBeGreaterThan(3 * (amountBox?.width ?? 0));
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("ADOBE CREATIVE CLOUD")).toHaveCount(0);

  // both saved rows are listed under Categorized
  await page.getByRole("button", { name: /^Categorized/ }).click();
  await expect(page.getByText("CLIENT PAYMENT ACME")).toBeVisible();
  await expect(page.getByText("ADOBE CREATIVE CLOUD")).toBeVisible();

  await page.goto(`${base}/reports?report=profit_and_loss&from=2026-01-01&to=2026-01-31`);
  await expect(page.getByRole("row", { name: /Total Income/ })).toContainText("1,200.00");
});

test("review queue shows threshold items and approval posts them", async ({ page }) => {
  await signIn(page);
  const base = orgBase(page);
  await page.goto(`${base}/accounting/entries/new`);
  await page.getByLabel("Memo").fill("Big equipment purchase");
  await pick(page.getByLabel("Line 1 account"), "1000", "1000 · Business Checking");
  await page.getByLabel("Line 1 credit").fill("3000");
  await pick(page.getByLabel("Line 2 account"), "equip", "1500 · Equipment");
  await page.getByLabel("Line 2 debit").fill("3000");
  await page.getByRole("button", { name: "Post entry" }).click();
  await expect(page.getByText(/review queue/i).first()).toBeVisible();

  await page.goto(`${base}/accounting/review`);
  await expect(page.getByText("Why it is here: Amount is at or above the review threshold")).toBeVisible();
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByText("Nothing waiting for review.")).toBeVisible();
});

test("an invoice over the threshold waits in the review queue and shows its lines", async ({ page }) => {
  await signIn(page);
  const base = orgBase(page);
  await page.goto(`${base}/sales/invoices/new`);
  await page.getByRole("combobox", { name: "Customer" }).fill("Initech");
  await page.getByRole("option", { name: '+ New customer "Initech"' }).click();
  await page.getByLabel("Line 1 description").fill("Annual retainer");
  await page.getByLabel("Line 1 quantity").fill("1");
  await page.getByLabel("Line 1 rate").fill("10000");
  await page.getByRole("button", { name: "Save draft" }).click();
  await page.getByRole("button", { name: "Mark as sent" }).click();
  await expect(page.getByText(/Waiting in the review queue/)).toBeVisible();

  // A held invoice used to crash the whole review page (#62).
  await page.goto(`${base}/accounting/review`);
  await expect(page.getByText(/Invoice .+ to Initech/)).toBeVisible();
  await expect(page.getByText("Annual retainer · $10,000.00")).toBeVisible();
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByText("Nothing waiting for review.")).toBeVisible();
});

test("create an invoice, mark it sent, and record full payment", async ({ page }) => {
  await signIn(page);
  const base = orgBase(page);
  await page.goto(`${base}/sales/invoices/new`);
  // A name that isn't there yet: the picker offers to create it, with no form to fill in.
  await page.getByRole("combobox", { name: "Customer" }).fill("Globex Corp");
  await page.getByRole("option", { name: '+ New customer "Globex Corp"' }).click();
  await expect(page.getByRole("combobox", { name: "Customer" })).toHaveValue("Globex Corp");
  await page.getByLabel("Line 1 description").fill("Consulting");
  await page.getByLabel("Line 1 quantity").fill("4");
  await page.getByLabel("Line 1 rate").fill("150");
  await page.getByRole("button", { name: "Save draft" }).click();

  await page.getByRole("button", { name: "Mark as sent" }).click();
  await expect(page.getByText("Open", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Record payment" }).click();
  const dialog = page.getByRole("dialog");
  await pick(dialog.getByLabel("Deposit to"), "checking", "1000 · Business Checking");
  await dialog.getByRole("button", { name: "Save payment" }).click();
  await expect(page.getByText("Paid", { exact: true }).first()).toBeVisible();

  await page.goto(`${base}/reports?report=ar_aging&as_of=2026-12-31`);
  await expect(page.getByText("Globex Corp")).toHaveCount(0);
});

test("a new bill can create its vendor from the picker", async ({ page }) => {
  await signIn(page);
  await page.goto(`${orgBase(page)}/expenses/bills/new`);
  await page.getByRole("combobox", { name: "Vendor" }).fill("Initech Supply");
  await page.getByRole("option", { name: '+ New vendor "Initech Supply"' }).click();
  await expect(page.getByRole("combobox", { name: "Vendor" })).toHaveValue("Initech Supply");
  await page.getByLabel("Line 1 description").fill("Paper");
  await pick(page.getByLabel("Line 1 account"), "supplies", "6150 · Supplies");
  await page.getByLabel("Line 1 amount").fill("80");
  await page.getByRole("button", { name: "Save bill" }).click();
  await expect(page.getByText("Initech Supply").first()).toBeVisible();
  await expect(page).toHaveURL(/\/expenses\/bills\/[A-Z0-9]+$/);
});

test("bank feeds card explains setup when Plaid has no keys", async ({ page }) => {
  await signIn(page);
  await page.goto(`${orgBase(page)}/banking/accounts`);
  await expect(page.getByRole("heading", { name: "Bank feeds" })).toBeVisible();
  await expect(page.getByText(/use your own Plaid keys/)).toBeVisible();
  await page.goto(`${orgBase(page)}/settings`);
  await page.getByRole("tab", { name: "Bank feeds" }).click();
  await expect(page.getByText("Using the instance keys.")).toBeVisible();
});
