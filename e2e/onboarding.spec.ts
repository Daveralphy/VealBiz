import { expect, test } from "@playwright/test";
import { APP_URL, PASSWORD, latestMail, signIn } from "./helpers";

const PDF = (name: string) => ({ name, mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 test document") });

test("a new business signs up, waits for WindVeal, sends what's asked for and gets in once approved", async ({ page, browser }) => {
  const stamp = Date.now();
  const email = `owner-${stamp}@example.com`;
  const biz = `Ada Analytics ${stamp} Limited`;
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
  await page.getByLabel("Registered business name").fill(biz);
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

  // The last step sends the business to WindVeal; the certificate is required.
  await expect(page.getByRole("heading", { name: "Show us you're real." })).toBeVisible();
  await expect(page.getByRole("button", { name: /Send for review/ })).toBeDisabled();
  await page.locator('.wz-proof input[type="file"]').first().setInputFiles(PDF("certificate.pdf"));
  await expect(page.getByText("certificate.pdf")).toBeVisible();
  await page.getByRole("button", { name: /Send for review/ }).click();

  // Nothing else opens until WindVeal approves it.
  await expect(page.getByRole("heading", { name: "We're reviewing your business." })).toBeVisible();
  expect((await latestMail(page, email)).subject).toBe(`We're reviewing ${biz}`);
  await page.goto("/people");
  await expect(page.getByRole("heading", { name: "We're reviewing your business." })).toBeVisible();
  expect((await page.request.get(`${APP_URL}/api/people/employees`)).status()).toBe(403);

  // A WindVeal reviewer gets an email, opens it and asks for proof of address.
  expect((await latestMail(page, "admin@example-trading.test")).subject).toBe(`New business to review: ${biz}`);
  const reviewer = await (await browser.newContext()).newPage();
  await signIn(reviewer);
  await reviewer.goto(`${APP_URL}/admin/organisations`);
  await reviewer.getByRole("row", { name: new RegExp(`Ada Analytics ${stamp}`) }).click();
  await expect(reviewer.getByRole("heading", { name: "Check these" })).toBeVisible();
  await reviewer.getByRole("checkbox", { name: "Registered name" }).check();
  await reviewer.locator(".ad-decide").getByRole("button", { name: "Ask for more" }).click();
  const ask = reviewer.getByRole("dialog", { name: /Ask Ada Analytics/ });
  await ask.getByLabel("Proof of address from the last 3 months").check();
  await ask.getByLabel("Message to them").fill("We need a recent proof of address.");
  await ask.getByRole("button", { name: "Send request" }).click();
  await expect(reviewer.getByRole("heading", { name: "Waiting for them" })).toBeVisible();

  // The business sees exactly what's needed, sends it, and goes back in the queue.
  expect((await latestMail(page, email)).subject).toBe(`WindVeal needs a little more from ${biz}`);
  await page.reload();
  await expect(page.getByRole("heading", { name: "WindVeal needs a little more from you." })).toBeVisible();
  await expect(page.getByText("We need a recent proof of address.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Send for review" })).toBeDisabled();
  await page.locator('.rv-req input[type="file"]').setInputFiles(PDF("utility-bill.pdf"));
  await expect(page.getByText("1 of 1 done")).toBeVisible();
  await page.getByRole("button", { name: "Send for review" }).click();
  await expect(page.getByRole("heading", { name: "We're reviewing your business." })).toBeVisible();

  // The reviewer approves; the business gets in.
  expect((await latestMail(page, "admin@example-trading.test")).subject).toBe(`${biz} sent more for review`);
  await reviewer.reload();
  await expect(reviewer.getByText("utility-bill.pdf").first()).toBeVisible();
  await reviewer.locator(".ad-decide").getByRole("button", { name: "Approve", exact: true }).click();
  await reviewer.getByRole("dialog", { name: /Approve Ada/ }).getByRole("button", { name: "Approve", exact: true }).click();
  await expect(reviewer.getByRole("heading", { name: "Approved" })).toBeVisible();
  expect((await latestMail(page, email)).subject).toBe(`${biz} is approved`);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Ada");
  await expect(page.locator(".home-tile").first()).toBeVisible();
});

test("a business WindVeal doesn't approve sees the reason and can't get in", async ({ page, browser }) => {
  const stamp = Date.now();
  const email = `refused-${stamp}@example.com`;
  const biz = `Not Real ${stamp} Limited`;
  await page.goto("/create-account");
  await page.getByLabel("Full name").fill("Sam Refused");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: /Create account/ }).click();
  await page.getByLabel("Digit 1").fill((await latestMail(page, email)).code!);
  await page.getByLabel("Registered business name").fill(biz);
  await page.getByLabel("Industry").selectOption("Retail");
  await page.getByLabel("Team size").selectOption("1 to 10 people");
  await page.getByLabel("City").fill("Abuja");
  await page.getByLabel("Business address").fill("2 Nowhere Street");
  await page.getByRole("button", { name: /Continue/ }).click();
  await page.getByRole("button", { name: /Continue/ }).click();
  await page.getByRole("button", { name: "Skip for now" }).click();
  await page.getByRole("button", { name: /Continue with Free/ }).click();
  await page.locator('.wz-proof input[type="file"]').first().setInputFiles(PDF("certificate.pdf"));
  await page.getByRole("button", { name: /Send for review/ }).click();
  await expect(page.getByRole("heading", { name: "We're reviewing your business." })).toBeVisible();

  const reviewer = await (await browser.newContext()).newPage();
  await signIn(reviewer);
  await reviewer.goto(`${APP_URL}/admin/organisations`);
  await reviewer.getByRole("row", { name: new RegExp(`Not Real ${stamp}`) }).click();
  await reviewer.locator(".ad-decide").getByRole("button", { name: "Don't approve" }).click();
  const no = reviewer.getByRole("dialog", { name: /Don't approve/ });
  await no.getByLabel("Reason").fill("We couldn't find this business in the official registry.");
  await no.getByRole("button", { name: "Don't approve" }).click();
  await expect(reviewer.getByRole("heading", { name: "Not approved" })).toBeVisible();

  expect((await latestMail(page, email)).subject).toBe(`We couldn't approve ${biz}`);
  await page.reload();
  await expect(page.getByRole("heading", { name: `We couldn't approve ${biz}.` })).toBeVisible();
  await expect(page.getByText("We couldn't find this business in the official registry.")).toBeVisible();
  await expect(page.getByRole("link", { name: /Contact support/ })).toBeVisible();
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
  await expect(page.getByRole("heading", { name: "You don't have access to this page" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Audit history" })).toHaveCount(0);
  await expect(page.locator('.home a[href="/settings"]')).toHaveCount(0);
});

test("only WindVeal admins can open the admin panel", async ({ page }) => {
  await signIn(page, "member@example-trading.test");
  await page.goto("/admin/organisations");
  await expect(page.getByRole("heading", { name: "You don't have access to this page" })).toBeVisible();
  await page.getByRole("button", { name: "Go to Home" }).click();
  await expect(page.locator('.home a[href="/admin"]')).toHaveCount(0);
});

test("someone invited who signs up the usual way is offered their invitation, not business setup", async ({ page, browser }) => {
  const email = `invitee-${Date.now()}@example.com`;
  const admin = await (await browser.newContext()).newPage();
  await signIn(admin);
  expect((await admin.request.post(`${APP_URL}/api/invitations`, { data: { invites: [{ email, role: "manager" }] } })).status()).toBe(200);

  await page.goto("/create-account");
  await page.getByLabel("Full name").fill("Tunde Ade");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: /Create account/ }).click();
  await expect(page.getByRole("heading", { name: "Check your email." })).toBeVisible();
  const code = (await (async () => { for (let i = 0; i < 20; i++) { const m = await latestMail(page, email); if (m.code) return m; await page.waitForTimeout(250); } throw new Error("no code"); })()).code!;
  await page.getByLabel("Digit 1").fill(code);

  await expect(page.getByRole("heading", { name: /You're invited to Example Trading/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Tell us about your business." })).toHaveCount(0);
  await page.getByRole("button", { name: "Join Example Trading" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Tunde");
});
