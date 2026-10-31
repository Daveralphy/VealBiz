export const WORKSPACES = ["recruitment", "people", "crm", "workflows", "documents", "insights"] as const;
export type Workspace = (typeof WORKSPACES)[number];

export const WORKSPACE_LABELS: Record<Workspace, string> = {
  recruitment: "Recruitment",
  people: "People & HR",
  crm: "CRM",
  workflows: "Workflows",
  documents: "Documents",
  insights: "Insights",
};

export const ACCESS_LEVELS = ["none", "view", "edit", "manage"] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

export const ROLES = ["admin", "manager", "member"] as const;
export type Role = (typeof ROLES)[number];

export const PLANS = ["free", "growth", "pro", "enterprise"] as const;
export type Plan = (typeof PLANS)[number];


export const VERIFICATION_STATUSES = ["pending", "verified", "rejected"] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];



export const TEAM_SIZES = ["1 to 10 people", "11 to 50 people", "51 to 200 people", "201 to 500 people", "More than 500 people"];

export const INDUSTRIES = [
  "Agriculture", "Construction", "Education", "Financial services", "Food and beverage distribution",
  "Healthcare", "Hospitality", "Logistics", "Manufacturing", "Professional services", "Retail", "Technology", "Other",
];

export const DEFAULT_RECRUITMENT_STAGES = ["Applied", "Screening", "Interview", "Offer", "Hired"];
export const DEFAULT_LEAD_STAGES = ["To contact", "Contacted", "Interested", "Qualified"];
export const DEFAULT_DEAL_STAGES = ["Qualified", "Proposal", "Negotiation"];


/** Import mapping value: keep a column that has no matching field as an extra detail on the record. */
export const IMPORT_KEEP = "__keep";
