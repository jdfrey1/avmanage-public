# Setting up avManage

## What you need

- A machine that runs Docker with the Compose plugin — a Linux server, a NAS that runs
  containers (Synology, Unraid, TrueNAS…), or a small cloud VM. 1 GB of RAM is plenty.
  Images are published for `amd64` and `arm64`.
- For use away from home: a way to reach it over HTTPS — a reverse proxy (Caddy, nginx,
  Traefik) or a tunnel (Cloudflare Tunnel, Tailscale).

## 1. Install

Make a folder for the stack and fetch the compose file and the example settings:

```bash
mkdir avmanage && cd avmanage
curl -O https://raw.githubusercontent.com/jdfrey1/avmanage-public/main/docker-compose.yml
curl -o .env https://raw.githubusercontent.com/jdfrey1/avmanage-public/main/.env.example
```

Edit `.env`. At minimum:

| Setting | Value |
|---|---|
| `POSTGRES_PASSWORD` | a long random password |
| `SESSION_SECRET` | output of `openssl rand -hex 32` |
| `COOKIE_SECURE` | `true` if you'll use HTTPS (recommended), `false` for plain http on your own network |

The database, uploads and backups go in a `data` folder next to the compose file; set
`DATA_PATH` to put them elsewhere. Everything else is optional — see
[CONFIGURATION.md](CONFIGURATION.md).

Start it:

```bash
docker compose up -d
docker compose logs -f app     # wait for "avManage listening on port 3022"
```

The app creates the database schema itself on first start.

**Using Portainer or another stack manager?** Paste `docker-compose.yml` as the stack and enter
the `.env` values as the stack's environment variables.

## 2. First run

Open `http://<server>:3022`. With no accounts yet, avManage shows a setup screen:

1. **Aircraft** — tail number, make and model, serial number.
2. **Your account** — name, email and password. This account is the administrator.
3. **Your role** — *Owner* if you own the aircraft, *Lessee / partner* otherwise.

> Do this right after installing. Until the first account exists, anyone who can reach the app
> can create it.

Setup also adds the usual date-based items (annual, ELT, altimeter/transponder, ELT battery,
registration) under **Maintenance → Inspections**; fill in their dates from your logbooks.

## 3. Add the other members

**Settings → Members → Add member**: name, email and role. avManage creates the account and
gives you a link for them to choose a password (valid 7 days). If Google is connected the link
is emailed to them automatically; otherwise copy it and send it yourself.

For each lessee, set the lease terms on the same screen: monthly rate, hour allotment and period
(per lease year or per month), excess rate per hour, and lease start date. Changing someone to
**Owner** makes the previous owner a lessee. Administrators can make other members
administrators, resend password links and remove members (their flights and ledger history are
kept).

Then, in **Settings**:

- **Aircraft** — insurance end date (the scheduler warns past it), the Hobbs and Flight meter
  readings to start from, and optionally your own aircraft photo for the sign-in screen.
- **Reports & Alerts** — turn on the monthly report and currency alerts (needs Google).
- **Backups** — schedule and retention (see below).

## 4. HTTPS and access from outside

Run avManage behind something that terminates TLS and forwards to port 3022, then set
`COOKIE_SECURE=true` and `PUBLIC_URL=https://your-host` (used in emailed links).

Caddy example:

```
avmanage.example.com {
    reverse_proxy 127.0.0.1:3022
}
```

With Cloudflare Tunnel or Tailscale, point the tunnel at `http://localhost:3022`. If you don't
want port 3022 open on your network, change the compose `ports:` line to
`"127.0.0.1:3022:3022"`.

The app is a PWA — on a phone, open it in the browser and use *Add to Home Screen*.

## 5. Backups

**Settings → Backups** runs `pg_dump` on a schedule (default: weekly) into
`DATA_PATH/backups`, keeps the newest N, and — with Google connected — copies each backup to the
Drive folder. Each backup has **Verify** (restores it into a scratch database and counts the
tables) and **Restore**.

Database backups don't include uploaded files. Back up the whole data folder too
(`uploads/` holds documents, invoices, photos and the FlightAware settings).

## 6. Updating

```bash
docker compose pull
docker compose up -d
```

Database changes are applied automatically when the new version starts (the log shows
`[migrate] applied …`). Take a backup first; to stay on a specific version, set `IMAGE_TAG`
(e.g. `IMAGE_TAG=1.2.0`) instead of `latest`.

## Troubleshooting

- **Health check:** `http://<server>:3022/api/health` should return
  `{"status":"ok","database":"connected"}`.
- **Can't sign in over plain http:** `COOKIE_SECURE` must be `false` without HTTPS.
- **Forgot password and Google isn't connected:** an administrator can send a new password link
  from Settings → Members.
- **Logs:** `docker compose logs app`.
