import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, ArrowRight, CheckCircle2, FileText, Upload, X } from "lucide-react";
import { CareersLayout, CareersState, OrgLogo } from "./CareersLayout";
import { useToast } from "@windveal/ui";
import { ApiError, careersApi, orgPlace, useLoad, type JobQuestion } from "./api";
import { JobFacts } from "./JobPage";

const MAX_CV = 5 * 1024 * 1024;
const CV_EXT = /\.(pdf|doc|docx)$/i;
const CV_TYPES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Details = { firstName: string; lastName: string; email: string; phone: string; location: string; coverLetter: string };
type Errors = Record<string, string>;

function Req() {
  return (
    <span className="req" aria-hidden>
      *
    </span>
  );
}

function FieldWrap({ id, label, required, optional, error, children }: { id: string; label: ReactNode; required?: boolean; optional?: boolean; error?: string; children: ReactNode }) {
  return (
    <div className="field">
      <label className="c-label" htmlFor={id}>
        {label}
        {required && <Req />}
        {required && <span className="sr-only"> (required)</span>}
        {optional && <span className="opt">Optional</span>}
      </label>
      {children}
      {error && (
        <span className="field-error" id={`${id}-err`}>
          {error}
        </span>
      )}
    </div>
  );
}

const errProps = (id: string, error?: string) => ({ "aria-invalid": !!error, "aria-describedby": error ? `${id}-err` : undefined });

function formatSize(b: number) {
  return b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`;
}

export default function ApplyPage() {
  const { slug = "", jobSlug = "" } = useParams();
  const load = useLoad(() => careersApi.job(slug, jobSlug), [slug, jobSlug]);
  const [d, setD] = useState<Details>({ firstName: "", lastName: "", email: "", phone: "", location: "", coverLetter: "" });
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [cv, setCv] = useState<File | null>(null);
  const [consent, setConsent] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const toast = useToast();
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const data = load.status === "ok" ? load.data : null;

  // Errors are shown as toasts.
  useEffect(() => {
    if (formError) toast(formError, "error");
  }, [formError, toast]);

  useEffect(() => {
    document.title = data ? `Apply for ${data.job.title} · ${data.org.name}` : "Careers";
  }, [data]);

  if (load.status !== "ok") return <CareersState state={load.status} error={load.status === "error" ? load.error : undefined} onRetry={() => window.location.reload()} />;
  const { org, job } = load.data;
  const questions = job.questions ?? [];

  const set = (k: keyof Details) => (e: { target: { value: string } }) => {
    setD((p) => ({ ...p, [k]: e.target.value }));
    if (errors[k]) setErrors(({ [k]: _drop, ...rest }) => rest);
  };
  const setAnswer = (id: string, v: string) => {
    setAnswers((p) => ({ ...p, [id]: v }));
    if (errors[`q-${id}`]) setErrors(({ [`q-${id}`]: _drop, ...rest }) => rest);
  };

  const pickFile = (file: File | undefined | null) => {
    if (!file) return;
    let err = "";
    if (!CV_EXT.test(file.name) && !CV_TYPES.includes(file.type)) err = "Upload your CV as a PDF or Word document.";
    else if (file.size > MAX_CV) err = `That file is ${formatSize(file.size)}. Upload a CV of 5 MB or less.`;
    else if (file.size === 0) err = "That file looks empty. Try another one.";
    if (err) {
      setCv(null);
      setErrors((p) => ({ ...p, cv: err }));
    } else {
      setCv(file);
      setErrors(({ cv: _drop, ...rest }) => rest);
    }
    if (fileRef.current) fileRef.current.value = "";
  };

  const validate = (): Errors => {
    const e: Errors = {};
    if (!d.firstName.trim()) e.firstName = "Enter your first name.";
    if (!d.lastName.trim()) e.lastName = "Enter your last name.";
    if (!d.email.trim()) e.email = "Enter your email address.";
    else if (!EMAIL_RE.test(d.email.trim())) e.email = "Enter a valid email address, like name@example.com.";
    // Phone is optional; only check it if one was entered.
    if (d.phone.trim() && d.phone.replace(/\D/g, "").length < 7) e.phone = "Enter a valid phone number.";
    if (!cv) e.cv = errors.cv ?? "Upload your CV.";
    for (const q of questions) {
      const v = (answers[q.id] ?? "").trim();
      if (q.required && !v) e[`q-${q.id}`] = q.type === "choice" || q.type === "yesno" ? "Choose an answer." : "Answer this question.";
      else if (q.type === "number" && v && Number.isNaN(Number(v))) e[`q-${q.id}`] = "Enter a number.";
    }
    if (!consent) e.consent = "Please agree so the hiring team can review your application.";
    return e;
  };

  const focusFirst = (e: Errors) => {
    const order = ["firstName", "lastName", "email", "phone", "location", "cv", ...questions.map((q) => `q-${q.id}`), "coverLetter", "consent"];
    const first = order.find((k) => e[k]) ?? Object.keys(e)[0];
    if (!first) return;
    const el = document.getElementById(`f-${first}`) ?? (first === "cv" ? document.getElementById("f-cv-drop") : null);
    el?.focus();
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  };

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    setFormError(null);
    const e = validate();
    setErrors(e);
    if (Object.keys(e).length) {
      focusFirst(e);
      return;
    }
    const fd = new FormData();
    fd.append("firstName", d.firstName.trim());
    fd.append("lastName", d.lastName.trim());
    fd.append("email", d.email.trim());
    fd.append("phone", d.phone.trim());
    fd.append("location", d.location.trim());
    fd.append("coverLetter", d.coverLetter.trim());
    fd.append("consent", "true");
    const ans: Record<string, string | number> = {};
    for (const q of questions) {
      const v = (answers[q.id] ?? "").trim();
      if (!v) continue;
      ans[q.id] = q.type === "number" ? Number(v) : v;
    }
    fd.append("answers", JSON.stringify(ans));
    if (cv) fd.append("cv", cv, cv.name);

    setSubmitting(true);
    try {
      await careersApi.apply(org.slug, job.slug, fd);
      setDone(true);
      window.scrollTo({ top: 0 });
    } catch (err) {
      if (err instanceof ApiError) {
        const mapped: Errors = {};
        for (const [k, msg] of Object.entries(err.details ?? {})) {
          const qid = k.startsWith("answers.") ? k.slice(8) : k;
          if (questions.some((q) => q.id === qid)) mapped[`q-${qid}`] = msg;
          else mapped[k] = msg;
        }
        setErrors(mapped);
        if (err.status === 404) setFormError("This role is no longer accepting applications.");
        else if (err.status === 429) setFormError("Too many attempts in a short time. Please wait a minute and try again.");
        else if (err.status === 0) setFormError(err.message);
        else setFormError(Object.keys(mapped).length ? "Please check the highlighted fields and try again." : err.message);
        if (Object.keys(mapped).length) focusFirst(mapped);
        else topRef.current?.scrollIntoView({ behavior: "smooth" });
      } else {
        setFormError("We couldn't send your application. Check your connection and try again.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (done) {
    return (
      <CareersLayout org={org}>
        <div className="careers-inner">
          <section className="apply-done" role="status">
            <span className="done-icon">
              <CheckCircle2 size={34} aria-hidden />
            </span>
            <h1>Application sent.</h1>
            <p>
              Thanks, {d.firstName.trim()}. {org.name}'s hiring team will be in touch.
            </p>
            <p className="muted-text">
              We've received your application for <b>{job.title}</b>. Keep an eye on {d.email.trim()} for next steps.
            </p>
            <Link to={`/careers/${org.slug}`} className="btn btn-brand btn-lg">
              See all roles at {org.name}
            </Link>
          </section>
        </div>
      </CareersLayout>
    );
  }

  const qError = (q: JobQuestion) => errors[`q-${q.id}`];

  return (
    <CareersLayout org={org}>
      <div className="careers-inner" ref={topRef}>
        <div className="careers-body apply-body">
          <div>
            <Link to={`/careers/${org.slug}/jobs/${job.slug}`} className="careers-back">
              <ArrowLeft size={15} aria-hidden /> Back to the role
            </Link>
            <h1 className="apply-title">Apply for {job.title}</h1>
            <p className="apply-intro">
              Fields marked <Req /> are required. Your application goes straight to the {org.name} hiring team.
            </p>

            <form onSubmit={submit} noValidate className="apply-form">
              <fieldset>
                <legend>Your details</legend>
                <div className="form-grid">
                  <FieldWrap id="f-firstName" label="First name" required error={errors.firstName}>
                    <input id="f-firstName" className="input" placeholder="First name" autoComplete="given-name" value={d.firstName} onChange={set("firstName")} {...errProps("f-firstName", errors.firstName)} />
                  </FieldWrap>
                  <FieldWrap id="f-lastName" label="Last name" required error={errors.lastName}>
                    <input id="f-lastName" className="input" placeholder="Last name" autoComplete="family-name" value={d.lastName} onChange={set("lastName")} {...errProps("f-lastName", errors.lastName)} />
                  </FieldWrap>
                  <FieldWrap id="f-email" label="Email" required error={errors.email}>
                    <input id="f-email" type="email" className="input" placeholder="you@example.com" autoComplete="email" value={d.email} onChange={set("email")} {...errProps("f-email", errors.email)} />
                  </FieldWrap>
                  <FieldWrap id="f-phone" label="Phone" optional error={errors.phone}>
                    <input id="f-phone" type="tel" className="input" placeholder="+234" autoComplete="tel" value={d.phone} onChange={set("phone")} {...errProps("f-phone", errors.phone)} />
                  </FieldWrap>
                  <div className="span-2">
                    <FieldWrap id="f-location" label="Where do you live?" error={errors.location}>
                      <input id="f-location" className="input" placeholder="City or area" autoComplete="address-level2" value={d.location} onChange={set("location")} {...errProps("f-location", errors.location)} />
                    </FieldWrap>
                  </div>
                </div>
              </fieldset>

              <fieldset>
                <legend>
                  Your CV
                  <Req />
                  <span className="sr-only"> (required)</span>
                </legend>
                <input
                  ref={fileRef}
                  id="f-cv"
                  type="file"
                  className="sr-only"
                  tabIndex={-1}
                  accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                  onChange={(e) => pickFile(e.target.files?.[0])}
                />
                {cv ? (
                  <div className="cv-file">
                    <span className="cv-icon">
                      <FileText size={18} aria-hidden />
                    </span>
                    <span className="grow">
                      <b>{cv.name}</b>
                      <small>{formatSize(cv.size)}</small>
                    </span>
                    <button type="button" className="link-btn" onClick={() => fileRef.current?.click()}>
                      Replace
                    </button>
                    <button type="button" className="icon-x" aria-label="Remove CV" onClick={() => setCv(null)}>
                      <X size={16} />
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    id="f-cv-drop"
                    className={`cv-drop${dragging ? " dragging" : ""}${errors.cv ? " invalid" : ""}`}
                    onClick={() => fileRef.current?.click()}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDragging(true);
                    }}
                    onDragLeave={() => setDragging(false)}
                    onDrop={(e) => {
                      e.preventDefault();
                      setDragging(false);
                      pickFile(e.dataTransfer.files?.[0]);
                    }}
                    aria-describedby={errors.cv ? "f-cv-err" : undefined}
                  >
                    <span className="cv-icon">
                      <Upload size={18} aria-hidden />
                    </span>
                    <b>Upload your CV</b>
                    <small>PDF or Word, up to 5 MB</small>
                  </button>
                )}
                {errors.cv && (
                  <span className="field-error" id="f-cv-err" role="alert">
                    {errors.cv}
                  </span>
                )}
              </fieldset>

              {questions.length > 0 && (
                <fieldset>
                  <legend>A few questions from {org.name}</legend>
                  <div className="stack-fields">
                    {questions.map((q) => {
                      const id = `f-q-${q.id}`;
                      const err = qError(q);
                      const v = answers[q.id] ?? "";
                      if (q.type === "yesno") {
                        return (
                          <div key={q.id} className="field" role="radiogroup" aria-labelledby={`${id}-label`} aria-describedby={err ? `${id}-err` : undefined}>
                            <span className="c-label" id={`${id}-label`}>
                              {q.label}
                              {q.required && <Req />}
                              {q.required && <span className="sr-only"> (required)</span>}
                            </span>
                            <div className="yesno">
                              {[
                                ["yes", "Yes"],
                                ["no", "No"],
                              ].map(([val, lab], i) => (
                                <label key={val} className={`radio-card${v === val ? " on" : ""}${err ? " invalid" : ""}`}>
                                  <input type="radio" id={i === 0 ? id : undefined} name={id} value={val} checked={v === val} onChange={() => setAnswer(q.id, val)} />
                                  {lab}
                                </label>
                              ))}
                            </div>
                            {err && (
                              <span className="field-error" id={`${id}-err`}>
                                {err}
                              </span>
                            )}
                          </div>
                        );
                      }
                      return (
                        <FieldWrap key={q.id} id={id} label={q.label} required={q.required} error={err}>
                          {q.type === "choice" ? (
                            <select id={id} className="select" value={v} onChange={(e) => setAnswer(q.id, e.target.value)} {...errProps(id, err)}>
                              <option value="">Select</option>
                              {(q.options ?? []).map((o) => (
                                <option key={o}>{o}</option>
                              ))}
                            </select>
                          ) : q.type === "number" ? (
                            <input id={id} type="number" inputMode="decimal" className="input" value={v} onChange={(e) => setAnswer(q.id, e.target.value)} {...errProps(id, err)} />
                          ) : (
                            <textarea id={id} className="textarea textarea-sm" rows={3} value={v} onChange={(e) => setAnswer(q.id, e.target.value)} {...errProps(id, err)} />
                          )}
                        </FieldWrap>
                      );
                    })}
                  </div>
                </fieldset>
              )}

              <fieldset>
                <legend>
                  <label htmlFor="f-coverLetter">Cover letter</label> <span className="opt">Optional</span>
                </legend>
                <textarea id="f-coverLetter" className="textarea" rows={5} placeholder="Tell us why you'd be a great fit" value={d.coverLetter} onChange={set("coverLetter")} {...errProps("f-coverLetter", errors.coverLetter)} />
                {errors.coverLetter && (
                  <span className="field-error" id="f-coverLetter-err">
                    {errors.coverLetter}
                  </span>
                )}
                <label className="consent">
                  <input
                    id="f-consent"
                    type="checkbox"
                    checked={consent}
                    onChange={(e) => {
                      setConsent(e.target.checked);
                      if (e.target.checked) setErrors(({ consent: _drop, ...rest }) => rest);
                    }}
                    {...errProps("f-consent", errors.consent)}
                  />
                  <span>I agree that {org.name} may store my details to review this application and contact me about it.</span>
                </label>
                {errors.consent && (
                  <span className="field-error" id="f-consent-err">
                    {errors.consent}
                  </span>
                )}
                <button type="submit" className="btn btn-brand btn-lg btn-block apply-submit" disabled={submitting}>
                  {submitting ? "Sending your application…" : "Submit application"} {!submitting && <ArrowRight size={16} aria-hidden />}
                </button>
              </fieldset>
            </form>
          </div>

          <aside className="careers-side">
            <section className="side-box apply-summary">
              <div className="apply-org">
                <OrgLogo org={org} size={52} />
                <span>
                  <b>{org.name}</b>
                  {orgPlace(org) && <small>{orgPlace(org)}</small>}
                </span>
              </div>
              <h2>{job.title}</h2>
              <JobFacts job={job} />
            </section>
          </aside>
        </div>
      </div>
    </CareersLayout>
  );
}
