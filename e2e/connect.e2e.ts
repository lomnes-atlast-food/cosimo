import { createHash, randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import { E2E_EMAIL, E2E_PASSWORD } from "./constants.ts";

const REDIRECT = "https://client.example.com/callback";

test("an AI client connects with OAuth: sign in, consent, exchange the code, call MCP", async ({
  page,
  request,
}) => {
  const reg = await request.post("/oauth/register", {
    data: { client_name: "E2E Assistant", redirect_uris: [REDIRECT] },
  });
  expect(reg.status()).toBe(201);
  const { client_id } = await reg.json();
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  let callback = "";
  await page.route("https://client.example.com/**", async (route) => {
    callback = route.request().url();
    await route.fulfill({ status: 200, body: "ok" });
  });

  const q = new URLSearchParams({
    client_id,
    redirect_uri: REDIRECT,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "e2e",
  });
  await page.goto(`/oauth/authorize?${q}`);
  await expect(page).toHaveURL(/\/login\?next=/);
  await page.getByLabel("Email").fill(E2E_EMAIL);
  await page.getByLabel("Password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();

  await expect(page.getByText("E2E Assistant")).toBeVisible();
  await expect(page.getByLabel("Access")).toHaveValue("bookkeeper");
  await page.getByRole("button", { name: "Allow" }).click();
  await expect.poll(() => callback).toContain("code=");
  const back = new URL(callback);
  expect(back.searchParams.get("state")).toBe("e2e");

  const tok = await request.post("/oauth/token", {
    form: {
      grant_type: "authorization_code",
      code: back.searchParams.get("code")!,
      redirect_uri: REDIRECT,
      client_id,
      code_verifier: verifier,
    },
  });
  expect(tok.status()).toBe(200);
  const { access_token } = await tok.json();
  const mcp = await request.post("/mcp", {
    headers: { authorization: `Bearer ${access_token}` },
    data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_orgs", arguments: {} } },
  });
  const body = await mcp.json();
  expect(body.result.structuredContent.orgs[0].role).toBe("bookkeeper");

  await page.unroute("https://client.example.com/**");
  await page.goto("/account");
  await expect(page.getByRole("cell", { name: "E2E Assistant" })).toBeVisible();
});
