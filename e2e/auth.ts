import { expect, type Page } from "@playwright/test";
import { E2E_EMAIL, E2E_PASSWORD } from "./constants.ts";

type Cookies = Awaited<ReturnType<ReturnType<Page["context"]>["cookies"]>>;
let saved: Cookies | null = null;

/**
 * Sign in as the e2e owner. The session cookies from the first sign-in are reused, so the suite
 * stays under the server's login rate limit (10 per minute per IP).
 */
export async function signIn(page: Page) {
  if (saved) {
    await page.context().addCookies(saved);
    await page.goto("/");
    await expect(page).toHaveURL(/\/o\/[A-Z0-9]+|\/login/);
    if (!page.url().includes("/login")) return;
    saved = null;
  }
  await page.goto("/login");
  await page.getByLabel("Email").fill(E2E_EMAIL);
  await page.getByLabel("Password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/o\/[A-Z0-9]+/);
  saved = await page.context().cookies();
}
