import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { employees, fileLinks, tasks } from "../src/db/schema";
import { addMember, getApp, signUpWithOrg } from "./helpers";

const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n", "latin1");

function multipart(fields: Record<string, string>, file?: { name: string; type: string; data: Buffer }) {
  const boundary = `----wvtest${Date.now()}`;
  const chunks: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  if (file) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="cv"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`));
    chunks.push(file.data, Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

async function apply(app: FastifyInstance, slug: string, jobSlug: string, fields: Record<string, string>, file?: { name: string; type: string; data: Buffer }) {
  const body = multipart(fields, file);
  const r = await app.inject({ method: "POST", url: `/api/careers/${slug}/jobs/${jobSlug}/apply`, payload: body.payload, headers: body.headers });
  return { status: r.statusCode, body: r.json() };
}

const JOB = {
  title: "Accounts Officer", location: "Lagos", employmentType: "Full-time", salaryMin: 250000, salaryMax: 320000, showSalary: true,
  description: "Keep our books in order.", status: "open",
  questions: [
    { id: "years", label: "Years of accounting experience", type: "choice", options: ["0 to 2 years", "3 to 5 years", "6+ years"], required: true },
    { id: "start", label: "Can you start within 30 days?", type: "yesno", required: true },
    { label: "Expected monthly salary", type: "number", required: false },
  ],
};

describe("recruitment and careers", () => {
  it("runs from job to hire, with the public careers contract", async () => {
    const app = await getApp();
    const { c: admin, org } = await signUpWithOrg(app);

    const created = await admin.post("/api/recruitment/jobs", JOB);
    expect(created.status).toBe(200);
    const job = created.body.job;
    expect(job.slug).toBe("accounts-officer");
    expect(job.stages).toEqual(["Applied", "Screening", "Interview", "Offer", "Hired"]);
    expect(job.isLive).toBe(false);
    expect(job.publicUrl).toContain(`/careers/${org.slug}/jobs/accounts-officer`);
    expect(job.questions[2].id).toBeTruthy();

    // A second job with the same title gets a different slug.
    const second = await admin.post("/api/recruitment/jobs", { title: "Accounts Officer" });
    expect(second.body.job.slug).toBe("accounts-officer-2");

    const missing = await app.inject({ method: "GET", url: `/api/careers/no-such-org-xyz` });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toEqual({ code: "not_live", message: "This careers page isn't available." });

    // Not published yet: not listed.
    const empty = await app.inject({ method: "GET", url: `/api/careers/${org.slug}` });
    expect(empty.statusCode).toBe(200);
    expect(empty.json().jobs).toHaveLength(0);

    const pub = await admin.patch(`/api/recruitment/jobs/${job.id}`, { published: true });
    expect(pub.status).toBe(200);
    expect(pub.body.job.isLive).toBe(true);

    const list = (await app.inject({ method: "GET", url: `/api/careers/${org.slug}` })).json();
    expect(Object.keys(list.org).sort()).toEqual(
      ["about", "brandColor", "city", "country", "coverUrl", "industry", "logoUrl", "name", "perks", "slug", "tagline", "teamSize", "website"].sort(),
    );
    expect(list.org.perks).toEqual([]);
    expect(list.jobs).toHaveLength(1);
    expect(list.jobs[0]).toMatchObject({ id: job.id, slug: "accounts-officer", title: "Accounts Officer", department: null, location: "Lagos", employmentType: "Full-time", isNew: true });

    const detail = (await app.inject({ method: "GET", url: `/api/careers/${org.slug}/jobs/accounts-officer` })).json();
    expect(detail.job.salary).toEqual({ min: 250000, max: 320000, period: "month", currency: "NGN" });
    expect(detail.job.questions[0]).toEqual({ id: "years", label: "Years of accounting experience", type: "choice", options: ["0 to 2 years", "3 to 5 years", "6+ years"], required: true });
    expect(detail.job.questions[1]).toEqual({ id: "start", label: "Can you start within 30 days?", type: "yesno", required: true });
    expect((await app.inject({ method: "GET", url: `/api/careers/${org.slug}/jobs/accounts-officer-2` })).statusCode).toBe(404);

    // Validation: missing CV, consent and required answers.
    const bad = await apply(app, org.slug, "accounts-officer", { firstName: "Chidi", lastName: "", email: "nope", answers: "{}" });
    expect(bad.status).toBe(400);
    expect(Object.keys(bad.body.error.details)).toEqual(expect.arrayContaining(["lastName", "email", "consent", "cv", "answers.years", "answers.start"]));
    const wrongType = await apply(app, org.slug, "accounts-officer",
      { firstName: "Chidi", lastName: "Okeke", email: "chidi@example.com", consent: "true", answers: JSON.stringify({ years: "3 to 5 years", start: "yes" }) },
      { name: "cv.exe", type: "application/octet-stream", data: Buffer.from("MZ") });
    expect(wrongType.status).toBe(400);
    expect(wrongType.body.error.details.cv).toBeTruthy();

    const ok = await apply(app, org.slug, "accounts-officer", {
      firstName: "Chidi", lastName: "Okeke", email: "Chidi@Example.com", phone: "0803 555 0177", location: "Surulere, Lagos",
      coverLetter: "I'd love to join.", consent: "true", answers: JSON.stringify({ years: "3 to 5 years", start: "yes" }),
    }, { name: "Chidi_Okeke_CV.pdf", type: "application/pdf", data: PDF });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true });
    const again = await apply(app, org.slug, "accounts-officer", {
      firstName: "Chidi", lastName: "Okeke", email: "chidi@example.com", consent: "true", answers: JSON.stringify({ years: "3 to 5 years", start: "no" }),
    }, { name: "cv.pdf", type: "application/pdf", data: PDF });
    expect(again.status).toBe(400);
    expect(again.body.error.details.email).toBeTruthy();

    // Appears in the pipeline at the first stage.
    const pipe = (await admin.get(`/api/recruitment/jobs/${job.id}`)).body;
    expect(pipe.stages[0].name).toBe("Applied");
    expect(pipe.stages[0].applications).toHaveLength(1);
    const card = pipe.stages[0].applications[0];
    expect(card).toMatchObject({ name: "Chidi Okeke", source: "Careers page", averageScore: null });
    const appId = card.id;

    const full = (await admin.get(`/api/recruitment/applications/${appId}`)).body;
    expect(full.candidate.email).toBe("chidi@example.com");
    expect(full.application.cv.name).toBe("Chidi_Okeke_CV.pdf");
    expect(full.application.answers).toEqual([
      { questionId: "years", label: "Years of accounting experience", type: "choice", value: "3 to 5 years" },
      { questionId: "start", label: "Can you start within 30 days?", type: "yesno", value: "Yes" },
    ]);
    const cvContent = await admin.get(`/api/files/${full.application.cvFileId}/content`);
    expect(cvContent.status).toBe(200);

    // Jobs list funnel and stats.
    const jobsList = (await admin.get("/api/recruitment/jobs")).body;
    const listed = jobsList.find((j: { id: string }) => j.id === job.id);
    expect(listed.funnel[0]).toEqual({ stage: "Applied", count: 1 });
    const stats = (await admin.get("/api/recruitment/stats")).body;
    expect(stats.openRoles).toBe(1);
    expect(stats.newApplicantsThisWeek).toBe(1);
    expect(stats.hiredThisMonth).toBe(0);

    // Move stage (but not straight to Hired).
    expect((await admin.post(`/api/recruitment/applications/${appId}/stage`, { stage: "Nope" })).status).toBe(400);
    expect((await admin.post(`/api/recruitment/applications/${appId}/stage`, { stage: "Hired" })).status).toBe(400);
    expect((await admin.post(`/api/recruitment/applications/${appId}/stage`, { stage: "Interview" })).status).toBe(200);
    const moved = (await admin.get(`/api/recruitment/applications/${appId}`)).body;
    expect(moved.application.stage).toBe("Interview");
    expect(moved.history.map((h: { to: string }) => h.to)).toEqual(["Applied", "Interview"]);

    // Can't remove a stage that still has candidates.
    const stageEdit = await admin.patch(`/api/recruitment/jobs/${job.id}`, { stages: ["Applied", "Screening", "Offer", "Hired"] });
    expect(stageEdit.status).toBe(409);

    // Scorecards stay hidden from other interviewers until they submit their own.
    const ngozi = await addMember(app, admin, "manager", "Ngozi Eze");
    const kofi = await addMember(app, admin, "manager", "Kofi Mensah");
    const members = (await admin.get("/api/members/assignable")).body as { id: string; name: string }[];
    const ngoziId = members.find((m) => m.name === "Ngozi Eze")!.id;
    const kofiId = members.find((m) => m.name === "Kofi Mensah")!.id;
    const iv = await admin.post(`/api/recruitment/applications/${appId}/interviews`, {
      title: "Technical interview", scheduledAt: new Date(Date.now() + 3600_000).toISOString(), durationMinutes: 45, mode: "office",
      interviewerUserIds: [ngoziId, kofiId],
    });
    expect(iv.status).toBe(200);
    const mine = (await ngozi.c.get("/api/recruitment/interviews?range=upcoming&interviewer=me")).body;
    expect(mine.items.map((i: { id: string }) => i.id)).toContain(iv.body.interview.id);

    const ratings = { "Skills and knowledge": 5, "Attention to detail": 4, "Communication": 5, "Fit with the team": 4 };
    const incomplete = await ngozi.c.put(`/api/recruitment/applications/${appId}/scorecard`, { interviewId: iv.body.interview.id, ratings: { Communication: 5 }, submit: true });
    expect(incomplete.status).toBe(400);
    const nsub = await ngozi.c.put(`/api/recruitment/applications/${appId}/scorecard`, { interviewId: iv.body.interview.id, ratings, recommendation: "strong_yes", notes: "Strong.", submit: true });
    expect(nsub.status).toBe(200);
    expect((await ngozi.c.put(`/api/recruitment/applications/${appId}/scorecard`, { interviewId: iv.body.interview.id, ratings, recommendation: "no", submit: true })).status).toBe(409);

    const kofiBefore = (await kofi.c.get(`/api/recruitment/applications/${appId}`)).body;
    expect(kofiBefore.scorecards).toHaveLength(0);
    expect(kofiBefore.feedback.hiddenCount).toBe(1);
    expect(kofiBefore.feedback.average).toBeNull();
    const kofiPipe = (await kofi.c.get(`/api/recruitment/jobs/${job.id}`)).body;
    expect(kofiPipe.stages[2].applications[0].averageScore).toBeNull();
    // Drafts don't unlock other people's scores.
    await kofi.c.put(`/api/recruitment/applications/${appId}/scorecard`, { interviewId: iv.body.interview.id, ratings: { Communication: 3 } });
    expect((await kofi.c.get(`/api/recruitment/applications/${appId}`)).body.scorecards.filter((s: { isMine: boolean }) => !s.isMine)).toHaveLength(0);
    await kofi.c.put(`/api/recruitment/applications/${appId}/scorecard`, {
      interviewId: iv.body.interview.id, ratings: { "Skills and knowledge": 4, "Attention to detail": 4, "Communication": 4, "Fit with the team": 4 }, recommendation: "yes", submit: true,
    });
    const kofiAfter = (await kofi.c.get(`/api/recruitment/applications/${appId}`)).body;
    expect(kofiAfter.scorecards).toHaveLength(2);
    expect(kofiAfter.feedback.average).toBe(4.3);
    const adminView = (await admin.get(`/api/recruitment/applications/${appId}`)).body;
    expect(adminView.scorecards).toHaveLength(2);

    // Notes: only the author edits.
    const note = await kofi.c.post(`/api/recruitment/applications/${appId}/notes`, { body: "References checked." });
    expect(note.status).toBe(200);
    expect((await admin.patch(`/api/recruitment/notes/${note.body.note.id}`, { body: "Changed" })).status).toBe(403);
    expect((await kofi.c.patch(`/api/recruitment/notes/${note.body.note.id}`, { body: "References checked. All positive." })).status).toBe(200);

    // Hire is idempotent: exactly one employee.
    const hireBody = { jobTitle: "Accounts Officer", departmentId: null, managerEmployeeId: null, startDate: "2026-12-01" };
    const [h1, h2] = await Promise.all([
      admin.post(`/api/recruitment/applications/${appId}/hire`, hireBody),
      admin.post(`/api/recruitment/applications/${appId}/hire`, hireBody),
    ]);
    expect(h1.status).toBe(200);
    expect(h2.status).toBe(200);
    expect(h1.body.employee.id).toBe(h2.body.employee.id);
    const h3 = await admin.post(`/api/recruitment/applications/${appId}/hire`, hireBody);
    expect(h3.body.alreadyHired).toBe(true);
    expect(h3.body.employee.id).toBe(h1.body.employee.id);
    const emps = await db.select().from(employees).where(eq(employees.sourceApplicationId, appId));
    expect(emps).toHaveLength(1);
    expect(emps[0]).toMatchObject({ firstName: "Chidi", lastName: "Okeke", email: "chidi@example.com", phone: "0803 555 0177", status: "onboarding", startDate: "2026-12-01" });
    const links = await db.select().from(fileLinks).where(and(eq(fileLinks.linkType, "employee"), eq(fileLinks.linkId, emps[0]!.id)));
    expect(links).toHaveLength(1);
    const onboarding = await db.select().from(tasks).where(and(eq(tasks.linkType, "employee"), eq(tasks.linkId, emps[0]!.id)));
    expect(onboarding.length).toBeGreaterThan(0);
    const hired = (await admin.get(`/api/recruitment/applications/${appId}`)).body;
    expect(hired.application.stage).toBe("Hired");
    expect(hired.application.employeeId).toBe(emps[0]!.id);
    expect((await admin.get("/api/recruitment/stats")).body.hiredThisMonth).toBe(1);
  });

  it("enforces workspace access and keeps organisations apart", async () => {
    const app = await getApp();
    const { c: admin } = await signUpWithOrg(app);
    const job = (await admin.post("/api/recruitment/jobs", { title: "Delivery Driver", status: "open" })).body.job;
    const added = await admin.post(`/api/recruitment/jobs/${job.id}/candidates`, { firstName: "Segun", lastName: "Bello", email: "segun@example.com", source: "Referral" });
    expect(added.status).toBe(200);
    const dup = await admin.post(`/api/recruitment/jobs/${job.id}/candidates`, { firstName: "Segun", lastName: "Bello", email: "SEGUN@example.com" });
    expect(dup.status).toBe(409);
    const appId = added.body.application.id;

    // Members have no recruitment access by default.
    const member = await addMember(app, admin, "member", "Mary Asante");
    expect((await member.c.get("/api/recruitment/jobs")).status).toBe(403);
    expect((await member.c.get(`/api/recruitment/applications/${appId}`)).status).toBe(403);
    expect((await member.c.post("/api/recruitment/jobs", { title: "Sneaky" })).status).toBe(403);

    // Another organisation can't see or change anything.
    const { c: other } = await signUpWithOrg(app);
    expect((await other.get(`/api/recruitment/jobs/${job.id}`)).status).toBe(404);
    expect((await other.get(`/api/recruitment/applications/${appId}`)).status).toBe(404);
    expect((await other.patch(`/api/recruitment/jobs/${job.id}`, { title: "Hacked" })).status).toBe(404);
    expect((await other.post(`/api/recruitment/applications/${appId}/hire`, { jobTitle: "X Y", startDate: "2026-12-01" })).status).toBe(404);
    expect((await other.get("/api/recruitment/applications")).body).toHaveLength(0);

    // Reject and restore.
    expect((await admin.post(`/api/recruitment/applications/${appId}/reject`, { reason: "Not enough experience" })).status).toBe(200);
    const pipe = (await admin.get(`/api/recruitment/jobs/${job.id}`)).body;
    expect(pipe.stages[0].applications).toHaveLength(0);
    expect(pipe.rejected).toHaveLength(1);
    expect((await admin.post(`/api/recruitment/applications/${appId}/restore`)).status).toBe(200);

    // Soft delete.
    expect((await admin.del(`/api/recruitment/jobs/${job.id}`)).status).toBe(200);
    expect((await admin.get(`/api/recruitment/jobs/${job.id}`)).status).toBe(404);
  });
});
