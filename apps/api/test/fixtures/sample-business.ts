/**
 * TEST DATA ONLY. Loads a fictional business ("Example Trading", slug example-trading) into a
 * throwaway test database for the browser tests (see e2e/prepare.mjs). Never run this against
 * your real database. Sign in as admin@example-trading.test / Testing#2026x (admin),
 * manager@example-trading.test (manager), member@example-trading.test (member).
 */
import { eq } from "drizzle-orm";
import { DEFAULT_DEAL_STAGES, DEFAULT_LEAD_STAGES, DEFAULT_RECRUITMENT_STAGES } from "@windveal/shared";
import { db, sql } from "../../src/db/client";
import * as s from "../../src/db/schema";
import { hashPassword } from "../../src/lib/crypto";
import { seedOrgDefaults } from "../../src/modules/org/defaults";
import { createApproval } from "../../src/lib/approvals";
import { createTask, startChecklist } from "../../src/lib/tasks";

const PASSWORD = "Testing#2026x";
const DAY = 86_400_000;
const d = (offset: number) => new Date(Date.now() + offset * DAY);
const ymd = (offset: number) => { const x = d(offset); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; };

async function user(email: string, name: string, hash: string) {
  const [existing] = await db.select().from(s.users).where(eq(s.users.email, email)).limit(1);
  if (existing) return existing;
  const [u] = await db.insert(s.users).values({ email, name, passwordHash: hash, emailVerifiedAt: new Date() }).returning();
  return u!;
}

async function sampleBusiness(hash: string) {
  const [exists] = await db.select().from(s.organisations).where(eq(s.organisations.slug, "example-trading")).limit(1);
  if (exists) { console.log("Example Trading already exists — skipping."); return; }

  const amaka = await user("admin@example-trading.test", "Amaka Okafor", hash);
  const kofi = await user("manager@example-trading.test", "Kofi Mensah", hash);
  const efua = await user("member@example-trading.test", "Efua Nyarko", hash);
  const fatima = await user("hr@example-trading.test", "Fatima Abubakar", hash);

  const [org] = await db.insert(s.organisations).values({
    slug: "example-trading", legalName: "Example Trading Limited", tradingName: "Example Trading", industry: "Food and beverage distribution",
    teamSize: "51 to 200 people", country: "NG", currency: "NGN", city: "Lagos", address: "14 Creek Road, Apapa", registrationNumber: "RC 1048291",
    website: "example-trading.test", verificationStatus: "verified", ownerName: "Chinedu Okafor", ownerEmail: "chinedu@example-trading.test",
    createdBy: amaka.id, brandColor: "#1E6B47", tagline: "Fresh food, delivered to the businesses that feed Nigeria.",
    about: "Since 2012 we've supplied fresh produce and pantry staples to restaurants, hotels and shops across Lagos and Abuja.",
    setupStep: "done", settings: { leadStages: DEFAULT_LEAD_STAGES, dealStages: DEFAULT_DEAL_STAGES, perks: ["Health cover for you and your family", "Paid training and clear paths to promotion", "Staff meals and transport support", "20 days paid leave"] },
  }).returning();
  const orgId = org!.id;
  await db.insert(s.memberships).values([
    { orgId, userId: amaka.id, role: "admin", isPrimaryAdmin: true, jobTitle: "HR Manager" },
    { orgId, userId: kofi.id, role: "manager", jobTitle: "Sales Team Lead" },
    { orgId, userId: efua.id, role: "member", jobTitle: "Sales Associate" },
    { orgId, userId: fatima.id, role: "admin", jobTitle: "HR Officer" },
  ]);
  await seedOrgDefaults(db, orgId, amaka.id);

  // ---- People ----
  const deptNames = ["Sales", "Operations", "Finance", "People", "Logistics"];
  const depts: Record<string, string> = {};
  for (const name of deptNames) {
    const [row] = await db.insert(s.departments).values({ orgId, name }).returning();
    depts[name] = row!.id;
  }
  const emp = async (first: string, last: string, title: string, dept: string, opts: Partial<typeof s.employees.$inferInsert> = {}) => {
    const [row] = await db.insert(s.employees).values({
      orgId, firstName: first, lastName: last, jobTitle: title, departmentId: depts[dept], location: "Lagos", employmentType: "Full-time",
      email: `${first.toLowerCase()}.${last.toLowerCase()}@example-trading.test`, phone: "0803 555 01" + String(Math.floor(Math.random() * 90) + 10),
      startDate: ymd(-400 - Math.floor(Math.random() * 900)), status: "active", ...opts,
    }).returning();
    await db.insert(s.employmentHistory).values({ orgId, employeeId: row!.id, occurredOn: row!.startDate ?? ymd(-400), event: `Joined as ${title}` });
    return row!;
  };
  const chinedu = await emp("Chinedu", "Okafor", "Managing Director", "People");
  const ama = await emp("Ama", "Darko", "Head of Sales", "Sales", { managerId: chinedu.id, location: "Accra" });
  const ngozi = await emp("Ngozi", "Eze", "Finance Manager", "Finance", { managerId: chinedu.id });
  const yaw = await emp("Yaw", "Boakye", "Logistics Manager", "Logistics", { managerId: chinedu.id });
  const amakaE = await emp("Amaka", "Okafor", "HR Manager", "People", { managerId: chinedu.id, userId: amaka.id, email: amaka.email });
  const kofiE = await emp("Kofi", "Mensah", "Sales Team Lead", "Sales", { managerId: ama.id, userId: kofi.id, email: kofi.email, location: "Accra" });
  await emp("Fatima", "Abubakar", "HR Officer", "People", { managerId: amakaE.id, userId: fatima.id, email: fatima.email, location: "Abuja" });
  const efuaE = await emp("Efua", "Nyarko", "Sales Associate", "Sales", { managerId: kofiE.id, userId: efua.id, email: efua.email, status: "onboarding", startDate: ymd(-6) });
  const grace = await emp("Grace", "Eze", "Accounts Officer", "Finance", { managerId: ngozi.id });
  const john = await emp("John", "Obi", "Delivery Driver", "Logistics", { managerId: yaw.id });
  await emp("Tunde", "Bello", "Warehouse Supervisor", "Operations", { managerId: yaw.id, location: "Ikeja" });
  await emp("Samuel", "Boateng", "Warehouse Assistant", "Operations", { managerId: yaw.id, location: "Ikeja", status: "leaving", endDate: ymd(27) });
  await db.update(s.departments).set({ headEmployeeId: ama.id }).where(eq(s.departments.id, depts.Sales!));
  await db.update(s.departments).set({ headEmployeeId: yaw.id }).where(eq(s.departments.id, depts.Logistics!));
  await db.update(s.departments).set({ headEmployeeId: ngozi.id }).where(eq(s.departments.id, depts.Finance!));
  await db.update(s.departments).set({ headEmployeeId: amakaE.id }).where(eq(s.departments.id, depts.People!));
  await db.insert(s.employeePay).values({ employeeId: kofiE.id, orgId, salaryAmount: "650000", currency: "NGN", payFrequency: "Monthly", bankName: "Access Bank", accountNumber: "0123456789" });
  await startChecklist({ orgId, employeeId: efuaE.id, kind: "onboarding", anchorDate: ymd(-6), createdBy: amaka.id });

  const [annual] = await db.select().from(s.leaveTypes).where(eq(s.leaveTypes.orgId, orgId)).limit(1);
  await db.insert(s.leaveRequests).values({ orgId, employeeId: kofiE.id, leaveTypeId: annual!.id, startDate: ymd(-1), endDate: ymd(2), days: "3", status: "approved", decidedBy: amaka.id, decidedAt: d(-5) });
  const [graceLeave] = await db.insert(s.leaveRequests).values({ orgId, employeeId: grace.id, leaveTypeId: annual!.id, startDate: ymd(14), endDate: ymd(18), days: "5", status: "pending", requestedBy: amaka.id, reason: "Family visit" }).returning();
  await createApproval({ orgId, kind: "leave", title: "Annual leave: Grace Eze", details: `${ymd(14)} to ${ymd(18)} · 5 days`, requestedBy: amaka.id, firstApproverUserId: amaka.id, linkType: "leave_request", linkId: graceLeave!.id });

  const at = (h: number, m: number) => { const x = new Date(); x.setHours(h, m, 0, 0); return x; };
  await db.insert(s.attendance).values([
    { orgId, employeeId: amakaE.id, workDate: ymd(0), clockIn: at(8, 2) },
    { orgId, employeeId: john.id, workDate: ymd(0), clockIn: at(7, 15) },
    { orgId, employeeId: grace.id, workDate: ymd(0), clockIn: at(9, 24) },
  ]);

  // ---- Recruitment ----
  const job = async (title: string, dept: string, published: boolean, extra: Partial<typeof s.jobs.$inferInsert> = {}) => {
    const [row] = await db.insert(s.jobs).values({
      orgId, title, slug: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"), departmentId: depts[dept], location: "Lagos", employmentType: "Full-time",
      description: `We're looking for a ${title} to join our ${dept} team.\n\nWhat you'll do\n• Keep day-to-day work accurate and on time\n• Work closely with the team\n\nWhat you'll need\n• Relevant experience\n• A careful eye for detail`,
      status: published ? "open" : "draft", published, openedAt: published ? d(-10) : null, stages: DEFAULT_RECRUITMENT_STAGES,
      hiringManagerUserId: amaka.id, hiringTeamUserIds: [amaka.id, fatima.id], createdBy: amaka.id,
      questions: [
        { id: "q1", label: "How many years of relevant experience do you have?", type: "choice", options: ["Less than 1", "1 to 2", "3 to 5", "More than 5"], required: true },
        { id: "q2", label: "Can you start within 30 days?", type: "yesno", required: true },
      ], ...extra,
    }).returning();
    return row!;
  };
  const accounts = await job("Accounts Officer", "Finance", true, { salaryMin: "350000", salaryMax: "450000", showSalary: true });
  await job("Warehouse Supervisor", "Operations", true, { location: "Ikeja" });
  await job("Sales Representative", "Sales", false, { location: "Abuja", employmentType: "Contract" });
  const cand = async (first: string, last: string, stage: string, daysAgo: number) => {
    const [c] = await db.insert(s.candidates).values({ orgId, firstName: first, lastName: last, email: `${first.toLowerCase()}.${last.toLowerCase()}@example.com`, phone: "0803 555 0177", location: "Lagos" }).returning();
    const [a] = await db.insert(s.applications).values({ orgId, jobId: accounts.id, candidateId: c!.id, stage, answers: { q1: "3 to 5", q2: "Yes" }, consentAt: d(-daysAgo), createdAt: d(-daysAgo), stageChangedAt: d(-daysAgo + 1) }).returning();
    return a!;
  };
  await cand("Adaeze", "Nwosu", "Applied", 0);
  await cand("Segun", "Bello", "Applied", 1);
  await cand("Ifeoma", "Kalu", "Screening", 4);
  const chidi = await cand("Chidi", "Okeke", "Interview", 9);
  await cand("David", "Ojo", "Offer", 12);
  const iv = new Date(); iv.setDate(iv.getDate() + 2); iv.setHours(10, 0, 0, 0);
  await db.insert(s.interviews).values({ orgId, applicationId: chidi.id, title: "Final interview", scheduledAt: iv, durationMinutes: 60, mode: "office", location: "Head office", interviewerUserIds: [amaka.id] });

  // ---- CRM ----
  const company = async (name: string, industry: string, status: "prospect" | "client", contact: [string, string, string]) => {
    const [c] = await db.insert(s.companies).values({ orgId, name, industry, location: "Lagos", status, ownerUserId: kofi.id }).returning();
    await db.insert(s.contacts).values({ orgId, companyId: c!.id, name: contact[0], role: contact[1], email: contact[2], isPrimary: true });
    return c!;
  };
  const northline = await company("Northline Hotels", "Hospitality", "prospect", ["Grace Adeyemi", "Purchasing Manager", "grace@northline.example"]);
  const harbour = await company("Harbour Logistics", "Logistics", "prospect", ["Yaw Boateng", "Fleet Manager", "yaw@harbour.example"]);
  const coastal = await company("Coastal Clinic", "Healthcare", "prospect", ["Dr Ruth Lamptey", "Administrator", "ruth@coastal.example"]);
  const apex = await company("Apex Bakery", "Retail", "prospect", ["Bayo Ade", "Owner", "bayo@apex.example"]);
  const greenfield = await company("Greenfield Farms", "Agriculture", "client", ["Kwame Asare", "Director", "kwame@greenfield.example"]);
  const deal = async (companyId: string, name: string, value: number, stage: string, extra: Partial<typeof s.deals.$inferInsert> = {}) =>
    db.insert(s.deals).values({ orgId, companyId, name, value: String(value), currency: "NGN", stage, ownerUserId: kofi.id, expectedCloseOn: ymd(20), ...extra });
  await deal(northline.id, "Linen and produce", 4_200_000, "Proposal", { nextStep: "Call Grace about the proposal", expectedCloseOn: ymd(10) });
  await deal(harbour.id, "Fleet catering", 3_100_000, "Qualified", { nextStep: "Send revised price list" });
  await deal(coastal.id, "Patient meals", 1_900_000, "Proposal", { nextStep: "Site visit and tasting" });
  await deal(apex.id, "Flour and sugar", 2_100_000, "Negotiation", { nextStep: "Contract review" });
  await deal(greenfield.id, "Distribution", 5_400_000, "Negotiation", { status: "won", wonAt: d(-4) });
  await deal(northline.id, "Event catering", 800_000, "Proposal", { status: "lost", lostAt: d(-30), lostReason: "Price" });
  await db.insert(s.leads).values([
    { orgId, companyName: "Bluegate Schools", contactName: "Head of Admin", source: "Website", stage: "To contact", ownerUserId: efua.id, nextStep: "Reach out", nextStepDue: ymd(2), estimatedValue: "2000000" },
    { orgId, companyName: "Savanna Mart", source: "Trade fair", stage: "To contact", ownerUserId: kofi.id, nextStep: "Find a contact" },
    { orgId, companyName: "Palm Hotel Abuja", contactName: "Emeka Obi", contactRole: "General Manager", source: "Cold call", stage: "Contacted", ownerUserId: kofi.id, nextStep: "Follow up", nextStepDue: ymd(-1) },
    { orgId, companyName: "Ace Foods Kitchen", contactName: "Bayo Ade", source: "LinkedIn", stage: "Interested", ownerUserId: fatima.id, qualification: { need: true, budget: true } },
    { orgId, companyName: "Kente Textiles", contactName: "Adjoa Mensah", contactRole: "Operations Director", source: "Referral", stage: "Qualified", ownerUserId: kofi.id, estimatedValue: "3600000", qualification: { need: true, budget: true, decisionMaker: true, timeline: true } },
  ]);
  await db.insert(s.activities).values({ orgId, companyId: northline.id, type: "meeting", subject: "Proposal walkthrough", body: "Liked the produce range. Concerned about linen turnaround times.", occurredAt: d(-5), authorUserId: kofi.id });

  // ---- Workflows ----
  await createTask({ orgId, title: "Call Grace about the linen proposal", workspace: "crm", assigneeUserId: kofi.id, createdBy: kofi.id, dueAt: d(-1), priority: "high", linkType: "company", linkId: northline.id, linkLabel: "Northline Hotels" });
  await createTask({ orgId, title: "Renew service agreement", workspace: "documents", assigneeUserId: amaka.id, createdBy: kofi.id, dueAt: d(0), priority: "high", linkType: "company", linkId: northline.id, linkLabel: "Northline Hotels" });
  await createTask({ orgId, title: "Send revised price list", workspace: "crm", assigneeUserId: amaka.id, createdBy: amaka.id, dueAt: d(0), linkType: "company", linkId: harbour.id, linkLabel: "Harbour Logistics" });
  await createTask({ orgId, title: "Schedule second interview", workspace: "recruitment", assigneeUserId: amaka.id, createdBy: amaka.id, dueAt: d(3), linkType: "application", linkId: chidi.id, linkLabel: "Chidi Okeke · Accounts Officer" });
  await createTask({ orgId, title: "Monthly stock count", workspace: "workflows", assigneeUserId: amaka.id, createdBy: amaka.id, dueAt: d(25) });
  await db.insert(s.approvalRules).values({ orgId, kind: "purchase", minAmount: "250000", approverUserId: fatima.id, label: "Finance" });
  await createApproval({ orgId, kind: "purchase", title: "Delivery van tyres", details: "4 tyres for van LAG-482-KJ. Two are worn below the safe limit.", amount: 480000, requestedBy: kofi.id, firstApproverUserId: amaka.id, firstLabel: "Operations manager" });

  console.log("✓ Example Trading created — sign in as admin@example-trading.test /", PASSWORD);
}

const hash = await hashPassword(PASSWORD);
await sampleBusiness(hash);
await sql.end();
