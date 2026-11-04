/**
 * What WindVeal can ask a business for during review. The reviewer ticks items; the business sees each
 * one as a to-do with the right button (upload a file, or change a detail).
 */
export const REVIEW_REQUESTS = {
  certificate: {
    ask: "A clearer copy of the certificate of incorporation",
    need: "A clearer copy of your certificate of incorporation",
    hint: "PDF, JPG or PNG, up to 10 MB", kind: "upload",
  },
  address: {
    ask: "Proof of address from the last 3 months",
    need: "Proof of address",
    hint: "A utility bill or bank statement from the last 3 months", kind: "upload",
  },
  registration_number: {
    ask: "Check and correct the registration number",
    need: "Registration number",
    hint: "Check it matches your certificate", kind: "field",
  },
  owner_id: {
    ask: "ID of the owner or a director",
    need: "ID of the owner or a director",
    hint: "Passport, national ID card or driver's licence", kind: "upload",
  },
  other: { ask: "Something else", need: "Something else", hint: "Upload a file or reply with a note", kind: "upload_or_note" },
} as const;
export type ReviewRequestKey = keyof typeof REVIEW_REQUESTS;
export const REVIEW_REQUEST_KEYS = Object.keys(REVIEW_REQUESTS) as ReviewRequestKey[];

/** Kinds of document a business sends in, so reviewers can see which file proves what. */
export const VERIFICATION_DOC_KINDS = { certificate: "Certificate of incorporation", address: "Proof of address", owner_id: "Owner or director ID", other: "Other document" } as const;
export type VerificationDocKind = keyof typeof VERIFICATION_DOC_KINDS;

export type ReviewRequestItem = {
  key: ReviewRequestKey;
  /** The reviewer's own wording for "something else". */
  label?: string;
  doneAt?: string | null;
  fileIds?: string[];
  note?: string | null;
};
export type ReviewRequest = { items: ReviewRequestItem[]; message: string; at: string; by: string };

/** What WindVeal's reviewers tick off while checking a business. */
export const REVIEW_CHECKS = {
  name: "Registered name",
  registration_number: "Registration number",
  certificate: "Certificate of incorporation",
  address: "Proof of address",
  person: "The person who registered",
  website: "Website",
} as const;
export type ReviewCheckKey = keyof typeof REVIEW_CHECKS;
