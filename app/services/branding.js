const fs = require('fs');
const path = require('path');

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
}

function clearBrandingMark() {
  for (const ext of EXTS) fs.rmSync(path.join(BRANDING_DIR, `mark.${ext}`), { force: true });
}

module.exports = { findBrandingMark, saveBrandingMark, clearBrandingMark };
