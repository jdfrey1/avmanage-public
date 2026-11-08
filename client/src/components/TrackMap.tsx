import { useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

// Flight track on a map (OpenStreetMap or satellite), with start/end markers and an optional
// marker at the hovered sample (shared with the charts).

export interface MapPoint { lat: number; lon: number }

const LAYERS = {
  Map: {
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
  },
  Satellite: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Imagery &copy; Esri',
    maxZoom: 18,
  },
} as const
type LayerName = keyof typeof LAYERS

export function TrackMap({ points, hover, className = 'h-72 md:h-96' }: { points: (MapPoint | null)[]; hover?: number | null; className?: string }) {
  const el = useRef<HTMLDivElement>(null)
  const map = useRef<L.Map | null>(null)
  const tiles = useRef<L.TileLayer | null>(null)
  const labels = useRef<L.TileLayer | null>(null)
  const marker = useRef<L.CircleMarker | null>(null)
  const [layer, setLayer] = useState<LayerName>('Satellite')

  useEffect(() => {
    if (!el.current) return
    const valid = points.filter((p): p is MapPoint => !!p && Number.isFinite(p.lat) && Number.isFinite(p.lon))
    const m = L.map(el.current, { zoomControl: true, attributionControl: true, zoomSnap: 0.25 })
    let bounds: L.LatLngBounds | null = null
    map.current = m
    if (valid.length) {
      const line = L.polyline(valid.map(p => [p.lat, p.lon] as L.LatLngTuple), { color: '#2563eb', weight: 3 }).addTo(m)
      L.circleMarker([valid[0].lat, valid[0].lon], { radius: 6, color: '#fff', weight: 2, fillColor: '#10b981', fillOpacity: 1 }).addTo(m).bindTooltip('Start')
      const end = valid[valid.length - 1]
      L.circleMarker([end.lat, end.lon], { radius: 6, color: '#fff', weight: 2, fillColor: '#e11d48', fillOpacity: 1 }).addTo(m).bindTooltip('End')
      bounds = line.getBounds()
      m.fitBounds(bounds, { padding: [24, 24] })
    } else {
      m.setView([39.5, -98.35], 4)
    }
    // The map is created before the pop-up is laid out; re-measure and re-fit once it is.
    const t = setTimeout(() => {
      m.invalidateSize()
      if (bounds) m.fitBounds(bounds, { padding: [24, 24] })
    }, 60)
    return () => { clearTimeout(t); m.remove(); map.current = null; tiles.current = null; labels.current = null; marker.current = null }
  }, [points])

  useEffect(() => {
    const m = map.current
    if (!m) return
    tiles.current?.remove()
    labels.current?.remove(); labels.current = null
    const cfg = LAYERS[layer]
    tiles.current = L.tileLayer(cfg.url, { attribution: cfg.attribution, maxZoom: cfg.maxZoom }).addTo(m)
    if (layer === 'Satellite') {
      // Town names and borders over the imagery, so it's easy to tell where you are.
      labels.current = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', { maxZoom: 18 }).addTo(m)
    }
  }, [layer, points])

  useEffect(() => {
    const m = map.current
    if (!m) return
    const p = hover != null ? points[hover] : null
    if (!p) { marker.current?.remove(); marker.current = null; return }
    if (!marker.current) {
      marker.current = L.circleMarker([p.lat, p.lon], { radius: 7, color: '#fff', weight: 2, fillColor: '#f59e0b', fillOpacity: 1 }).addTo(m)
    } else {
      marker.current.setLatLng([p.lat, p.lon])
    }
  }, [hover, points])

  return (
    <div className="relative">
      <div ref={el} className={`w-full rounded-md ${className}`} style={{ zIndex: 0 }} />
      <div className="absolute right-2 top-2 z-[400] flex overflow-hidden rounded-md border bg-background text-xs shadow">
        {(Object.keys(LAYERS) as LayerName[]).map(n => (
          <button key={n} type="button" onClick={() => setLayer(n)}
            className={`px-2 py-1 ${layer === n ? 'bg-primary text-primary-foreground' : 'hover:bg-accent'}`}>
            {n}
          </button>
        ))}
      </div>
    </div>
  )
}
