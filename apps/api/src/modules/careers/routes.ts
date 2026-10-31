import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, desc, eq, gte, isNull, or, sql as dsql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/client";
import {
  applicationStageHistory, applications, auditEvents, candidates, departments, fileLinks, fileVersions, files, folders, jobs, memberships, organisations,
  type JobQuestion,
} from "../../db/schema";
import { AppError, iso, today } from "../../lib/http";
import { notify } from "../../lib/audit";
import { checkFileType, putObject } from "../../lib/storage";
import { findOrCreateCandidate } from "../recruitment/routes";

type Org = typeof organisations.$inferSelect;
type Job = typeof jobs.$inferSelect;

const CV_MAX_BYTES = 5 * 1024 * 1024;
const CV_EXTS = ["pdf", "doc", "docx"];
const NEW_DAYS = 7;

const notLive = () => new AppError(404, "not_live", "This careers page isn't available.");
const invalid = (message: string, details: Record<string, string>) => new AppError(400, "invalid_application", message, details);

function orgPublic(o: Org) {
  return {
    name: o.tradingName || o.legalName,
    slug: o.slug,
    tagline: o.tagline,
    about: o.about,
    brandColor: o.brandColor,
    logoUrl: o.logoFileId ? `/api/public/files/${o.logoFileId}` : null,
    coverUrl: o.coverFileId ? `/api/public/files/${o.coverFileId}` : null,
    industry: o.industry,
    city: o.city,
    country: o.country,
    teamSize: o.teamSize,
    website: o.website,
    perks: Array.isArray(o.settings?.perks) ? o.settings.perks.filter((p): p is string => typeof p === "string") : [],
  };
}

async function liveOrg(slug: string): Promise<Org> {
  const [o] = await db.select().from(organisations).where(and(eq(organisations.slug, slug), isNull(organisations.deletedAt))).limit(1);
  if (!o || o.verificationStatus !== "verified" || o.accountStatus !== "active") throw notLive();
  return o;
}

/** Published, open, not deleted, and not past its apply-by date. */
const liveJobConds = (orgId: string) => [
  eq(jobs.orgId, orgId), eq(jobs.published, true), eq(jobs.status, "open"), isNull(jobs.deletedAt),
  or(isNull(jobs.applyBy), gte(jobs.applyBy, today()))!,
];

async function liveJob(org: Org, jobSlug: string) {
  const [row] = await db.select({ j: jobs, dept: departments.name }).from(jobs).leftJoin(departments, eq(departments.id, jobs.departmentId))
    .where(and(...liveJobConds(org.id), eq(jobs.slug, jobSlug))).limit(1);
  if (!row) throw notLive();
  return row;
}

const postedAt = (j: Job) => j.openedAt ?? j.createdAt;

function sniffOk(ext: string, buf: Buffer): boolean {
  if (ext === "pdf") return buf.subarray(0, 5).toString("latin1") === "%PDF-";
  if (ext === "docx") return buf[0] === 0x50 && buf[1] === 0x4b; // zip container
  if (ext === "doc") return buf.subarray(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]));
  return false;
}

type ParsedForm = { fields: Record<string, string>; cv: { filename: string; mimetype: string; data: Buffer; truncated: boolean } | null };

async function readForm(req: FastifyRequest): Promise<ParsedForm> {
  if (!req.isMultipart()) throw invalid("Send the application as a form with your CV attached.", { cv: "Attach your CV" });
  const fields: Record<string, string> = {};
  let cv: ParsedForm["cv"] = null;
  try {
    for await (const part of req.parts({ limits: { fileSize: CV_MAX_BYTES, files: 1, fields: 40, fieldSize: 100_000 }, throwFileSizeLimit: false } as never)) {
      if (part.type === "file") {
        const data = await part.toBuffer();
        if (part.fieldname === "cv" && !cv) cv = { filename: part.filename, mimetype: part.mimetype, data, truncated: part.file.truncated };
      } else if (typeof part.value === "string") {
        fields[part.fieldname] = part.value;
      }
    }
  } catch (e) {
    const code = (e as { code?: string }).code ?? "";
    if (code.includes("FILE_TOO_LARGE")) throw invalid("Your CV is too large.", { cv: "Your CV must be 5 MB or smaller" });
    if (code.includes("FILES_LIMIT")) throw invalid("Attach only one file.", { cv: "Attach only one file" });
    throw invalid("We couldn't read your application. Please try again.", {});
  }
  return { fields, cv };
}

function validateAnswers(questions: JobQuestion[], raw: string | undefined, details: Record<string, string>): Record<string, string> {
  let parsed: Record<string, unknown> = {};
  if (raw && raw.trim()) {
    try {
      const v = JSON.parse(raw);
      if (v && typeof v === "object" && !Array.isArray(v)) parsed = v as Record<string, unknown>;
      else details.answers = "Answers weren't in the expected format";
    } catch {
      details.answers = "Answers weren't in the expected format";
    }
  }
  const out: Record<string, string> = {};
  for (const q of questions) {
    const rawVal = parsed[q.id];
    const val = rawVal === undefined || rawVal === null ? "" : String(rawVal).trim().slice(0, 5000);
    const key = `answers.${q.id}`;
    if (!val) {
      if (q.required) details[key] = "This question needs an answer";
      continue;
    }
    if (q.type === "number") {
      const n = Number(val.replace(/,/g, ""));
      if (!Number.isFinite(n)) { details[key] = "Enter a number"; continue; }
      out[q.id] = String(n);
    } else if (q.type === "yesno") {
      const l = val.toLowerCase();
      if (["yes", "true"].includes(l)) out[q.id] = "Yes";
      else if (["no", "false"].includes(l)) out[q.id] = "No";
      else details[key] = "Choose yes or no";
    } else if (q.type === "choice") {
      const opt = (q.options ?? []).find((o) => o.toLowerCase() === val.toLowerCase());
      if (!opt) details[key] = "Choose one of the options";
      else out[q.id] = opt;
    } else {
      out[q.id] = val;
    }
  }
  return out;
}

export default async function careersRoutes(app: FastifyInstance) {
  app.get<{ Params: { slug: string } }>("/api/careers/:slug", async (req) => {
    const org = await liveOrg(req.params.slug);
    const rows = await db.select({ j: jobs, dept: departments.name }).from(jobs).leftJoin(departments, eq(departments.id, jobs.departmentId))
      .where(and(...liveJobConds(org.id))).orderBy(desc(dsql`coalesce(${jobs.openedAt}, ${jobs.createdAt})`));
    const cutoff = Date.now() - NEW_DAYS * 86_400_000;
    return {
      org: orgPublic(org),
      jobs: rows.map(({ j, dept }) => ({
        id: j.id, slug: j.slug, title: j.title, department: dept ?? null, location: j.location, employmentType: j.employmentType,
        postedAt: iso(postedAt(j)), isNew: postedAt(j).getTime() >= cutoff,
      })),
    };
  });

  app.get<{ Params: { slug: string; jobSlug: string } }>("/api/careers/:slug/jobs/:jobSlug", async (req) => {
    const org = await liveOrg(req.params.slug);
    const { j, dept } = await liveJob(org, req.params.jobSlug);
    const hasSalary = j.showSalary && (j.salaryMin !== null || j.salaryMax !== null);
    return {
      org: orgPublic(org),
      job: {
        id: j.id, slug: j.slug, title: j.title, department: dept ?? null, location: j.location, employmentType: j.employmentType,
        description: j.description,
        salary: hasSalary ? {
          min: j.salaryMin === null ? null : Number(j.salaryMin), max: j.salaryMax === null ? null : Number(j.salaryMax),
          period: j.salaryPeriod ?? "month", currency: org.currency,
        } : null,
        applyBy: j.applyBy, postedAt: iso(postedAt(j)),
        questions: j.questions.map((q) => ({
          id: q.id, label: q.label, type: q.type, ...(q.type === "choice" ? { options: q.options ?? [] } : {}), required: q.required,
        })),
      },
    };
  });

  app.post<{ Params: { slug: string; jobSlug: string } }>(
    "/api/careers/:slug/jobs/:jobSlug/apply",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (req) => {
      const org = await liveOrg(req.params.slug);
      const { j } = await liveJob(org, req.params.jobSlug);
      const { fields, cv } = await readForm(req);
      const f = (k: string, max = 200) => (fields[k] ?? "").trim().slice(0, max);
      const details: Record<string, string> = {};
      const firstName = f("firstName", 80);
      const lastName = f("lastName", 80);
      const email = f("email", 200).toLowerCase();
      const phone = f("phone", 40);
      const location = f("location", 120);
      const coverLetter = (fields.coverLetter ?? "").trim().slice(0, 10_000);
      if (!firstName) details.firstName = "Enter your first name";
      if (!lastName) details.lastName = "Enter your last name";
      if (!email) details.email = "Enter your email";
      else if (!z.string().email().safeParse(email).success) details.email = "Enter a valid email";
      if (phone && !/^[+()\d\s-]{6,}$/.test(phone)) details.phone = "Enter a valid phone number";
      if (fields.consent !== "true") details.consent = "Please agree so we can process your application";
      const answers = validateAnswers(j.questions, fields.answers, details);
      let ext = "";
      if (!cv || cv.data.length === 0) details.cv = "Attach your CV";
      else if (cv.truncated || cv.data.length > CV_MAX_BYTES) details.cv = "Your CV must be 5 MB or smaller";
      else {
        ext = cv.filename.split(".").pop()?.toLowerCase() ?? "";
        if (!CV_EXTS.includes(ext) || checkFileType(cv.filename, cv.mimetype) || !sniffOk(ext, cv.data)) details.cv = "Upload a PDF or Word document";
      }
      if (Object.keys(details).length) throw invalid("Some details need fixing.", details);

      // Check for a repeat application before storing the file.
      const [already] = await db.select({ id: applications.id }).from(applications)
        .innerJoin(candidates, eq(candidates.id, applications.candidateId))
        .where(and(eq(applications.jobId, j.id), eq(candidates.orgId, org.id), eq(candidates.email, email), isNull(candidates.deletedAt), isNull(applications.deletedAt)))
        .limit(1);
      if (already) throw invalid("You've already applied for this role.", { email: "You've already applied for this role with this email" });

      const stored = await putObject(org.id, cv!.data);
      await db.transaction(async (tx) => {
        const cand = await findOrCreateCandidate(tx, org.id, { firstName, lastName, email, phone: phone || null, location: location || null });
        const [existing] = await tx.select({ id: applications.id }).from(applications)
          .where(and(eq(applications.jobId, j.id), eq(applications.candidateId, cand.id), isNull(applications.deletedAt))).limit(1);
        if (existing) throw invalid("You've already applied for this role.", { email: "You've already applied for this role with this email" });
        const [folder] = await tx.select({ id: folders.id }).from(folders)
          .where(and(eq(folders.orgId, org.id), eq(folders.name, "CVs and applications"), isNull(folders.deletedAt))).limit(1);
        const safeName = cv!.filename.replace(/[\\/\r\n"]/g, "_").slice(0, 200) || `CV.${ext}`;
        const [file] = await tx.insert(files).values({
          orgId: org.id, folderId: folder?.id ?? null, name: safeName, mime: cv!.mimetype || "application/octet-stream", size: stored.size,
          storageKey: stored.key, sha256: stored.sha256, kind: "system", category: "CV",
        }).returning();
        await tx.insert(fileVersions).values({ fileId: file!.id, version: 1, storageKey: stored.key, size: stored.size });
        const [a] = await tx.insert(applications).values({
          orgId: org.id, jobId: j.id, candidateId: cand.id, stage: j.stages[0]!, source: "Careers page", answers,
          coverLetter: coverLetter || null, cvFileId: file!.id, consentAt: new Date(),
        }).returning();
        await tx.insert(fileLinks).values({ orgId: org.id, fileId: file!.id, linkType: "application", linkId: a!.id, label: "CV" });
        await tx.insert(applicationStageHistory).values({ orgId: org.id, applicationId: a!.id, fromStage: null, toStage: a!.stage });
        await tx.insert(auditEvents).values({
          orgId: org.id, actorUserId: null, action: "application.received", category: "data", entityType: "application", entityId: a!.id,
          summary: `${firstName} ${lastName} applied for ${j.title} through the careers page`,
        });
        // Tell the hiring manager, or the admins if there isn't one.
        let recipients: string[] = [];
        if (j.hiringManagerUserId) {
          const [m] = await tx.select({ id: memberships.userId }).from(memberships)
            .where(and(eq(memberships.orgId, org.id), eq(memberships.userId, j.hiringManagerUserId), eq(memberships.status, "active"), isNull(memberships.deletedAt))).limit(1);
          if (m) recipients = [m.id];
        }
        if (!recipients.length) {
          const admins = await tx.select({ id: memberships.userId }).from(memberships)
            .where(and(eq(memberships.orgId, org.id), eq(memberships.role, "admin"), eq(memberships.status, "active"), isNull(memberships.deletedAt)));
          recipients = admins.map((r) => r.id);
        }
        for (const u of recipients) {
          await notify(org.id, u, `New applicant: ${firstName} ${lastName}`, `${j.title} · Careers page`, `/recruitment/applications/${a!.id}`, tx);
        }
      });
      return { ok: true };
    },
  );
}
