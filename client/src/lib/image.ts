// Shrink a phone photo before upload. Full-size camera images are 3–5 MB, which is slow to send
// over a mobile connection, and the vision model scales anything over ~1568px down anyway.
// Re-encoding to JPEG also converts HEIC photos. Falls back to the original file on any error.
export async function shrinkImage(file: File, maxEdge = 2000, quality = 0.85): Promise<File> {
  if (!file.type.startsWith('image/') && !/\.(heic|heif)$/i.test(file.name)) return file
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height))
    const w = Math.round(bitmap.width * scale)
    const h = Math.round(bitmap.height * scale)
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return file
    ctx.drawImage(bitmap, 0, 0, w, h)
    bitmap.close()
    const blob = await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/jpeg', quality))
    if (!blob || (blob.size >= file.size && file.type === 'image/jpeg')) return file
    return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' })
  } catch {
    return file
  }
}
