const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const path = require('path');
const pool = require('./db');
const requireAuth = require('./middleware/requireAuth');
const authRouter = require('./routes/auth');
const flightsRouter = require('./routes/flights');
const scheduleRouter = require('./routes/schedule');
const ledgerRouter       = require('./routes/ledger');
const squawksRouter      = require('./routes/squawks');
const maintenanceRouter  = require('./routes/maintenance');
const calendarRouter     = require('./routes/calendar');
const partnershipRouter  = require('./routes/partnership');
const currencyRouter     = require('./routes/currency');
const exportRouter       = require('./routes/export');
const backupRouter       = require('./routes/backup');
const logbookRouter      = require('./routes/logbook');
const documentsRouter    = require('./routes/documents');
const reportsRouter      = require('./routes/reports');
const flightawareRouter  = require('./routes/flightaware');
const invoicesRouter     = require('./routes/invoices');
const setupRouter        = require('./routes/setup');
const { migrate }        = require('./migrate');
const googleAuth         = require('./services/googleAuth');
const { findBrandingMark } = require('./services/branding');
const { initCron }       = require('./services/backupCron');
const { initCron: initReportCron } = require('./services/reportCron');
const { initCron: initLeaseBilling } = require('./services/leaseBilling');
const { initCron: initFlightAware } = require('./services/flightaware');
const { initCron: initForeflightEmail } = require('./services/foreflightEmail');
const { initCron: initNotifications } = require('./services/notifications');

const app = express();
const port = process.env.PORT || 3022;

app.set('trust proxy', 1);
app.use(express.json());

app.use(session({
  store: new pgSession({ pool, tableName: 'session' }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.COOKIE_SECURE === 'true',
    // 'lax' (not 'strict') so the session cookie survives a top-level cross-site redirect —
    // needed for the Google Calendar OAuth callback (accounts.google.com → our domain).
    // Lax still blocks cookies on cross-site subrequests/POSTs, so CSRF protection holds.
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  },
}));

app.use('/api/setup', setupRouter);
app.use('/api/auth', authRouter);
app.use('/api/flights', flightsRouter);
app.use('/api/schedule', scheduleRouter);
app.use('/api/ledger',       ledgerRouter);
app.use('/api/squawks',      squawksRouter);
app.use('/api/maintenance',  maintenanceRouter);
app.use('/api/calendar',     calendarRouter);
app.use('/api/partnership',  partnershipRouter);
app.use('/api/currency',     currencyRouter);
app.use('/api/export',       exportRouter);
app.use('/api/backup',       backupRouter);
app.use('/api/logbook',      logbookRouter);
app.use('/api/documents',    documentsRouter);
app.use('/api/reports',      reportsRouter);
app.use('/api/flightaware',  flightawareRouter);
app.use('/api/garmin',       require('./routes/garmin'));
app.use('/api/invoices',     invoicesRouter);
app.use('/api/notifications', require('./routes/notifications'));

app.get('/api/config', requireAuth, (req, res) => {
  res.json({ ocrEnabled: !!process.env.ANTHROPIC_API_KEY });
});

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', database: 'connected' });
  } catch (err) {
    res.status(503).json({ status: 'error', database: 'unreachable', error: err.message });
  }
});

// Serve the built React PWA
const publicDir = path.join(__dirname, 'public');

// The aircraft image on the sign-in screen and dashboard: the one uploaded in Settings if
// there is one, otherwise the generic avManage mark.
app.get('/branding/mark', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  const custom = findBrandingMark();
  res.sendFile(custom || path.join(publicDir, 'avmanage-mark.svg'));
});
app.use(express.static(publicDir));

// SPA fallback — let React Router handle non-API routes
app.get('*', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// Bring the database schema up to date before taking requests or starting background jobs.
migrate()
  .then(() => googleAuth.syncConfigFromEnv())
  .then(() => {
    app.listen(port, () => {
      console.log(`avManage listening on port ${port}`);
      initCron();
      initReportCron();
      initLeaseBilling();
      initFlightAware();
      initForeflightEmail();
      initNotifications();
      require('./services/engineAnalysis').reparseStale().catch(err => console.error('[garmin] re-parse failed:', err.message));
    });
  })
  .catch(err => {
    console.error('[migrate]', err.message);
    process.exit(1);
  });
