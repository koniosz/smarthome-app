import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { projectsApi, handoverApi } from '../api/client'
import type { HandoverProtocol } from '../api/client'
import type { Project } from '../types'

// Dane wykonawcy do dokumentu (do edycji w razie zmiany danych spółki).
const COMPANY = {
  name: 'Smart Home Center Sp. z o.o.',
  address: 'Gieysztora 6/u8, 02-999 Warszawa',
  nip: 'PL9512423139',
}

function fmtDateTime(s?: string | null) {
  if (!s) return '—'
  const d = new Date(s)
  return isNaN(d.getTime()) ? s : d.toLocaleString('pl-PL', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}
function fmtDate(s?: string | null) {
  if (!s) return '—'
  const d = new Date(s); return isNaN(d.getTime()) ? s : d.toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

export default function HandoverPrintView() {
  const { id, protocolId } = useParams<{ id: string; protocolId: string }>()
  const [project, setProject] = useState<Project | null>(null)
  const [proto, setProto] = useState<HandoverProtocol | null>(null)
  const [loading, setLoading] = useState(true)
  const [pdfBusy, setPdfBusy] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)

  const generatePdf = async () => {
    if (!contentRef.current || !proto) return
    setPdfBusy(true)
    try {
      const html2pdf = (await import('html2pdf.js')).default
      await html2pdf().set({
        margin: [10, 10, 10, 10],
        filename: `Protokol_odbioru_${proto.number.replace(/\//g, '-')}.pdf`,
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: { scale: 2, useCORS: true, backgroundColor: '#ffffff' },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
      }).from(contentRef.current).save()
    } catch {
      alert('Nie udało się wygenerować PDF.')
    } finally {
      setPdfBusy(false)
    }
  }

  useEffect(() => {
    if (!id || !protocolId) return
    Promise.all([projectsApi.get(id), handoverApi.list(id)])
      .then(([p, list]) => { setProject(p); setProto(list.find(x => x.id === protocolId) ?? null) })
      .finally(() => setLoading(false))
  }, [id, protocolId])

  useEffect(() => { document.title = proto ? `Protokół odbioru ${proto.number}` : 'Protokół odbioru' }, [proto])

  if (loading) return <div style={{ padding: 40, fontFamily: 'sans-serif' }}>Ładowanie…</div>
  if (!proto || !project) return <div style={{ padding: 40, fontFamily: 'sans-serif' }}>Nie znaleziono protokołu.</div>

  const accepted = proto.status === 'accepted'

  return (
    <div style={{ background: '#fff', minHeight: '100vh' }}>
      <style>{`@media print { .no-print { display:none !important } body { margin:0 } } @page { margin: 18mm }`}</style>

      <div className="no-print" style={{ position: 'sticky', top: 0, background: '#f8fafc', borderBottom: '1px solid #e5e7eb', padding: '10px 16px', display: 'flex', gap: 10, justifyContent: 'flex-end', zIndex: 10 }}>
        <button onClick={generatePdf} disabled={pdfBusy} style={{ background: '#16a34a', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 18px', fontSize: 14, fontWeight: 600, cursor: pdfBusy ? 'default' : 'pointer', opacity: pdfBusy ? 0.6 : 1 }}>{pdfBusy ? 'Generuję PDF…' : '📄 Pobierz PDF'}</button>
        <button onClick={() => window.print()} style={{ background: '#2563eb', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 18px', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>🖨 Drukuj</button>
      </div>

      <div ref={contentRef} style={{ maxWidth: 760, margin: '0 auto', padding: '32px 28px', fontFamily: "'Segoe UI', Arial, sans-serif", color: '#111827', fontSize: 14, lineHeight: 1.55 }}>
        {/* Nagłówek */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24, paddingBottom: 16, borderBottom: '2px solid #111827' }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 800 }}>{COMPANY.name}</div>
            <div style={{ fontSize: 12, color: '#4b5563' }}>{COMPANY.address}</div>
            <div style={{ fontSize: 12, color: '#4b5563' }}>NIP: {COMPANY.nip}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 12, color: '#6b7280' }}>Nr dokumentu</div>
            <div style={{ fontSize: 15, fontWeight: 700 }}>{proto.number}</div>
            <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>Data wystawienia: {fmtDate(proto.created_at)}</div>
          </div>
        </div>

        <h1 style={{ textAlign: 'center', fontSize: 20, fontWeight: 800, letterSpacing: 0.5, margin: '8px 0 24px' }}>PROTOKÓŁ ODBIORU WYKONANYCH PRAC</h1>

        {/* Strony */}
        <div style={{ display: 'flex', gap: 16, marginBottom: 20 }}>
          <div style={{ flex: 1, border: '1px solid #e5e7eb', borderRadius: 8, padding: 14 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', marginBottom: 6 }}>Wykonawca</div>
            <div style={{ fontWeight: 600 }}>{COMPANY.name}</div>
            <div style={{ fontSize: 12, color: '#4b5563' }}>{COMPANY.address}</div>
            <div style={{ fontSize: 12, color: '#4b5563' }}>NIP: {COMPANY.nip}</div>
          </div>
          <div style={{ flex: 1, border: '1px solid #e5e7eb', borderRadius: 8, padding: 14 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', marginBottom: 6 }}>Zamawiający</div>
            <div style={{ fontWeight: 600 }}>{project.client_name || '—'}</div>
            <div style={{ fontSize: 12, color: '#4b5563' }}>{project.client_contact || ''}</div>
          </div>
        </div>

        <p style={{ margin: '0 0 6px' }}><strong>Projekt:</strong> {project.name}</p>
        {proto.title ? <p style={{ margin: '0 0 12px' }}><strong>Tytuł:</strong> {proto.title}</p> : null}

        {/* Zakres */}
        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', marginBottom: 6 }}>Zakres wykonanych prac</div>
          <div style={{ whiteSpace: 'pre-line', border: '1px solid #e5e7eb', borderRadius: 8, padding: 14, minHeight: 60, background: '#fafafa' }}>{proto.scope || '—'}</div>
        </div>

        {/* Oświadczenie */}
        <p style={{ margin: '0 0 18px' }}>
          Zamawiający niniejszym potwierdza odbiór wykonanych prac w zakresie określonym powyżej
          {accepted ? ', bez zastrzeżeń (o ile w uwagach nie wskazano inaczej).' : '.'}
        </p>

        {(proto.client_comment) ? (
          <div style={{ marginBottom: 18 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', marginBottom: 6 }}>Uwagi Zamawiającego</div>
            <div style={{ whiteSpace: 'pre-line', border: '1px solid #fde68a', background: '#fffbeb', borderRadius: 8, padding: 12 }}>{proto.client_comment}</div>
          </div>
        ) : null}

        {/* Status / podpis */}
        {accepted ? (
          <div style={{ marginTop: 28, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 24 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: "'Segoe Script','Brush Script MT',cursive", fontSize: 26, color: '#1e3a8a', borderBottom: '1px solid #9ca3af', paddingBottom: 4 }}>{proto.signature || proto.client_name}</div>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 6 }}>Podpis Zamawiającego (elektronicznie)</div>
              <div style={{ fontSize: 12, color: '#6b7280' }}>Data akceptacji: {fmtDateTime(proto.accepted_at)}</div>
            </div>
            <div style={{ textAlign: 'center', color: '#16a34a', fontWeight: 700, fontSize: 13, border: '2px solid #16a34a', borderRadius: 8, padding: '8px 14px' }}>ODEBRANO</div>
          </div>
        ) : (
          <div style={{ marginTop: 32, display: 'flex', gap: 40 }}>
            <div style={{ flex: 1 }}><div style={{ borderTop: '1px solid #9ca3af', paddingTop: 6, fontSize: 12, color: '#6b7280' }}>Podpis Wykonawcy</div></div>
            <div style={{ flex: 1 }}><div style={{ borderTop: '1px solid #9ca3af', paddingTop: 6, fontSize: 12, color: '#6b7280' }}>Podpis Zamawiającego</div></div>
          </div>
        )}

        <p style={{ marginTop: 28, fontSize: 11, color: '#9ca3af', textAlign: 'center' }}>
          Dokument wygenerowany elektronicznie{accepted ? ' — akceptacja potwierdzona zdalnie przez Zamawiającego' : ''}.
        </p>
      </div>
    </div>
  )
}
