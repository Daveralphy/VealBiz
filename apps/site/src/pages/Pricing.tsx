import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Check, Minus } from "lucide-react";
import { formatMoney } from "@windveal/shared";
import { Skeleton, SkeletonText } from "@windveal/ui";
import { detectCurrency, monthlyPrice, usePricing } from "../lib/pricing";
import { CtaBand, MarketingLayout } from "../components/Layout";
import { GET_STARTED_URL, useTitle } from "../lib/site";

type Billing = "monthly" | "yearly";

const FAQ = [
  { q: "Which currency will I pay in?", a: "Prices are shown and charged in your local currency, based on where your organisation is." },
  { q: "Is the Free plan really free?", a: "Yes. Use all six workspaces for as long as you like. Upgrade when you need more space or AI." },
  { q: "What is WindVeal AI?", a: "Optional AI help on paid plans. Everything else in WindVeal works without it." },
  { q: "Can I change plans later?", a: "Yes. Upgrade or downgrade whenever you like, and switch between monthly and yearly billing." },
];

export default function Pricing() {
  useTitle("Pricing · WindVeal");
  const [billing, setBilling] = useState<Billing>("yearly");
  const pricing = usePricing();
  const data = pricing.status === "ok" ? pricing.data : null;
  const where = useMemo(() => (data ? detectCurrency(data) : null), [data]);
  const currency = where?.currency ?? "";
  const plans = data?.plans.filter((p) => !p.custom) ?? [];
  const enterprise = data?.plans.find((p) => p.custom);
  const monthsFree = data?.yearlyMonthsFree ?? 0;
  const sub = (amount: number) => {
    if (amount === 0) return "Free forever";
    return billing === "yearly" ? `${formatMoney(amount * (12 - monthsFree), currency)} billed yearly` : "Billed monthly";
  };

  return (
    <MarketingLayout>
      <section className="page-hero pricing-hero">
        <div className="container">
          <h1>
            Plans that grow <span className="accent">with you.</span>
          </h1>
          <p className="lede">Start with what you need. Upgrade for more space and AI when you're ready.</p>
          <div className="billing-toggle" role="group" aria-label="Billing period">
            <button type="button" aria-pressed={billing === "monthly"} className={billing === "monthly" ? "on" : undefined} onClick={() => setBilling("monthly")}>
              Monthly
            </button>
            <button type="button" aria-pressed={billing === "yearly"} className={billing === "yearly" ? "on" : undefined} onClick={() => setBilling("yearly")}>
              Yearly {monthsFree > 0 && <small>{monthsFree} months free</small>}
            </button>
          </div>
          <p className="currency-note">{where?.country ? `Prices shown in ${currency} for ${where.country}.` : "Prices shown in your local currency."}</p>
        </div>
      </section>

      <section className="container">
        {pricing.status === "loading" && (
          <div className="plans" role="status" aria-label="Loading prices">
            {[0, 1, 2].map((i) => (
              <article key={i} className="plan">
                <Skeleton width="45%" height={24} radius={8} />
                <div style={{ marginTop: 14 }}><SkeletonText lines={2} /></div>
                <Skeleton width="60%" height={44} radius={10} style={{ margin: "26px 0 22px" }} />
                <SkeletonText lines={5} />
              </article>
            ))}
          </div>
        )}
        {pricing.status === "error" && <p className="currency-note">Prices couldn't be loaded. Please refresh the page.</p>}
        <div className="plans">
          {data && plans.map((p) => {
            const amount = monthlyPrice(data, p, currency);
            const price = formatMoney(amount, currency);
            return (
              <article key={p.key} className={`plan${p.popular ? " plan-popular" : ""}`}>
                <div className="plan-top">
                  <h2>{p.name}</h2>
                  {p.popular && <span className="plan-badge">Popular</span>}
                </div>
                <p className="plan-desc">{p.description}</p>
                <div className="plan-price">
                  <b className={price.length > 6 ? "long" : undefined}>{price}</b>
                  <span>/ month</span>
                </div>
                <p className="plan-sub">{sub(amount)}</p>
                <div className="plan-compact" aria-hidden>
                  <span>{p.storageGB} GB storage</span>
                  <span>{p.aiRequestsPerMonth ? `AI: ${p.aiRequestsPerMonth.toLocaleString("en-GB")} / mo` : "No AI"}</span>
                </div>
                <a href={`${GET_STARTED_URL}?plan=${p.key}&billing=${billing}`} className={`btn btn-lg btn-block ${p.popular ? "btn-light" : "btn-primary"}`}>
                  {p.cta}
                </a>
                <ul className="plan-features">
                  {p.features.map((f) => (
                    <li key={f}>
                      <Check size={15} aria-hidden /> <span>{f}</span>
                    </li>
                  ))}
                </ul>
              </article>
            );
          })}
        </div>
        {enterprise && (
          <article className="plan-enterprise">
            <div>
              <h2>{enterprise.name}</h2>
              <p>{enterprise.description}</p>
            </div>
            <div className="enterprise-right">
              <b>Custom</b>
              <Link to="/contact?topic=sales" className="btn btn-primary btn-lg">
                {enterprise.cta}
              </Link>
            </div>
          </article>
        )}
      </section>

      {data && data.compare.length > 0 && (
        <section className="section compare-section">
          <div className="container">
            <div className="table-scroll">
              <table className="compare">
                <caption className="sr-only">Compare plans</caption>
                <thead>
                  <tr>
                    <th scope="col">Compare plans</th>
                    {data.plans.map((p) => <th key={p.key} scope="col">{p.name}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {data.compare.map((row) => (
                    <tr key={row.label}>
                      <th scope="row">{row.label}</th>
                      {data.plans.map((p) => {
                        const v = row.values[p.key];
                        return (
                          <td key={p.key}>
                            {v === true ? <Check size={16} className="yes" aria-label="Included" />
                              : v === false || v === undefined ? <Minus size={16} className="no" aria-label="Not included" />
                              : v}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      <section className="section section-tight">
        <div className="container">
          <h2 className="section-title">Questions, answered.</h2>
          <div className="faq">
            {FAQ.map((f) => (
              <div key={f.q} className="faq-item">
                <h3>{f.q}</h3>
                <p>{f.a}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <CtaBand
        title="Need something built around you?"
        text="Talk to us about storage, AI and support that fit your organisation."
        primary={{ label: "Contact us", href: "/contact?topic=sales" }}
        secondary={{ label: "Get started", href: GET_STARTED_URL, external: true }}
      />
    </MarketingLayout>
  );
}
