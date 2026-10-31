import { Navigate, Outlet, RouterProvider, createBrowserRouter, useLocation } from "react-router-dom";
import { Loading } from "@windveal/ui";
import { useMe } from "./lib/session";
import { AppShell } from "./layouts/AppShell";
import { SignIn, CreateAccount, VerifyEmail, ForgotPassword, ResetPassword, AcceptInvite } from "./pages/auth";
import { SetupRoutes } from "./pages/setup";
import { SettingsRoutes } from "./pages/settings";
import { ProfileRoutes } from "./pages/profile";
import { AdminRoutes } from "./pages/admin";
import { Overview } from "./pages/overview/Overview";
import { Help, NotFound, DevMailbox } from "./pages/misc";
import PeopleModule from "./modules/people";
import RecruitmentModule from "./modules/recruitment";
import CrmModule from "./modules/crm";
import WorkflowsModule from "./modules/workflows";
import DocumentsModule from "./modules/documents";
import InsightsModule from "./modules/insights";
import ImportModule from "./modules/imports";

/** Sends people to the right place for where they are in sign-up. */
function Gate({ need }: { need: "app" | "setup" }) {
  const { data: me, isLoading } = useMe();
  const loc = useLocation();
  if (isLoading || !me) return <Loading />;
  if (!me.user) return <Navigate to={`/sign-in?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  if (!me.user.emailVerified) return <Navigate to="/verify-email" replace />;
  if (!me.org) return need === "setup" ? <Outlet /> : <Navigate to="/setup" replace />;
  const setupDone = me.org.setupStep === "done" || me.membership?.role !== "admin";
  if (need === "app" && !setupDone) return <Navigate to={`/setup/${me.org.setupStep}`} replace />;
  if (need === "setup" && setupDone && !loc.pathname.startsWith("/setup/done")) return <Navigate to="/" replace />;
  return need === "app" ? <AppShell /> : <Outlet />;
}

/** Signed-in people don't need to see sign-in screens. */
function GuestOnly() {
  const { data: me, isLoading } = useMe();
  if (isLoading) return <Loading />;
  if (me?.user?.emailVerified) return <Navigate to="/" replace />;
  return <Outlet />;
}

const router = createBrowserRouter([
  {
    element: <GuestOnly />,
    children: [
      { path: "/sign-in", element: <SignIn /> },
      { path: "/create-account", element: <CreateAccount /> },
      { path: "/forgot-password", element: <ForgotPassword /> },
    ],
  },
  { path: "/verify-email", element: <VerifyEmail /> },
  { path: "/reset-password", element: <ResetPassword /> },
  { path: "/invite/:token", element: <AcceptInvite /> },
  { path: "/dev/mailbox", element: <DevMailbox /> },
  { element: <Gate need="setup" />, children: [{ path: "/setup/*", element: <SetupRoutes /> }] },
  {
    element: <Gate need="app" />,
    children: [
      { path: "/", element: <Overview /> },
      { path: "/people/*", element: <PeopleModule /> },
      { path: "/recruitment/*", element: <RecruitmentModule /> },
      { path: "/crm/*", element: <CrmModule /> },
      { path: "/workflows/*", element: <WorkflowsModule /> },
      { path: "/documents/*", element: <DocumentsModule /> },
      { path: "/insights/*", element: <InsightsModule /> },
      { path: "/import/*", element: <ImportModule /> },
      { path: "/settings/*", element: <SettingsRoutes /> },
      { path: "/profile/*", element: <ProfileRoutes /> },
      { path: "/admin/*", element: <AdminRoutes /> },
      { path: "/help", element: <Help /> },
      { path: "*", element: <NotFound /> },
    ],
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}
