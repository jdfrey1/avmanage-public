const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const BRANDING_DIR = path.join(process.env.UPLOADS_DIR || '/data/uploads', 'branding');
const EXTS = ['jpg', 'png', 'webp'];

// Path of the uploaded aircraft image, or null when none has been uploaded.
function findBrandingMark() {
  for (const ext of EXTS) {
    const p = path.join(BRANDING_DIR, `mark.${ext}`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function saveBrandingMark(buffer, mimetype) {
  const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[mimetype];
  if (!ext) throw Object.assign(new Error('Image must be a JPEG, PNG or WebP'), { status: 400 });
  fs.mkdirSync(BRANDING_DIR, { recursive: true });
  clearBrandingMark();
  fs.writeFileSync(path.join(BRANDING_DIR, `mark.${ext}`), buffer);
  archiveToDrive(`mark.${ext}`, mimetype, buffer);
}

// Keeps a copy of the aircraft image in the Drive "App Branding" folder (it isn't in the database
// backups). Best effort: the upload itself has already succeeded on local disk.
function archiveToDrive(name, mimeType, buffer) {
  const googleAuth = require('./googleAuth');
  const googleDrive = require('./googleDrive');
  googleAuth.isConnected().then(async (connected) => {
    if (!connected) return;
    await googleDrive.ensureFolderStructure();
    const existing = await googleDrive.findFileId('branding', name);
    if (existing) await googleDrive.updateFileContent(existing, { mimeType, buffer });
    else await googleDrive.uploadFile('branding', { name, mimeType, buffer });
  }).catch(err => console.error('Branding Drive copy failed:', err.message));
}

function clearBrandingMark() {
  for (const ext of EXTS) fs.rmSync(path.join(BRANDING_DIR, `mark.${ext}`), { force: true });
  for (const size of ICON_SIZES) fs.rmSync(path.join(BRANDING_DIR, `icon-${size}.png`), { force: true });
}

// Home-screen / browser-tab icons made from the uploaded image: centered on a square of the
// image's own background color (taken from its corner), with a small margin. Made on first
// request and remade whenever the image changes. Null when no image is uploaded.
const ICON_SIZES = [32, 180, 192, 512];
function brandingIcon(size) {
  const mark = findBrandingMark();
  if (!mark || !ICON_SIZES.includes(size)) return null;
  const out = path.join(BRANDING_DIR, `icon-${size}.png`);
  if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(mark).mtimeMs) return out;
  try {
    const bg = execFileSync('convert', [mark, '-format', '%[pixel:p{3,3}]', 'info:']).toString().trim() || 'white';
    const inner = Math.round(size * 0.92);
    execFileSync('convert', [mark, '-resize', `${inner}x${inner}`, '-background', bg, '-gravity', 'center',
      '-extent', `${size}x${size}`, '-strip', `png:${out}`]);
    return out;
  } catch (err) {
    console.error('Branding icon failed:', err.message);
    return null;
  }
}

module.exports = { findBrandingMark, saveBrandingMark, clearBrandingMark, brandingIcon, ICON_SIZES };
