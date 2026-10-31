import React, { useEffect } from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Route, Routes, useLocation } from "react-router-dom";
import { ToastProvider, usePageTransition } from "@windveal/ui";
import "@windveal/ui/styles.css";
import "./site.css";
import Home from "./pages/Home";
import Product from "./pages/Product";
import Workspace from "./pages/Workspace";
import Pricing from "./pages/Pricing";
import About from "./pages/About";
import Contact from "./pages/Contact";
import NotFound from "./pages/NotFound";
import CompanyPage from "./careers/CompanyPage";
import JobPage from "./careers/JobPage";
import ApplyPage from "./careers/ApplyPage";
import { WORKSPACE_LIST } from "./lib/workspaces";

function ScrollToTop() {
  const { pathname, hash } = useLocation();
  useEffect(() => {
    if (hash) {
      document.getElementById(hash.slice(1))?.scrollIntoView();
      return;
    }
    window.scrollTo(0, 0);
  }, [pathname, hash]);
  return null;
}

/** Fades each page in as you move around the site. */
function PageTransition({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation();
  const ref = usePageTransition<HTMLDivElement>(pathname);
  return <div ref={ref} className="page-enter">{children}</div>;
}

function App() {
  return (
    <BrowserRouter>
      <ScrollToTop />
      <PageTransition>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/product" element={<Product />} />
        {WORKSPACE_LIST.map((w) => (
          <Route key={w.key} path={w.path} element={<Workspace ws={w.key} />} />
        ))}
        <Route path="/pricing" element={<Pricing />} />
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
