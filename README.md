# avManage

Self-hosted management for a shared general aviation aircraft — an owner and the pilots who
lease or co-own it. One small Docker stack (Node/Express + React PWA, PostgreSQL) that runs on
a home server, a NAS or a small cloud VM.

> **Not a substitute for official records.** avManage is a convenience tool. The aircraft and
> engine logbooks, the POH/AFM and your own pilot logbook remain the legal records. Verify
> anything safety-related (inspections, ADs, currency) against them.

## What it does

- **Flights** — log Hobbs and flight-timer readings (optionally read from a photo of the meters),
  fuel and oil added, route and notes; import pilot currency from ForeFlight CSV exports.
- **Schedule** — reservations and maintenance blocks with conflict checking, an `.ics` feed per
  pilot, optional push to a shared Google Calendar, warnings when insurance will have lapsed.
- **Ledger** — per-member running balance: monthly lease charges (auto-posted), excess-hour
  charges over each member's allotment, payments, recurring charges. The owner's ledger works as
  an operating-cost tracker (annual, maintenance, insurance, hangar, subscriptions, capital).
- **Maintenance** — squawks (an open *major* squawk grounds the aircraft and blocks new
  reservations), maintenance log, hour-based intervals counted on the flight timer, date-based
  inspections and expirations, logbook import and search.
- **Invoices** — attach shop invoices to ledger entries; PDFs are searchable, and work orders in
  a recognised format are split into line items. Linked to ledger and logbook entries.
- **Documents** — the required aircraft documents (ARROW) plus insurance, lease and other
  paperwork, with an optional "ask the documents" chat.
- **Pilot currency** — IFR, day/night landings, medical and flight review, with email alerts.
- **Reports and backups** — monthly email report; scheduled database backups you can verify
  and restore from Settings, optionally copied to Google Drive.
- **Optional integrations** — Google (Calendar, Drive, Gmail), FlightAware (flight alerts and
  tracks), Anthropic (meter-photo reading and document chat). Everything else works without them.

## Members and roles

Each member is an **owner** or a **lessee**. The partnership has at most one owner — the person
who owns the aircraft and pays its costs; the owner has no hour allotment and their ledger shows
total expenses. Lessees have lease terms (monthly rate, hour allotment per lease year or month,
excess-hour rate, start date). Any member can be made an **administrator**, who manages members
and settings. A group of co-owners with no single owner works too: make everyone a lessee.

## Quick start

```bash
curl -O https://raw.githubusercontent.com/jdfrey1/avmanage-public/main/docker-compose.yml
curl -o .env https://raw.githubusercontent.com/jdfrey1/avmanage-public/main/.env.example
# edit .env: set POSTGRES_PASSWORD and SESSION_SECRET (openssl rand -hex 32)
docker compose up -d
```

Open `http://<server>:3022`. The first visit shows the setup screen: enter the aircraft and
create your administrator account, then add the other members in **Settings → Members**.

Full instructions: **[docs/SETUP.md](docs/SETUP.md)**.

## Documentation

| Guide | |
|---|---|
| [Setup](docs/SETUP.md) | Installing, first run, HTTPS, backups, updating |
| [Configuration](docs/CONFIGURATION.md) | Every environment variable |
| [Integrations](docs/INTEGRATIONS.md) | Google, FlightAware, Anthropic |
| [Development](docs/DEVELOPMENT.md) | Running from source, migrations, architecture, invoice parsers |

## License

[MIT](LICENSE).
