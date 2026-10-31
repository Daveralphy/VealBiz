import { useEffect } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { BookOpen, Compass, LifeBuoy, Mail } from "lucide-react";
import { Card, EmptyState, Loading, PageHeader } from "@windveal/ui";
import { api } from "../lib/api";
import { SUPPORT_EMAIL } from "../lib/config";
import { timeAgo } from "../lib/format";

export function Help() {
  useEffect(() => { document.title = "Help · WindVeal"; }, []);
  const topics: [string, string, string][] = [
    ["Getting started", "Set up your organisation, invite your team and import your spreadsheets.", "/import"],
    ["People & HR", "Add employees, manage leave and attendance, and run onboarding.", "/people"],
    ["Recruitment", "Post jobs, review candidates and hire into People & HR.", "/recruitment"],
    ["CRM", "Track leads, deals and clients, and never miss a follow-up.", "/crm"],
    ["Workflows", "Tasks, approvals and reusable checklists across the business.", "/workflows"],
    ["Profile", "Your details, photo, email and password, and your company profile.", "/profile"],
    ["Settings", "Members, roles and permissions, plan and audit history.", "/settings"],
  ];
  return (
    <>
      <PageHeader title="Help" subtitle="Guides and support for WindVeal." />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(260px,1fr))", gap: 16, margin: "22px 0" }}>
        {topics.map(([t, d, h]) => (
          <Link key={t} to={h} className="card" style={{ display: "block" }}>
            <BookOpen size={20} color="var(--blue)" />
            <h3 style={{ fontSize: 17, margin: "10px 0 4px" }}>{t}</h3>
            <p style={{ fontSize: 14 }}>{d}</p>
          </Link>
        ))}
      </div>
      <Card title="Still need help?" subtitle="We usually reply within one working day.">
        <div className="row" style={{ gap: 18, flexWrap: "wrap" }}>
          <a className="btn btn-primary" href={`mailto:${SUPPORT_EMAIL}`}><Mail size={16} />Email support</a>
          <span className="row muted"><LifeBuoy size={16} />Keyboard shortcuts: Ctrl K to search, Ctrl B to collapse the sidebar.</span>
        </div>
      </Card>
    </>
  );
}

export function NotFound() {
  return <EmptyState title="Page not found" icon={<Compass size={24} />} action={<Link to="/" className="btn btn-primary">Go to Overview</Link>}>That page doesn't exist or has moved.</EmptyState>;
}

/** Development only: shows emails the API would have sent (codes, invitations, reset links). */
export function DevMailbox() {
  const q = useQuery({ queryKey: ["dev-mailbox"], queryFn: () => api.get<{ items: any[] }>("/api/dev/mailbox"), refetchInterval: 3000 });
  if (!import.meta.env.DEV) return <EmptyState title="Not available" />;
  return (
    <div style={{ maxWidth: 820, margin: "0 auto", padding: "32px 16px" }}>
      <PageHeader title="Dev mailbox" subtitle="Emails WindVeal would send. Development only. Refreshes every few seconds." />
      <div style={{ marginTop: 20 }}>
        {q.isLoading ? <Loading /> : (q.data?.items ?? []).length === 0 ? <Card><EmptyState title="No emails yet" /></Card> : (q.data?.items ?? []).map((m) => (
          <Card key={m.id}>
            <div className="between"><b className="ink">{m.subject}</b><small className="muted">{timeAgo(m.sentAt)}</small></div>
            <p className="muted" style={{ fontSize: 13 }}>To {m.to}</p>
            {m.code && <p style={{ fontFamily: "var(--display)", fontSize: 28, fontWeight: 800, letterSpacing: 6, color: "var(--ink)", margin: "10px 0" }}>{m.code}</p>}
            {m.link && <p style={{ marginTop: 8, wordBreak: "break-all" }}><a className="link" href={m.link}>{m.link}</a></p>}
            {!m.code && !m.link && <p style={{ marginTop: 8 }}>{m.text}</p>}
          </Card>
        ))}
      </div>
    </div>
  );
}
