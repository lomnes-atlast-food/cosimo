import { expect, type Page, test } from "@playwright/test";
import { signIn } from "./auth.ts";

function orgBase(page: Page) {
  const m = /\/o\/([A-Z0-9]+)/.exec(page.url());
  return `/o/${m![1]}`;
}

async function setMode(page: Page, base: string, mode: "Off" | "Payment link" | "Stripe") {
  await page.goto(`${base}/settings`);
  await page.getByRole("tab", { name: "Online payments" }).click();
  await page.getByLabel("Mode").selectOption({ label: mode });
}

async function newInvoice(page: Page, base: string, customer: string, rate: string) {
  await page.goto(`${base}/sales/invoices/new`);
  await page.getByRole("combobox", { name: "Customer" }).fill(customer);
  await page.getByRole("option", { name: `+ New customer "${customer}"` }).click();
  await page.getByLabel("Line 1 description").fill("Consulting");
  await page.getByLabel("Line 1 rate").fill(rate);
}

test.describe.configure({ mode: "serial" });

test("payment link mode: the link entered on an invoice shows on the invoice page", async ({ page }) => {
  await signIn(page);
  const base = orgBase(page);
  await setMode(page, base, "Payment link");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved.")).toBeVisible();

  const url = `https://pay.example.com/inv-${Date.now().toString(36)}`;
  await newInvoice(page, base, "Hooli Payments", "250");
  await page.getByLabel("Payment link").fill(url);
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page).toHaveURL(/\/sales\/invoices\/[A-Z0-9]+$/);
  await expect(page.getByRole("link", { name: url })).toBeVisible();

  await setMode(page, base, "Off");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
});

// Live Stripe test mode: set COSIMO_TEST_STRIPE=1 and STRIPE_TEST_SECRET_KEY (sk_test_ or rk_test_).
test.describe(() => {
  test.skip(process.env.COSIMO_TEST_STRIPE !== "1", "Needs COSIMO_TEST_STRIPE=1 and a test-mode key");

  test("pay an invoice with a test card on Stripe Checkout", async ({ page }) => {
    const key = process.env.STRIPE_TEST_SECRET_KEY ?? "";
    await signIn(page);
    const base = orgBase(page);
    await setMode(page, base, "Stripe");
    await page.getByLabel("Secret or restricted key").fill(key);
    await page.getByLabel(/^ACH Direct Debit/).uncheck();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Test mode")).toBeVisible();

    await newInvoice(page, base, "Stripe Test Customer", "42");
    await page.getByLabel(/Accept online payment/).check();
    await page.getByRole("button", { name: "Save draft" }).click();
    await page.getByRole("button", { name: "Mark as sent" }).click();
    const link = page.locator("code").filter({ hasText: "/pay/" });
    await expect(link).toBeVisible();
    const payUrl = (await link.textContent())!.trim();
    const invoicePage = page.url();

    await page.goto(payUrl);
    await expect(page).toHaveURL(/checkout\.stripe\.com/);
    await page.locator("#email").fill("customer@example.com");
    await page.locator("#cardNumber").fill("4242424242424242");
    await page.locator("#cardExpiry").fill("12 / 34");
    await page.locator("#cardCvc").fill("123");
    await page.locator("#billingName").fill("Test Customer");
    const zip = page.locator("#billingPostalCode");
    if (await zip.isVisible()) await zip.fill("94107");
    await page.locator(".SubmitButton").click();
    await expect(page.getByText("This invoice is paid")).toBeVisible({ timeout: 45_000 });

    await page.goto(invoicePage);
    await expect(page.getByText("Paid", { exact: true }).first()).toBeVisible();
    await setMode(page, base, "Off");
    await page.getByRole("button", { name: "Save", exact: true }).click();
  });
});
