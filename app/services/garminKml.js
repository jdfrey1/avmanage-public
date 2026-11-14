// Google Earth (KML) file for a Garmin data log: the flight path at its true altitude with a
// curtain down to the ground, takeoff/landing pins, and a clickable point every minute with the
// flight and engine readings. Saved next to the CSV in Drive's "Garmin Data Logs" folder, where
// Drive's "Open with → Google Earth" shows it in a browser.
const pool = require('../db');
const googleAuth = require('./googleAuth');
const googleDrive = require('./googleDrive');

const FT_TO_M = 0.3048;
const KML_MIME = 'application/vnd.google-earth.kml+xml';
const TZ = process.env.APP_TIMEZONE || 'America/New_York';

const esc = (s) => String(s ?? '').replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
const clock = (ms) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: TZ });
const fmt = (v, unit, d = 0) => (v == null ? null : `${Number(v).toFixed(d)}${unit}`);

// f = 0 (lowest) … 1 (highest) → RGB on the hue wheel from red (0°) to magenta (300°), at
// GPS Visualizer's saturation/brightness (0.9 value).
function bandRgb(f) {
  const h = 300 * f / 60, v = 230, x = Math.round(v * (1 - Math.abs((h % 2) - 1)));
  const k = Math.floor(h) % 6;
  return [[v, x, 0], [x, v, 0], [0, v, x], [0, x, v], [x, 0, v], [v, 0, x]][k];
}

function buildKml(log) {
  const s = log.series || {};
  const n = (s.t || []).length;
  const at = (k, i) => s[k]?.[i] ?? null;
  const ok = (i) => at('lat', i) != null && at('lon', i) != null && at('alt', i) != null;
  const coord = (i) => `${at('lon', i)},${at('lat', i)},${Math.round(at('alt', i) * FT_TO_M)}`;
  const idx = [...Array(n).keys()].filter(ok);
  if (idx.length < 2) return null;

  const timeOf = (i) => s.t0 + s.t[i] * 1000;
  const maxCht = (i) => {
    const v = [1, 2, 3, 4, 5, 6].map(c => at(`cht${c}`, i)).filter(x => x != null);
    return v.length ? Math.max(...v) : null;
  };
  const reading = (i) => [
    `Time: ${clock(timeOf(i))}`,
    fmt(at('alt', i), ' ft MSL') && `Altitude: ${fmt(at('alt', i), ' ft MSL')}`,
    fmt(at('gs', i), ' kt') && `Groundspeed: ${fmt(at('gs', i), ' kt')}`,
    fmt(at('ias', i), ' kt') && `IAS: ${fmt(at('ias', i), ' kt')}`,
    fmt(at('vs', i), ' fpm') && `Vertical speed: ${fmt(at('vs', i), ' fpm')}`,
    fmt(at('rpm', i), '') && `RPM: ${fmt(at('rpm', i), '')}`,
    fmt(at('map', i), ' in', 1) && `MAP: ${fmt(at('map', i), ' in', 1)}`,
    fmt(at('ff', i), ' gph', 1) && `Fuel flow: ${fmt(at('ff', i), ' gph', 1)}`,
    maxCht(i) != null && `Hottest CHT: ${maxCht(i)}°F`,
    fmt(at('oilt', i), '°F') && `Oil temp: ${fmt(at('oilt', i), '°F')}`,
  ].filter(Boolean).join('<br/>');

  // A reading pin once a minute while airborne (groundspeed over 40 kt), plus takeoff and landing.
  const pins = [];
  let next = -Infinity;
  for (const i of idx) {
    if ((at('gs', i) ?? 0) < 40 || s.t[i] < next) continue;
    next = s.t[i] + 60;
    pins.push(i);
  }
  const msOf = (iso) => (iso ? new Date(iso).getTime() : null);
  const nearest = (ms) => (ms == null ? null : idx.reduce((b, i) => (Math.abs(timeOf(i) - ms) < Math.abs(timeOf(b) - ms) ? i : b), idx[0]));
  const off = nearest(msOf(log.takeoff_at)), on = nearest(msOf(log.landing_at));

  const title = `${log.origin || '?'} → ${log.destination || '?'} · ${new Date(log.started_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: TZ })}`;
  const summary = [
    log.engine_hrs != null && `${log.engine_hrs.toFixed(1)} hrs engine`,
    log.air_hrs != null && `${log.air_hrs.toFixed(1)} hrs airborne`,
    log.fuel_used_gal != null && `${log.fuel_used_gal.toFixed(1)} gal burned`,
    log.max_cht != null && `peak CHT ${log.max_cht}°F (#${log.max_cht_cyl})`,
  ].filter(Boolean).join(' · ');
  const maxAlt = Math.max(...idx.map(i => at('alt', i)));

  // Track colored by altitude, GPS Visualizer style: hue runs red (lowest) → yellow → green →
  // blue → magenta (highest), each piece extruded to the ground in its own color. Consecutive
  // samples in the same color band share one LineString to keep the file small.
  const alts = idx.map(i => at('alt', i));
  const lo = Math.min(...alts), hi = Math.max(...alts);
  const BANDS = 40;
  const band = (alt) => (hi > lo ? Math.min(BANDS - 1, Math.floor(((alt - lo) / (hi - lo)) * BANDS)) : 0);
  const pieces = [];
  for (let k = 1; k < idx.length; k++) {
    const b = band((at('alt', idx[k - 1]) + at('alt', idx[k])) / 2);
    const last = pieces[pieces.length - 1];
    if (last && last.b === b && last.end === k - 1) { last.pts.push(idx[k]); last.end = k; }
    else pieces.push({ b, end: k, pts: [idx[k - 1], idx[k]] });
  }
  const styles = [...new Set(pieces.map(p => p.b))].map(b => {
    const [r, g, bl] = bandRgb(b / (BANDS - 1));
    const bgr = [bl, g, r].map(v => v.toString(16).padStart(2, '0')).join('');
    return `  <Style id="alt${b}"><LineStyle><color>ff${bgr}</color><width>2</width></LineStyle><PolyStyle><color>99${bgr}</color><outline>0</outline></PolyStyle></Style>`;
  }).join('\n');
  const legend = [1, 0.75, 0.5, 0.25, 0].map(f => {
    const [r, g, bl] = bandRgb(f);
    const hex = [r, g, bl].map(v => v.toString(16).padStart(2, '0')).join('');
    return `
    <Placemark><name><![CDATA[<span style="color:#${hex};"><b>${Math.round(lo + f * (hi - lo)).toLocaleString('en-US')} ft</b></span>]]></name><styleUrl>#legend</styleUrl></Placemark>`;
  }).join('');
  const trackPieces = pieces.map(p => `
    <Placemark><styleUrl>#alt${p.b}</styleUrl>
      <LineString><extrude>1</extrude><tessellate>0</tessellate><altitudeMode>absolute</altitudeMode><coordinates>${p.pts.map(coord).join(' ')}</coordinates></LineString></Placemark>`).join('');

  const pin = (i, name, style) => `
      <Placemark><name>${esc(name)}</name><styleUrl>#${style}</styleUrl>
        <description><![CDATA[${reading(i)}]]></description>
        <Point><altitudeMode>absolute</altitudeMode><coordinates>${coord(i)}</coordinates></Point></Placemark>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
  <name>${esc(title)}</name>
  <description>${esc(`${summary}${summary ? ' · ' : ''}max ${maxAlt} ft MSL. Garmin data log ${log.filename}.`)}</description>
${styles}
  <Style id="legend"><IconStyle><Icon><href>http://maps.google.com/mapfiles/kml/pal2/icon26.png</href></Icon></IconStyle></Style>
  <Style id="reading"><IconStyle><scale>0.5</scale><Icon><href>http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href></Icon></IconStyle><LabelStyle><scale>0</scale></LabelStyle></Style>
  <Style id="airport"><IconStyle><scale>1.0</scale><Icon><href>http://maps.google.com/mapfiles/kml/shapes/airports.png</href></Icon></IconStyle></Style>
  <Folder><name>Legend: altitude (ft MSL)</name><open>1</open>${legend}
  </Folder>
  <Folder><name>Track</name>${trackPieces}
  </Folder>${off != null ? pin(off, `Takeoff ${log.origin || ''} ${clock(timeOf(off))}`, 'airport') : ''}${on != null ? pin(on, `Landing ${log.destination || ''} ${clock(timeOf(on))}`, 'airport') : ''}
  <Folder><name>Readings (each minute)</name>${pins.map(i => pin(i, clock(timeOf(i)), 'reading')).join('')}
  </Folder>
</Document>
</kml>
`;
}

const KML_COLS = `id, filename, series, origin, destination, started_at, takeoff_at, landing_at, kml_drive_file_id,
  engine_hrs::float, air_hrs::float, fuel_used_gal::float, max_cht::float, max_cht_cyl`;

// Makes the KML for a log and saves it to Drive (once). Returns the Drive file id, or null when
// Drive isn't connected or the log has no position data.
async function ensureKml(logId) {
  const { rows: [log] } = await pool.query(`SELECT ${KML_COLS} FROM garmin_data_logs WHERE id = $1`, [logId]);
  if (!log) return null;
  if (log.kml_drive_file_id) return log.kml_drive_file_id;
  if (!(await googleAuth.isConnected())) return null;
  const kml = buildKml(log);
  if (!kml) return null;
  await googleDrive.ensureFolderStructure();
  const fileId = await googleDrive.uploadFile('garminLogs', {
    name: log.filename.replace(/\.csv$/i, '') + '.kml', mimeType: KML_MIME, buffer: Buffer.from(kml, 'utf8'),
  });
  await pool.query('UPDATE garmin_data_logs SET kml_drive_file_id = $1 WHERE id = $2', [fileId, logId]);
  return fileId;
}

// Rewrites a log's KML already on Drive (after the KML format changes).
async function rebuildKml(logId) {
  const { rows: [log] } = await pool.query(`SELECT ${KML_COLS} FROM garmin_data_logs WHERE id = $1`, [logId]);
  if (!log?.kml_drive_file_id) return ensureKml(logId);
  const kml = buildKml(log);
  if (!kml) return null;
  await googleDrive.updateFileContent(log.kml_drive_file_id, { mimeType: KML_MIME, buffer: Buffer.from(kml, 'utf8') });
  return log.kml_drive_file_id;
}

async function kmlFor(logId, partnershipId) {
  const { rows: [log] } = await pool.query(`SELECT ${KML_COLS} FROM garmin_data_logs WHERE id = $1 AND partnership_id = $2`, [logId, partnershipId]);
  return log ? { name: log.filename.replace(/\.csv$/i, '') + '.kml', kml: buildKml(log) } : null;
}

module.exports = { buildKml, ensureKml, rebuildKml, kmlFor, KML_MIME };
