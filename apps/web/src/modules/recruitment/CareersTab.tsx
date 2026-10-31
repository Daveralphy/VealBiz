import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Copy, ExternalLink, Globe, Lock } from "lucide-react";
import { Button, Card, EmptyState, Loading, Notice, Pill } from "@windveal/ui";
import { api } from "../../lib/api";
import { fmtDate } from "../../lib/format";
import { useSession } from "../../lib/session";
import { careersUrl, keys, type Job } from "./data";
import { copyText } from "./JobsPage";
import { useToast } from "@windveal/ui";

export function CareersTab() {
  const { org, isAdmin } = useSession();
  const nav = useNavigate();
  const toast = useToast();
  const verified = org.verificationStatus === "verified";
  const url = careersUrl(org.slug);
  const jobs = useQuery({ queryKey: keys.jobs("?status=open"), queryFn: () => api.get<Job[]>("/api/recruitment/jobs?status=open") });
  const published = (jobs.data ?? []).filter((j) => j.published);
  const notPublished = (jobs.data ?? []).filter((j) => !j.published);

  return (
    <div className="stack" style={{ gap: 20 }}>
      <Card title="Your careers page" subtitle="A public page where people can see your open jobs and apply.">
        {verified ? (
          <div className="rc-live">
            <span className="rc-live-ic"><Globe size={20} /></span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="row"><b className="ink">Live</b><Pill tone="ok">Verified</Pill></div>
              <a className="rc-url" href={url} target="_blank" rel="noreferrer">{url}</a>
            </div>
            <div className="row" style={{ flexWrap: "wrap" }}>
              <Button variant="secondary" icon={<Copy size={15} />} onClick={async () => toast((await copyText(url)) ? "Link copied" : url)}>Copy link</Button>
              <a className="btn btn-primary" href={url} target="_blank" rel="noreferrer"><ExternalLink size={15} />Open</a>
            </div>
          </div>
        ) : (
          <Notice tone="warn" icon={<Lock size={18} />} action={<Link to="/profile/company">Check status</Link>}>
            <b>Your careers page is locked until {org.name} is verified.</b> {org.verificationStatus === "rejected"
              ? "Verification wasn't approved. Check the details in Settings."
              : "You can prepare jobs now. They'll go live once verification is done."}
          </Notice>
        )}
        {isAdmin && <p className="muted rc-mt">Logo, cover image, tagline and perks come from <Link to="/profile/company">your organisation's branding settings</Link>.</p>}
      </Card>

      <Card title="On the careers page" subtitle={verified ? "Open jobs with “Show on careers page” turned on." : "These will show once you're verified."} flush>
        {jobs.isLoading ? <Loading /> : jobs.isError ? <div style={{ padding: 20 }}><Notice tone="error">{(jobs.error as Error).message}</Notice></div> : !published.length ? (
          <EmptyState title="No jobs on the careers page">Open a job and turn on “Show on careers page” to list it here.</EmptyState>
        ) : (
          <div className="table-wrap" style={{ borderRadius: 0 }}>
            <table className="table" style={{ border: 0, borderRadius: 0 }}>
              <thead><tr><th>Job</th><th className="hide-sm">Posted</th><th>Status</th><th /></tr></thead>
              <tbody>
                {published.map((j) => (
                  <tr key={j.id} className="clickable" onClick={() => nav(`/recruitment/jobs/${j.id}`)}>
                    <td><div className="cell-main"><div><b>{j.title}</b><small>{[j.department, j.location, j.employmentType].filter(Boolean).join(" · ")}</small></div></div></td>
                    <td className="hide-sm">{fmtDate(j.openedAt ?? j.createdAt)}</td>
                    <td>{j.isLive ? <Pill tone="ok">Live</Pill> : <Pill tone="warn">Waiting for verification</Pill>}</td>
                    <td className="num" onClick={(e) => e.stopPropagation()}>
                      {j.isLive && <Button size="sm" variant="ghost" onClick={async () => toast((await copyText(j.publicUrl)) ? "Link copied" : j.publicUrl)}>Copy link</Button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {!!notPublished.length && (
        <Card title="Open but not listed" subtitle="These jobs take applications you add yourself, but don't appear publicly.">
          {notPublished.map((j) => (
            <div key={j.id} className="list-row between">
              <span className="ink">{j.title}</span>
              <Button size="sm" variant="ghost" onClick={() => nav(`/recruitment/jobs/${j.id}/edit`)}>Edit</Button>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
