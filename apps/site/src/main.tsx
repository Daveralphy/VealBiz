import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Route, Routes, useLocation, useNavigationType } from "react-router-dom";
import { ToastProvider, useFirstVisitHold, usePageTransition, useScrollMemory } from "@windveal/ui";
import "@windveal/ui/styles.css";
import "./site.css";
import Home from "./pages/Home";
import Product from "./pages/Product";
import Workspace from "./pages/Workspace";
import Pricing from "./pages/Pricing";
import About from "./pages/About";
import Contact from "./pages/Contact";
import NotFound from "./pages/NotFound";
import Download from "./pages/Download";
import CompanyPage from "./careers/CompanyPage";
import JobPage from "./careers/JobPage";
import ApplyPage from "./careers/ApplyPage";
import { WORKSPACE_LIST } from "./lib/workspaces";

/**
 * Moving around the site: the first time a page is opened it gets a short loading moment, then fades in.
 * Back and forward return to pages as they were, scrolled to the same place; links open pages at the top.
 */
function PageTransition({ children }: { children: React.ReactNode }) {
  const { pathname, hash, key } = useLocation();
  const historyMove = useNavigationType() === "POP";
  useScrollMemory(key, historyMove, hash);
  const held = useFirstVisitHold("site", pathname, historyMove);
  const ref = usePageTransition<HTMLDivElement>(held ? "held" : pathname);
  return (
    <>
      {held && (
        <div className="boot" role="status" aria-label="Loading">
          <img className="boot-light" src="/logo.png" alt="" draggable={false} />
          <span className="boot-bar" />
        </div>
      )}
      <div ref={ref} className="page-enter" style={held ? { display: "none" } : undefined}>{children}</div>
    </>
  );
}

function App() {
  return (
    <BrowserRouter>
      <PageTransition>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/product" element={<Product />} />
        {WORKSPACE_LIST.map((w) => (
          <Route key={w.key} path={w.path} element={<Workspace ws={w.key} />} />
        ))}
        <Route path="/pricing" element={<Pricing />} />
        <Route path="/download" element={<Download />} />
        <Route path="/about" element={<About />} />
        <Route path="/contact" element={<Contact />} />
        <Route path="/careers/:slug" element={<CompanyPage />} />
        <Route path="/careers/:slug/jobs/:jobSlug" element={<JobPage />} />
        <Route path="/careers/:slug/jobs/:jobSlug/apply" element={<ApplyPage />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
      </PageTransition>
    </BrowserRouter>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </React.StrictMode>,
);
