import { expect, test } from "@playwright/test";
import { APP_URL, PASSWORD, latestMail, signIn } from "./helpers";

test("a new business signs up, sets up and lands on Overview", async ({ page }) => {
  const email = `owner-${Date.now()}@example.com`;
  await page.goto("/create-account");
  await page.getByLabel("Full name").fill("Ada Lovelace");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: /Create account/ }).click();

  await expect(page.getByRole("heading", { name: "Check your email." })).toBeVisible();
  const { code } = await latestMail(page, email);
  await page.getByLabel("Digit 1").fill(code!);

  await expect(page.getByRole("heading", { name: "Tell us about your business." })).toBeVisible();
  await page.getByLabel("Registered business name").fill("Ada Analytics Limited");
  await page.getByLabel("Industry").selectOption("Technology");
  await page.getByLabel("Team size").selectOption("1 to 10 people");
  await page.getByLabel("City").fill("Lagos");
  await page.getByLabel("Business address").fill("1 Marina Road");
  await page.getByRole("button", { name: /Continue/ }).click();

  await expect(page.getByRole("heading", { name: "What's your role?" })).toBeVisible();
  await page.getByRole("button", { name: /Continue/ }).click();
  await expect(page.getByRole("heading", { name: "Make it yours." })).toBeVisible();
  await page.getByRole("button", { name: "Skip for now" }).click();
  await expect(page.getByRole("heading", { name: "Choose your plan." })).toBeVisible();
  await page.getByRole("button", { name: /Continue with Free/ }).click();
  await expect(page.getByRole("heading", { name: "Invite your team." })).toBeVisible();
  await page.getByRole("button", { name: "Skip for now" }).click();
  await expect(page.getByRole("heading", { name: /You're all set/ })).toBeVisible();
  await page.getByRole("link", { name: /Go to my workspace/ }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Ada");
  await expect(page.locator(".home-tile").first()).toBeVisible();
});

test("wrong password shows one clear message", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill("admin@example-trading.test");
  await page.getByLabel("Password", { exact: true }).fill("Not#theRight1");
  await page.getByRole("button", { name: /^Sign in/ }).click();
  await expect(page.getByText("Email or password is incorrect.")).toBeVisible();
});

test("the admin sees the demo business and can open each workspace", async ({ page }) => {
  await signIn(page);
  await expect(page.getByText("Example Trading").first()).toBeVisible();
  // Home has a tile for each workspace; each opens on its own dashboard, and Home is back in the account menu.
  for (const [href, heading] of [["/recruitment", "Recruitment"], ["/people", "People & HR"], ["/crm", "CRM"], ["/workflows", "Workflows"], ["/documents", "Documents"], ["/insights", "Insights"], ["/settings", "Settings"]] as const) {
    await page.locator(`.home a[href="${href}"]`).click();
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    await page.getByRole("button", { name: "Account menu" }).first().click();
    await page.locator(".menu-float").getByRole("button", { name: "Home" }).click();
    await expect(page.getByRole("heading", { level: 1, name: /Good (morning|afternoon|evening)/ })).toBeVisible();
  }
});

test("a member can't open admin-only settings", async ({ page }) => {
  await signIn(page, "member@example-trading.test");
  await page.goto("/settings/audit");
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole("link", { name: "Audit history" })).toHaveCount(0);
});

test("only WindVeal admins can open the admin panel", async ({ page }) => {
  await signIn(page, "member@example-trading.test");
  await page.goto("/admin");
  await expect(page).toHaveURL(`${APP_URL}/`);
  await expect(page.locator('.home a[href="/admin"]')).toHaveCount(0);
});
