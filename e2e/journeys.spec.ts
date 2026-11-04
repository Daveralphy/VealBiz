import { expect, test, type Page } from "@playwright/test";
import { APP_URL, SITE_URL, latestMail, signIn } from "./helpers";

/** Fails the test on any server error or uncaught page error while visiting. */
function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`page error: ${e.message}`));
  page.on("response", (r) => { if (r.status() >= 500) errors.push(`${r.status()} ${r.url()}`); });
  return errors;
}

const SCREENS = [
  "/", "/people", "/people/directory", "/people/departments", "/people/leave", "/people/attendance", "/people/onboarding",
  "/recruitment", "/recruitment/jobs", "/recruitment/candidates", "/recruitment/interviews", "/recruitment/careers", "/recruitment/jobs/new",
  "/crm", "/crm/pipeline", "/crm/companies", "/crm/leads", "/crm/follow-ups",
  "/workflows", "/workflows/mine", "/workflows/approvals", "/workflows/all", "/workflows/templates",
  "/documents", "/documents/library", "/documents/recent", "/documents/shared", "/documents/archive",
  "/insights", "/insights/sales", "/insights/people", "/insights/hiring", "/insights/work",
  "/import", "/import/new", "/import/history", "/settings", "/settings/members", "/settings/invitations", "/settings/roles", "/settings/roles/new", "/billing", "/settings/audit", "/help",
  "/profile", "/profile/edit", "/profile/company", "/profile/company/edit", "/admin", "/admin/organisations", "/admin/people",
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
  await page.goto("/people/directory?q=Nkem");
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
  await page.goto("/admin/organisations");
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
  await expect(page.getByRole("link", { name: /^Download/ })).toHaveCount(0);
  await page.getByRole("link", { name: /^Get started$/ }).first().click();
  await expect(page.getByRole("heading", { name: /WindVeal for every device/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "macOS" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Android" })).toBeVisible();
});

test("a screen opened for the first time pauses briefly; going back shows it straight away", async ({ page }) => {
  await signIn(page);
  await page.locator('.home a[href="/crm"]').click();
  await expect(page.locator(".skel-page")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "CRM" })).toBeVisible();
  await expect(page.locator(".skel-page")).toHaveCount(0);
  await page.locator('.in-ws .sb a[href="/crm/pipeline"]').click();
  await expect(page.getByRole("heading", { level: 1, name: "CRM" })).toBeVisible();
  await page.goBack();
  // Seen before: no pause, and it's there at once.
  await expect(page.getByRole("heading", { level: 1, name: "CRM" })).toBeVisible({ timeout: 300 });
  await expect(page.locator(".skel-page")).toHaveCount(0);
});

test("an invited employee joins from the sign-in screen without the email link", async ({ page }) => {
  // The admin invites someone.
  await signIn(page);
  const email = `joiner-${Date.now()}@example.com`;
  const inv = await page.request.post("/api/invitations", { data: { invites: [{ email, role: "member" }] } });
  expect(inv.ok()).toBeTruthy();
  await page.request.post("/api/auth/logout");
  await page.context().clearCookies();

  await page.goto("/sign-in");
  await page.getByRole("link", { name: /Invited by your employer/ }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: /Send code/ }).click();
  // Wait for the code email (the invitation email arrived first).
  let code: string | undefined;
  for (let i = 0; i < 40 && !code; i++) {
    code = (await latestMail(page, email)).code;
    if (!code) await page.waitForTimeout(250);
  }
  await page.getByLabel("Code").fill(code!);
  await page.getByRole("button", { name: /Continue/ }).click();
  await expect(page.getByRole("heading", { name: /Welcome to Example Trading/ })).toBeVisible();
  await page.getByLabel("Full name").fill("Chidi Nwosu");
  await page.getByLabel("Password", { exact: true }).fill("Testing#2026x");
  await page.getByRole("button", { name: /Join Example Trading/ }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/Good (morning|afternoon|evening), Chidi/);
});

test("your clock in the top bar: clock in, take a break, resume and clock out; others see no running count", async ({ page }) => {
  // Amaka clocked in at 08:02 this morning (sample data).
  await signIn(page);
  const clock = page.locator(".topbar .hclock");
  await expect(clock).toHaveClass(/hclock-in/);
  await clock.click();
  await page.locator(".menu-float").getByRole("button", { name: "Take a break" }).click();
  await expect(clock).toHaveClass(/hclock-break/);
  await page.goto("/people/attendance");
  const me = page.getByRole("row", { name: /Amaka Okafor/ });
  await expect(me.getByText("On a break")).toBeVisible();
  await clock.click();
  await page.locator(".menu-float").getByRole("button", { name: "Resume" }).click();
  await expect(clock).toHaveClass(/hclock-in/);
  await expect(me.getByText("Still working")).toBeVisible();
  await clock.click();
  await page.locator(".menu-float").getByRole("button", { name: "Clock out" }).click();
  await page.getByRole("dialog", { name: "Clock out for today?" }).getByRole("button", { name: "Clock out" }).click();
  await expect(page.locator(".toast", { hasText: "You worked" })).toBeVisible();
  await expect(clock).toHaveClass(/hclock-done/);
  await expect(me.locator(".ppl-daycell b")).toHaveText(/\dh \d\dm/);
  // Clocked out by mistake: Resume from the menu, and the Attendance card offers it too.
  await expect(page.locator(".ppl-myday").getByRole("button", { name: "Resume" })).toBeVisible();
  await clock.click();
  await page.locator(".menu-float").getByRole("button", { name: "Resume" }).click();
  await expect(clock).toHaveClass(/hclock-in/);

  // Someone who hasn't clocked in yet starts from the top bar.
  await page.request.post("/api/auth/logout");
  await page.context().clearCookies();
  await signIn(page, "manager@example-trading.test");
  await page.locator(".topbar .hclock").click();
  await page.locator(".menu-float").getByRole("button", { name: "Clock in" }).click();
  await expect(page.locator(".topbar .hclock")).toHaveClass(/hclock-in/);
});

test("WindVeal admins see what needs approval and open a person's details", async ({ page }) => {
  const errors = watchErrors(page);
  await signIn(page);
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Review queue" })).toBeVisible();
  await page.goto("/admin/people");
  await page.getByRole("row", { name: /Efua Nyarko/ }).click();
  await expect(page.getByRole("heading", { name: "Manage account" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Deactivate account" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Devices/ })).toBeVisible();
  expect(errors).toEqual([]);
});

test("one New button holds every kind of record, and a template opens on its own page", async ({ page }) => {
  await signIn(page);
  await page.goto(`${APP_URL}/crm/companies`);
  await page.getByRole("button", { name: /^New/ }).click();
  await page.locator(".menu-float").getByRole("button", { name: "Lead" }).click();
  await expect(page.getByRole("dialog", { name: "Add lead" })).toBeVisible();
  await page.keyboard.press("Escape");

  // The templates page is a list; nothing opens until you pick one.
  await page.goto(`${APP_URL}/workflows/templates`);
  await expect(page.locator(".wf-tpl-card").first()).toBeVisible();
  await expect(page.locator(".wf-tpl-card-editor")).toHaveCount(0);
  await page.locator(".wf-tpl-card").first().click();
  await expect(page).toHaveURL(/\/workflows\/templates\/[^/]+$/);
  await expect(page.locator(".wf-tpl-card-editor")).toBeVisible();
  await expect(page.locator(".wf-tpl-grid")).toHaveCount(0);
});

test("roles decide what people open; an admin can add more for one person, and typed addresses are blocked too", async ({ page, browser }) => {
  const errors = watchErrors(page);
  await signIn(page);
  // A new role, made on its own page.
  await page.goto(`${APP_URL}/settings/roles`);
  await page.getByRole("button", { name: "New role" }).click();
  const stamp = Date.now() % 100000;
  await page.getByLabel("Role name").fill(`Sales rep ${stamp}`);
  await page.locator(".ac-row", { hasText: "CRM" }).getByRole("radio", { name: "Edit" }).click();
  await page.getByRole("button", { name: "Create role" }).click();
  await expect(page.getByRole("heading", { name: `Sales rep ${stamp}` })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit role" })).toBeVisible();
  await page.getByRole("link", { name: "All roles" }).click();
  await expect(page.getByRole("row", { name: new RegExp(`Sales rep ${stamp}`) })).toBeVisible();

  // Invitations offer the new role.
  await page.goto(`${APP_URL}/settings/members`);
  await page.getByRole("button", { name: "Invite people" }).click();
  await expect(page.getByRole("dialog", { name: "Invite people" }).getByLabel("Role").locator("option", { hasText: `Sales rep ${stamp}` })).toHaveCount(1);
  await page.keyboard.press("Escape");

  // Efua's role has no Recruitment: the address bar can't get round it.
  const efua = await (await browser.newContext()).newPage();
  await signIn(efua, "member@example-trading.test");
  await efua.goto(`${APP_URL}/recruitment/jobs`);
  await expect(efua.getByRole("heading", { name: "You don't have access to this page" })).toBeVisible();
  await efua.goto(`${APP_URL}/settings/roles`);
  await expect(efua.getByRole("heading", { name: "You don't have access to this page" })).toBeVisible();
  expect((await efua.request.get(`${APP_URL}/api/recruitment/jobs`)).status()).toBe(403);

  // The admin adds Recruitment (view) for Efua alone.
  await page.getByRole("row", { name: /Efua Nyarko/ }).click();
  await expect(page.getByRole("heading", { name: "Role: Member" })).toBeVisible();
  await page.getByRole("button", { name: "Edit access" }).click();
  await page.locator(".ac-row", { hasText: "Recruitment" }).getByRole("radio", { name: "View" }).click();
  await page.getByRole("button", { name: "Save access" }).click();
  await expect(page.locator(".ac-row", { hasText: "Recruitment" }).getByText("Added for Efua")).toBeVisible();
  await efua.goto(`${APP_URL}/recruitment/jobs`);
  await expect(efua.getByRole("heading", { level: 1, name: "Recruitment" })).toBeVisible();
  await expect(efua.getByRole("button", { name: "New job" })).toHaveCount(0);

  // And takes it away again.
  await page.getByRole("button", { name: "Edit access" }).click();
  await page.locator(".ac-row", { hasText: "Recruitment" }).getByRole("radio", { name: "No access" }).click();
  await page.getByRole("button", { name: "Save access" }).click();
  await expect(page.locator(".ac-row", { hasText: "Recruitment" }).getByText("From Member")).toBeVisible();
  expect(errors).toEqual([]);
});
