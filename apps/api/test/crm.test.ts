import { describe, expect, it } from "vitest";
import { addMember, getApp, giveAccess, signUpWithOrg } from "./helpers";

describe("crm: leads", () => {
  it("qualifies and converts a lead, reusing an existing company and starting the deal at Qualified", async () => {
    const app = await getApp();
    const { c } = await signUpWithOrg(app);

    // An existing company with one contact (e.g. from an import).
    const co = await c.post("/api/crm/companies", { name: "Kente Textiles", industry: "Manufacturing" });
    expect(co.status).toBe(200);
    await c.post(`/api/crm/companies/${co.body.id}/contacts`, { name: "Kwame Asante", email: "kwame@kente.example" });

    const lead = await c.post("/api/crm/leads", {
      companyName: "  kente textiles ", contactName: "Adjoa Mensah", contactRole: "Operations Director",
      email: "adjoa@kente.example", source: "Referral", estimatedValue: "3600000",
    });
    expect(lead.status).toBe(200);
    expect(lead.body.stage).toBe("To contact");

    expect((await c.post(`/api/crm/leads/${lead.body.id}/move`, { stage: "Nowhere" })).status).toBe(400);
    expect((await c.post(`/api/crm/leads/${lead.body.id}/move`, { stage: "Qualified" })).status).toBe(200);
    const q = await c.put(`/api/crm/leads/${lead.body.id}/qualification`, { need: true, budget: true, decisionMaker: true, timeline: true, notes: { budget: "Approved for Q1" } });
    expect(q.body.qualificationScore).toBe(4);

    const preview = await c.get(`/api/crm/leads/${lead.body.id}/convert-preview`);
    expect(preview.status).toBe(200);
    expect(preview.body.existingCompany.id).toBe(co.body.id);
    expect(preview.body.existingCompany.contactCount).toBe(1);

    const conv = await c.post(`/api/crm/leads/${lead.body.id}/convert`, {
      useExistingCompanyId: co.body.id,
      contact: { name: "Adjoa Mensah", role: "Operations Director", email: "adjoa@kente.example", phone: "" },
      deal: { name: "Staff canteen supply", value: 3600000 },
    });
    expect(conv.status).toBe(200);
    expect(conv.body.companyId).toBe(co.body.id);
    expect(conv.body.createdCompany).toBe(false);

    const companies = (await c.get("/api/crm/companies")).body;
    const kente = companies.filter((x: any) => x.name.toLowerCase().includes("kente"));
    expect(kente).toHaveLength(1);
    expect(kente[0].contactCount).toBe(2);
    expect(kente[0].openDeals).toBe(1);
    expect(kente[0].openValue).toBe(3600000);

    const detail = (await c.get(`/api/crm/companies/${co.body.id}`)).body;
    expect(detail.contacts).toHaveLength(2);
    expect(detail.deals).toHaveLength(1);
    expect(detail.deals[0].stage).toBe("Qualified");
    expect(detail.deals[0].value).toBe(3600000);

    const after = (await c.get(`/api/crm/leads/${lead.body.id}`)).body.lead;
    expect(after.stage).toBe("Closed");
    expect(after.closedOutcome).toBe("converted");
    expect(after.convertedDealId).toBe(conv.body.dealId);

    // Converting twice is refused and creates nothing.
    const again = await c.post(`/api/crm/leads/${lead.body.id}/convert`, { useExistingCompanyId: co.body.id, deal: { name: "Again" } });
    expect(again.status).toBe(409);
    expect((await c.get(`/api/crm/companies/${co.body.id}`)).body.deals).toHaveLength(1);

    const audit = (await c.get("/api/audit")).body.items;
    // Everyday CRM work isn't kept in the audit history.
    expect(audit.some((e: any) => e.action.startsWith("crm."))).toBe(false);
  });

  it("closes a lead as not interested with a reason", async () => {
    const app = await getApp();
    const { c } = await signUpWithOrg(app);
    const lead = await c.post("/api/crm/leads", { companyName: "Lekki Snacks", source: "Website" });
    expect((await c.post(`/api/crm/leads/${lead.body.id}/close`, {})).status).toBe(400);
    const closed = await c.post(`/api/crm/leads/${lead.body.id}/close`, { reason: "Has a supplier" });
    expect(closed.body.closedOutcome).toBe("not_interested");
    const board = (await c.get("/api/crm/leads")).body;
    expect(board.items.find((l: any) => l.id === lead.body.id).stage).toBe("Closed");
    expect(board.stats.active).toBe(0);
  });
});

describe("crm: deals", () => {
  it("marking a deal won turns the company into a client and counts in the overview", async () => {
    const app = await getApp();
    const { c } = await signUpWithOrg(app);
    const deal = await c.post("/api/crm/deals", { newCompany: { name: "Greenfield Farms" }, name: "Distribution", value: 5400000 });
    expect(deal.status).toBe(200);
    expect(deal.body.stage).toBe("Qualified");
    expect((await c.post(`/api/crm/deals/${deal.body.id}/move`, { stage: "Proposal" })).body.stage).toBe("Proposal");

    let ov = (await c.get("/api/crm/overview")).body;
    expect(ov.stats.openValue).toBe(5400000);
    expect(ov.pipeline.find((p: any) => p.stage === "Proposal").count).toBe(1);

    const won = await c.post(`/api/crm/deals/${deal.body.id}/won`);
    expect(won.status).toBe(200);
    expect(won.body.status).toBe("won");

    const company = (await c.get(`/api/crm/companies/${deal.body.companyId}`)).body.company;
    expect(company.status).toBe("client");

    ov = (await c.get("/api/crm/overview")).body;
    expect(ov.stats.wonThisMonth).toBe(5400000);
    expect(ov.stats.wonThisMonthCount).toBe(1);
    expect(ov.stats.winRate).toBe(100);
    expect(ov.stats.openCount).toBe(0);
    expect(ov.recentWins[0].id).toBe(deal.body.id);

    // Lost with a reason, then reopened.
    const d2 = await c.post("/api/crm/deals", { companyId: deal.body.companyId, name: "Event catering", value: 800000 });
    expect((await c.post(`/api/crm/deals/${d2.body.id}/lost`, { reason: "Price" })).body.status).toBe("lost");
    expect((await c.get("/api/crm/overview")).body.stats.winRate).toBe(50);
    expect((await c.post(`/api/crm/deals/${d2.body.id}/reopen`)).body.status).toBe("open");
  });

  it("won't remove a deal stage that still has open deals, and keeps other settings", async () => {
    const app = await getApp();
    const { c } = await signUpWithOrg(app);
    await c.post("/api/crm/deals", { newCompany: { name: "Apex Bakery" }, name: "Flour", stage: "Negotiation" });
    expect((await c.put("/api/crm/stages/deals", { stages: ["Qualified", "Proposal"] })).status).toBe(409);
    expect((await c.put("/api/crm/stages/deals", { stages: ["Qualified", "Proposal", "Negotiation", "Contract"] })).status).toBe(200);
    expect((await c.put("/api/crm/stages/deals", { stages: ["Qualified", "Won"] })).status).toBe(400);
    const s = (await c.get("/api/crm/stages")).body;
    expect(s.dealStages).toEqual(["Qualified", "Proposal", "Negotiation", "Contract"]);
    expect(s.leadStages).toEqual(["To contact", "Contacted", "Interested", "Qualified"]);
  });
});

describe("crm: activities and follow-ups", () => {
  it("logging an activity with a follow-up creates a crm task", async () => {
    const app = await getApp();
    const { c } = await signUpWithOrg(app);
    const co = await c.post("/api/crm/companies", { name: "Northline Hotels" });
    const due = new Date(Date.now() - 86_400_000).toISOString();
    const r = await c.post("/api/crm/activities", {
      type: "call", subject: "Call with Grace", body: "Interested. Current supplier is late too often.", durationMinutes: 12,
      companyId: co.body.id, followUp: { title: "Call Grace about the proposal", dueAt: due },
    });
    expect(r.status).toBe(200);
    expect(r.body.taskId).toBeTruthy();

    const detail = (await c.get(`/api/crm/companies/${co.body.id}`)).body;
    expect(detail.activities).toHaveLength(1);
    expect(detail.activities[0].type).toBe("call");
    expect(detail.nextFollowUp.title).toBe("Call Grace about the proposal");

    const fu = (await c.get("/api/crm/follow-ups")).body;
    expect(fu.overdue).toHaveLength(1);
    expect(fu.overdue[0].linkType).toBe("company");
    expect(fu.overdue[0].companyId).toBe(co.body.id);

    const ov = (await c.get("/api/crm/overview")).body;
    expect(ov.stats.followUpsDue).toBe(1);
    expect(ov.stats.followUpsOverdue).toBe(1);

    expect((await c.post(`/api/crm/follow-ups/${r.body.taskId}/done`)).status).toBe(200);
    expect((await c.get("/api/crm/follow-ups")).body.total).toBe(0);

    // Empty activity is rejected.
    expect((await c.post("/api/crm/activities", { type: "note", companyId: co.body.id })).status).toBe(400);
  });
});

describe("crm: access", () => {
  it("members without crm access get 403", async () => {
    const app = await getApp();
    const { c: admin } = await signUpWithOrg(app);
    const { c: member, email } = await addMember(app, admin, "member", "Kofi Mensah");
    // New members open only My Workspace until an admin gives them more.
    expect((await member.get("/api/crm/overview")).status).toBe(403);
    await giveAccess(admin, email, { crm: "edit" });
    expect((await member.get("/api/crm/overview")).status).toBe(200);
    const m = (await admin.get("/api/members")).body.find((x: any) => !x.isYou);
    expect((await admin.patch(`/api/members/${m.id}`, { workspaceAccess: { crm: "none" } })).status).toBe(200);
    expect((await member.get("/api/crm/overview")).status).toBe(403);
    expect((await member.get("/api/crm/companies")).status).toBe(403);
    expect((await member.post("/api/crm/leads", { companyName: "X" })).status).toBe(403);

    // View-only can read but not write; stage editing needs manage.
    await admin.patch(`/api/members/${m.id}`, { workspaceAccess: { crm: "view" } });
    expect((await member.get("/api/crm/leads")).status).toBe(200);
    expect((await member.post("/api/crm/leads", { companyName: "X" })).status).toBe(403);
    await admin.patch(`/api/members/${m.id}`, { workspaceAccess: { crm: "edit" } });
    expect((await member.put("/api/crm/stages/leads", { stages: ["New"] })).status).toBe(403);
  });

  it("keeps organisations isolated (404 across orgs)", async () => {
    const app = await getApp();
    const a = await signUpWithOrg(app);
    const b = await signUpWithOrg(app);
    const co = await a.c.post("/api/crm/companies", { name: "Coastal Clinic" });
    const deal = await a.c.post("/api/crm/deals", { companyId: co.body.id, name: "Patient meals", value: 1900000 });
    const lead = await a.c.post("/api/crm/leads", { companyName: "Unity Canteens" });
    expect((await b.c.get(`/api/crm/companies/${co.body.id}`)).status).toBe(404);
    expect((await b.c.get(`/api/crm/deals/${deal.body.id}`)).status).toBe(404);
    expect((await b.c.post(`/api/crm/deals/${deal.body.id}/won`)).status).toBe(404);
    expect((await b.c.get(`/api/crm/leads/${lead.body.id}`)).status).toBe(404);
    expect((await b.c.post("/api/crm/activities", { type: "note", body: "x", companyId: co.body.id })).status).toBe(404);
    expect((await b.c.post("/api/crm/deals", { companyId: co.body.id, name: "Steal" })).status).toBe(404);
    expect((await b.c.post(`/api/crm/leads/${lead.body.id}/convert`, { useExistingCompanyId: co.body.id, deal: { name: "x" } })).status).toBe(404);
    expect((await b.c.get("/api/crm/companies")).body).toHaveLength(0);
  });
});
