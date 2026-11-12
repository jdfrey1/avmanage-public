// Reads the date a photo was taken from its EXIF data (DateTimeOriginal, falling back to
// DateTimeDigitized, then DateTime),
// as YYYY-MM-DD. Handles JPEG only — iPhones hand the browser a JPEG when a photo is picked.
// Returns null when the file has no EXIF date (e.g. a screenshot or a re-saved image).
export async function photoTakenDate(file: File): Promise<string | null> {
  try {
    const buf = await file.slice(0, 256 * 1024).arrayBuffer()
    const v = new DataView(buf)
    if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return null
    let off = 2
    while (off + 4 <= v.byteLength) {
      const marker = v.getUint16(off)
      const size = v.getUint16(off + 2)
      if (marker === 0xffe1 && v.getUint32(off + 4) === 0x45786966) return readTiff(v, off + 10) // "Exif"
      if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) return null
      off += 2 + size
    }
  } catch { /* unreadable — no date */ }
  return null
}

function readTiff(v: DataView, tiff: number): string | null {
  const le = v.getUint16(tiff) === 0x4949
  const u16 = (o: number) => v.getUint16(tiff + o, le)
  const u32 = (o: number) => v.getUint32(tiff + o, le)
  const ascii = (o: number, n: number) => {
    let s = ''
    for (let i = 0; i < n && tiff + o + i < v.byteLength; i++) {
      const c = v.getUint8(tiff + o + i)
      if (!c) break
      s += String.fromCharCode(c)
    }
    return s
  }
  const tags = (ifd: number) => {
    const out = new Map<number, number>() // tag -> offset of its value/offset field
    const n = u16(ifd)
    for (let i = 0; i < n; i++) out.set(u16(ifd + 2 + i * 12), ifd + 2 + i * 12 + 8)
    return out
  }
  const str = (t: Map<number, number>, tag: number) => {
    const at = t.get(tag)
    return at == null ? null : ascii(u32(at), 19) // "YYYY:MM:DD HH:MM:SS"
  }
  const ifd0 = tags(u32(4))
  const exifPtr = ifd0.get(0x8769)
  const exif = exifPtr != null ? tags(u32(exifPtr)) : null
  // DateTimeOriginal (shutter), then DateTimeDigitized, then the file's DateTime (last modified).
  const raw = (exif && (str(exif, 0x9003) ?? str(exif, 0x9004))) ?? str(ifd0, 0x0132)
  const m = raw?.match(/^(\d{4}):(\d{2}):(\d{2})/)
  return m && m[1] !== '0000' ? `${m[1]}-${m[2]}-${m[3]}` : null
}
