// Skrzynka e-mail (IMAP) na faktury spoza KSeF — tylko admin. GET/PUT /settings/imap, POST /test, POST /check-now.
// „Sprawdź teraz” = POST /check-now → 202 { started, started_at }; sprawdzenie (IMAP + odczyt AI) trwa w tle,
// wynik odczytujemy odpytując GET /settings/imap co 3 s, aż last_checked_at ≥ started_at (last_error = błąd).
import { useEffect, useState } from 'react'
import { Save, Mail, RefreshCw, Loader2 } from 'lucide-react'
import { imapSettingsApi, IMAP_PASSWORD_MASK, type ImapSettings, type ImapSettingsInput, type ImapTestResult, type ImapCheckResult } from '../../api/costInbox'
import { errorMessage, fmtDateTime, inputCls, labelCls, cardCls, btnPrimary, btnSecondary, Alert, Badge } from './shared'

const CHECK_POLL_MS = 3_000
const CHECK_POLL_MAX_MS = 180_000
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

// Wynik „Sprawdź teraz”: błąd, statystyki (starszy backend odpowiadał synchronicznie) albo samo „gotowe”
type CheckOutcome = Partial<ImapCheckResult> & { started?: boolean; started_at?: string; done?: boolean }

const pick = (s: ImapSettings): ImapSettingsInput => ({
  enabled: !!s.enabled, host: s.host || '', port: s.port || 993, secure: s.secure !== false,
  user: s.user || '', pass: s.pass || '', folder: s.folder || 'INBOX',
})

export default function ImapSettingsCard() {
  const [settings, setSettings] = useState<ImapSettings | null>(null)
  const [f, setF] = useState<ImapSettingsInput>({ enabled: false, host: '', port: 993, secure: true, user: '', pass: '', folder: 'INBOX' })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [checking, setChecking] = useState(false)
  const [notice, setNotice] = useState('')
  const [testResult, setTestResult] = useState<ImapTestResult | null>(null)
  const [checkResult, setCheckResult] = useState<CheckOutcome | null>(null)

  const set = <K extends keyof ImapSettingsInput>(k: K, v: ImapSettingsInput[K]) => setF(p => ({ ...p, [k]: v }))

  const load = async () => {
    setLoading(true); setError('')
    try { const s = await imapSettingsApi.get(); setSettings(s); setF(pick(s)) }
    catch (e) { setError(errorMessage(e, 'Nie udało się pobrać ustawień skrzynki.')) }
    finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])

  const dirty = settings ? JSON.stringify(pick(settings)) !== JSON.stringify(f) : true

  const validate = (): string => {
    if (!f.host.trim()) return 'Podaj serwer IMAP (np. imap.gmail.com).'
    if (!f.port || f.port < 1 || f.port > 65535) return 'Port musi być liczbą 1–65535.'
    if (!f.user.trim()) return 'Podaj login (adres e-mail skrzynki).'
    if (!f.pass) return 'Podaj hasło (dla Gmaila: hasło aplikacji).'
    return ''
  }

  const save = async (): Promise<boolean> => {
    const v = validate()
    if (v) { setError(v); return false }
    setSaving(true); setError(''); setNotice('')
    try {
      const s = await imapSettingsApi.update({ ...f, host: f.host.trim(), user: f.user.trim(), folder: f.folder.trim() || 'INBOX', port: Number(f.port) })
      setSettings(s); setF(pick(s))
      setNotice('Ustawienia zapisane.')
      return true
    } catch (e) { setError(errorMessage(e, 'Nie udało się zapisać ustawień.')); return false }
    finally { setSaving(false) }
  }

  // Test łączy się z zapisanymi ustawieniami — gdy formularz zmieniony, najpierw zapis
  const test = async () => {
    setTestResult(null)
    if (dirty && !(await save())) return
    setTesting(true); setError('')
    try { setTestResult(await imapSettingsApi.test()) }
    catch (e) { setTestResult({ ok: false, error: errorMessage(e, 'Połączenie nie powiodło się.') }) }
    finally { setTesting(false) }
  }

  const checkNow = async () => {
    setCheckResult(null)
    if (dirty && !(await save())) return
    setChecking(true); setError(''); setNotice('')
    try {
      const r: CheckOutcome = await imapSettingsApi.checkNow()
      if (!r.started) { setCheckResult(r); await load(); return } // odpowiedź synchroniczna (starszy backend)
      // 202: sprawdzanie trwa w tle — czekaj, aż backend zapisze last_checked_at nie starsze niż started_at
      const startedAt = r.started_at || ''
      const deadline = Date.now() + CHECK_POLL_MAX_MS
      let done: ImapSettings | null = null
      while (Date.now() < deadline) {
        await sleep(CHECK_POLL_MS)
        const s = await imapSettingsApi.get()
        if (s.last_checked_at && s.last_checked_at >= startedAt) { done = s; break }
      }
      if (done) { setSettings(done); setCheckResult(done.last_error ? { error: done.last_error } : { done: true }) }
      else setNotice('Sprawdzanie skrzynki trwa dłużej niż zwykle — odśwież stronę za chwilę, dokumenty pojawią się w zakładce „Dokumenty”.')
    }
    catch (e) { setError(errorMessage(e, 'Sprawdzenie skrzynki nie powiodło się.')) }
    finally { setChecking(false) }
  }

  if (loading) return <div className="p-10 text-center text-gray-400 text-sm">Ładowanie…</div>

  return (
    <div className="space-y-4">
      <Alert tone="blue">
        <b>Przekazuj faktury spoza KSeF na tę skrzynkę — system odczyta je automatycznie.</b><br />
        Najlepiej założyć osobny adres (np. <i>koszty@twojafirma.pl</i>) i przekazywać na niego e-maile z fakturami zagranicznymi, subskrypcjami czy paragonami.
        System sprawdza skrzynkę co 15 minut i pobiera załączniki PDF/JPG/PNG (do 10 MB). Każdy trafia do zakładki „Dokumenty” do zatwierdzenia.
      </Alert>

      {error && <Alert tone="red">{error}</Alert>}
      {notice && <Alert tone="green">{notice}</Alert>}

      <div className={`${cardCls} p-5`}>
        <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
          <h3 className="text-sm font-bold text-gray-800 dark:text-gray-100 inline-flex items-center gap-2"><Mail size={16} className="text-violet-500" /> Połączenie ze skrzynką (IMAP)</h3>
          <label className="inline-flex items-center gap-2 text-sm font-semibold text-gray-700 dark:text-gray-200 cursor-pointer">
            <input type="checkbox" checked={f.enabled} onChange={e => set('enabled', e.target.checked)} className="accent-violet-600 w-4 h-4" />
            Automatyczne sprawdzanie włączone
          </label>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
          <div className="col-span-2 md:col-span-3">
            <label className={labelCls}>Serwer IMAP</label>
            <input value={f.host} onChange={e => set('host', e.target.value)} className={inputCls} placeholder="imap.gmail.com" autoComplete="off" />
          </div>
          <div>
            <label className={labelCls}>Port</label>
            <input value={f.port} onChange={e => set('port', Number(e.target.value.replace(/\D/g, '')) || 0)} inputMode="numeric" className={inputCls} />
          </div>
          <div className="col-span-1 md:col-span-2 flex items-end pb-2">
            <label className="inline-flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200 cursor-pointer">
              <input type="checkbox" checked={f.secure} onChange={e => set('secure', e.target.checked)} className="accent-violet-600" />
              SSL/TLS (port 993)
            </label>
          </div>
          <div className="col-span-2 md:col-span-3">
            <label className={labelCls}>Login (adres e-mail)</label>
            <input value={f.user} onChange={e => set('user', e.target.value)} className={inputCls} placeholder="koszty@twojafirma.pl" autoComplete="off" />
          </div>
          <div className="col-span-2 md:col-span-2">
            <label className={labelCls}>Hasło</label>
            <input type="password" value={f.pass} onChange={e => set('pass', e.target.value)} className={inputCls}
              placeholder={settings?.pass === IMAP_PASSWORD_MASK ? 'zapisane — zostaw, by nie zmieniać' : 'hasło lub hasło aplikacji'} autoComplete="new-password" />
          </div>
          <div>
            <label className={labelCls}>Folder</label>
            <input value={f.folder} onChange={e => set('folder', e.target.value)} className={inputCls} placeholder="INBOX" />
          </div>
        </div>
        <div className="text-[11px] text-gray-400 mt-2">
          Gmail: włącz IMAP w ustawieniach i użyj „hasła aplikacji” (wymaga weryfikacji dwuetapowej). Hasło jest przechowywane na serwerze i nigdy nie wraca do przeglądarki w całości.
        </div>

        <div className="flex items-center gap-2 mt-4 flex-wrap">
          <button onClick={save} disabled={saving || !dirty} className={btnPrimary}><Save size={14} /> {saving ? 'Zapisuję…' : 'Zapisz'}</button>
          <button onClick={test} disabled={saving || testing} className={btnSecondary} title="Zapisuje ustawienia i próbuje zalogować się do skrzynki">
            {testing ? <Loader2 size={14} className="animate-spin" /> : <Mail size={14} />} {testing ? 'Łączę…' : 'Testuj połączenie'}
          </button>
          <button onClick={checkNow} disabled={saving || checking} className={btnSecondary} title="Pobierz nowe wiadomości teraz, bez czekania na harmonogram">
            <RefreshCw size={14} className={checking ? 'animate-spin' : ''} /> {checking ? 'Sprawdzam…' : 'Sprawdź teraz'}
          </button>
        </div>

        {testResult && (
          <div className="mt-3">
            {testResult.ok
              ? <Alert tone="green">✓ Połączenie działa. W folderze: <b>{testResult.mailbox?.exists ?? 0}</b> wiadomości, nieprzeczytanych: <b>{testResult.mailbox?.unseen ?? 0}</b>.</Alert>
              : <Alert tone="red">✕ Nie udało się połączyć: {testResult.error || 'nieznany błąd'}</Alert>}
          </div>
        )}
        {checkResult && (
          <div className="mt-3">
            {checkResult.error
              ? <Alert tone="red">Sprawdzenie nie powiodło się: {checkResult.error}</Alert>
              : typeof checkResult.fetched === 'number'
                ? <Alert tone="green">Pobrano <b>{checkResult.fetched}</b> wiadomości · nowych dokumentów: <b>{checkResult.created ?? 0}</b> · pominiętych (już były / bez załącznika): {checkResult.skipped ?? 0}.</Alert>
                : <Alert tone="green">Skrzynka sprawdzona. Nowe dokumenty (jeśli były) znajdziesz w zakładce „Dokumenty”.</Alert>}
          </div>
        )}
      </div>

      {settings && (
        <div className={`${cardCls} p-5 text-sm`}>
          <h3 className="text-sm font-bold text-gray-800 dark:text-gray-100 mb-2">Stan</h3>
          <div className="flex items-center gap-4 flex-wrap text-gray-600 dark:text-gray-300">
            <span>Status: {settings.enabled ? <Badge tone="green">włączone</Badge> : <Badge tone="gray">wyłączone</Badge>}</span>
            <span>Ostatnie sprawdzenie: <b>{fmtDateTime(settings.last_checked_at)}</b></span>
            <span className="text-xs text-gray-400" title="Identyfikator ostatniej przetworzonej wiadomości">UID: {settings.last_uid}</span>
          </div>
          {settings.last_error && (
            <div className="mt-2 text-xs font-semibold text-red-600 dark:text-red-400">Ostatni błąd: {settings.last_error}</div>
          )}
        </div>
      )}
    </div>
  )
}
