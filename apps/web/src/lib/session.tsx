import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AccessLevel, Workspace } from "@windveal/shared";
import { ACCESS_LEVELS, formatMoney } from "@windveal/shared";
import { api } from "./api";

export type Me = {
  user: {
    id: string; name: string; email: string; emailVerified: boolean; phone: string | null; avatarFileId: string | null;
    platformAdmin: boolean; createdAt: string;
  } | null;
  org: {
    id: string; name: string; legalName: string; slug: string; country: string; currency: string; plan: string;
    verificationStatus: "pending" | "verified" | "rejected"; brandColor: string | null; logoFileId: string | null; setupStep: string;
  } | null;
  membership: {
    id: string; role: "admin" | "manager" | "member"; status: string; isPrimaryAdmin: boolean; jobTitle: string | null;
    access: Record<Workspace, AccessLevel>; special: string[];
  } | null;
  pendingInvitation: { orgName: string; role: string } | null;
};

export const ME_KEY = ["me"];

export function useMe() {
  return useQuery({ queryKey: ME_KEY, queryFn: () => api.get<Me>("/api/auth/me"), staleTime: 60_000 });
}

export function useSetMe() {
  const qc = useQueryClient();
  return (me: Me | null) => (me ? qc.setQueryData(ME_KEY, me) : qc.invalidateQueries({ queryKey: ME_KEY }));
}

/** The signed-in organisation context. Only use inside the app shell (where it's guaranteed). */
export function useSession() {
  const { data } = useMe();
  const me = data!;
  const access = (ws: Workspace, level: AccessLevel = "view") =>
    !!me.membership && ACCESS_LEVELS.indexOf(me.membership.access[ws]) >= ACCESS_LEVELS.indexOf(level);
  return {
    user: me.user!,
    org: me.org!,
    membership: me.membership!,
    isAdmin: me.membership?.role === "admin",
    can: access,
    hasSpecial: (p: string) => !!me.membership?.special.includes(p),
    money: (v: number | string | null | undefined, compact = false) => formatMoney(v, me.org?.currency ?? "NGN", compact),
  };
}
