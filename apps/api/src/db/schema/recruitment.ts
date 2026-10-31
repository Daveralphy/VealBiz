import { boolean, date, index, integer, jsonb, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { pk, tracked } from "./_common";
import { organisations, users } from "./core";
import { departments, employees } from "./people";

export type JobQuestion = {
  id: string;
  label: string;
  type: "text" | "choice" | "yesno" | "number";
  options?: string[];
  required: boolean;
};

export const jobs = pgTable("jobs", {
  id: pk(),
  orgId: uuid("org_id").notNull().references(() => organisations.id),
  title: text("title").notNull(),
  slug: text("slug").notNull(),
  departmentId: uuid("department_id").references(() => departments.id),
  location: text("location"),
  employmentType: text("employment_type"),
  salaryMin: numeric("salary_min", { precision: 14, scale: 2 }),
  salaryMax: numeric("salary_max", { precision: 14, scale: 2 }),
  salaryPeriod: text("salary_period").default("month"),
  showSalary: boolean("show_salary").notNull().default(false),
  description: text("description"),
  status: text("status").$type<"draft" | "open" | "closed">().notNull().default("draft"),
  /** Public on the careers page (only effective once the organisation is verified). */
  published: boolean("published").notNull().default(false),
  applyBy: date("apply_by"),
  hiringManagerUserId: uuid("hiring_manager_user_id").references(() => users.id),
  hiringTeamUserIds: jsonb("hiring_team_user_ids").$type<string[]>().notNull().default([]),
  stages: jsonb("stages").$type<string[]>().notNull(),
  questions: jsonb("questions").$type<JobQuestion[]>().notNull().default([]),
  openedAt: timestamp("opened_at", { withTimezone: true }),
  createdBy: uuid("created_by").references(() => users.id),
  /** ID or reference number from the business's own records (e.g. a staff number from an imported sheet). */
  reference: text("reference"),
  /** Other columns kept from an imported spreadsheet: column name → value. */
  extraDetails: jsonb("extra_details").$type<Record<string, string>>().notNull().default({}),
  ...tracked(),
}, (t) => [index("jobs_org_idx").on(t.orgId)]);

export const candidates = pgTable("candidates", {
  id: pk(),
  orgId: uuid("org_id").notNull().references(() => organisations.id),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  email: text("email").notNull(),
  phone: text("phone"),
  location: text("location"),
  ...tracked(),
}, (t) => [index("candidates_org_email_idx").on(t.orgId, t.email)]);

export const applications = pgTable("applications", {
  id: pk(),
  orgId: uuid("org_id").notNull().references(() => organisations.id),
  jobId: uuid("job_id").notNull().references(() => jobs.id),
  candidateId: uuid("candidate_id").notNull().references(() => candidates.id),
  stage: text("stage").notNull(),
  source: text("source").notNull().default("Careers page"),
  answers: jsonb("answers").$type<Record<string, string>>().notNull().default({}),
  coverLetter: text("cover_letter"),
  cvFileId: uuid("cv_file_id"),
  expectedSalary: numeric("expected_salary", { precision: 14, scale: 2 }),
  consentAt: timestamp("consent_at", { withTimezone: true }),
  rejectedAt: timestamp("rejected_at", { withTimezone: true }),
  rejectionReason: text("rejection_reason"),
  hiredAt: timestamp("hired_at", { withTimezone: true }),
  employeeId: uuid("employee_id").references(() => employees.id),
  stageChangedAt: timestamp("stage_changed_at", { withTimezone: true }).notNull().defaultNow(),
  ...tracked(),
}, (t) => [index("applications_job_idx").on(t.jobId), index("applications_org_idx").on(t.orgId)]);

export const applicationStageHistory = pgTable("application_stage_history", {
  id: pk(),
  orgId: uuid("org_id").notNull().references(() => organisations.id),
  applicationId: uuid("application_id").notNull().references(() => applications.id),
  fromStage: text("from_stage"),
  toStage: text("to_stage").notNull(),
  actorUserId: uuid("actor_user_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const interviews = pgTable("interviews", {
  id: pk(),
  orgId: uuid("org_id").notNull().references(() => organisations.id),
  applicationId: uuid("application_id").notNull().references(() => applications.id),
  title: text("title").notNull().default("Interview"),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
  durationMinutes: integer("duration_minutes").notNull().default(45),
  mode: text("mode").$type<"office" | "phone" | "video">().notNull().default("office"),
  location: text("location"),
  interviewerUserIds: jsonb("interviewer_user_ids").$type<string[]>().notNull().default([]),
  status: text("status").$type<"scheduled" | "completed" | "cancelled">().notNull().default("scheduled"),
  ...tracked(),
}, (t) => [index("interviews_org_time_idx").on(t.orgId, t.scheduledAt)]);

export const scorecards = pgTable("scorecards", {
  id: pk(),
  orgId: uuid("org_id").notNull().references(() => organisations.id),
  interviewId: uuid("interview_id").references(() => interviews.id),
  applicationId: uuid("application_id").notNull().references(() => applications.id),
  interviewerUserId: uuid("interviewer_user_id").notNull().references(() => users.id),
  ratings: jsonb("ratings").$type<Record<string, number>>().notNull().default({}),
  recommendation: text("recommendation").$type<"strong_no" | "no" | "yes" | "strong_yes">(),
  notes: text("notes"),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  ...tracked(),
});

export const candidateNotes = pgTable("candidate_notes", {
  id: pk(),
  orgId: uuid("org_id").notNull().references(() => organisations.id),
  applicationId: uuid("application_id").notNull().references(() => applications.id),
  authorUserId: uuid("author_user_id").notNull().references(() => users.id),
  body: text("body").notNull(),
  ...tracked(),
});
