import { useEffect, useRef, useState } from 'react'
import type { KsefLineItem } from '../../types'

// Dyskretna lista pozycji faktury. Ładuje się leniwie dopiero, gdy wiersz
// wejdzie w widok (IntersectionObserver), żeby nie odpalać dziesiątek zapytań
// naraz. Backend cache'uje wynik, więc kolejne wyświetlenia są natychmiastowe.
export default function InvoiceLineItems({ load, padLeft = 0 }: {
  load: () => Promise<KsefLineItem[]>
  padLeft?: number
}) {
  const [items, setItems]   = useState<KsefLineItem[] | null>(null)
  const [loading, setLoad]  = useState(false)
  const ref                 = useRef<HTMLDivElement>(null)
  const started             = useRef(false)

  useEffect(() => {
    const el = ref.current
    if (!el || started.current) return
    const io = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting) && !started.current) {
        started.current = true
        io.disconnect()
        setLoad(true)
        load()
          .then(setItems)
          .catch(() => setItems([]))
          .finally(() => setLoad(false))
      }
    }, { rootMargin: '120px' })
    io.observe(el)
    return () => io.disconnect()
  }, [load])

  return (
    <div ref={ref} style={{ paddingLeft: padLeft, marginTop: 4 }}>
      {loading && (
        <div style={{ fontSize: 11, color: '#cbd5e1', fontStyle: 'italic' }}>wczytywanie pozycji…</div>
      )}
      {items && items.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 10px', fontSize: 11, color: '#94a3b8', lineHeight: 1.5 }}>
          {items.map((it, i) => (
            <span key={i} style={{ whiteSpace: 'nowrap' }}>
              {it.qty && <span style={{ fontVariantNumeric: 'tabular-nums' }}>{it.qty}{it.unit ? ` ${it.unit}` : ''} × </span>}
              <span style={{ color: '#64748b' }}>{it.name}</span>
              {i < items.length - 1 && <span style={{ color: '#e2e8f0' }}> ·</span>}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
