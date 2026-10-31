import { Navigate, Outlet, RouterProvider, ScrollRestoration, createBrowserRouter, useLocation, useNavigationType } from "react-router-dom";
import { useFirstVisitHold } from "@windveal/ui";
import { Splash } from "./components/Splash";
import { AccountPaused, Welcome } from "./pages/welcome";
import { useMe } from "./lib/session";
import { AppShell } from "./layouts/AppShell";
import { SignIn, CreateAccount, VerifyEmail, ForgotPassword, ResetPassword, AcceptInvite, Invited } from "./pages/auth";
import { SetupRoutes } from "./pages/setup";
import { BillingPage, SettingsRoutes } from "./pages/settings";
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
  if (isLoading || !me) return <Splash />;
  // Opening the app signed out starts at Welcome; a deeper link goes to sign-in and comes back after.
  if (!me.user) return <Navigate to={loc.pathname === "/" ? "/welcome" : `/sign-in?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  if (!me.user.emailVerified) return <Navigate to="/verify-email" replace />;
  if (!me.org) return need === "setup" ? <Outlet /> : <Navigate to="/setup" replace />;
  // WindVeal has suspended or closed this organisation (WindVeal's own admins still get in to sort it out).
  if (me.org.accountStatus !== "active" && !me.user.platformAdmin) {
    return <AccountPaused orgName={me.org.name} status={me.org.accountStatus} reason={me.org.accountStatusReason} />;
  }
  const setupDone = me.org.setupStep === "done" || me.membership?.role !== "admin";
  if (need === "app" && !setupDone) return <Navigate to={`/setup/${me.org.setupStep}`} replace />;
  if (need === "setup" && setupDone && !loc.pathname.startsWith("/setup/done")) return <Navigate to="/" replace />;
  return need === "app" ? <AppShell /> : <Outlet />;
}

/** Signed-in people don't need to see sign-in screens. */
function GuestOnly() {
  const { data: me, isLoading } = useMe();
  if (isLoading) return <Splash />;
  if (me?.user?.emailVerified) return <Navigate to="/" replace />;
  return <Outlet />;
}

/** Full-screen pages outside the workspace (welcome, sign-in, setup) get the same first-visit pause. */
const FULL_SCREEN = /^\/(welcome|sign-in|create-account|invited|forgot-password|reset-password|verify-email|invite|setup)(\/|$)/;

function Root() {
  const loc = useLocation();
  const historyMove = useNavigationType() === "POP";
  const fullScreen = FULL_SCREEN.test(loc.pathname);
  const held = useFirstVisitHold("screens", fullScreen ? loc.pathname : "workspace", historyMove || !fullScreen);
  return (
    <>
      {/* Back/forward returns to the same scroll position; following a link starts at the top. */}
      <ScrollRestoration />
      {held && <Splash />}
      <div style={held ? { display: "none" } : undefined}><Outlet /></div>
    </>
  );
}

const router = createBrowserRouter([{ element: <Root />, children: [
  {
    element: <GuestOnly />,
    children: [
      { path: "/welcome", element: <Welcome /> },
      { path: "/sign-in", element: <SignIn /> },
      { path: "/create-account", element: <CreateAccount /> },
      { path: "/invited", element: <Invited /> },
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
      { path: "/billing", element: <BillingPage /> },
      { path: "/profile/*", element: <ProfileRoutes /> },
      { path: "/admin/*", element: <AdminRoutes /> },
      { path: "/help", element: <Help /> },
      { path: "*", element: <NotFound /> },
    ],
  },
] }]);

export function App() {
  return <RouterProvider router={router} />;
}
