# Development

## Stack

- **app/** — Node 20, Express, PostgreSQL via `pg`, sessions in Postgres (`connect-pg-simple`),
  `node-cron` for scheduled jobs. Serves the API under `/api` and the built frontend.
- **client/** — React, TypeScript, Vite, Tailwind. Built into `app/public/` (not committed).
- One container for app + frontend, one for PostgreSQL 16. `app/Dockerfile` is a multi-stage
  build (client, then runtime with `postgresql-client`, `qpdf` and ImageMagick).

```
app/
  server.js            Express setup, runs migrations, then starts the cron jobs
  migrate.js           migration runner
  migrations/          numbered SQL files — the schema
  routes/              one router per area (flights, schedule, ledger, invoices, …)
  services/            reports, Google, FlightAware, backups, lease billing, invoice parsing
  scripts/             one-off maintenance scripts
client/src/
  pages/               one component per screen
  components/          shared UI (shadcn-style primitives in components/ui)
  lib/api.ts           fetch wrapper and the shared types
docs/                  user and developer documentation
```

## Running from source

With Docker (builds the image locally):

```bash
cp .env.example .env        # set POSTGRES_PASSWORD and SESSION_SECRET
docker compose -f docker-compose.dev.yml up --build
```

Frontend with hot reload, against an app on port 3022:

```bash
cd client && npm install && npm run dev     # Vite proxies /api and /branding to :3022
```

Type-check the client with `npx tsc -p tsconfig.app.json --noEmit` — the root `tsconfig.json`
only references the sub-projects, so plain `tsc --noEmit` checks nothing.

## Database migrations

The schema lives in `app/migrations/`. `0001_baseline.sql` is the full schema of the first
release; every later change is a new file with the next number:

```
app/migrations/0003_add_something.sql
```

On startup the app applies, in order, every file not yet recorded in `schema_migrations`, each
in its own transaction. Rules:

- Never edit a migration that has been released — add a new one.
- Migrations change **schema** (and default/reference data every installation needs). Never put
  one installation's data in a migration.
- Write them so they're safe on an existing database (`IF NOT EXISTS`, explicit defaults).

## Things that aren't obvious from the code

**Hobbs vs. Flight timer column names.** For historical reasons `flights.tach_start/tach_end`
hold the **Hobbs** readings and `flights.hobbs_start/hobbs_end` hold the **Flight timer**
readings; `flights.flight_time` is the flight-timer difference. Hour allotments and hour-based
maintenance intervals use flight time. The UI labels them correctly.

**Roles.** `partnership_members.role` is `owner` or `lessee`; at most one owner. The owner (or an
administrator, `users.is_admin`) manages members and lease terms. The owner has no allotment and
no lease charges; their ledger is an expense tracker.

**Ledger.** Every financial event is one `financial_ledger` row with a positive `amount` and a
`direction` (`debit`/`credit`); balances are computed with a window function per member.
`entry_type` is free text so new categories never need a migration (the UI's list is
`client/src/lib/ledgerTypes.ts`). Automatic rows (monthly lease charges from
`recurring_charges`, excess-hour charges) carry an `auto_key` so they're posted exactly once —
see `services/leaseBilling.js`. Invoices and documents attach through the `ledger_invoices` and
`ledger_documents` join tables.

**Allotment windows.** A lessee's allotment runs per lease year (or month) from their
`lease_start_date`; excess is billed in 0.1-hour steps. See `allotmentWindow()` in
`services/reports.js`.

**Google integration.** One OAuth grant for one shared Google account, stored in the singleton
`google_calendar_config` row (client from the environment, refresh token from the in-app
connect flow). Calendar sync is one-way (app → Google) on purpose: a Google event can't carry
the reservation type or pilot, and two-way sync would clobber edits. Drive uses the narrow
`drive.file` scope, so the app creates its folder tree once and stores the folder IDs. Sync
failures are logged, never thrown — an outage must not block scheduling or logging. The session
cookie is `sameSite: 'lax'` so it survives the OAuth redirect back from Google.

**Pilot currency.** `currency_events` is the single source of truth, filled from logged flights,
manual entries and ForeFlight CSV imports, because currency depends on all of a pilot's flying.
ForeFlight's export format varies between accounts; see the comments in `routes/currency.js`.

**Invoice parsing.** PDF text comes from the file's own text layer (`pdf-parse`, no AI). A
parser per shop format in `app/services/invoiceParsers/` turns a recognised work order into
header fields and line items; the line items must add up to the printed total or they're
discarded. To support another shop, copy `sweetAviation.js`, adapt the patterns, and add it to
the `PARSERS` list in `services/invoiceParser.js`.

**Paid API calls are explicit.** Anything that spends Anthropic credits (document text
extraction, chat, meter photos) runs only when a user asks for it.

## Releasing

GitHub Actions (`.github/workflows/release.yml`) builds a multi-arch image and pushes it to
`ghcr.io/<owner>/<repo>`: `latest` on every push to `main`, and `X.Y.Z` / `X.Y` for a `vX.Y.Z`
tag.

```bash
git tag v1.2.0 && git push origin v1.2.0
```
