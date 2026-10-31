import { expect, type Page } from "@playwright/test";

export const PASSWORD = "Testing#2026x";
/** Where the apps under test run (set by playwright.config.ts). */
export const APP_URL = process.env.E2E_APP_URL ?? "http://localhost:5273";
export const SITE_URL = process.env.E2E_SITE_URL ?? "http://localhost:5274";
export const API_URL = process.env.E2E_API_URL ?? "http://localhost:4100";

export async function signIn(page: Page, email = "admin@example-trading.test", password = PASSWORD) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: /^Sign in/ }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/Good (morning|afternoon|evening)/);
}

/** Reads the newest email to `to` from the development mailbox. */
export async function latestMail(page: Page, to: string) {
  for (let i = 0; i < 20; i++) {
    const r = await page.request.get(`${API_URL}/api/dev/mailbox?to=${encodeURIComponent(to)}`);
    const items = (await r.json()).items as { code?: string; link?: string; subject: string }[];
    if (items.length) return items[0]!;
    await page.waitForTimeout(250);
  }
  throw new Error(`No email for ${to}`);
}
