# Configuration

avManage is configured with environment variables — in a `.env` file next to
`docker-compose.yml`, or in your stack manager. Most day-to-day settings (members, lease terms,
insurance date, backups, reports) live in the app under **Settings** instead.

## Required

| Variable | Description |
|---|---|
| `POSTGRES_USER` | Database user (created on first start). |
| `POSTGRES_PASSWORD` | Database password. |
| `POSTGRES_DB` | Database name. |
| `SESSION_SECRET` | Secret for signing session cookies — `openssl rand -hex 32`. Changing it signs everyone out. |

## Recommended

| Variable | Default | Description |
|---|---|---|
| `DATA_PATH` | `./data` | Host folder holding `db_data/`, `uploads/` and `backups/`. |
| `COOKIE_SECURE` | `false` | `true` when served over HTTPS. Must be `false` for plain http or sign-in won't stick. |
| `PUBLIC_URL` | address of the request | Base URL used in emailed links (password resets, invitations), e.g. `https://avmanage.example.com`. |
| `APP_TIMEZONE` | `America/New_York` | IANA time zone for FlightAware alert times and the calendar feed. |
| `IMAGE_TAG` | `latest` | Image version to run, e.g. `1.2.0`. |

## Optional integrations

See [INTEGRATIONS.md](INTEGRATIONS.md) for what each one does and how to get the values.

| Variable | Description |
|---|---|
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | OAuth client for Google Calendar, Drive and Gmail. |
| `GOOGLE_CALENDAR_ID` | Calendar to push the schedule to. Defaults to the connected account's primary calendar. |
| `FLIGHTAWARE_API_KEY` | AeroAPI key for flight tracks. Can be entered in Settings instead. |
| `ANTHROPIC_API_KEY` | Enables reading meters from a photo, the documents and logbook chat, and AI text extraction of uploaded documents. Usage is billed to your Anthropic account. |

## Advanced

| Variable | Default | Description |
|---|---|---|
| `IMAGE_NAME` | `ghcr.io/jdfrey1/avmanage-public` | Image to run — set it to run your own build (e.g. from a fork). |
| `PORT` | `3022` | Port the app listens on inside the container. |
| `UPLOADS_DIR` | `/data/uploads` | Uploads location inside the container. |
| `DATABASE_URL` | built from the `POSTGRES_*` values | Set it yourself to use an external PostgreSQL 16+ server. |
| `FLIGHTAWARE_SETTINGS_FILE` | `UPLOADS_DIR/.flightaware-settings.json` | Where the AeroAPI key entered in Settings is stored. |

## Data on disk

Under `DATA_PATH` (`./data` unless set):

| Folder | Contents |
|---|---|
| `db_data/` | PostgreSQL data files. |
| `uploads/` | Documents, invoices, logbook scans, meter photos, the custom aircraft image, FlightAware settings. |
| `backups/` | Database backups made from Settings → Backups, and the backup schedule. |
