# Optional integrations

Everything here is optional. Without any of it avManage still logs flights, schedules,
tracks the ledger, maintenance and currency, stores documents and makes backups.

## Google — Calendar, Drive and Gmail

One Google account, connected once by an administrator, gives the partnership:

- **Calendar** — reservations and flights pushed to a Google Calendar as they change (one-way:
  the app is the source of truth; share the calendar with members as view-only).
- **Drive** — uploaded documents, invoices, logbooks, meter photos and database backups copied
  into a folder named after the tail number.
- **Gmail** — the monthly report, currency alerts, password-reset and invitation emails are sent
  from the account; the account itself is copied on the monthly report as an archive. With
  FlightAware alerts going to this inbox, flight alerts are read from it too.

**Use a dedicated Google account for the aircraft** (e.g. a new Gmail address) rather than a
member's personal account — it can be handed over if members change, and the app only asks
for access to files it creates itself on Drive.

### Create the OAuth client (once)

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project.
2. **APIs & Services → Library**: enable the **Google Calendar API**, **Google Drive API** and
   **Gmail API**.
3. **APIs & Services → OAuth consent screen** (Google Auth Platform): user type *External*;
   fill in the app name and your email. Add the aircraft account as a test user while you set up.
4. **Credentials → Create credentials → OAuth client ID**: type *Web application*. Under
   *Authorised redirect URIs* add
   `https://<your-host>/api/calendar/google/callback`
   (use exactly the address you open avManage at — `http://192.168.1.10:3022/...` works on a
   home network).
5. Copy the client ID and secret into `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, optionally
   set `GOOGLE_CALENDAR_ID`, and restart the app.
6. **Publish the app** (OAuth consent screen → *Publish app*). While it's in "Testing", Google
   expires the connection after 7 days. Personal-use apps don't need Google's verification;
   you'll see an "unverified app" warning once when connecting, which is expected.

Scopes requested: `calendar.events`, `drive.file` (only files the app creates),
`gmail.send`, and `gmail.readonly` (to read FlightAware alert emails).

### Connect

Signed in to avManage, go to **Settings → Google Integration → Connect
Google** and sign in **as the aircraft's Google account**. If Settings later shows the
connection as expired, click Disconnect, then Connect again.

## FlightAware — flight alerts and tracks

1. In your FlightAware account, set up flight alerts for the tail number (departure and arrival)
   sent to the Google account connected above.
2. avManage checks that inbox every 15 minutes, pairs departure/arrival alerts into flights, and
   attaches them to logged flights that match by date. Flights it can't match are listed at the
   top of the **Flights** page, where you can ignore them. It never creates flights by itself.
3. For the flight **track** (map), add a FlightAware **AeroAPI** key in **Settings →
   FlightAware** or as `FLIGHTAWARE_API_KEY`. On the Personal tier a flight costs about $0.02,
   usually within the free monthly credit, and tracks are only available for about 10 days, so
   the app fetches them soon after landing.

## Anthropic — meter photos and document chat

Set `ANTHROPIC_API_KEY` to enable:

- reading the Hobbs and Flight meters from a photo when logging a flight;
- the "ask about the documents" and logbook chats;
- AI text extraction for uploaded documents and logbook scans (the **Process** button — never
  automatic, since it uses API credits).

Usage is billed to your Anthropic account. Invoice PDFs don't need it: their text is read
directly.
