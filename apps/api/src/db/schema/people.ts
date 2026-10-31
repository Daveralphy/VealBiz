import { boolean, date, index, integer, jsonb, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { pk, timestamps, tracked } from "./_common";
import { organisations, users } from "./core";

export const departments = pgTable("departments", {
  id: pk(),
  orgId: uuid("org_id").notNull().references(() => organisations.id),
  name: text("name").notNull(),
  headEmployeeId: uuid("head_employee_id"),
  ...tracked(),
}, (t) => [index("departments_org_idx").on(t.orgId)]);

export const employees = pgTable("employees", {
  id: pk(),
  orgId: uuid("org_id").notNull().references(() => organisations.id),
  userId: uuid("user_id").references(() => users.id),
  employeeCode: text("employee_code"),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  email: text("email"),
  phone: text("phone"),
  jobTitle: text("job_title"),
  departmentId: uuid("department_id").references(() => departments.id),
  managerId: uuid("manager_id"),
  location: text("location"),
  employmentType: text("employment_type"), // Full-time, Part-time, Contract...
  startDate: date("start_date"),
  endDate: date("end_date"),
  status: text("status").$type<"onboarding" | "active" | "on_leave" | "leaving" | "left">().notNull().default("active"),
  dateOfBirth: date("date_of_birth"),
  homeAddress: text("home_address"),
  emergencyContact: text("emergency_contact"),
  nationalId: text("national_id"),
  sourceApplicationId: uuid("source_application_id"),
  /** ID or reference number from the business's own records (e.g. a staff number from an imported sheet). */
  reference: text("reference"),
  /** Other columns kept from an imported spreadsheet: column name → value. */
  extraDetails: jsonb("extra_details").$type<Record<string, string>>().notNull().default({}),
  ...tracked(),
}, (t) => [index("employees_org_idx").on(t.orgId), index("employees_manager_idx").on(t.managerId)]);

/** Sensitive pay details kept apart so they can be permission-checked and audited separately. */
export const employeePay = pgTable("employee_pay", {
  employeeId: uuid("employee_id").primaryKey().references(() => employees.id),
  orgId: uuid("org_id").notNull().references(() => organisations.id),
  salaryAmount: numeric("salary_amount", { precision: 14, scale: 2 }),
  currency: text("currency"),
  payFrequency: text("pay_frequency"),
  bankName: text("bank_name"),
  accountNumber: text("account_number"),
  ...timestamps(),
});

export const employmentHistory = pgTable("employment_history", {
  id: pk(),
  orgId: uuid("org_id").notNull().references(() => organisations.id),
  employeeId: uuid("employee_id").notNull().references(() => employees.id),
  occurredOn: date("occurred_on").notNull(),
  event: text("event").notNull(), // "Joined as Sales Associate"
  details: text("details"),
  actorUserId: uuid("actor_user_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("emp_history_idx").on(t.employeeId)]);

export const leaveTypes = pgTable("leave_types", {
  id: pk(),
  orgId: uuid("org_id").notNull().references(() => organisations.id),
  name: text("name").notNull(),
  daysPerYear: numeric("days_per_year", { precision: 6, scale: 1 }),
  paid: boolean("paid").notNull().default(true),
  requiresNote: boolean("requires_note").notNull().default(false),
  ...tracked(),
});

export const leaveRequests = pgTable("leave_requests", {
  id: pk(),
  orgId: uuid("org_id").notNull().references(() => organisations.id),
  employeeId: uuid("employee_id").notNull().references(() => employees.id),
  leaveTypeId: uuid("leave_type_id").notNull().references(() => leaveTypes.id),
  startDate: date("start_date").notNull(),
  endDate: date("end_date").notNull(),
  days: numeric("days", { precision: 6, scale: 1 }).notNull(),
  reason: text("reason"),
  status: text("status").$type<"pending" | "approved" | "declined" | "cancelled">().notNull().default("pending"),
  requestedBy: uuid("requested_by").references(() => users.id),
  decidedBy: uuid("decided_by").references(() => users.id),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  decisionNote: text("decision_note"),
  ...tracked(),
}, (t) => [index("leave_org_idx").on(t.orgId, t.startDate)]);

export const attendance = pgTable("attendance", {
  id: pk(),
  orgId: uuid("org_id").notNull().references(() => organisations.id),
  employeeId: uuid("employee_id").notNull().references(() => employees.id),
  workDate: date("work_date").notNull(),
  clockIn: timestamp("clock_in", { withTimezone: true }),
  clockOut: timestamp("clock_out", { withTimezone: true }),
  source: text("source").notNull().default("app"),
  correctedBy: uuid("corrected_by").references(() => users.id),
  note: text("note"),
  ...tracked(),
}, (t) => [index("attendance_org_date_idx").on(t.orgId, t.workDate)]);

/** Onboarding / offboarding checklist instance; its tasks live in Workflows (tasks.checklist_id). */
export const checklists = pgTable("checklists", {
  id: pk(),
  orgId: uuid("org_id").notNull().references(() => organisations.id),
  employeeId: uuid("employee_id").notNull().references(() => employees.id),
  kind: text("kind").$type<"onboarding" | "offboarding">().notNull(),
  templateId: uuid("template_id"),
  title: text("title").notNull(),
  status: text("status").$type<"in_progress" | "done">().notNull().default("in_progress"),
  ...tracked(),
});

export const publicHolidays = pgTable("public_holidays", {
  id: pk(),
  orgId: uuid("org_id").notNull().references(() => organisations.id),
  name: text("name").notNull(),
  day: date("day").notNull(),
  recurring: boolean("recurring").notNull().default(false),
  position: integer("position").notNull().default(0),
});

