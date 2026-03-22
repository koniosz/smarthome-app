import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import type { AiQuote } from '../types'
import { QUOTE_BRANDS, QUOTE_STATUS_LABELS } from '../types'
import { aiQuotesApi } from '../api/client'

function fmt(n: number) {
  return new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
}

function fmtInt(n: number) {
  return new Intl.NumberFormat('pl-PL').format(Math.round(n))
}

// Cena jednostkowa po rabacie per-pozycja (rabat nie pokazywany klientowi)
function effectiveUnitPrice(item: AiQuote['items'][0], globalDiscountPct = 0) {
  return (item.unit_price || 0) * (1 - (item.discount_pct || 0) / 100) * (1 - globalDiscountPct / 100)
}
function itemTotal(item: AiQuote['items'][0], globalDiscountPct = 0) {
  return (item.qty || 0) * effectiveUnitPrice(item, globalDiscountPct)
}

export default function AIQuotePrintView() {
  const { id: projectId, quoteId } = useParams<{ id: string; quoteId: string }>()
  const [quote, setQuote] = useState<AiQuote | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!projectId || !quoteId) return
    aiQuotesApi.get(projectId, quoteId)
      .then(q => { setQuote(q); setLoading(false) })
      .catch(() => { setError('Nie znaleziono wyceny.'); setLoading(false) })
  }, [projectId, quoteId])

  useEffect(() => {
    if (quote) {
      const timer = setTimeout(() => window.print(), 1000)
      return () => clearTimeout(timer)
    }
  }, [quote])

  if (loading) return <div className="flex items-center justify-center h-64 text-gray-400">Ładowanie wyceny…</div>
  if (error || !quote) return <div className="flex items-center justify-center h-64 text-red-500">{error || 'Błąd'}</div>

  const rooms = Array.from(new Set(quote.items.map(i => i.room)))
  const discountPct = quote.discount_pct ?? 0
  const laborPct = quote.labor_cost_pct ?? 50
  // Wszystkie rabaty (per-pozycja + globalny) są wliczone w ceny — klient nie widzi rabatów
  const totalEquipment = quote.items.reduce((s, i) => s + itemTotal(i, discountPct), 0)
  const laborCost = totalEquipment * (laborPct / 100)
  const grandTotal = totalEquipment + laborCost

  const brandTotals = QUOTE_BRANDS.reduce<Record<string, number>>((acc, b) => {
    acc[b] = quote.items.filter(i => i.brand === b).reduce((s, i) => s + itemTotal(i, discountPct), 0)
    return acc
  }, {})

  const fileNames = quote.floor_plan_originals?.length
    ? quote.floor_plan_originals
    : quote.floor_plan_original ? [quote.floor_plan_original] : []

  return (
    <div className="print-page bg-white text-gray-900" style={{ fontFamily: 'Arial, sans-serif', fontSize: '11px', padding: '15mm', maxWidth: '210mm', margin: '0 auto' }}>
      <style>{`
        @media print {
          @page { margin: 12mm; size: A4; }
          body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          .no-print { display: none !important; }
        }
        table { border-collapse: collapse; width: 100%; }
        th, td { border: 1px solid #e5e7eb; padding: 3px 7px; }
        th { background: #f9fafb; font-weight: 600; }
        .room-header td { background: #ede9fe; font-weight: 600; }
      `}</style>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '14px', borderBottom: '2px solid #7c3aed', paddingBottom: '10px' }}>
        <div>
          <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#7c3aed' }}>Smart Home Manager</div>
          <div style={{ fontSize: '13px', fontWeight: 'bold', marginTop: '3px' }}>Oferta / Wycena instalacji smart home</div>
          {fileNames.length > 0 && (
            <div style={{ fontSize: '9px', color: '#9ca3af', marginTop: '3px' }}>
              Pliki: {fileNames.join(', ')}
            </div>
          )}
        </div>
        <div style={{ textAlign: 'right', fontSize: '10px', color: '#6b7280' }}>
          <div>Data: {new Date(quote.created_at).toLocaleDateString('pl-PL')}</div>
          <div>Status: {QUOTE_STATUS_LABELS[quote.status]}</div>
          {quote.rooms_detected?.length > 0 && (
            <div style={{ maxWidth: '200px' }}>Pomieszczenia: {quote.rooms_detected.join(', ')}</div>
          )}
        </div>
      </div>

      {/* Items per room */}
      {rooms.map(room => (
        <div key={room} style={{ marginBottom: '14px', breakInside: 'avoid' }}>
          <table>
            <thead>
              <tr className="room-header">
                <td colSpan={6} style={{ background: '#ede9fe', fontWeight: '600', fontSize: '11px', padding: '4px 7px' }}>
                  🏠 {room}
                </td>
              </tr>
              <tr>
                <th style={{ width: '55px' }}>Marka</th>
                <th style={{ width: '75px' }}>Kategoria</th>
                <th>Produkt</th>
                <th style={{ width: '35px', textAlign: 'right' }}>Ilość</th>
                <th style={{ width: '28px' }}>J.m.</th>
                <th style={{ width: '70px', textAlign: 'right' }}>Cena netto</th>
                <th style={{ width: '75px', textAlign: 'right' }}>Razem (PLN)</th>
              </tr>
            </thead>
            <tbody>
              {quote.items.filter(i => i.room === room).map(item => (
                <tr key={item.id}>
                  <td style={{ fontWeight: '500', color: '#7c3aed' }}>{item.brand}</td>
                  <td style={{ color: '#6b7280' }}>{item.category}</td>
                  <td>{item.name}</td>
                  <td style={{ textAlign: 'right' }}>{item.qty}</td>
                  <td style={{ color: '#6b7280' }}>{item.unit}</td>
                  <td style={{ textAlign: 'right' }}>{fmtInt(effectiveUnitPrice(item, discountPct))}</td>
                  <td style={{ textAlign: 'right', fontWeight: '600' }}>{fmtInt(itemTotal(item, discountPct))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      {/* Brand summary */}
      <div style={{ marginTop: '20px', breakInside: 'avoid' }}>
        <div style={{ fontWeight: '600', fontSize: '12px', marginBottom: '6px' }}>Podsumowanie według marek</div>
        <table>
          <thead>
            <tr>
              <th>Marka</th>
              <th style={{ textAlign: 'right' }}>Wartość netto (PLN)</th>
              <th style={{ textAlign: 'right' }}>Udział</th>
            </tr>
          </thead>
          <tbody>
            {QUOTE_BRANDS.filter(b => brandTotals[b] > 0).map(brand => (
              <tr key={brand}>
                <td style={{ fontWeight: '500' }}>{brand}</td>
                <td style={{ textAlign: 'right' }}>{fmt(brandTotals[brand])}</td>
                <td style={{ textAlign: 'right', color: '#6b7280' }}>
                  {totalEquipment > 0 ? ((brandTotals[brand] / totalEquipment) * 100).toFixed(1) : 0}%
                </td>
              </tr>
            ))}
            <tr style={{ background: '#f9fafb', fontWeight: '600' }}>
              <td>Sprzęt łącznie (netto)</td>
              <td style={{ textAlign: 'right' }}>{fmt(totalEquipment)} PLN</td>
              <td style={{ textAlign: 'right' }}>100%</td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Financial summary */}
      <div style={{ marginTop: '16px', breakInside: 'avoid' }}>
        <div style={{ fontWeight: '600', fontSize: '12px', marginBottom: '6px' }}>Podsumowanie finansowe</div>
        <table style={{ width: '50%', marginLeft: 'auto' }}>
          <tbody>
            <tr>
              <td>Wartość sprzętu netto</td>
              <td style={{ textAlign: 'right', fontWeight: '500' }}>{fmt(totalEquipment)} PLN</td>
            </tr>
            <tr>
              <td>Robocizna ({laborPct}% wartości sprzętu)</td>
              <td style={{ textAlign: 'right', fontWeight: '500' }}>{fmt(laborCost)} PLN</td>
            </tr>
            <tr style={{ background: '#f0fdf4', fontWeight: '700', fontSize: '12px' }}>
              <td>RAZEM NETTO</td>
              <td style={{ textAlign: 'right', color: '#16a34a' }}>{fmt(grandTotal)} PLN</td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Description sections */}
      {quote.description && (
        <div style={{ marginTop: '20px', breakInside: 'avoid' }}>
          <div style={{ fontWeight: '600', fontSize: '12px', marginBottom: '8px' }}>Opis oferty</div>
          {[
            { key: 'must_have', label: '✅ Instalacja bazowa (koniecznie)', bg: '#f0fdf4', border: '#bbf7d0' },
            { key: 'nice_to_have', label: '💡 Rekomendowane rozszerzenia', bg: '#eff6ff', border: '#bfdbfe' },
            { key: 'premium', label: '⭐ Funkcjonalności premium', bg: '#f5f3ff', border: '#ddd6fe' },
          ].map(({ key, label, bg, border }) => {
            const text = quote.description?.[key as keyof typeof quote.description]
            if (!text) return null
            return (
              <div key={key} style={{ marginBottom: '8px', padding: '8px 10px', background: bg, border: `1px solid ${border}`, borderRadius: '4px', breakInside: 'avoid' }}>
                <div style={{ fontWeight: '600', fontSize: '10px', marginBottom: '4px' }}>{label}</div>
                <div style={{ color: '#374151', fontSize: '10px', lineHeight: '1.5' }}>{text}</div>
              </div>
            )
          })}
        </div>
      )}

      {/* Notes */}
      {quote.notes && (
        <div style={{ marginTop: '14px', padding: '8px', background: '#f9fafb', borderRadius: '4px', breakInside: 'avoid' }}>
          <div style={{ fontWeight: '600', marginBottom: '3px' }}>Notatki</div>
          <div style={{ color: '#4b5563', whiteSpace: 'pre-wrap' }}>{quote.notes}</div>
        </div>
      )}

      {/* Footer */}
      <div style={{ marginTop: '20px', borderTop: '1px solid #e5e7eb', paddingTop: '8px', display: 'flex', justifyContent: 'space-between', fontSize: '9px', color: '#9ca3af' }}>
        <div>Wycena wygenerowana przez Smart Home Manager · AI ({new Date(quote.created_at).toLocaleDateString('pl-PL')})</div>
        <div>Ceny netto w PLN · Nie zawiera podatku VAT (23%)</div>
      </div>

      {/* Print button */}
      <div className="no-print" style={{ position: 'fixed', bottom: '20px', right: '20px', display: 'flex', gap: '10px' }}>
        <button
          onClick={() => window.history.back()}
          style={{ padding: '10px 20px', background: '#6b7280', color: 'white', borderRadius: '8px', border: 'none', cursor: 'pointer', fontSize: '14px' }}
        >
          ← Wróć
        </button>
        <button
          onClick={() => window.print()}
          style={{ padding: '10px 20px', background: '#7c3aed', color: 'white', borderRadius: '8px', border: 'none', cursor: 'pointer', fontWeight: '600', fontSize: '14px' }}
        >
          📄 Drukuj / Zapisz PDF
        </button>
      </div>
    </div>
  )
}
