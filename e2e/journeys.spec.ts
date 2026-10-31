import { expect, test, type Page } from "@playwright/test";
import { APP_URL, SITE_URL, signIn } from "./helpers";

/** Fails the test on any server error or uncaught page error while visiting. */
function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`page error: ${e.message}`));
  page.on("response", (r) => { if (r.status() >= 500) errors.push(`${r.status()} ${r.url()}`); });
  return errors;
}

const SCREENS = [
  "/", "/people", "/people/departments", "/people/leave", "/people/attendance", "/people/onboarding",
  "/recruitment", "/recruitment/candidates", "/recruitment/interviews", "/recruitment/careers", "/recruitment/jobs/new",
  "/crm", "/crm/pipeline", "/crm/companies", "/crm/leads", "/crm/follow-ups",
  "/workflows", "/workflows/approvals", "/workflows/all", "/workflows/templates",
  "/documents", "/documents/recent", "/documents/shared", "/documents/archive",
  "/insights", "/insights/sales", "/insights/people", "/insights/hiring", "/insights/work",
  "/import", "/settings", "/settings/roles", "/settings/billing", "/settings/audit", "/help",
  "/profile", "/profile/edit", "/profile/company", "/profile/company/edit", "/admin", "/admin/people",
];

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`every screen loads without errors (${viewport.width}px)`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const errors = watchErrors(page);
    await signIn(page);
    for (const path of SCREENS) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      await expect(page.locator(".loading")).toHaveCount(0, { timeout: 10_000 });
      // No horizontal scrolling on phones.
      if (viewport.width < 500) {
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (overflow > 2) {
          const culprits = await page.evaluate(() => [...document.querySelectorAll("body *")]
            .filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1 && getComputedStyle(e).position !== "fixed")
            .slice(0, 3).map((e) => `${e.tagName.toLowerCase()}.${String((e as HTMLElement).className).split(" ")[0]}`));
          errors.push(`${path} scrolls sideways by ${overflow}px (${culprits.join(", ")})`);
        }
      }
    }
    expect(errors).toEqual([]);
  });
}

test("a candidate applies on the careers page and is hired into People & HR", async ({ page, context }) => {
  const errors = watchErrors(page);
  // Public careers page (no sign-in).
  await page.goto(`${SITE_URL}/careers/example-trading`);
  await expect(page.getByRole("heading", { name: "Example Trading" })).toBeVisible();
  await page.getByRole("link", { name: /Accounts Officer/ }).first().click();
  await expect(page.getByRole("heading", { name: "Accounts Officer" })).toBeVisible();
  await page.getByRole("link", { name: /Apply for this role/ }).first().click();

  const email = `nkem-${Date.now()}@example.com`;
  await page.getByLabel(/First name/).fill("Nkem");
  await page.getByLabel(/Last name/).fill("Obi");
  await page.getByLabel(/^Email/).fill(email);
  await page.getByLabel(/^Phone/).fill("0803 555 0100");
  await page.locator('input[type="file"]').setInputFiles({ name: "cv.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 test cv") });
  // Answer the job's required questions.
  await page.getByLabel(/years of relevant experience/i).selectOption({ index: 2 });
  await page.getByText("Yes", { exact: true }).first().click();
  await page.getByRole("checkbox").last().check();
  await page.getByRole("button", { name: /Submit application/ }).click();
  await expect(page.getByText(/Application sent/i)).toBeVisible();

  // The recruiter sees the new applicant and hires them.
  await signIn(page);
  await page.goto("/recruitment/candidates");
  await page.getByText("Nkem Obi").first().click();
  await expect(page.getByRole("heading", { name: "Nkem Obi" })).toBeVisible();
  const appUrl = page.url();
  const appId = appUrl.split("/applications/")[1]!.split(/[?#]/)[0]!;
  const r = await page.request.post(`${APP_URL}/api/recruitment/applications/${appId}/hire`, {
    data: { jobTitle: "Accounts Officer", startDate: new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10) },
  });
  expect(r.ok()).toBeTruthy();
  await page.goto("/people?q=Nkem");
  await expect(page.getByText("Nkem Obi").first()).toBeVisible();
  expect(errors).toEqual([]);
  void context;
});

test("profile shows details first and edits them after Edit profile", async ({ page }) => {
  const errors = watchErrors(page);
  await signIn(page);
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("button", { name: "My profile" }).click();
  await expect(page).toHaveURL(/\/profile$/);
  await expect(page.getByRole("heading", { name: "Personal details" })).toBeVisible();
  await page.getByRole("button", { name: "Edit profile" }).click();
  await page.getByLabel(/^Phone/).fill("0803 555 0199");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page).toHaveURL(/\/profile$/);
  await expect(page.getByText("0803 555 0199")).toBeVisible();

  await page.getByRole("link", { name: "Company" }).click();
  await expect(page.getByRole("heading", { name: "Business details" })).toBeVisible();
  await page.getByRole("button", { name: "Edit company" }).click();
  await page.getByLabel("Tagline").fill("Trading made simple");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page).toHaveURL(/\/profile\/company$/);
  await expect(page.getByText("Trading made simple").first()).toBeVisible();
  expect(errors).toEqual([]);
});

test("errors are shown as toasts", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill("admin@example-trading.test");
  await page.getByLabel("Password", { exact: true }).fill("Wrong#password1");
  await page.getByRole("button", { name: /^Sign in/ }).click();
  await expect(page.locator(".toast.error")).toHaveText("Email or password is incorrect.");
});

test("WindVeal admins review an organisation and open what it sent", async ({ page }) => {
  const errors = watchErrors(page);
  await signIn(page);
  await page.goto("/admin");
  await page.getByRole("radio", { name: "All" }).click();
  await page.getByRole("row", { name: /Example Trading/ }).click();
  await expect(page.getByRole("heading", { name: "Registration details" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Everything they've uploaded" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Members \(/ })).toBeVisible();
  expect(errors).toEqual([]);
});

test("signing out asks first", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Account menu" }).first().click();
  await page.getByRole("button", { name: "Sign out" }).click();
  const dialog = page.getByRole("dialog", { name: "Sign out?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(page).not.toHaveURL(/sign-in/);
  await page.getByRole("button", { name: "Account menu" }).first().click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByRole("dialog", { name: "Sign out?" }).getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/sign-in/);
});

test("the app opens on Welcome, and the website offers Download instead of sign-in", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/welcome$/);
  await expect(page.getByRole("heading", { name: /Welcome to/ })).toBeVisible();
  await page.getByRole("link", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.getByRole("link", { name: "WindVeal" }).first().click();
  await expect(page).toHaveURL(/\/welcome$/);

  await page.goto(SITE_URL);
  await expect(page.getByRole("link", { name: /Sign in/ })).toHaveCount(0);
  await page.getByRole("link", { name: /^Download$/ }).first().click();
  await expect(page.getByRole("heading", { name: /Get WindVeal/ })).toBeVisible();
});

test("a screen opened for the first time pauses briefly; going back shows it straight away", async ({ page }) => {
  await signIn(page);
  await page.locator('nav[aria-label="Main"] a[href="/crm"]').click();
  await expect(page.locator(".skel-page")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "CRM" })).toBeVisible();
  await expect(page.locator(".skel-page")).toHaveCount(0);
  await page.locator('nav[aria-label="Main"] a[href="/people"]').click();
  await expect(page.getByRole("heading", { level: 1, name: "People & HR" })).toBeVisible();
  await page.goBack();
  // Seen before: no pause, and it's there at once.
  await expect(page.getByRole("heading", { level: 1, name: "CRM" })).toBeVisible({ timeout: 300 });
  await expect(page.locator(".skel-page")).toHaveCount(0);
});
