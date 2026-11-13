import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, bigint } from "drizzle-orm/pg-core";
import type { AccessLevel, Briefing, NotificationPrefs, ReviewRequest, Workspace } from "@windveal/shared";
import { pk, timestamps, tracked } from "./_common";

// ---------------- accounts ----------------
export const users = pgTable("users", {
  id: pk(),
  email: text("email").notNull(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  phone: text("phone"),
  avatarFileId: uuid("avatar_file_id"),
  /** WindVeal staff: can open the WindVeal admin panel and review every organisation. */
  platformAdmin: boolean("platform_admin").notNull().default(false),
  /** Which notifications they get (all of them unless they turn some off) and whether they pop up on their computer. */
  notificationPrefs: jsonb("notification_prefs").$type<NotificationPrefs>().notNull().default({ off: [], desktop: true }),
  /** Set by WindVeal when an account is deactivated: the person can't sign in until reactivated. */
  deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
  deactivatedReason: text("deactivated_reason"),
  emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  ...timestamps(),
}, (t) => [uniqueIndex("users_email_uq").on(t.email)]);

export const devices = pgTable("devices", {
  id: pk(),
  userId: uuid("user_id").notNull().references(() => users.id),
  label: text("label").notNull(),
  userAgent: text("user_agent"),
  ip: text("ip"),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  blockedAt: timestamp("blocked_at", { withTimezone: true }),
});

export const sessions = pgTable("sessions", {
  id: pk(),
  userId: uuid("user_id").notNull().references(() => users.id),
  deviceId: uuid("device_id").references(() => devices.id),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("sessions_token_uq").on(t.tokenHash)]);

/** One-time codes and tokens: email verification codes and password reset tokens. */
export const authTokens = pgTable("auth_tokens", {
  id: pk(),
  userId: uuid("user_id").notNull().references(() => users.id),
  purpose: text("purpose").$type<"verify_email" | "reset_password" | "change_email" | "change_password">().notNull(),
  tokenHash: text("token_hash").notNull(),
  /** Extra data for the token, e.g. the new address for an email change. */
  payload: text("payload"),
  attempts: integer("attempts").notNull().default(0),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------- organisations ----------------
export type OrgSettings = {
  leadStages?: string[];
  dealStages?: string[];
  perks?: string[];
  workdayStart?: string; // "09:00"
  /** Organisation-level defaults per role (Settings → Roles and permissions). */
  roleAccess?: Partial<Record<"manager" | "member", Partial<Record<Workspace, AccessLevel>>>>;
  roleSpecial?: Partial<Record<"manager" | "member", string[]>>;
};

export const organisations = pgTable("organisations", {
  id: pk(),
  slug: text("slug").notNull(),
  legalName: text("legal_name").notNull(),
  tradingName: text("trading_name"),
  industry: text("industry"),
  teamSize: text("team_size"),
  country: text("country").notNull(),
  currency: text("currency").notNull(),
  city: text("city"),
  address: text("address"),
  registrationNumber: text("registration_number"),
  website: text("website"),
  verificationStatus: text("verification_status").$type<"pending" | "needs_info" | "verified" | "rejected">().notNull().default("pending"),
  verificationNote: text("verification_note"),
  /** Certificates and other documents uploaded to support verification. */
  verificationDocumentIds: jsonb("verification_document_ids").$type<string[]>().notNull().default([]),
  verificationReviewedAt: timestamp("verification_reviewed_at", { withTimezone: true }),
  verificationReviewedBy: uuid("verification_reviewed_by"),
  /** When the business last sent itself (or more) for review; null while it's still setting up. */
  verificationSubmittedAt: timestamp("verification_submitted_at", { withTimezone: true }),
  /** What WindVeal asked for when it needs more, and how far the business has got with it. */
  verificationRequest: jsonb("verification_request").$type<ReviewRequest | null>(),
  /** Which kind of proof each verification document is. */
  verificationDocumentKinds: jsonb("verification_document_kinds").$type<Record<string, string>>().notNull().default({}),
  /** WindVeal reviewers' own ticks while checking (never shown to the business). */
  verificationChecks: jsonb("verification_checks").$type<Record<string, boolean>>().notNull().default({}),
  /** WindVeal can suspend or close an organisation's account; its data is kept and it can be brought back. */
  accountStatus: text("account_status").$type<"active" | "suspended" | "closed">().notNull().default("active"),
  accountStatusReason: text("account_status_reason"),
  accountStatusAt: timestamp("account_status_at", { withTimezone: true }),
  ownerName: text("owner_name"),
  ownerEmail: text("owner_email"),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  brandColor: text("brand_color"),
  tagline: text("tagline"),
  about: text("about"),
  logoFileId: uuid("logo_file_id"),
  coverFileId: uuid("cover_file_id"),
  plan: text("plan").$type<"free" | "growth" | "pro" | "enterprise">().notNull().default("free"),
  billing: text("billing").$type<"monthly" | "yearly">().notNull().default("monthly"),
  settings: jsonb("settings").$type<OrgSettings>().notNull().default({}),
  setupStep: text("setup_step").notNull().default("details"),
  ...tracked(),
}, (t) => [uniqueIndex("organisations_slug_uq").on(t.slug)]);

/**
 * What a group of people can open. Admin is built in (everything) and isn't stored here. Every organisation
 * has a Manager role; custom roles come with Growth and up.
 */
export const roles = pgTable("roles", {
  id: pk(),
  orgId: uuid("org_id").notNull().references(() => organisations.id),
  name: text("name").notNull(),
  description: text("description"),
  kind: text("kind").$type<"manager" | "custom">().notNull().default("custom"),
  access: jsonb("access").$type<Record<Workspace, AccessLevel>>().notNull(),
  special: jsonb("special").$type<string[]>().notNull().default([]),
  createdBy: uuid("created_by"),
  ...tracked(),
}, (t) => [index("roles_org_idx").on(t.orgId)]);

export const memberships = pgTable("memberships", {
  id: pk(),
  orgId: uuid("org_id").notNull().references(() => organisations.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  /** "admin", or the tier of their role: "manager" for the Manager role, "member" for a custom one. */
  role: text("role").$type<"admin" | "manager" | "member">().notNull(),
  /** Their role (null for admins). */
  roleId: uuid("role_id"),
  status: text("status").$type<"active" | "suspended">().notNull().default("active"),
  isPrimaryAdmin: boolean("is_primary_admin").notNull().default(false),
  isOwner: boolean("is_owner").notNull().default(false),
  jobTitle: text("job_title"),
  workspaceAccess: jsonb("workspace_access").$type<Partial<Record<Workspace, AccessLevel>>>().notNull().default({}),
  specialPermissions: jsonb("special_permissions").$type<string[]>().notNull().default([]),
  ...tracked(),
}, (t) => [
  // One active organisation per user (enforced in the database).
  uniqueIndex("memberships_one_org_uq").on(t.userId),
  index("memberships_org_idx").on(t.orgId),
]);

export const invitations = pgTable("invitations", {
  id: pk(),
  orgId: uuid("org_id").notNull().references(() => organisations.id),
  email: text("email").notNull(),
  role: text("role").$type<"admin" | "manager" | "member">().notNull(),
  roleId: uuid("role_id"),
  tokenHash: text("token_hash").notNull(),
  invitedBy: uuid("invited_by").notNull().references(() => users.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  /** "I was invited" without the email link: a 6-digit code sent to the invited address. */
  claimCodeHash: text("claim_code_hash"),
  claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
  claimAttempts: integer("claim_attempts").notNull().default(0),
  ...timestamps(),
}, (t) => [index("invitations_org_idx").on(t.orgId)]);

export const auditEvents = pgTable("audit_events", {
  id: pk(),
  orgId: uuid("org_id").notNull().references(() => organisations.id),
  actorUserId: uuid("actor_user_id").references(() => users.id),
  action: text("action").notNull(), // e.g. "member.role_changed"
  category: text("category").notNull().default("general"), // access | data | sync | settings | general
  entityType: text("entity_type"),
  entityId: uuid("entity_id"),
  summary: text("summary").notNull(),
  meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default({}),
  deviceLabel: text("device_label"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("audit_org_time_idx").on(t.orgId, t.createdAt)]);

export const notifications = pgTable("notifications", {
  id: pk(),
  orgId: uuid("org_id").notNull().references(() => organisations.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  title: text("title").notNull(),
  body: text("body"),
  link: text("link"),
  kind: text("kind").notNull().default("account"),
  readAt: timestamp("read_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("notifications_user_idx").on(t.userId, t.createdAt)]);

// ---------------- files (shared by Documents, branding, CVs, attachments) ----------------
export const folders = pgTable("folders", {
  id: pk(),
  orgId: uuid("org_id").notNull().references(() => organisations.id),
  name: text("name").notNull(),
  parentId: uuid("parent_id"),
  /** Who can see files in this folder; empty = everyone in the organisation with Documents access. */
  accessRoles: jsonb("access_roles").$type<string[]>().notNull().default([]),
  restricted: boolean("restricted").notNull().default(false),
  system: boolean("system").notNull().default(false),
  createdBy: uuid("created_by").references(() => users.id),
  ...tracked(),
}, (t) => [index("folders_org_idx").on(t.orgId)]);

export const files = pgTable("files", {
  id: pk(),
  orgId: uuid("org_id").notNull().references(() => organisations.id),
  folderId: uuid("folder_id"),
  name: text("name").notNull(),
  mime: text("mime").notNull(),
  size: bigint("size", { mode: "number" }).notNull(),
  storageKey: text("storage_key").notNull(),
  sha256: text("sha256").notNull(),
  category: text("category"),
  tags: jsonb("tags").$type<string[]>().notNull().default([]),
  expiresOn: text("expires_on"),
  currentVersion: integer("current_version").notNull().default(1),
  /** "document" = lives in the Documents library; "system" = logo/cover/CV not shown in the library root. */
  kind: text("kind").$type<"document" | "system">().notNull().default("document"),
  isPublic: boolean("is_public").notNull().default(false),
  uploadedBy: uuid("uploaded_by").references(() => users.id),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  ...tracked(),
}, (t) => [index("files_org_idx").on(t.orgId), index("files_hash_idx").on(t.orgId, t.sha256)]);

export const fileVersions = pgTable("file_versions", {
  id: pk(),
  fileId: uuid("file_id").notNull().references(() => files.id),
  version: integer("version").notNull(),
  storageKey: text("storage_key").notNull(),
  size: bigint("size", { mode: "number" }).notNull(),
  note: text("note"),
  uploadedBy: uuid("uploaded_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Links a stored file to a record in any workspace (no duplicate blobs). */
export const fileLinks = pgTable("file_links", {
  id: pk(),
  orgId: uuid("org_id").notNull().references(() => organisations.id),
  fileId: uuid("file_id").notNull().references(() => files.id),
  linkType: text("link_type").notNull(), // employee | company | deal | lead | application | task | job
  linkId: uuid("link_id").notNull(),
  label: text("label"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("file_links_target_idx").on(t.linkType, t.linkId)]);

/** Veal (WindVeal AI) requests per business per month, for plan allowances. */
export const aiUsage = pgTable("ai_usage", {
  orgId: uuid("org_id").notNull().references(() => organisations.id),
  month: text("month").notNull(), // "2026-11"
  count: integer("count").notNull().default(0),
}, (t) => [uniqueIndex("ai_usage_org_month_uq").on(t.orgId, t.month)]);

/** A person's chats with Veal. Only they can see them; cleared 15 days after they were last used. */
export const aiChats = pgTable("ai_chats", {
  id: uuid("id").primaryKey(),
  orgId: uuid("org_id").notNull().references(() => organisations.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  /** Where it was started (an Assistant area, or "home"). */
  area: text("area").notNull(),
  title: text("title").notNull(),
  messages: jsonb("messages").notNull().$type<unknown[]>(),
  ...timestamps(),
}, (t) => [index("ai_chats_user_idx").on(t.userId, t.updatedAt)]);

/** What Veal sees in an area for one person, worked out once a day (or when they ask it to look again). */
export const aiBriefings = pgTable("ai_briefings", {
  orgId: uuid("org_id").notNull().references(() => organisations.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  area: text("area").notNull(),
  day: text("day").notNull(), // "2026-11-13"
  content: jsonb("content").notNull().$type<Briefing>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("ai_briefings_user_area_uq").on(t.orgId, t.userId, t.area)]);
