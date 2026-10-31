import { boolean, date, index, jsonb, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { pk, tracked } from "./_common";
import { organisations, users } from "./core";

export const companies = pgTable("companies", {
  id: pk(),
  orgId: uuid("org_id").notNull().references(() => organisations.id),
  name: text("name").notNull(),
  industry: text("industry"),
  location: text("location"),
  website: text("website"),
  status: text("status").$type<"prospect" | "client" | "former">().notNull().default("prospect"),
  ownerUserId: uuid("owner_user_id").references(() => users.id),
  notes: text("notes"),
  /** ID or reference number from the business's own records (e.g. a staff number from an imported sheet). */
  reference: text("reference"),
  /** Other columns kept from an imported spreadsheet: column name → value. */
  extraDetails: jsonb("extra_details").$type<Record<string, string>>().notNull().default({}),
  ...tracked(),
}, (t) => [index("companies_org_idx").on(t.orgId)]);

export const contacts = pgTable("contacts", {
  id: pk(),
  orgId: uuid("org_id").notNull().references(() => organisations.id),
  companyId: uuid("company_id").references(() => companies.id),
  name: text("name").notNull(),
  role: text("role"),
  email: text("email"),
  phone: text("phone"),
  isPrimary: boolean("is_primary").notNull().default(false),
  ...tracked(),
}, (t) => [index("contacts_company_idx").on(t.companyId)]);

export type LeadQualification = { need?: boolean; budget?: boolean; decisionMaker?: boolean; timeline?: boolean; notes?: Record<string, string> };

export const leads = pgTable("leads", {
  id: pk(),
  orgId: uuid("org_id").notNull().references(() => organisations.id),
  companyName: text("company_name").notNull(),
  contactName: text("contact_name"),
  contactRole: text("contact_role"),
  email: text("email"),
  phone: text("phone"),
  source: text("source"),
  /** One of the organisation's lead stages, or "Closed". */
  stage: text("stage").notNull(),
  ownerUserId: uuid("owner_user_id").references(() => users.id),
  estimatedValue: numeric("estimated_value", { precision: 14, scale: 2 }),
  qualification: jsonb("qualification").$type<LeadQualification>().notNull().default({}),
  nextStep: text("next_step"),
  nextStepDue: date("next_step_due"),
  closedOutcome: text("closed_outcome").$type<"converted" | "not_interested">(),
  closedReason: text("closed_reason"),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  convertedCompanyId: uuid("converted_company_id").references(() => companies.id),
  convertedDealId: uuid("converted_deal_id"),
  /** ID or reference number from the business's own records (e.g. a staff number from an imported sheet). */
  reference: text("reference"),
  /** Other columns kept from an imported spreadsheet: column name → value. */
  extraDetails: jsonb("extra_details").$type<Record<string, string>>().notNull().default({}),
  ...tracked(),
}, (t) => [index("leads_org_idx").on(t.orgId)]);

export const deals = pgTable("deals", {
  id: pk(),
  orgId: uuid("org_id").notNull().references(() => organisations.id),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  contactId: uuid("contact_id").references(() => contacts.id),
  name: text("name").notNull(),
  value: numeric("value", { precision: 14, scale: 2 }).notNull().default("0"),
  currency: text("currency").notNull(),
  stage: text("stage").notNull(),
  status: text("status").$type<"open" | "won" | "lost">().notNull().default("open"),
  expectedCloseOn: date("expected_close_on"),
  ownerUserId: uuid("owner_user_id").references(() => users.id),
  nextStep: text("next_step"),
  wonAt: timestamp("won_at", { withTimezone: true }),
  lostAt: timestamp("lost_at", { withTimezone: true }),
  lostReason: text("lost_reason"),
  ...tracked(),
}, (t) => [index("deals_org_idx").on(t.orgId), index("deals_company_idx").on(t.companyId)]);

export const activities = pgTable("activities", {
  id: pk(),
  orgId: uuid("org_id").notNull().references(() => organisations.id),
  companyId: uuid("company_id").references(() => companies.id),
  dealId: uuid("deal_id").references(() => deals.id),
  leadId: uuid("lead_id").references(() => leads.id),
  contactId: uuid("contact_id").references(() => contacts.id),
  type: text("type").$type<"note" | "call" | "meeting" | "email">().notNull(),
  subject: text("subject"),
  body: text("body"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  durationMinutes: numeric("duration_minutes"),
  authorUserId: uuid("author_user_id").notNull().references(() => users.id),
  ...tracked(),
}, (t) => [index("activities_company_idx").on(t.companyId, t.occurredAt)]);
