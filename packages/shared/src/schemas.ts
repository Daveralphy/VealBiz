import { z } from "zod";
import { ACCESS_LEVELS, ROLES, WORKSPACES } from "./constants";

export const id = z.string().uuid();
export const email = z.string().trim().toLowerCase().email("Enter a valid email address").max(200);
export const password = z
  .string()
  .min(10, "Use at least 10 characters")
  .regex(/[0-9]/, "Include a number")
  .regex(/[A-Z]/, "Include an uppercase letter")
  .regex(/[^A-Za-z0-9]/, "Include a symbol")
  .max(200);
export const optionalText = (max = 200) => z.string().trim().max(max).optional().or(z.literal(""));

export const registerInput = z.object({
  name: z.string().trim().min(2, "Enter your full name").max(120),
  email,
  password,
  acceptTerms: z.literal(true, { errorMap: () => ({ message: "You need to accept the terms" }) }),
});
export const loginInput = z.object({ email, password: z.string().min(1, "Enter your password"), remember: z.boolean().optional() });
export const verifyEmailInput = z.object({ code: z.string().regex(/^\d{6}$/, "Enter the 6-digit code") });
export const forgotPasswordInput = z.object({ email });
export const resetPasswordInput = z.object({ token: z.string().min(20), password });

/** Personal profile (Profile → Personal). Email and password change through their own confirmed flows. */
export const profileInput = z.object({
  name: z.string().trim().min(2, "Enter your full name").max(120),
  phone: optionalText(40),
  jobTitle: optionalText(120),
  avatarFileId: id.nullable().optional(),
});
/** "I was invited": find the invitation by email, confirm a code, then create the account. */
export const invitedStartInput = z.object({ email });
export const invitedVerifyInput = z.object({ email, code: z.string().regex(/^\d{6}$/, "Enter the 6-digit code") });
export const invitedCompleteInput = invitedVerifyInput.extend({ name: z.string().trim().min(2, "Enter your full name").max(120), password });
export const emailChangeInput = z.object({ newEmail: email, currentPassword: z.string().min(1, "Enter your password") });
export const passwordCodeInput = z.object({ currentPassword: z.string().min(1, "Enter your current password") });
export const passwordChangeInput = z.object({ code: z.string().regex(/^\d{6}$/, "Enter the 6-digit code"), password });

export const orgDetailsInput = z.object({
  legalName: z.string().trim().min(2, "Enter the registered business name").max(200),
  tradingName: optionalText(),
  industry: z.string().min(1, "Choose an industry"),
  teamSize: z.string().min(1, "Choose a team size"),
  country: z.string().length(2, "Choose a country"),
  city: z.string().trim().min(1, "Enter a city").max(120),
  address: z.string().trim().min(3, "Enter the business address").max(300),
  registrationNumber: optionalText(60),
  website: optionalText(),
});
export const orgRoleInput = z.discriminatedUnion("relation", [
  z.object({ relation: z.literal("owner"), jobTitle: optionalText(120) }),
  z.object({
    relation: z.literal("representative"),
    ownerName: z.string().trim().min(2, "Enter the owner's name").max(120),
    ownerEmail: email,
    jobTitle: z.string().trim().min(2, "Enter your job title").max(120),
  }),
]);
export const orgBrandingInput = z.object({
  brandColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a colour like #1E6B47").optional(),
  tagline: optionalText(160),
  about: optionalText(2000),
  logoFileId: id.nullable().optional(),
  coverFileId: id.nullable().optional(),
  perks: z.array(z.string().trim().max(120)).max(10).optional(),
});
export const orgPlanInput = z.object({ plan: z.enum(["free", "growth", "pro"]), billing: z.enum(["monthly", "yearly"]) });
export const inviteInput = z.object({
  invites: z.array(z.object({ email, role: z.enum(ROLES) })).min(1).max(50),
});
export const memberUpdateInput = z.object({
  role: z.enum(ROLES).optional(),
  status: z.enum(["active", "suspended"]).optional(),
  workspaceAccess: z.record(z.enum(WORKSPACES), z.enum(ACCESS_LEVELS)).optional(),
});

export type ApiError = { error: { code: string; message: string; details?: Record<string, string> } };
