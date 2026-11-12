import { useCallback } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'

// A back button that returns to wherever the user actually came from (tab, filters and all, since
// those live in the URL — see useUrlState). Falls back to `fallback` when there's no in-app history,
// e.g. the page was opened from a link or a fresh tab.
export function useGoBack(fallback: string) {
  const navigate = useNavigate()
  return useCallback(() => {
    // React Router numbers its history entries (idx); 0 means this is the first page of the session.
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0
    if (idx > 0) navigate(-1)
    else navigate(fallback, { replace: true })
  }, [navigate, fallback])
}

// useState that lives in a URL query parameter, so the view (tab, filter, month…) survives going to
// another page and coming back. Changes replace the current history entry rather than adding one, so
// Back still leaves the page instead of stepping through every tab click. The default value is kept
// out of the URL.
export function useUrlState<T extends string>(
  key: string,
  defaultValue: T,
  allowed?: readonly T[],
): [T, (v: T | ((prev: T) => T)) => void] {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const raw = searchParams.get(key)
  const value = raw !== null && (!allowed || (allowed as readonly string[]).includes(raw)) ? (raw as T) : defaultValue

  const setValue = useCallback((v: T | ((prev: T) => T)) => {
    // Read the live URL (not the render-time params) so several updates in one handler all stick.
    const params = new URLSearchParams(window.location.search)
    const cur = params.get(key)
    const prev = cur !== null && (!allowed || (allowed as readonly string[]).includes(cur)) ? (cur as T) : defaultValue
    const next = typeof v === 'function' ? (v as (p: T) => T)(prev) : v
    if (next === defaultValue || next === '') params.delete(key)
    else params.set(key, next)
    const qs = params.toString()
    navigate({ pathname: window.location.pathname, search: qs ? `?${qs}` : '', hash: window.location.hash },
      { replace: true, preventScrollReset: true })
  }, [key, defaultValue, allowed, navigate])

  return [value, setValue]
}
