import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import type { FastifyInstance } from "fastify";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../src/db/client";
import { auditEvents, departments, employees } from "../src/db/schema";
import { Client, addMember, getApp, signUpWithOrg } from "./helpers";

async function upload(app: FastifyInstance, c: Client, fileName: string, content: string | Buffer) {
  const boundary = "----windvealtest" + Math.random().toString(16).slice(2);
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: text/csv\r\n\r\n`),
    typeof content === "string" ? Buffer.from(content) : content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await app.inject({
    method: "POST", url: "/api/imports/upload", payload: body,
    headers: { "content-type": `multipart/form-data; boundary=${boundary}`, cookie: Object.entries(c.cookies).map(([k, v]) => `${k}=${v}`).join("; ") },
  });
  return { status: res.statusCode, body: res.json() };
}

const STAFF_CSV = [
  "Full Name,Email,Dept,Start,Mgr,Phone No.",
  "Ngozi Eze,ngozi@example.test,Finance,03/02/2021,,0803 555 0100",
  "Amaka Okafor,amaka@example.test,Finance,15/07/2022,N. Eze,0803 555 0142",
  "Kofi Mensah,kofi.mensah@gmail.com,Sales,01/03/2020,Ngozi Eze,0812 555 0199",
  "Efua Nyarko,efua@bad,Sales,02/04/2023,,0705 555 0110",
  "John Obi,john@example.test,Operations,1 Mar 2020,Someone Unknown,0909 555 0137",
].join("\n");

async function orgIdOf(c: Client) {
  return (await c.get("/api/auth/me")).body.org.id as string;
}

describe("imports", () => {
  it("uploads, reviews, commits only ready rows, links managers and undoes", async () => {
    const app = await getApp();
    const { c } = await signUpWithOrg(app);
    const orgId = await orgIdOf(c);
    // An existing employee who also appears in the file.
    const [existing] = await db.insert(employees).values({ orgId, firstName: "Kofi", lastName: "Mensah", email: "kofi.m@example.test" }).returning();

    const up = await upload(app, c, "staff_list.csv", STAFF_CSV);
    expect(up.status).toBe(200);
    const job = up.body.job;
    expect(job.sheets).toHaveLength(1);
    const sheet = job.sheets[0];
    expect(sheet.destination).toBe("people.employees");
    expect(sheet.confidence).toBeGreaterThanOrEqual(0.5);
    expect(sheet.mapping["Full Name"]).toBe("fullName");
    expect(sheet.mapping["Dept"]).toBe("department");
    expect(sheet.mapping["Start"]).toBe("startDate");
    expect(sheet.mapping["Mgr"]).toBe("manager");
    expect(sheet.dateFormat).toBe("dmy");

    // Confirm the sheet (as the Sheets step does).
    const patched = await c.patch(`/api/imports/jobs/${job.id}/sheets`, { sheets: [{ name: sheet.name, include: true, destination: "people.employees" }] });
    expect(patched.status).toBe(200);

    const attention = await c.get(`/api/imports/jobs/${job.id}/rows?tab=attention`);
    expect(attention.status).toBe(200);
    expect(attention.body.counts).toMatchObject({ all: 5, ready: 3, attention: 2 });
    const invalid = attention.body.rows.find((r: any) => r.status === "invalid");
    expect(invalid.label).toBe("Efua Nyarko");
    expect(invalid.issues[0].message).toContain("Email address isn't valid");
    const dup = attention.body.rows.find((r: any) => r.status === "duplicate");
    expect(dup.label).toBe("Kofi Mensah");
    expect(dup.duplicateOfId).toBe(existing!.id);
    expect(dup.decision).toBe("skip");

    const cmp = await c.get(`/api/imports/jobs/${job.id}/duplicate/${dup.id}`);
    expect(cmp.body.existing.email).toBe("kofi.m@example.test");
    expect(cmp.body.incoming.email).toBe("kofi.mensah@gmail.com");

    const ready = await c.get(`/api/imports/jobs/${job.id}/rows?tab=ready`);
    const john = ready.body.rows.find((r: any) => r.label === "John Obi");
    expect(john.values.startDate).toBe("2020-03-01");
    expect(john.issues.some((i: any) => i.field === "manager")).toBe(true);

    // Nothing is written before commit.
    const before = await db.select().from(employees).where(and(eq(employees.orgId, orgId), isNull(employees.deletedAt)));
    expect(before).toHaveLength(1);
    expect(await db.select().from(departments).where(eq(departments.orgId, orgId))).toHaveLength(0);

    const summary = await c.get(`/api/imports/jobs/${job.id}/summary`);
    expect(summary.body.summary.toImport).toBe(3);
    expect(summary.body.summary.newDepartments).toBe(2);
    expect(summary.body.summary.managers).toEqual({ linked: 1, blank: 1 });

    expect((await c.post(`/api/imports/jobs/${job.id}/commit`, {})).status).toBe(400);
    const commit = await c.post(`/api/imports/jobs/${job.id}/commit`, { confirm: true });
    expect(commit.status).toBe(200);
    expect(commit.body.job.status).toBe("committed");
    expect(commit.body.job.summary.added).toBe(3);
    expect(commit.body.job.canUndo).toBe(true);

    const after = await db.select().from(employees).where(and(eq(employees.orgId, orgId), isNull(employees.deletedAt)));
    expect(after).toHaveLength(4);
    expect(after.some((e) => e.firstName === "Efua")).toBe(false);
    const ngozi = after.find((e) => e.firstName === "Ngozi")!;
    const amaka = after.find((e) => e.firstName === "Amaka")!;
    const john2 = after.find((e) => e.firstName === "John")!;
    expect(amaka.managerId).toBe(ngozi.id);
    expect(john2.managerId).toBeNull();
    const depts = await db.select().from(departments).where(and(eq(departments.orgId, orgId), isNull(departments.deletedAt)));
    expect(depts.map((d) => d.name).sort()).toEqual(["Finance", "Operations"]);
    expect(amaka.departmentId).toBe(depts.find((d) => d.name === "Finance")!.id);

    // Committing twice is refused.
    expect((await c.post(`/api/imports/jobs/${job.id}/commit`, { confirm: true })).status).toBe(409);

    const history = await c.get("/api/imports/jobs");
    expect(history.body[0]).toMatchObject({ fileName: "staff_list.csv", added: 3, status: "committed" });

    const undo = await c.post(`/api/imports/jobs/${job.id}/undo`);
    expect(undo.status).toBe(200);
    expect(undo.body.removed).toBe(3);
    const remaining = await db.select().from(employees).where(and(eq(employees.orgId, orgId), isNull(employees.deletedAt)));
    expect(remaining.map((e) => e.id)).toEqual([existing!.id]);
    expect(await db.select().from(departments).where(and(eq(departments.orgId, orgId), isNull(departments.deletedAt)))).toHaveLength(0);

    const events = await db.select().from(auditEvents).where(eq(auditEvents.orgId, orgId));
    expect(events.some((e) => e.action === "import.committed" && e.summary.includes("3 added"))).toBe(true);
    expect(events.some((e) => e.action === "import.undone")).toBe(true);
  });

  it("applies duplicate decisions, edits and exclusions", async () => {
    const app = await getApp();
    const { c } = await signUpWithOrg(app);
    const orgId = await orgIdOf(c);
    const [existing] = await db.insert(employees).values({ orgId, firstName: "Kofi", lastName: "Mensah", email: "kofi.m@example.test", jobTitle: "Rep" }).returning();
    const up = await upload(app, c, "staff.csv", STAFF_CSV);
    const jobId = up.body.job.id;
    const rows = (await c.get(`/api/imports/jobs/${jobId}/rows?tab=all`)).body.rows;
    const kofi = rows.find((r: any) => r.label === "Kofi Mensah");
    const efua = rows.find((r: any) => r.label === "Efua Nyarko");
    const john = rows.find((r: any) => r.label === "John Obi");
    expect((await c.patch(`/api/imports/rows/${kofi.id}`, { decision: "update" })).body.row.decision).toBe("update");
    const fixed = await c.patch(`/api/imports/rows/${efua.id}`, { values: { email: "efua@example.test" } });
    expect(fixed.body.row.status).toBe("ready");
    expect((await c.patch(`/api/imports/rows/${john.id}`, { excluded: true })).body.row.status).toBe("excluded");
    const commit = await c.post(`/api/imports/jobs/${jobId}/commit`, { confirm: true });
    expect(commit.body.job.summary).toMatchObject({ added: 3, updated: 1 });
    const [k] = await db.select().from(employees).where(eq(employees.id, existing!.id));
    expect(k!.email).toBe("kofi.mensah@gmail.com");
    expect(k!.version).toBeGreaterThan(1);
    expect(k!.managerId).not.toBeNull();
    // Undo keeps the updated record.
    await c.post(`/api/imports/jobs/${jobId}/undo`);
    const [k2] = await db.select().from(employees).where(eq(employees.id, existing!.id));
    expect(k2!.deletedAt).toBeNull();
  });

  it("suggests CRM and recruitment destinations and flags unclear sheets", async () => {
    const app = await getApp();
    const { c } = await signUpWithOrg(app);
    const clients = await upload(app, c, "clients.csv", "Company,Contact person,Email,City\nNorthline Hotels,Grace Adeyemi,grace@northline.ng,Lagos\n");
    expect(clients.body.job.sheets[0].destination).toBe("crm.companies");
    const leadsUp = await upload(app, c, "pipeline.csv", "Company,Contact,Source,Estimated value\nBluegate,Ada,Referral,1.5m\n");
    expect(leadsUp.body.job.sheets[0].destination).toBe("crm.leads");
    const jobsUp = await upload(app, c, "open_roles.csv", "Job title,Department,Location\nSales Associate,Sales,Lagos\n");
    expect(jobsUp.body.job.sheets[0].destination).toBe("recruitment.jobs");
    const notes = await upload(app, c, "notes.csv", "Date,Note,By\n12/09/2026,Call Northline,Kofi\n");
    expect(notes.body.job.sheets[0].destination).toBeNull();
    expect(notes.body.job.sheets[0].confidence).toBeLessThan(0.5);

    const commit = await c.post(`/api/imports/jobs/${leadsUp.body.job.id}/commit`, { confirm: true });
    expect(commit.body.job.summary.leads).toBe(1);
    const tpl = await app.inject({ method: "GET", url: "/api/imports/templates/people.employees", headers: { cookie: `wv_session=${c.cookies.wv_session}` } });
    expect(tpl.headers["content-disposition"]).toContain("attachment");
    expect(tpl.body).toContain("Employee name");
  });

  it("requires manage access and keeps organisations apart", async () => {
    const app = await getApp();
    const { c: admin } = await signUpWithOrg(app);
    const { c: member } = await addMember(app, admin, "member");
    expect((await upload(app, member, "staff.csv", STAFF_CSV)).status).toBe(403);

    const up = await upload(app, admin, "staff.csv", STAFF_CSV);
    const other = await signUpWithOrg(app);
    expect((await other.c.get(`/api/imports/jobs/${up.body.job.id}`)).status).toBe(404);
    expect((await other.c.get(`/api/imports/jobs/${up.body.job.id}/rows`)).status).toBe(404);
    expect((await other.c.post(`/api/imports/jobs/${up.body.job.id}/commit`, { confirm: true })).status).toBe(404);
    expect((await other.c.get("/api/imports/jobs")).body).toHaveLength(0);
    const rowId = (await admin.get(`/api/imports/jobs/${up.body.job.id}/rows`)).body.rows[0].id;
    expect((await other.c.patch(`/api/imports/rows/${rowId}`, { excluded: true })).status).toBe(404);
  });

  it("reads every worksheet of an Excel file, with dates as ISO", async () => {
    const app = await getApp();
    const { c } = await signUpWithOrg(app);
    const wb = new ExcelJS.Workbook();
    const staff = wb.addWorksheet("Employees");
    staff.addRow([]);
    staff.addRow(["Full Name", "Dept", "Start", "Email"]);
    staff.addRow(["Amaka Okafor", "Finance", new Date(Date.UTC(2021, 1, 3)), { text: "amaka@example.test", hyperlink: "mailto:amaka@example.test" }]);
    const clients = wb.addWorksheet("Clients");
    clients.addRow(["Company", "Contact person", "Email"]);
    clients.addRow(["Northline Hotels", "Grace Adeyemi", "grace@northline.ng"]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer() as ArrayBuffer);
    const up = await upload(app, c, "staff_records.xlsx", buf);
    expect(up.status).toBe(200);
    const [s1, s2] = up.body.job.sheets;
    expect(s1).toMatchObject({ name: "Employees", rowCount: 1, destination: "people.employees" });
    expect(s2).toMatchObject({ name: "Clients", rowCount: 1, destination: "crm.companies" });
    const rows = (await c.get(`/api/imports/jobs/${up.body.job.id}/rows?sheet=Employees`)).body.rows;
    expect(rows[0].rowNumber).toBe(3);
    expect(rows[0].values).toMatchObject({ startDate: "2021-02-03", email: "amaka@example.test", department: "Finance" });
    const commit = await c.post(`/api/imports/jobs/${up.body.job.id}/commit`, { confirm: true });
    expect(commit.body.job.summary).toMatchObject({ added: 2, employees: 1, companies: 1, contacts: 1 });
  });

  it("imports ID columns and keeps every other column unless the person skips it", async () => {
    const app = await getApp();
    const { c } = await signUpWithOrg(app);
    const orgId = await orgIdOf(c);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Staff");
    ws.addRow(["Staff ID", "Full Name", "Email", "Grade", "Blood group", "Notes to skip"]);
    ws.addRow([1001, "Ngozi Eze", "ngozi@example.test", "Level 8", "O+", "old"]);
    ws.addRow([1002, "Kofi Mensah", "kofi@example.test", "Level 6", "A-", "old"]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer() as ArrayBuffer);

    const up = await upload(app, c, "staff.xlsx", buf);
    const job = up.body.job;
    const sheet = job.sheets[0];
    expect(sheet.mapping["Staff ID"]).toBe("reference");
    // No matching field: kept, not dropped.
    expect(sheet.mapping["Grade"]).toBe("__keep");
    expect(sheet.mapping["Blood group"]).toBe("__keep");
    // Only the person importing can skip a column.
    await c.patch(`/api/imports/jobs/${job.id}/sheets`, { sheets: [{ name: "Staff", include: true, destination: "people.employees" }] });
    expect((await c.patch(`/api/imports/jobs/${job.id}/sheets`, { sheets: [{ name: "Staff", mapping: { "Notes to skip": null } }] })).status).toBe(200);
    const commit = await c.post(`/api/imports/jobs/${job.id}/commit`, { confirm: true });
    expect(commit.status).toBe(200);

    const rows = await db.select().from(employees).where(and(eq(employees.orgId, orgId), isNull(employees.deletedAt)));
    const ngozi = rows.find((e) => e.firstName === "Ngozi")!;
    expect(ngozi.reference).toBe("1001");
    expect(ngozi.extraDetails).toEqual({ Grade: "Level 8", "Blood group": "O+" });
    // A copy of what was imported is kept in Documents › Imports.
    const lib = await c.get("/api/documents/files?q=imported");
    expect(JSON.stringify(lib.body)).toMatch(/staff \(imported/);
    const profile = await c.get(`/api/people/employees/${ngozi.id}`);
    expect(profile.body.reference).toBe("1001");
    expect(profile.body.extraDetails).toMatchObject({ Grade: "Level 8" });

    // The same ID in a later file is the same person, even if the name changed.
    const wb2 = new ExcelJS.Workbook();
    const ws2 = wb2.addWorksheet("Staff");
    ws2.addRow(["Staff ID", "Full Name", "Grade"]);
    ws2.addRow([1001, "Ngozi Eze-Bello", "Level 9"]);
    const up2 = await upload(app, c, "staff2.xlsx", Buffer.from(await wb2.xlsx.writeBuffer() as ArrayBuffer));
    await c.patch(`/api/imports/jobs/${up2.body.job.id}/sheets`, { sheets: [{ name: "Staff", include: true, destination: "people.employees" }] });
    const r2 = (await c.get(`/api/imports/jobs/${up2.body.job.id}/rows?sheet=Staff`)).body.rows[0];
    expect(r2.status).toBe("duplicate");
    expect((await c.patch(`/api/imports/rows/${r2.id}`, { decision: "update" })).status).toBe(200);
    await c.post(`/api/imports/jobs/${up2.body.job.id}/commit`, { confirm: true });
    const [after] = await db.select().from(employees).where(eq(employees.id, ngozi.id));
    expect(after!.firstName).toBe("Ngozi");
    expect(after!.lastName).toBe("Eze-Bello");
    expect(after!.extraDetails).toEqual({ Grade: "Level 9", "Blood group": "O+" });
  });
});
