/**
 * Loads an organisation from a JSON file (e.g. data/windveal.json) into the database as a real,
 * working account: the organisation, its owner's user account (verified, primary admin and owner),
 * the owner's employee record, the logo and cover images, and the same starting setup every new
 * organisation gets. Running it again updates the organisation from the file; nothing is duplicated.
 *
 * Usage: pnpm data:load                 (loads data/windveal.json)
 *        pnpm data:load path/to/org.json
 *
 * The owner signs in by setting a password with the one-time link printed at the end (no sign-up).
 */
import fs from "node:fs";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { INDUSTRIES, PLANS, TEAM_SIZES } from "@windveal/shared";
import { db, sql } from "./client";
import * as s from "./schema";
import { hashPassword, randomToken, sha256 } from "../lib/crypto";
import { putObject } from "../lib/storage";
import { currencyForCountry } from "../lib/pricing";
import { seedOrgDefaults } from "../modules/org/defaults";
import { env } from "../env";

const blankable = (max: number) => z.string().trim().max(max).optional().nullable().transform((v) => (v ? v : null));

const fileSchema = z.object({
  organisation: z.object({
    slug: z.string().regex(/^[a-z0-9-]{2,60}$/, "slug must be lowercase letters, numbers and dashes"),
    legalName: z.string().trim().min(2),
    tradingName: blankable(200),
    industry: z.enum(INDUSTRIES as [string, ...string[]]).optional().nullable(),
    teamSize: z.enum(TEAM_SIZES as [string, ...string[]]).optional().nullable(),
    country: z.string().length(2),
    city: blankable(120),
    address: blankable(300),
    registrationNumber: blankable(60),
    website: blankable(200),
    domain: blankable(200),
    verificationStatus: z.enum(["pending", "verified", "rejected"]).default("pending"),
    plan: z.enum(PLANS).default("free"),
    billing: z.enum(["monthly", "yearly"]).default("monthly"),
    brandColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().nullable(),
    tagline: blankable(160),
    about: blankable(2000),
    logo: z.string().optional().nullable(),
    cover: z.string().optional().nullable(),
    perks: z.array(z.string().trim().max(120)).max(10).default([]),
  }),
  owner: z.object({
    name: z.string().trim().min(2),
    /** The email they sign in with (password resets and notifications go here). */
    email: z.string().trim().toLowerCase().email(),
    /** Their work email, shown on their employee profile. Defaults to the sign-in email. */
    workEmail: z.string().trim().toLowerCase().email().optional().nullable(),
    jobTitle: blankable(120),
    department: blankable(120),
  }),
});

async function storeImage(orgId: string, file: string, uploadedBy: string, current: string | null) {
  const data = fs.readFileSync(file);
  const ext = path.extname(file).slice(1).toLowerCase();
  const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
  if (current) {
    const [existing] = await db.select().from(s.files).where(eq(s.files.id, current)).limit(1);
    // Same image already stored: keep it.
    if (existing && existing.sha256 === (await import("node:crypto")).createHash("sha256").update(data).digest("hex")) return current;
  }
  const stored = await putObject(orgId, data);
  const [f] = await db.insert(s.files).values({
    orgId, name: path.basename(file), mime, size: stored.size, storageKey: stored.key, sha256: stored.sha256,
    kind: "system", isPublic: true, uploadedBy,
  }).returning();
  return f!.id;
}

// Paths are relative to where the command was run (pnpm sets INIT_CWD).
const target = process.argv[2] ? path.resolve(process.env.INIT_CWD ?? process.cwd(), process.argv[2]) : path.join(env.dataDir, "windveal.json");
if (!fs.existsSync(target)) {
  console.error(`File not found: ${target}`);
  process.exit(1);
}
const parsed = fileSchema.safeParse(JSON.parse(fs.readFileSync(target, "utf8")));
if (!parsed.success) {
  console.error("The file has problems:");
  for (const i of parsed.error.issues) console.error(`  • ${i.path.join(".")}: ${i.message}`);
  process.exit(1);
}
const { organisation: o, owner } = parsed.data;
const currency = currencyForCountry(o.country);
if (!currency) {
  console.error(`Country "${o.country}" isn't in data/pricing.json, so it has no currency.`);
  process.exit(1);
}
const resolveFile = (p?: string | null) => (p ? path.resolve(path.dirname(target), p) : null);
for (const f of [resolveFile(o.logo), resolveFile(o.cover)]) {
  if (f && !fs.existsSync(f)) { console.error(`Image not found: ${f}`); process.exit(1); }
}

// 1. Owner's user account (verified; password is set with the one-time link below).
let [user] = await db.select().from(s.users).where(eq(s.users.email, owner.email)).limit(1);
if (!user) {
  // The owner's sign-in email changed in the file: update their existing account instead of making a new one.
  const [existingOrg] = await db.select().from(s.organisations).where(eq(s.organisations.slug, o.slug)).limit(1);
  if (existingOrg?.ownerEmail && existingOrg.ownerEmail !== owner.email) {
    const [previous] = await db.select().from(s.users).where(eq(s.users.email, existingOrg.ownerEmail)).limit(1);
    if (previous) {
      [user] = await db.update(s.users).set({ email: owner.email }).where(eq(s.users.id, previous.id)).returning();
      console.log(`✓ Changed the sign-in email from ${existingOrg.ownerEmail} to ${owner.email}`);
    }
  }
}
const newUser = !user;
if (!user) {
  [user] = await db.insert(s.users).values({
    email: owner.email, name: owner.name, passwordHash: await hashPassword(randomToken(32)), emailVerifiedAt: new Date(),
  }).returning();
} else {
  await db.update(s.users).set({ name: owner.name, emailVerifiedAt: user.emailVerifiedAt ?? new Date() }).where(eq(s.users.id, user.id));
}
const u = user!;

// 2. The organisation.
const details = {
  legalName: o.legalName, tradingName: o.tradingName, industry: o.industry ?? null, teamSize: o.teamSize ?? null,
  country: o.country, currency, city: o.city, address: o.address, registrationNumber: o.registrationNumber, website: o.website,
  verificationStatus: o.verificationStatus, ownerName: owner.name, ownerEmail: owner.email, brandColor: o.brandColor ?? null,
  tagline: o.tagline, about: o.about, plan: o.plan, billing: o.billing, setupStep: "done",
};
let [org] = await db.select().from(s.organisations).where(eq(s.organisations.slug, o.slug)).limit(1);
const newOrg = !org;
if (!org) {
  const [existingMembership] = await db.select().from(s.memberships).where(and(eq(s.memberships.userId, u.id), isNull(s.memberships.deletedAt))).limit(1);
  if (existingMembership) {
    console.error(`${owner.email} already belongs to another organisation (one organisation per person).`);
    process.exit(1);
  }
  [org] = await db.insert(s.organisations).values({ slug: o.slug, createdBy: u.id, settings: {}, ...details }).returning();
  await db.insert(s.memberships).values({ orgId: org!.id, userId: u.id, role: "admin", isPrimaryAdmin: true, isOwner: true, jobTitle: owner.jobTitle });
  const stages = await seedOrgDefaults(db, org!.id, u.id);
  await db.update(s.organisations).set({ settings: { leadStages: stages.leadStages, dealStages: stages.dealStages, perks: o.perks } }).where(eq(s.organisations.id, org!.id));
} else {
  await db.update(s.organisations).set({ ...details, settings: { ...org.settings, perks: o.perks } }).where(eq(s.organisations.id, org.id));
  const [mine] = await db.select().from(s.memberships).where(and(eq(s.memberships.userId, u.id), isNull(s.memberships.deletedAt))).limit(1);
  if (mine && mine.orgId !== org.id) {
    console.error(`${owner.email} already belongs to another organisation (one organisation per person).`);
    process.exit(1);
  }
  if (!mine) {
    // The owner wasn't a member yet: make them the owner and primary admin.
    await db.update(s.memberships).set({ isPrimaryAdmin: false, isOwner: false }).where(eq(s.memberships.orgId, org.id));
    await db.insert(s.memberships).values({ orgId: org.id, userId: u.id, role: "admin", isPrimaryAdmin: true, isOwner: true, jobTitle: owner.jobTitle });
  } else {
    await db.update(s.memberships).set({ role: "admin", jobTitle: owner.jobTitle, isOwner: true, status: "active" }).where(eq(s.memberships.id, mine.id));
  }
}
const orgId = org!.id;

// 3. Logo and cover (stored like uploaded images; replaced only if the file changed).
const logoFile = resolveFile(o.logo);
const coverFile = resolveFile(o.cover);
const [fresh] = await db.select().from(s.organisations).where(eq(s.organisations.id, orgId)).limit(1);
await db.update(s.organisations).set({
  logoFileId: logoFile ? await storeImage(orgId, logoFile, u.id, fresh!.logoFileId) : null,
  coverFileId: coverFile ? await storeImage(orgId, coverFile, u.id, fresh!.coverFileId) : null,
}).where(eq(s.organisations.id, orgId));

// 4. The owner's employee record (People & HR), in their department.
let departmentId: string | null = null;
if (owner.department) {
  const [dept] = await db.select().from(s.departments).where(and(eq(s.departments.orgId, orgId), eq(s.departments.name, owner.department), isNull(s.departments.deletedAt))).limit(1);
  departmentId = dept?.id ?? (await db.insert(s.departments).values({ orgId, name: owner.department }).returning())[0]!.id;
}
const [first, ...rest] = owner.name.split(/\s+/);
const [emp] = await db.select().from(s.employees).where(and(eq(s.employees.orgId, orgId), eq(s.employees.userId, u.id), isNull(s.employees.deletedAt))).limit(1);
if (!emp) {
  const [e] = await db.insert(s.employees).values({
    orgId, userId: u.id, firstName: first!, lastName: rest.join(" ") || first!, email: owner.workEmail ?? owner.email, jobTitle: owner.jobTitle,
    departmentId, status: "active", startDate: new Date().toISOString().slice(0, 10),
  }).returning();
  await db.insert(s.employmentHistory).values({ orgId, employeeId: e!.id, occurredOn: e!.startDate!, event: `Joined as ${owner.jobTitle ?? "owner"}` });
  if (departmentId) await db.update(s.departments).set({ headEmployeeId: e!.id }).where(eq(s.departments.id, departmentId));
} else {
  await db.update(s.employees).set({ firstName: first!, lastName: rest.join(" ") || first!, email: owner.workEmail ?? owner.email, jobTitle: owner.jobTitle, departmentId: departmentId ?? emp.departmentId }).where(eq(s.employees.id, emp.id));
}

// 5. One-time link for the owner to set their password (valid 7 days).
const token = randomToken();
await db.insert(s.authTokens).values({ userId: u.id, purpose: "reset_password", tokenHash: sha256(token), expiresAt: new Date(Date.now() + 7 * 86_400_000) });

console.log(`\n✓ ${newOrg ? "Created" : "Updated"} ${o.tradingName ?? o.legalName} (${o.verificationStatus}, ${o.plan} plan, ${currency}) from ${path.relative(process.cwd(), target)}`);
console.log(`✓ ${newUser ? "Created" : "Updated"} ${owner.name} <${owner.email}> as owner and primary admin`);
console.log(`\nSet your password here (valid for 7 days), then sign in:\n  ${env.appUrl}/reset-password?token=${token}\n`);
console.log(`Careers page: ${env.siteUrl}/careers/${o.slug}\n`);
await sql.end();
