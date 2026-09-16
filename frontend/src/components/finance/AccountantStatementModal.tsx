import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { X, Upload, Trash2, FileSpreadsheet, Scale, BookOpen } from 'lucide-react'
import {
  accountantApi,
  type AccountantImportResult, type AccountantStatementSummary, type AccountantCompareResponse,
  type AccountantMode, type AccountantLines,
} from '../../api/accountant'

// ── Formatowanie ──────────────────────────────────────────────────────────────
function fmt(n: number) {
  return new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n || 0)
}
function fmt0(n: number) {
  return new Intl.NumberFormat('pl-PL', { maximumFractionDigits: 0 }).format(n || 0)
}
function money(n: number) {
  return `${fmt(n)} zł`
}
function fmtDate(s: string) {
  if (!s) return '—'
  const [y, m, d] = s.slice(0, 10).split('-')
  return d ? `${d}.${m}.${y}` : s
}
const MONTH_NAMES = ['styczeń', 'luty', 'marzec', 'kwiecień', 'maj', 'czerwiec', 'lipiec', 'sierpień', 'wrzesień', 'październik', 'listopad', 'grudzień']
function periodLabel(p: string) {
  const [y, m] = p.split('-')
  const idx = parseInt(m, 10) - 1
  return MONTH_NAMES[idx] ? `${MONTH_NAMES[idx]} ${y}` : p
}

// Etykiety linii zestawienia księgowej (kolejność jak w RZiS)
const LINE_LABELS: Array<{ key: keyof AccountantLines; label: string; bold?: boolean; sign?: -1 | 1 }> = [
  { key: 'revenue', label: 'Przychody ze sprzedaży (konta 70–74)', bold: true },
  { key: 'other_revenue', label: 'Pozostałe przychody (750, 760)' },
  { key: 'cogs', label: 'Wartość sprzedanych towarów i produktów (701, 731, 741)', sign: -1 },
  { key: 'depreciation', label: 'Amortyzacja (400)', sign: -1 },
  { key: 'materials', label: 'Materiały i energia (401)', sign: -1 },
  { key: 'services', label: 'Usługi obce (402)', sign: -1 },
  { key: 'taxes_fees', label: 'Podatki i opłaty (403)', sign: -1 },
  { key: 'salaries', label: 'Wynagrodzenia (404)', sign: -1 },
  { key: 'social', label: 'Ubezpieczenia społeczne i inne świadczenia (405)', sign: -1 },
  { key: 'other_costs', label: 'Pozostałe koszty (406–409, 761)', sign: -1 },
  { key: 'financial_costs', label: 'Koszty finansowe (751)', sign: -1 },
  { key: 'costs_total', label: 'Koszty razem', bold: true, sign: -1 },
  { key: 'cit', label: 'Podatek dochodowy CIT (870)', sign: -1 },
  { key: 'result', label: 'Wynik', bold: true },
]

const MODE_LABELS: Record<AccountantMode, string> = {
  monthly: 'Obroty miesiąca (tylko ten miesiąc)',
  ytd: 'Narastająco od stycznia (system odejmie poprzedni miesiąc)',
}

type Tab = 'import' | 'list' | 'compare'

const inputCls = 'px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500 w-full'
const btnPrimary = 'inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-700 text-white text-sm font-semibold disabled:opacity-60'
const btnSecondary = 'inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-200 text-sm font-semibold hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-60'

// ── Modal: zestawienie obrotów i sald od księgowej ────────────────────────────
export default function AccountantStatementModal({ period, initialTab = 'import', onClose }: {
  /** Miesiąc YYYY-MM wybrany na stronie Rentowność — domyślny okres importu/porównania */
  period: string
  initialTab?: Tab
  /** `changed=true` gdy coś zapisano/usunięto — strona odświeża pasek uzgodnienia */
  onClose: (changed: boolean) => void
}) {
  const [tab, setTab] = useState<Tab>(initialTab)
  const changedRef = useRef(false)
  const close = () => onClose(changedRef.current)

  // ── Lista zapisanych zestawień ──
  const [statements, setStatements] = useState<AccountantStatementSummary[]>([])
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState('')
  const reloadList = useCallback(async () => {
    setListLoading(true); setListError('')
    try { setStatements(await accountantApi.list()) }
    catch (e: any) { setListError(e?.response?.data?.error ?? 'Nie udało się pobrać listy zestawień.') }
    finally { setListLoading(false) }
  }, [])
  useEffect(() => { reloadList() }, [reloadList])

  // ── Import ──
  const fileRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [importPeriod, setImportPeriod] = useState(period)
  const [mode, setMode] = useState<AccountantMode>('monthly')
  const [preview, setPreview] = useState<AccountantImportResult | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [importError, setImportError] = useState('')
  const [savedPeriod, setSavedPeriod] = useState('')

  const pickFile = (f: File | null) => {
    setFile(f); setPreview(null); setImportError(''); setSavedPeriod('')
  }

  const runPreview = async () => {
    if (!file) { setImportError('Wybierz plik CSV lub Excel z zestawieniem.'); return }
    if (!/^\d{4}-\d{2}$/.test(importPeriod)) { setImportError('Podaj okres w formacie RRRR-MM.'); return }
    setPreviewLoading(true); setImportError(''); setSavedPeriod('')
    try {
      setPreview(await accountantApi.import(file, importPeriod, mode, true))
    } catch (e: any) {
      setPreview(null)
      setImportError(e?.response?.data?.error ?? 'Nie udało się odczytać pliku. Sprawdź, czy to zestawienie obrotów i sald (CSV/XLSX).')
    } finally { setPreviewLoading(false) }
  }

  const save = async () => {
    if (!file || !preview) return
    setSaving(true); setImportError('')
    try {
      const res = await accountantApi.import(file, importPeriod, mode, false)
      changedRef.current = true
      setPreview(res)
      setSavedPeriod(res.period)
      await reloadList()
    } catch (e: any) {
      setImportError(e?.response?.data?.error ?? 'Nie udało się zapisać zestawienia.')
    } finally { setSaving(false) }
  }

  // ── Porównanie ──
  const [comparePeriod, setComparePeriod] = useState(period)
  const [compare, setCompare] = useState<AccountantCompareResponse | null>(null)
  const [compareMissing, setCompareMissing] = useState(false)
  const [compareLoading, setCompareLoading] = useState(false)
  const [compareError, setCompareError] = useState('')
  const compareSeq = useRef(0)

  const loadCompare = useCallback(async (p: string) => {
    if (!/^\d{4}-\d{2}$/.test(p)) return
    const seq = ++compareSeq.current
    setCompareLoading(true); setCompareError(''); setCompareMissing(false)
    try {
      const res = await accountantApi.compareOrNull(p)
      if (seq !== compareSeq.current) return // odpowiedź nieaktualnego okresu — ignoruj
      setCompare(res)
      setCompareMissing(res === null)
    } catch (e: any) {
      if (seq !== compareSeq.current) return
      setCompare(null)
      setCompareError(e?.response?.data?.error ?? 'Nie udało się pobrać porównania.')
    } finally {
      if (seq === compareSeq.current) setCompareLoading(false)
    }
  }, [])

  useEffect(() => { if (tab === 'compare') loadCompare(comparePeriod) }, [tab, comparePeriod, loadCompare])

  const goCompare = (p: string) => { setComparePeriod(p); setTab('compare') }

  const remove = async (s: AccountantStatementSummary) => {
    if (!confirm(`Usunąć zestawienie księgowej za ${periodLabel(s.period)}?`)) return
    try {
      await accountantApi.remove(s.period)
      changedRef.current = true
      await reloadList()
      if (comparePeriod === s.period) { setCompare(null); setCompareMissing(true) }
    } catch (e: any) {
      setListError(e?.response?.data?.error ?? 'Nie udało się usunąć zestawienia.')
    }
  }

  const pendingCount = statements.length

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={e => e.target === e.currentTarget && close()}>
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-3xl max-h-[88vh] overflow-y-auto">
        {/* Nagłówek */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 dark:border-gray-800 sticky top-0 bg-white dark:bg-gray-900 z-10">
          <div>
            <h2 className="text-base font-bold text-gray-800 dark:text-gray-100">🧾 Zestawienie księgowej</h2>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              Poproś biuro rachunkowe o miesięczne zestawienie obrotów i sald (CSV/Excel). System porówna je z naszymi liczbami.
            </p>
          </div>
          <button onClick={close} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"><X size={18} /></button>
        </div>

        {/* Zakładki */}
        <div className="px-6 pt-4">
          <div className="flex bg-gray-100 dark:bg-gray-800 rounded-lg p-0.5 w-fit">
            {([
              ['import', 'Import pliku', <Upload size={14} key="i" />],
              ['list', `Zapisane (${pendingCount})`, <BookOpen size={14} key="l" />],
              ['compare', 'Porównanie', <Scale size={14} key="c" />],
            ] as [Tab, string, ReactNode][]).map(([v, l, icon]) => (
              <button key={v} onClick={() => setTab(v)}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-semibold ${tab === v ? 'bg-white dark:bg-gray-900 text-violet-700 dark:text-violet-300 shadow-sm' : 'text-gray-500 dark:text-gray-400'}`}>
                {icon}{l}
              </button>
            ))}
          </div>
        </div>

        <div className="p-6 space-y-4">
          {/* ── IMPORT ── */}
          {tab === 'import' && (
            <>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
                <div className="md:col-span-1">
                  <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 mb-1">Plik z zestawieniem (CSV / XLSX)</label>
                  <input ref={fileRef} type="file" accept=".csv,.txt,.xlsx,.xls" className="hidden"
                    onChange={e => pickFile(e.target.files?.[0] ?? null)} />
                  <button onClick={() => fileRef.current?.click()} className={`${btnSecondary} w-full justify-center`}>
                    <FileSpreadsheet size={15} />
                    <span className="truncate">{file ? file.name : 'Wybierz plik…'}</span>
                  </button>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 mb-1">Okres (miesiąc)</label>
                  <input type="month" value={importPeriod} onChange={e => { setImportPeriod(e.target.value); setPreview(null); setSavedPeriod('') }} className={inputCls} />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 mb-1">Co zawiera plik</label>
                  <select value={mode} onChange={e => { setMode(e.target.value as AccountantMode); setPreview(null); setSavedPeriod('') }} className={inputCls}>
                    {(Object.keys(MODE_LABELS) as AccountantMode[]).map(m => <option key={m} value={m}>{MODE_LABELS[m]}</option>)}
                  </select>
                </div>
              </div>
              <div className="text-xs text-gray-400">
                Najpierw zobaczysz <b>podgląd</b> odczytanych liczb — nic nie zostanie zapisane, dopóki nie klikniesz „Zapisz”.
                {mode === 'ytd' && <> Przy pliku narastającym system odejmie zapisane zestawienie za poprzedni miesiąc (też narastające) — jeśli go nie ma, zapisze liczby jak są i pokaże ostrzeżenie.</>}
              </div>

              <div className="flex items-center gap-2 flex-wrap">
                <button onClick={runPreview} disabled={previewLoading || !file} className={btnSecondary}>
                  {previewLoading ? 'Odczytuję…' : '👁 Podgląd'}
                </button>
                {preview && !savedPeriod && (
                  <button onClick={save} disabled={saving} className={btnPrimary}>
                    {saving ? 'Zapisuję…' : `💾 Zapisz za ${periodLabel(preview.period)}`}
                  </button>
                )}
                {savedPeriod && (
                  <button onClick={() => goCompare(savedPeriod)} className={btnPrimary}>
                    <Scale size={15} /> Porównaj z naszym RZiS →
                  </button>
                )}
              </div>

              {importError && (
                <div className="p-3 rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-sm text-red-700 dark:text-red-300">{importError}</div>
              )}
              {savedPeriod && (
                <div className="p-3 rounded-xl bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 text-sm text-green-800 dark:text-green-300">
                  <b>Zapisano ✓</b> zestawienie za {periodLabel(savedPeriod)}. Od teraz pod tabelą RZiS zobaczysz pasek „Uzgodnienie z księgową”.
                </div>
              )}

              {preview && <ImportPreview preview={preview} />}
            </>
          )}

          {/* ── LISTA ── */}
          {tab === 'list' && (
            <>
              {listError && <div className="p-3 rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-sm text-red-700 dark:text-red-300">{listError}</div>}
              {listLoading ? (
                <div className="p-8 text-center text-gray-400 text-sm">Ładowanie…</div>
              ) : statements.length === 0 ? (
                <div className="p-8 text-center text-gray-400 text-sm">
                  Brak zapisanych zestawień. Wgraj pierwsze w zakładce „Import pliku”.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-xs uppercase tracking-wide text-gray-400 border-b border-gray-100 dark:border-gray-800">
                        <th className="py-2 pr-2 text-left font-semibold">Okres</th>
                        <th className="py-2 pr-2 text-left font-semibold">Tryb</th>
                        <th className="py-2 pr-2 text-right font-semibold">Przychód</th>
                        <th className="py-2 pr-2 text-right font-semibold">Koszty</th>
                        <th className="py-2 pr-2 text-right font-semibold">Wynik</th>
                        <th className="py-2 pr-2 text-left font-semibold">Plik</th>
                        <th className="py-2"></th>
                      </tr>
                    </thead>
                    <tbody className="tabular-nums">
                      {statements.map(s => (
                        <tr key={s.period} className="border-b border-gray-50 dark:border-gray-800/60">
                          <td className="py-2 pr-2 font-semibold text-gray-800 dark:text-gray-100 whitespace-nowrap">{periodLabel(s.period)}</td>
                          <td className="py-2 pr-2 text-xs text-gray-500 dark:text-gray-400">{s.mode === 'ytd' ? 'narastająco' : 'miesięczne'}</td>
                          <td className="py-2 pr-2 text-right text-gray-700 dark:text-gray-200">{money(s.revenue)}</td>
                          <td className="py-2 pr-2 text-right text-gray-700 dark:text-gray-200">{money(s.costs)}</td>
                          <td className={`py-2 pr-2 text-right font-semibold ${s.result < 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-800 dark:text-gray-100'}`}>{money(s.result)}</td>
                          <td className="py-2 pr-2 text-xs text-gray-400 max-w-[160px] truncate" title={`${s.file_name} · ${fmtDate(s.created_at)}`}>{s.file_name || '—'}</td>
                          <td className="py-2 text-right whitespace-nowrap">
                            <button onClick={() => goCompare(s.period)} className="text-xs font-semibold text-violet-600 dark:text-violet-400 hover:underline mr-3">Porównaj →</button>
                            <button onClick={() => remove(s)} className="text-gray-400 hover:text-red-500" title="Usuń zestawienie"><Trash2 size={14} /></button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}

          {/* ── PORÓWNANIE ── */}
          {tab === 'compare' && (
            <>
              <div className="flex items-center gap-3 flex-wrap">
                <div>
                  <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 mb-1">Okres</label>
                  <input type="month" value={comparePeriod} onChange={e => setComparePeriod(e.target.value)} className={inputCls} />
                </div>
                {statements.length > 0 && (
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 mb-1">Zapisane zestawienia</div>
                    <div className="flex gap-1 flex-wrap">
                      {statements.map(s => (
                        <button key={s.period} onClick={() => setComparePeriod(s.period)}
                          className={`px-2 py-1 rounded-md text-xs font-bold ${comparePeriod === s.period
                            ? 'bg-violet-600 text-white'
                            : 'bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800'}`}>
                          {s.period}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {compareLoading ? (
                <div className="p-8 text-center text-gray-400 text-sm">Porównuję…</div>
              ) : compareError ? (
                <div className="p-3 rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-sm text-red-700 dark:text-red-300">{compareError}</div>
              ) : compareMissing || !compare ? (
                <div className="p-8 text-center text-gray-400 text-sm">
                  Brak zestawienia księgowej za {periodLabel(comparePeriod)}.{' '}
                  <button onClick={() => { setImportPeriod(comparePeriod); setPreview(null); setSavedPeriod(''); setTab('import') }} className="text-violet-600 dark:text-violet-400 font-semibold hover:underline">
                    Wgraj je w zakładce Import →
                  </button>
                </div>
              ) : (
                <CompareView c={compare} />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Podgląd importu: wykryte kolumny, ostrzeżenia, linie ─────────────────────
function ImportPreview({ preview }: { preview: AccountantImportResult }) {
  const d = preview.detected
  const col = (i: number) => (i >= 0 ? `kol. ${i + 1}` : 'nie wykryto')
  return (
    <div className="space-y-3">
      {preview.warnings.length > 0 && (
        <div className="p-3 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-sm text-amber-800 dark:text-amber-300">
          <b>Uwagi z odczytu:</b>
          <ul className="list-disc pl-5 mt-1 space-y-0.5">{preview.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </div>
      )}
      <div className="flex items-center gap-2 flex-wrap text-xs">
        <span className="px-2 py-1 rounded-md bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 font-semibold">{preview.rows_count} kont odczytanych</span>
        <span className="px-2 py-1 rounded-md bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400">Konto: {col(d.account_col)}</span>
        <span className="px-2 py-1 rounded-md bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400">Nazwa: {col(d.name_col)}</span>
        <span className="px-2 py-1 rounded-md bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400">Wn: {col(d.debit_col)}</span>
        <span className="px-2 py-1 rounded-md bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400">Ma: {col(d.credit_col)}</span>
        <span className="px-2 py-1 rounded-md bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400">
          {d.header_row >= 0 ? `Nagłówek: wiersz ${d.header_row + 1}` : 'Bez nagłówka — rozpoznano po układzie kolumn'}
        </span>
        {d.has_period_and_ytd && (
          <span className="px-2 py-1 rounded-md bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 font-semibold" title="Plik ma obroty okresu i narastająco — użyto kolumn obrotów okresu">
            użyto „obroty okresu”
          </span>
        )}
        <span className="px-2 py-1 rounded-md bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400" title="Zespół kont, z którego wzięto koszty">
          koszty z zespołu {preview.lines.source_classes}
        </span>
      </div>

      <div className="bg-gray-50 dark:bg-gray-800/40 border border-gray-100 dark:border-gray-800 rounded-xl overflow-hidden">
        <div className="px-4 py-2 text-xs font-bold uppercase tracking-wide text-gray-400 border-b border-gray-100 dark:border-gray-800">
          Odczytane linie — {periodLabel(preview.period)}{preview.mode === 'ytd' ? ' (po odjęciu poprzedniego miesiąca)' : ''}
        </div>
        <table className="w-full text-sm">
          <tbody>
            {LINE_LABELS.map(({ key, label, bold, sign }) => {
              const raw = preview.lines[key]
              if (typeof raw !== 'number') return null
              const v = (sign ?? 1) * raw
              return (
                <tr key={key} className="border-b border-gray-100 dark:border-gray-800 last:border-0">
                  <td className={`py-2 pl-4 ${bold ? 'font-bold text-gray-900 dark:text-gray-100' : 'text-gray-600 dark:text-gray-300'}`}>{label}</td>
                  <td className={`py-2 pr-4 text-right tabular-nums whitespace-nowrap ${bold ? 'font-bold' : ''} ${v < 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-800 dark:text-gray-100'}`}>{money(v)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {preview.lines.warnings?.length > 0 && (
        <ul className="text-xs text-gray-400 list-disc pl-5 space-y-0.5">{preview.lines.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
      )}
    </div>
  )
}

// ── Porównanie: nasz RZiS vs księgowa ────────────────────────────────────────
function CompareView({ c }: { c: AccountantCompareResponse }) {
  const resultDiff = c.ours.result - c.theirs.result
  return (
    <div className="space-y-3">
      {c.verdict === 'ok' ? (
        <div className="p-4 rounded-xl bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 text-sm text-green-800 dark:text-green-300">
          <b>✅ Zgodne w granicach błędu</b> — różnica wyniku {money(Math.abs(resultDiff))} mieści się w progu {fmt0(c.threshold)} zł.
        </div>
      ) : (
        <div className="p-4 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-sm text-amber-800 dark:text-amber-300">
          <b>⚠️ Do wyjaśnienia</b> — nasz wynik różni się od księgowej o {money(Math.abs(resultDiff))} (próg: {fmt0(c.threshold)} zł).
        </div>
      )}

      <div className="text-xs text-gray-400">
        <b>Nasz RZiS</b> = liczby z systemu (KSeF, wyciągi MT940, magazyn). <b>Księgowa</b> = zestawienie obrotów i sald z biura. <b>Różnica</b> = nasz − księgowa;
        na czerwono, gdy przekracza 1 % kwoty.
      </div>

      <div className="overflow-x-auto bg-gray-50 dark:bg-gray-800/40 border border-gray-100 dark:border-gray-800 rounded-xl">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs uppercase tracking-wide text-gray-400 border-b border-gray-100 dark:border-gray-800">
              <th className="py-2 pl-4 text-left font-semibold">Linia</th>
              <th className="py-2 px-2 text-right font-semibold">Nasz RZiS</th>
              <th className="py-2 px-2 text-right font-semibold">Księgowa</th>
              <th className="py-2 pr-4 text-right font-semibold">Różnica</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {c.by_line.map(l => {
              const base = Math.max(Math.abs(l.ours), Math.abs(l.theirs))
              const bad = Math.abs(l.diff) > 0.005 && Math.abs(l.diff) > base * 0.01
              const bold = l.key === 'result' || l.key === 'costs_total' || l.key === 'revenue'
              return (
                <tr key={l.key} className="border-b border-gray-100 dark:border-gray-800 last:border-0">
                  <td className={`py-2 pl-4 ${bold ? 'font-bold text-gray-900 dark:text-gray-100' : 'text-gray-600 dark:text-gray-300'}`}>{l.label}</td>
                  <td className={`py-2 px-2 text-right whitespace-nowrap ${bold ? 'font-bold' : ''} text-gray-800 dark:text-gray-100`}>{money(l.ours)}</td>
                  <td className={`py-2 px-2 text-right whitespace-nowrap ${bold ? 'font-bold' : ''} text-gray-800 dark:text-gray-100`}>{money(l.theirs)}</td>
                  <td className={`py-2 pr-4 text-right whitespace-nowrap font-semibold ${bad ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'}`}>
                    {l.diff > 0 ? '+' : ''}{money(l.diff)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {c.hints.length > 0 && (
        <div className="p-3 rounded-xl bg-violet-50 dark:bg-violet-950/30 border border-violet-100 dark:border-violet-900 text-sm text-violet-900 dark:text-violet-200">
          <b>💡 Podpowiedzi, skąd może brać się różnica:</b>
          <ul className="list-disc pl-5 mt-1 space-y-0.5">{c.hints.map((h, i) => <li key={i}>{h}</li>)}</ul>
        </div>
      )}
      {c.theirs.warnings?.length > 0 && (
        <ul className="text-xs text-gray-400 list-disc pl-5 space-y-0.5">{c.theirs.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
      )}
    </div>
  )
}
