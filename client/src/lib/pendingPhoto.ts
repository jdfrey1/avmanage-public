let pending: File | null = null

export function setPendingPhoto(f: File) {
  pending = f
}

export function takePendingPhoto(): File | null {
  const f = pending
  pending = null
  return f
}
