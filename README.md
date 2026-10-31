# WindVeal Biz Platform

WindVeal Biz Platform is a business operations application developed by [WindVeal](https://github.com/Daveralphy). It brings essential business activities into one place, helping teams manage their people, recruitment, customers, documents and daily work.

The platform is being built as a Windows desktop application with offline support. Businesses will be able to work with their local data without an internet connection and synchronise changes when they reconnect.

## Workspaces

- **Recruitment** — Manage job openings, applicants, interviews and hiring.
- **People & HR** — Maintain employee records, departments, leave and attendance.
- **CRM** — Organise companies, contacts, leads, opportunities and follow-ups.
- **Workflows** — Assign tasks, manage deadlines and handle approvals.
- **Documents** — Store, organise and access business documents.
- **Insights** — Review business reports and operational performance.

## Key capabilities

- A single workspace for business operations.
- Import and organise existing spreadsheets and business documents.
- Review data mappings and import results before records are added.
- Work offline with locally available business data.
- Synchronise authorised changes when internet access is restored.
- Manage organisation members, roles and access permissions.
- Use core features without depending on an external AI service.

## Project status

WindVeal Biz Platform is under active development. The repository is being rebuilt around the desktop-first product direction. The capabilities described above represent the intended product scope; they should not be assumed to be available until implemented and released.

WindVeal will be the first pilot organisation. Initial development and testing will take place on one Windows computer before the application is packaged for installation and tested across multiple computers.

## Brand

The product uses the WindVeal blue colour palette and a typography-led identity. The platform name is the visual identity; no product logo is used.

## Development

WindVeal is currently built and tested as an online web application. Offline support and the Windows desktop app (Tauri, with an encrypted local database) come later, just before packaging.

### What's in the repository

| Folder | What it is |
| --- | --- |
| `apps/web` | The business app (React, TypeScript, Vite) on http://localhost:5173 |
| `apps/site` | The public website and each organisation's careers page on http://localhost:5174 |
| `apps/api` | The central API (Fastify, Drizzle, PostgreSQL) on http://localhost:4000 |
| `packages/shared` | Types, validation and permission rules shared by the apps and the API |
| `packages/ui` | Design tokens and shared UI components |

### Requirements

- Node.js 20 or newer
- pnpm 10 (`npm install -g pnpm@10`)
- Docker Desktop (runs PostgreSQL 16)

### First-time setup

```bash
pnpm install
cp apps/api/.env.example apps/api/.env
pnpm db:up        # start PostgreSQL in Docker (port 5433)
pnpm db:push      # create the database tables
```

The database starts empty: nothing about a business is written into the code.

**Load WindVeal (no sign-up needed).** WindVeal's details live in `data/windveal.json`: the organisation, Raphael Daveal as CEO and primary admin (signs in with their own email, work email raphael@windveal.com), windveal.com, verified, on the Enterprise plan, with the real logo. `"platformAdmin": true` on the owner gives that account the **WindVeal admin** panel (review and approve organisations). Load it with:

```bash
pnpm data:load                      # loads data/windveal.json
pnpm data:load path/to/other.json   # or any organisation file in the same format
```

It creates a real, working account and prints a one-time link to set your password (valid 7 days). Running it again updates the organisation from the file without duplicating anything, so edit the JSON and load it again whenever details change.

**Pricing.** Plans, prices for each currency, storage and AI limits, and the supported countries all come from `data/pricing.json`. The API re-reads it when it changes. The website works out each visitor's country from their device's time zone and language settings and shows prices in that currency.

**Deleting.** The files in `data/` are yours to edit or delete. `pnpm db:reset` deletes everything in the database and uploaded files; run `pnpm data:load` afterwards to bring WindVeal back from the JSON.

**Starting over.** `pnpm db:reset` permanently deletes everything on this computer (the database, uploaded files and the dev mailbox) and gives you a fresh, empty database. It asks you to type `DELETE` first.

**Settings.** Contact emails, website links and which careers page "Careers at WindVeal" opens are set in `apps/web/.env` and `apps/site/.env` (copy the `.env.example` files). Nothing business-specific is written into the code.

### Run everything

```bash
pnpm dev          # API + business app + public site together
```

Then open http://localhost:5173: the app starts on its Welcome screen (sign in or create an account). The website (http://localhost:5174) has no sign-in; its Download page is where people get the app. Download links for each platform are set in `apps/site/.env` (`VITE_DOWNLOAD_WINDOWS`, `_MAC`, `_LINUX`, `_ANDROID`, `_IOS`); a platform without a link shows "Coming soon". Company careers pages stay public web pages on the website. People invited by an employer can join from **Invited by your employer?** on the sign-in screen, without the email link. In development no real emails are sent: verification codes, invitation links and password reset links appear at http://localhost:5173/dev/mailbox (and in the API console).

**Where things are.** Your own details, photo, email and password are in **Profile** (account menu → My profile); the company's details, logo, cover and verification documents are in **Profile → Company**. **Settings** holds Members, Roles and permissions, Plan and billing, and Audit history. Changing an email or password needs a code sent by email (see the dev mailbox).

**Verifying organisations.** New organisations wait for review in **WindVeal admin** (sidebar, WindVeal admins only). Open one to see everything it sent in, open its documents and files, then approve it or say what to fix. Once verified, publish a job in **Recruitment** and visit http://localhost:5174/careers/your-organisation-slug (for WindVeal, `windveal`).

### Checks

```bash
pnpm typecheck    # TypeScript across all packages
pnpm test         # API tests (use a separate database, windveal_test)
pnpm test:e2e     # browser tests in Edge (throwaway database, own ports 4100/5273/5274, so it runs beside pnpm dev)
pnpm build        # production builds
```

## Contributing

Please read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting changes.

---

Developed by **WindVeal**.
