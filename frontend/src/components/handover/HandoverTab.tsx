import { useEffect, useState } from 'react'
import Modal from '../ui/Modal'
import { handoverApi } from '../../api/client'
import type { HandoverProtocol } from '../../api/client'
import type { Project } from '../../types'

const STATUS: Record<string, { label: string; cls: string }> = {
  draft: { label: 'Szkic', cls: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400' },
  sent: { label: 'Wysłany do klienta', cls: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300' },
  accepted: { label: '✓ Odebrany', cls: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300' },
}
const inputCls = 'w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500'
const lblCls = 'block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1'

export default function HandoverTab({ projectId, project }: { projectId: string; project: Project }) {
  const [list, setList] = useState<HandoverProtocol[]>([])
  const [loading, setLoading] = useState(true)
  const [showNew, setShowNew] = useState(false)
  const [sendFor, setSendFor] = useState<HandoverProtocol | null>(null)

  const load = () => { setLoading(true); handoverApi.list(projectId).then(setList).catch(() => setList([])).finally(() => setLoading(false)) }
  useEffect(() => { load() }, [projectId])

  const del = async (p: HandoverProtocol) => {
    if (!window.confirm(`Usunąć protokół ${p.number}?`)) return
    try { await handoverApi.delete(projectId, p.id); load() } catch { alert('Nie udało się usunąć.') }
  }
  const openPrint = (p: HandoverProtocol) => window.open(`/projects/${projectId}/handover/${p.id}/print`, '_blank')

  return (
    <div>
      <div className="flex justify-end mb-3">
        <button onClick={() => setShowNew(true)} className="px-3 py-1.5 text-xs font-medium bg-violet-600 hover:bg-violet-700 text-white rounded-lg">+ Nowy protokół odbioru</button>
      </div>

      {loading ? <div className="text-center py-10 text-gray-400">Ładowanie…</div>
        : list.length === 0 ? <div className="text-center py-10 text-gray-400 text-sm">Brak protokołów. Utwórz protokół odbioru i wyślij go klientowi do podpisu.</div>
        : (
          <div className="space-y-2">
            {list.map(p => {
              const st = STATUS[p.status] ?? STATUS.draft
              return (
                <div key={p.id} className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-3.5">
                  <div className="flex items-center gap-3 flex-wrap">
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold text-gray-800 dark:text-gray-100">{p.number}{p.title ? ` · ${p.title}` : ''}</div>
                      <div className="text-xs text-gray-400 truncate">{p.scope || 'Bez opisu zakresu'}</div>
                    </div>
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${st.cls}`}>{st.label}</span>
                    <div className="flex items-center gap-1.5">
                      {p.status !== 'accepted' && (
                        <button onClick={() => setSendFor(p)} className="px-2.5 py-1 text-xs bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800 rounded hover:bg-blue-100">✉️ {p.status === 'sent' ? 'Wyślij ponownie' : 'Wyślij'}</button>
                      )}
                      <button onClick={() => openPrint(p)} className="px-2.5 py-1 text-xs border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 rounded hover:bg-gray-100 dark:hover:bg-gray-800">🖨 Drukuj</button>
                      <button onClick={() => del(p)} className="px-2 py-1 text-xs border border-red-200 dark:border-red-900 text-red-500 rounded hover:bg-red-50">🗑</button>
                    </div>
                  </div>
                  {p.status === 'accepted' && (
                    <div className="mt-2 pt-2 border-t border-gray-100 dark:border-gray-800 text-xs text-gray-500 dark:text-gray-400">
                      Podpisano: <strong>{p.signature || p.client_name}</strong>{p.accepted_at ? ` · ${new Date(p.accepted_at).toLocaleString('pl-PL')}` : ''}
                      {p.client_comment ? <div className="mt-1 text-amber-600 dark:text-amber-400">Uwagi: {p.client_comment}</div> : null}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}

      {showNew && <NewModal projectId={projectId} onClose={() => setShowNew(false)} onSaved={() => { setShowNew(false); load() }} />}
      {sendFor && <SendModal projectId={projectId} proto={sendFor} project={project} onClose={() => setSendFor(null)} onSent={() => { setSendFor(null); load() }} />}
    </div>
  )
}

function NewModal({ projectId, onClose, onSaved }: { projectId: string; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState('')
  const [scope, setScope] = useState('')
  const [saving, setSaving] = useState(false)
  const save = async () => {
    setSaving(true)
    try { await handoverApi.create(projectId, { title: title.trim() || undefined, scope: scope.trim() || undefined }); onSaved() }
    catch { alert('Błąd zapisu.') } finally { setSaving(false) }
  }
  return (
    <Modal title="Nowy protokół odbioru" onClose={onClose} wide>
      <div className="space-y-4">
        <div><label className={lblCls}>Tytuł (opcjonalnie)</label><input className={inputCls} value={title} onChange={e => setTitle(e.target.value)} placeholder="np. Etap I — instalacja KNX" /></div>
        <div><label className={lblCls}>Zakres wykonanych prac</label><textarea className={inputCls} rows={5} value={scope} onChange={e => setScope(e.target.value)} placeholder="Opisz, jakie prace zostały wykonane i odebrane…" /></div>
        <div className="flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg">Anuluj</button>
          <button onClick={save} disabled={saving} className="px-4 py-2 text-sm font-medium bg-violet-600 hover:bg-violet-700 text-white rounded-lg disabled:opacity-50">{saving ? 'Zapisywanie…' : 'Utwórz'}</button>
        </div>
      </div>
    </Modal>
  )
}

function SendModal({ projectId, proto, project, onClose, onSent }: { projectId: string; proto: HandoverProtocol; project: Project; onClose: () => void; onSent: () => void }) {
  const [email, setEmail] = useState(proto.client_email || (project.client_contact?.includes('@') ? project.client_contact : ''))
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const send = async () => {
    if (!email.includes('@')) { setErr('Podaj poprawny e-mail klienta'); return }
    setSaving(true); setErr('')
    try { await handoverApi.send(projectId, proto.id, email.trim()); alert(`Protokół ${proto.number} wysłany do ${email}. Klient otrzyma link do podpisu.`); onSent() }
    catch (e: any) { setErr(e?.response?.data?.error || 'Nie udało się wysłać e-maila.') } finally { setSaving(false) }
  }
  return (
    <Modal title={`Wyślij protokół ${proto.number}`} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm text-gray-500 dark:text-gray-400">Klient dostanie e-mail z linkiem, gdzie potwierdzi odbiór, doda uwagi i podpisze się.</p>
        <div><label className={lblCls}>E-mail klienta</label><input className={inputCls} value={email} onChange={e => setEmail(e.target.value)} placeholder="klient@firma.pl" /></div>
        {err && <div className="text-sm text-red-500">{err}</div>}
        <div className="flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg">Anuluj</button>
          <button onClick={send} disabled={saving} className="px-4 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white rounded-lg disabled:opacity-50">{saving ? 'Wysyłanie…' : 'Wyślij do klienta'}</button>
        </div>
      </div>
    </Modal>
  )
}
