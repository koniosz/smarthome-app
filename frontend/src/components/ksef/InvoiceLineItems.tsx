import { useEffect, useState } from 'react'
import { Package } from 'lucide-react'
import type { KsefLineItem } from '../../types'

// Dyskretna lista pozycji faktury. Ładuje się od razu po zamontowaniu wiersza —
// backend cache'uje wynik (i serializuje pobrania z KSeF), więc nie zalewa API.
export default function InvoiceLineItems({ invoiceId, load }: {
  invoiceId: string
  load: () => Promise<KsefLineItem[]>
}) {
  const [items, setItems]  = useState<KsefLineItem[] | null>(null)
  const [loading, setLoad] = useState(true)

  // klucz na invoiceId — pobranie tylko gdy zmieni się faktura, nie przy każdym renderze
  useEffect(() => {
    let alive = true
    setLoad(true)
    load()
      .then(r => { if (alive) setItems(r) })
      .catch(() => { if (alive) setItems([]) })
      .finally(() => { if (alive) setLoad(false) })
    return () => { alive = false }
  }, [invoiceId]) // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) {
    return <div style={{ fontSize: 11, color: '#cbd5e1', fontStyle: 'italic', marginTop: 4 }}>wczytywanie pozycji…</div>
  }
  if (!items || items.length === 0) return null

  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, marginTop: 5 }}>
      <Package size={12} color="#cbd5e1" style={{ flexShrink: 0, marginTop: 2 }} />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 8px', fontSize: 11.5, color: '#94a3b8', lineHeight: 1.5 }}>
        {items.map((it, i) => (
          <span key={i} style={{ whiteSpace: 'nowrap' }}>
            {it.qty && (
              <span style={{ fontVariantNumeric: 'tabular-nums', color: '#cbd5e1' }}>
                {Number(it.qty).toLocaleString('pl-PL')}{it.unit ? ` ${it.unit}` : ''}×{' '}
              </span>
            )}
            <span style={{ color: '#64748b' }}>{it.name}</span>
            {i < items.length - 1 && <span style={{ color: '#e2e8f0' }}> ·</span>}
          </span>
        ))}
      </div>
    </div>
  )
}
