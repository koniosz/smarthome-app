/**
 * Magazyn XML faktur KSeF — czyste części: mapowanie błędów → odpowiedź HTTP, nazwa pliku,
 * rozpoznanie XML faktury, ogranicznik równoległości oraz logika cache / de-duplikacji na atrapach.
 * Bez bazy i bez sieci. Uruchom: cd backend && npx tsx --test src/__tests__/ksef-xml-store.test.ts
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { AxiosError, CanceledError } from 'axios'
import {
  mapKsefXmlError, mapKsefSessionError, sendKsefXmlError, describeKsefError, KsefXmlError,
  looksLikeKsefInvoiceXml, ksefInvoiceFileBaseName, createLimiter, createInvoiceXmlStore,
  NO_KSEF_NUMBER_MSG, RATE_LIMITED_MSG, UNPARSEABLE_MSG, NOT_IN_KSEF_MSG,
  KSEF_TIMEOUT_MSG, KSEF_UNREACHABLE_MSG, INVALID_XML_MSG, SERVER_ERROR_MSG,
  KSEF_SESSION_MSG, XML_TOO_LARGE_MSG, MAX_INVOICE_XML_BYTES,
  type InvoiceXmlStoreDeps,
} from '../services/ksef-xml-store'
import { KsefNotConfiguredError, KSEF_NOT_CONFIGURED_MSG } from '../services/ksef'
import { KsefDocumentError } from '../services/ksef-document'

const XML = '<?xml version="1.0" encoding="UTF-8"?><Faktura xmlns="http://crd.gov.pl/wzor/2025/06/25/13775/"><Naglowek/><Fa><P_2>FV/12/2026</P_2></Fa></Faktura>'
const SECRET = 'SECRET-SESSION-TOKEN'

/** Atrapa błędu axios z odpowiedzią HTTP (config niesie token — nie może nigdzie wyciec). */
function axiosHttpError(status: number, data: unknown = ''): Error {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true,
    code: status >= 500 ? 'ERR_BAD_RESPONSE' : 'ERR_BAD_REQUEST',
    response: { status, data },
    config: { headers: { Authorization: `Bearer ${SECRET}` } },
  })
}
/** Atrapa błędu axios bez odpowiedzi (timeout / sieć). */
function axiosNetError(code: string, message: string): Error {
  return Object.assign(new Error(message), {
    isAxiosError: true, code, config: { headers: { Authorization: `Bearer ${SECRET}` } },
  })
}
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

describe('mapKsefXmlError — błąd → { status, body } wg kontraktu API', () => {
  test('brak konfiguracji KSeF firmy → 400 + configured:false', () => {
    assert.deepEqual(mapKsefXmlError(new KsefNotConfiguredError()), {
      status: 400, body: { error: KSEF_NOT_CONFIGURED_MSG, configured: false },
    })
  })

  test('HTTP 429 z KSeF → 429 rate_limited z komunikatem po polsku', () => {
    assert.deepEqual(mapKsefXmlError(axiosHttpError(429, '{"status":{"code":429}}')), {
      status: 429,
      body: { error: 'KSeF chwilowo ogranicza liczbę zapytań. Spróbuj ponownie za kilka minut.', code: 'rate_limited' },
    })
    assert.equal(RATE_LIMITED_MSG, 'KSeF chwilowo ogranicza liczbę zapytań. Spróbuj ponownie za kilka minut.')
  })

  test('HTTP 404 z KSeF → 404 (faktury nie ma w KSeF)', () => {
    assert.deepEqual(mapKsefXmlError(axiosHttpError(404)), {
      status: 404, body: { error: NOT_IN_KSEF_MSG, code: 'not_in_ksef' },
    })
  })

  test('inna odpowiedź HTTP z KSeF → 502 „KSeF odpowiedział błędem (HTTP <status>).”', () => {
    for (const status of [400, 401, 403, 500, 503]) {
      assert.deepEqual(mapKsefXmlError(axiosHttpError(status, { exception: 'x' })), {
        status: 502, body: { error: `KSeF odpowiedział błędem (HTTP ${status}).` },
      })
    }
  })

  test('timeout → 502 z komunikatem o braku odpowiedzi', () => {
    assert.deepEqual(mapKsefXmlError(axiosNetError('ECONNABORTED', 'timeout of 15000ms exceeded')), {
      status: 502, body: { error: KSEF_TIMEOUT_MSG },
    })
    assert.deepEqual(mapKsefXmlError(axiosNetError('ETIMEDOUT', 'connect ETIMEDOUT 1.2.3.4:443')), {
      status: 502, body: { error: KSEF_TIMEOUT_MSG },
    })
  })

  test('błąd sieci (DNS, reset, odmowa połączenia) → 502 z komunikatem o braku połączenia', () => {
    for (const code of ['ENOTFOUND', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ERR_NETWORK']) {
      assert.deepEqual(mapKsefXmlError(axiosNetError(code, `getaddrinfo ${code} api.ksef.mf.gov.pl`)), {
        status: 502, body: { error: KSEF_UNREACHABLE_MSG },
      })
    }
    // błąd spoza axios, ale z kodem sieciowym Node
    assert.equal(mapKsefXmlError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })).status, 502)
  })

  test('odpowiedź większa niż limit rozmiaru (axios maxContentLength: ERR_BAD_RESPONSE bez `response`) → 502 xml_too_large', () => {
    const message = `maxContentLength size of ${MAX_INVOICE_XML_BYTES} exceeded` // tekst nadaje adapter http axios
    const expected = { status: 502, body: { error: XML_TOO_LARGE_MSG, code: 'xml_too_large' } }
    assert.deepEqual(mapKsefXmlError(axiosNetError('ERR_BAD_RESPONSE', message)), expected)
    assert.deepEqual(mapKsefXmlError(new AxiosError(message, AxiosError.ERR_BAD_RESPONSE)), expected)
    assert.equal(MAX_INVOICE_XML_BYTES, 8 * 1024 * 1024)
    assert.match(XML_TOO_LARGE_MSG, /zbyt duży.*limit 8 MB/)
  })

  test('pobieranie przerwane łącznym limitem czasu (axios ERR_CANCELED, bez `response`) → 502 z komunikatem o braku odpowiedzi', () => {
    const expected = { status: 502, body: { error: KSEF_TIMEOUT_MSG } }
    assert.deepEqual(mapKsefXmlError(axiosNetError('ERR_CANCELED', 'canceled')), expected)
    // prawdziwy błąd axios po przerwaniu sygnałem (AbortSignal.timeout): CanceledError, kod ERR_CANCELED
    const canceled = new CanceledError()
    assert.equal(canceled.code, 'ERR_CANCELED')
    assert.deepEqual(mapKsefXmlError(canceled), expected)
  })

  test('inny błąd axios bez odpowiedzi (np. urwany strumień, ERR_BAD_RESPONSE) → 502 po polsku, nigdy 500', () => {
    assert.deepEqual(mapKsefXmlError(axiosNetError('ERR_BAD_RESPONSE', 'stream has been aborted')), {
      status: 502, body: { error: KSEF_UNREACHABLE_MSG },
    })
    assert.deepEqual(mapKsefXmlError(new AxiosError('stream has been aborted', AxiosError.ERR_BAD_RESPONSE)), {
      status: 502, body: { error: KSEF_UNREACHABLE_MSG },
    })
  })

  test('KsefDocumentError (XML nie do odczytania) → 422 unparseable', () => {
    assert.deepEqual(mapKsefXmlError(new KsefDocumentError('to nie jest faktura')), {
      status: 422,
      body: { error: 'Nie udało się odczytać struktury tej faktury. Pobierz plik XML.', code: 'unparseable' },
    })
    assert.equal(UNPARSEABLE_MSG, 'Nie udało się odczytać struktury tej faktury. Pobierz plik XML.')
  })

  test('KsefXmlError niesie własny status, kod i komunikat', () => {
    assert.deepEqual(mapKsefXmlError(new KsefXmlError(400, 'no_ksef_number', NO_KSEF_NUMBER_MSG)), {
      status: 400, body: { error: NO_KSEF_NUMBER_MSG, code: 'no_ksef_number' },
    })
    const e = new KsefXmlError(502, 'invalid_xml', INVALID_XML_MSG)
    assert.ok(e instanceof Error)
    assert.equal(e.name, 'KsefXmlError')
    assert.equal(mapKsefXmlError(e).status, 502)
  })

  test('cokolwiek innego → 500 z ogólnym komunikatem (bez surowej treści błędu)', () => {
    for (const err of [new Error('Cannot read properties of undefined'), new TypeError('boom'), 'tekst', null, undefined, {}, 42]) {
      assert.deepEqual(mapKsefXmlError(err), { status: 500, body: { error: SERVER_ERROR_MSG } })
    }
    // błąd Prisma (np. brak połączenia z bazą) to nie błąd KSeF
    assert.equal(mapKsefXmlError(Object.assign(new Error("Can't reach database server"), { code: 'P1001' })).status, 500)
  })

  test('token sesji z konfiguracji żądania nigdy nie trafia do odpowiedzi ani do opisu w logach', () => {
    const errors = [axiosHttpError(429), axiosHttpError(500, { detail: 'x' }), axiosNetError('ECONNABORTED', 'timeout of 15000ms exceeded')]
    for (const err of errors) {
      assert.ok(!JSON.stringify(mapKsefXmlError(err)).includes(SECRET))
      assert.ok(!describeKsefError(err).includes(SECRET))
    }
  })
})

describe('mapKsefSessionError — błąd uzyskania sesji KSeF → błąd oddawany przez magazyn', () => {
  // kształty komunikatów z services/ksef.ts: `${etap} failed: ${axiosError(err)}`, axiosError = „HTTP <status>: <JSON>”
  test('limit zapytań przy tworzeniu sesji („… HTTP 429: {…}”) → 429 rate_limited', () => {
    for (const message of [
      'Challenge failed: HTTP 429: {"status":{"code":429,"description":"Too Many Requests"}}',
      'Token auth init failed: HTTP 429: {}',
      'Token redeem failed: HTTP 429: "Too Many Requests"',
    ]) {
      const mapped = mapKsefSessionError(new Error(message))
      assert.ok(mapped instanceof KsefXmlError, message)
      assert.deepEqual(mapKsefXmlError(mapped), { status: 429, body: { error: RATE_LIMITED_MSG, code: 'rate_limited' } })
    }
  })

  test('każdy inny błąd sesji → 502 ksef_session, bez surowej treści błędu', () => {
    const errors: unknown[] = [
      new Error('Token redeem failed: HTTP 500: {}'),
      new Error('Challenge failed: HTTP 401: {"exception":"Unauthorized"}'),
      new Error('Challenge failed: HTTP 4290: {}'),                       // 4290 to nie 429
      new Error('Challenge failed: timeout of 15000ms exceeded'),
      new Error('Brak referenceNumber lub authenticationToken po init'),
      new Error(`Token auth init failed: HTTP 500: {"token":"${SECRET}"}`),
      'tekst', null, undefined, {}, 429,
    ]
    for (const err of errors) {
      const mapped = mapKsefSessionError(err)
      assert.ok(mapped instanceof KsefXmlError)
      assert.deepEqual(mapKsefXmlError(mapped), { status: 502, body: { error: KSEF_SESSION_MSG, code: 'ksef_session' } })
      assert.ok(!mapped.message.includes(SECRET))
    }
  })

  test('brak konfiguracji KSeF firmy przechodzi bez zmian (ten sam obiekt) → 400 configured:false', () => {
    const err = new KsefNotConfiguredError()
    assert.equal(mapKsefSessionError(err), err)
    assert.deepEqual(mapKsefXmlError(mapKsefSessionError(err)), {
      status: 400, body: { error: KSEF_NOT_CONFIGURED_MSG, configured: false },
    })
  })
})

describe('describeKsefError / sendKsefXmlError', () => {
  test('opis błędu: status HTTP, kod, komunikat i skrót treści odpowiedzi', () => {
    const text = describeKsefError(axiosHttpError(500, { exception: { code: 21405 } }))
    assert.match(text, /HTTP 500/)
    assert.match(text, /ERR_BAD_RESPONSE/)
    assert.match(text, /21405/)
    assert.equal(describeKsefError(undefined), 'nieznany błąd')
    assert.equal(describeKsefError(new Error('boom\n    at stack')), 'boom')
    assert.ok(describeKsefError(axiosHttpError(500, 'x'.repeat(5000))).length < 1000)
  })

  test('wysyła status i body z mapowania; 5xx loguje, 4xx nie', () => {
    const sent: { status?: number; body?: unknown } = {}
    const res = { status(code: number) { sent.status = code; return { json(body: unknown) { sent.body = body } } } }
    const logged: unknown[][] = []
    const original = console.error
    console.error = (...args: unknown[]) => { logged.push(args) }
    try {
      sendKsefXmlError(res, axiosHttpError(429))
      assert.equal(sent.status, 429)
      assert.deepEqual(sent.body, { error: RATE_LIMITED_MSG, code: 'rate_limited' })
      assert.equal(logged.length, 0)

      sendKsefXmlError(res, axiosHttpError(503), 'test/tag')
      assert.equal(sent.status, 502)
      assert.deepEqual(sent.body, { error: 'KSeF odpowiedział błędem (HTTP 503).' })
      assert.equal(logged.length, 1)
      assert.match(String(logged[0][0]), /test\/tag/)
      assert.ok(!JSON.stringify(logged).includes(SECRET))
    } finally {
      console.error = original
    }
  })
})

describe('looksLikeKsefInvoiceXml', () => {
  test('rozpoznaje fakturę FA (z prefiksem przestrzeni nazw i bez)', () => {
    assert.equal(looksLikeKsefInvoiceXml(XML), true)
    assert.equal(looksLikeKsefInvoiceXml('<tns:Faktura xmlns:tns="http://crd.gov.pl/wzor/2023/06/29/12648/"><tns:Fa/></tns:Faktura>'), true)
    assert.equal(looksLikeKsefInvoiceXml('﻿<?xml version="1.0"?>\n<Faktura>\n</Faktura>'), true)
  })
  test('rozpoznaje korzeń UBL faktur PEF (Invoice / CreditNote)', () => {
    assert.equal(looksLikeKsefInvoiceXml('<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"></Invoice>'), true)
    assert.equal(looksLikeKsefInvoiceXml('<ubl:CreditNote xmlns:ubl="x"></ubl:CreditNote>'), true)
  })
  test('odrzuca treści błędów i nie-teksty', () => {
    assert.equal(looksLikeKsefInvoiceXml('{"exception":{"exceptionDetailList":[{"exceptionCode":21405,"exceptionDescription":"Faktura nie istnieje"}]}}'), false)
    assert.equal(looksLikeKsefInvoiceXml('<html><body><h1>503 Service Unavailable</h1></body></html>'), false)
    assert.equal(looksLikeKsefInvoiceXml('Faktura'), false)
    assert.equal(looksLikeKsefInvoiceXml(''), false)
    assert.equal(looksLikeKsefInvoiceXml(null), false)
    assert.equal(looksLikeKsefInvoiceXml(undefined), false)
    assert.equal(looksLikeKsefInvoiceXml({ data: XML }), false)
  })
})

describe('ksefInvoiceFileBaseName — „faktura-<numer>” bez rozszerzenia', () => {
  test('numer faktury: znaki spoza [A-Za-z0-9_.-] → „_”', () => {
    assert.equal(ksefInvoiceFileBaseName({ invoice_number: 'FV/12/2026', ksef_number: '1234567890-20260101-ABCDEF-01' }), 'faktura-FV_12_2026')
    assert.equal(ksefInvoiceFileBaseName({ invoice_number: 'FS 1/05/2026 "A"', ksef_number: null }), 'faktura-FS_1_05_2026_A')
    assert.equal(ksefInvoiceFileBaseName({ invoice_number: 'F.2026-01', ksef_number: null }), 'faktura-F.2026-01')
  })
  test('polskie znaki są transliterowane', () => {
    assert.equal(ksefInvoiceFileBaseName({ invoice_number: 'FV/1/Łódź/Żółć', ksef_number: null }), 'faktura-FV_1_Lodz_Zolc')
  })
  test('brak numeru faktury → numer KSeF; brak obu → „faktura”', () => {
    assert.equal(ksefInvoiceFileBaseName({ invoice_number: null, ksef_number: '1234567890-20260101-ABCDEF-01' }), 'faktura-1234567890-20260101-ABCDEF-01')
    assert.equal(ksefInvoiceFileBaseName({ invoice_number: '   ', ksef_number: '5260001246-20260210-0A1B2C3D4E5F-7A' }), 'faktura-5260001246-20260210-0A1B2C3D4E5F-7A')
    assert.equal(ksefInvoiceFileBaseName({ invoice_number: null, ksef_number: null }), 'faktura')
    assert.equal(ksefInvoiceFileBaseName({ invoice_number: '///', ksef_number: null }), 'faktura')
  })
  test('numer faktury od kontrahenta nie może domknąć cudzysłowu ani dopisać parametru w Content-Disposition', () => {
    const hostile = [
      'FV/1"; filename*=UTF-8\'\'evil.html; x="',
      'FV\\1"\r\nSet-Cookie: x=1',
      'a\tb;c=d\u0000e\u2028f',
      '"',
    ]
    for (const invoice_number of hostile) {
      const name = ksefInvoiceFileBaseName({ invoice_number, ksef_number: null })
      assert.match(name, /^faktura(-[A-Za-z0-9_.-]+)?$/, JSON.stringify(invoice_number))
      // tak trasy /xml budują nagłówek — w środku nie ma nic poza nazwą pliku
      assert.match(`inline; filename="${name}.xml"`, /^inline; filename="[A-Za-z0-9_.-]+\.xml"$/)
    }
    assert.equal(ksefInvoiceFileBaseName({ invoice_number: hostile[0], ksef_number: null }), 'faktura-FV_1_filename_UTF-8_evil.html_x')
  })

  test('wynik nie ma rozszerzenia, cudzysłowów ani separatorów ścieżki i jest ograniczony długością', () => {
    const name = ksefInvoiceFileBaseName({ invoice_number: '../../etc/passwd"\r\n' + 'x'.repeat(500), ksef_number: null })
    assert.match(name, /^faktura-[\w.-]+$/)
    assert.ok(!name.includes('/'))
    assert.ok(name.length <= 'faktura-'.length + 100)
  })
})

describe('createLimiter — ogranicznik równoległości', () => {
  test('najwyżej 2 zadania naraz, kolejność FIFO, wszystkie wyniki wracają', async () => {
    const limit = createLimiter(2)
    let active = 0
    let peak = 0
    const started: number[] = []
    const job = (i: number) => limit(async () => {
      active++; peak = Math.max(peak, active); started.push(i)
      await sleep(5)
      active--
      return i * 10
    })
    const out = await Promise.all([1, 2, 3, 4, 5, 6, 7].map(job))
    assert.deepEqual(out, [10, 20, 30, 40, 50, 60, 70])
    assert.deepEqual(started, [1, 2, 3, 4, 5, 6, 7])
    assert.equal(peak, 2)
    assert.equal(active, 0)
  })

  test('błąd zadania zwalnia slot i nie blokuje kolejki', async () => {
    const limit = createLimiter(1)
    const results = await Promise.allSettled([
      limit(async () => { await sleep(2); throw new Error('pierwsze pada') }),
      limit(async () => 'drugie'),
      limit(async () => 'trzecie'),
    ])
    assert.deepEqual(results.map(r => r.status), ['rejected', 'fulfilled', 'fulfilled'])
    assert.equal(await limit(async () => 'kolejne'), 'kolejne')
  })

  test('limit nie jest przekraczany, gdy nowe zadanie dochodzi dokładnie w chwili przekazywania slotu', async () => {
    // Stary wzorzec (finally { active--; queue.shift()?.() }) miał okno między zwolnieniem slotu a wznowieniem
    // czekającego: zadanie zgłoszone w tym oknie widziało wolny slot i ruszało jako drugie naraz (limit 1 → 2).
    // Okno trwa jeden „tik” mikrozadań, więc sondujemy każdy tik po zwolnieniu (stary wzorzec pada przy ticks=2).
    for (let ticks = 0; ticks <= 6; ticks++) {
      const limit = createLimiter(1)
      let active = 0
      let peak = 0
      let release: () => void = () => {}
      const gate = new Promise<void>(resolve => { release = resolve })
      const job = (wait: Promise<void>) => limit(async () => { active++; peak = Math.max(peak, active); await wait; active-- })
      const first = job(gate)          // zajmuje jedyny slot
      const second = job(sleep(1))     // czeka w kolejce
      release()                        // pierwsze kończy → slot przechodzi na drugie
      for (let i = 0; i < ticks; i++) await Promise.resolve()
      const third = job(sleep(1))      // zgłoszone w trakcie przekazywania slotu
      await Promise.all([first, second, third])
      assert.equal(peak, 1, `ticks=${ticks}`)
      assert.equal(active, 0)
    }
  })
})

describe('createInvoiceXmlStore — cache fail-soft, pobieranie, de-duplikacja (atrapy)', () => {
  function setup(over: Partial<InvoiceXmlStoreDeps> = {}) {
    const cache = new Map<string, string>()
    const calls = { read: 0, write: 0, download: 0 }
    const downloaded: string[] = []
    const warnings: string[] = []
    let clock = 1_700_000_000_000
    const deps: InvoiceXmlStoreDeps = {
      readCache: async id => { calls.read++; return cache.get(id) ?? null },
      writeCache: async (id, xml) => { calls.write++; cache.set(id, xml) },
      download: async ksefNumber => { calls.download++; downloaded.push(ksefNumber); return XML },
      warn: message => { warnings.push(message) },
      now: () => clock,
      ...over,
    }
    return { store: createInvoiceXmlStore(deps), cache, calls, downloaded, warnings, advance: (ms: number) => { clock += ms } }
  }
  const INV = { id: 'inv-1', ksef_number: '5260001246-20260210-0A1B2C3D4E5F-7A' }
  const missingTable = () => Object.assign(
    new Error('The table `public.ksef_invoice_xml` does not exist in the current database.'), { code: 'P2021' })

  test('brak w cache → pobranie z KSeF + zapis; kolejne wywołanie już z cache', async () => {
    const s = setup()
    assert.deepEqual(await s.store.getInvoiceXml(INV), { xml: XML, source: 'ksef' })
    assert.deepEqual(s.downloaded, [INV.ksef_number])
    assert.equal(s.cache.get('inv-1'), XML)
    assert.deepEqual(await s.store.getInvoiceXml(INV), { xml: XML, source: 'cache' })
    assert.equal(s.calls.download, 1)
    assert.equal(s.calls.write, 1)
    assert.equal(s.warnings.length, 0)
  })

  test('trafienie w cache nie dotyka KSeF', async () => {
    const s = setup()
    s.cache.set('inv-1', XML)
    assert.deepEqual(await s.store.getInvoiceXml(INV), { xml: XML, source: 'cache' })
    assert.equal(s.calls.download, 0)
    assert.equal(s.calls.write, 0)
  })

  test('faktura bez numeru KSeF → KsefXmlError 400 no_ksef_number, bez odczytu cache i bez pobierania', async () => {
    const s = setup()
    for (const ksef_number of [null, '', '   ']) {
      await assert.rejects(s.store.getInvoiceXml({ id: 'inv-x', ksef_number }), (err: unknown) => {
        assert.ok(err instanceof KsefXmlError)
        assert.deepEqual(mapKsefXmlError(err), { status: 400, body: { error: NO_KSEF_NUMBER_MSG, code: 'no_ksef_number' } })
        return true
      })
    }
    assert.deepEqual(s.calls, { read: 0, write: 0, download: 0 })
  })

  test('tabela cache jeszcze nie istnieje (P2021): działa jak bez cache, ostrzeżenie raz, cache wstrzymany', async () => {
    let reads = 0
    let writes = 0
    const s = setup({
      readCache: async () => { reads++; throw missingTable() },
      writeCache: async () => { writes++; throw missingTable() },
    })
    for (const id of ['a', 'b', 'c', 'a']) {
      assert.deepEqual(await s.store.getInvoiceXml({ id, ksef_number: `ksef-${id}` }), { xml: XML, source: 'ksef' })
    }
    assert.equal(s.calls.download, 4)
    assert.equal(s.warnings.length, 1)
    assert.match(s.warnings[0], /ksef_invoice_xml/)
    assert.equal(reads, 1)   // po pierwszym błędzie nie odpytujemy nieistniejącej tabeli przy każdym wywołaniu
    assert.equal(writes, 0)

    s.advance(11 * 60 * 1000) // po przerwie próbujemy ponownie (np. tabela powstała w międzyczasie)
    await s.store.getInvoiceXml({ id: 'd', ksef_number: 'ksef-d' })
    assert.equal(reads, 2)
    assert.equal(s.warnings.length, 1)
  })

  test('tabela pojawia się po przerwie → cache zaczyna działać bez restartu', async () => {
    let tableExists = false
    const rows = new Map<string, string>()
    const s = setup({
      readCache: async id => { if (!tableExists) throw missingTable(); return rows.get(id) ?? null },
      writeCache: async (id, xml) => { if (!tableExists) throw missingTable(); rows.set(id, xml) },
    })
    assert.equal((await s.store.getInvoiceXml(INV)).source, 'ksef')
    tableExists = true
    s.advance(11 * 60 * 1000)
    assert.equal((await s.store.getInvoiceXml(INV)).source, 'ksef')  // pierwsze pobranie zapisuje do cache
    assert.equal((await s.store.getInvoiceXml(INV)).source, 'cache')
    assert.equal(s.calls.download, 2)
  })

  test('inny błąd odczytu/zapisu cache jest połykany (ostrzeżenie raz na rodzaj), XML i tak wraca', async () => {
    let reads = 0
    let writes = 0
    const s = setup({
      readCache: async () => { reads++; throw Object.assign(new Error("Can't reach database server"), { code: 'P1001' }) },
      writeCache: async () => { writes++; throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }) },
    })
    for (const id of ['a', 'b', 'c']) {
      assert.deepEqual(await s.store.getInvoiceXml({ id, ksef_number: `ksef-${id}` }), { xml: XML, source: 'ksef' })
    }
    assert.equal(reads, 3)   // zwykły błąd nie wyłącza cache — próbujemy przy każdym wywołaniu
    assert.equal(writes, 3)
    assert.equal(s.warnings.length, 2) // jedno dla odczytu, jedno dla zapisu
  })

  test('trwały błąd cache: ostrzeżenie wraca najwyżej raz na godzinę (na operację i rodzaj błędu), z licznikiem powtórzeń', async () => {
    const MIN = 60 * 1000
    const s = setup({
      writeCache: async () => { throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }) },
    })
    const call = (id: string) => s.store.getInvoiceXml({ id, ksef_number: `ksef-${id}` })

    await call('a')                            // t = 0 — pierwsze ostrzeżenie
    assert.equal(s.warnings.length, 1)
    assert.match(s.warnings[0], /zapis nieudany/)
    assert.doesNotMatch(s.warnings[0], /powtórzył/)

    s.advance(10 * MIN); await call('b')       // t = 10 min
    s.advance(49 * MIN); await call('c')       // t = 59 min — wciąż cisza
    assert.equal(s.warnings.length, 1)

    s.advance(2 * MIN); await call('d')        // t = 61 min — przypomnienie
    assert.equal(s.warnings.length, 2)
    assert.match(s.warnings[1], /zapis nieudany.*Unique constraint failed/)
    assert.match(s.warnings[1], /powtórzył się 2×/)

    await call('e')                            // zaraz potem znów cisza — do następnej godziny
    s.advance(59 * MIN); await call('f')
    assert.equal(s.warnings.length, 2)
    s.advance(1 * MIN); await call('g')        // pełna godzina od poprzedniego ostrzeżenia
    assert.equal(s.warnings.length, 3)
    assert.match(s.warnings[2], /powtórzył się 2×/)
    assert.equal(s.calls.download, 7)          // awaria cache nigdy nie blokuje pobrania
  })

  test('różne rodzaje błędów cache mają osobne liczniki czasu', async () => {
    let code = 'P2002'
    const s = setup({ writeCache: async () => { throw Object.assign(new Error(`błąd ${code}`), { code }) } })
    const call = (id: string) => s.store.getInvoiceXml({ id, ksef_number: `ksef-${id}` })
    await call('a')
    code = 'P2003'                             // inny rodzaj błędu — ostrzeżenie od razu, bez czekania godziny
    s.advance(60 * 1000); await call('b')
    code = 'P2002'
    await call('c')                            // ten rodzaj był już zgłoszony minutę temu
    assert.deepEqual(s.warnings.map(w => /błąd (P\d+)/.exec(w)?.[1]), ['P2002', 'P2003'])
  })

  test('brak tabeli cache: przerwa 10 min bez zmian, przypomnienie w logach najwyżej raz na godzinę', async () => {
    let reads = 0
    const s = setup({
      readCache: async () => { reads++; throw missingTable() },
      writeCache: async () => { throw missingTable() },
    })
    const call = (id: string) => s.store.getInvoiceXml({ id, ksef_number: `ksef-${id}` })
    await call('a')                            // t = 0: ostrzeżenie, cache wstrzymany na 10 min
    for (let i = 1; i <= 5; i++) {             // t = 11, 22, 33, 44, 55 min: ponowna próba odczytu, bez ostrzeżenia
      s.advance(11 * 60 * 1000)
      await call(`b${i}`)
      await call(`c${i}`)                      // w trakcie przerwy cache nie jest odpytywany
    }
    assert.equal(reads, 6)
    assert.equal(s.warnings.length, 1)
    s.advance(11 * 60 * 1000); await call('d') // t = 66 min: przypomnienie
    assert.equal(reads, 7)
    assert.equal(s.warnings.length, 2)
    assert.match(s.warnings[1], /ksef_invoice_xml/)
    assert.match(s.warnings[1], /powtórzył się 5×/)
  })

  test('treść większa niż limit rozmiaru → KsefXmlError 502 xml_too_large i NIC nie trafia do cache', async () => {
    const tooLarge = { status: 502, body: { error: XML_TOO_LARGE_MSG, code: 'xml_too_large' } }
    const atLimit = XML + ' '.repeat(MAX_INVOICE_XML_BYTES - XML.length)
    assert.equal(atLimit.length, MAX_INVOICE_XML_BYTES)

    // treść o znak dłuższa niż limit (gdyby klient HTTP ją przepuścił) — odrzucona przed zapisem
    const over = setup({ download: async () => atLimit + ' ' })
    await assert.rejects(over.store.getInvoiceXml(INV), (err: unknown) => {
      assert.ok(err instanceof KsefXmlError)
      assert.deepEqual(mapKsefXmlError(err), tooLarge)
      return true
    })
    assert.equal(over.calls.write, 0)
    assert.equal(over.cache.size, 0)

    // axios przerywa pobieranie po przekroczeniu maxContentLength — błąd wraca, zapisu nie ma
    const aborted = setup({
      download: async () => { throw axiosNetError('ERR_BAD_RESPONSE', `maxContentLength size of ${MAX_INVOICE_XML_BYTES} exceeded`) },
    })
    await assert.rejects(aborted.store.getInvoiceXml(INV), (err: unknown) => {
      assert.deepEqual(mapKsefXmlError(err), tooLarge)
      return true
    })
    assert.equal(aborted.calls.write, 0)
    assert.equal(aborted.cache.size, 0)

    // dokładnie na limicie — zwykła ścieżka (pobranie + zapis)
    const ok = setup({ download: async () => atLimit })
    assert.equal((await ok.store.getInvoiceXml(INV)).source, 'ksef')
    assert.equal(ok.calls.write, 1)
  })

  test('treść błędu z KSeF (nie XML faktury) → KsefXmlError 502 i NIC nie trafia do cache', async () => {
    const s = setup({ download: async () => '{"exception":{"exceptionDetailList":[{"exceptionCode":21405}]}}' })
    await assert.rejects(s.store.getInvoiceXml(INV), (err: unknown) => {
      assert.deepEqual(mapKsefXmlError(err), { status: 502, body: { error: INVALID_XML_MSG, code: 'invalid_xml' } })
      return true
    })
    assert.equal(s.calls.write, 0)
    assert.equal(s.cache.size, 0)
  })

  test('błąd pobierania wraca do wywołującego bez zapisu; następne wywołanie próbuje ponownie', async () => {
    let attempt = 0
    const s = setup({ download: async () => { attempt++; if (attempt === 1) throw axiosHttpError(429); return XML } })
    await assert.rejects(s.store.getInvoiceXml(INV), (err: unknown) => {
      assert.equal(mapKsefXmlError(err).status, 429)
      return true
    })
    assert.equal(s.calls.write, 0)
    assert.deepEqual(await s.store.getInvoiceXml(INV), { xml: XML, source: 'ksef' })
    assert.equal(attempt, 2)
    assert.equal(s.cache.get('inv-1'), XML)
  })

  test('śmieci w cache są traktowane jak brak wpisu i nadpisywane poprawnym XML', async () => {
    const s = setup()
    s.cache.set('inv-1', '<html>błąd</html>')
    assert.deepEqual(await s.store.getInvoiceXml(INV), { xml: XML, source: 'ksef' })
    assert.equal(s.cache.get('inv-1'), XML)
  })

  test('równoległe żądania o tę samą fakturę → jedno pobranie (lista pozycji + podgląd dokumentu)', async () => {
    let downloads = 0
    const s = setup({ download: async () => { downloads++; await sleep(10); return XML } })
    const results = await Promise.all([1, 2, 3, 4].map(() => s.store.getInvoiceXml(INV)))
    assert.equal(downloads, 1)
    assert.equal(s.calls.write, 1)
    for (const r of results) assert.deepEqual(r, { xml: XML, source: 'ksef' })
    // po zakończeniu wpis „w toku” znika — kolejne wywołanie idzie już z cache
    assert.deepEqual(await s.store.getInvoiceXml(INV), { xml: XML, source: 'cache' })
    assert.equal(downloads, 1)
  })

  test('równoległe żądania, które kończą się błędem, dostają ten sam błąd i nie blokują kolejnych', async () => {
    let downloads = 0
    const s = setup({ download: async () => { downloads++; await sleep(5); if (downloads === 1) throw axiosHttpError(503); return XML } })
    const results = await Promise.allSettled([s.store.getInvoiceXml(INV), s.store.getInvoiceXml(INV)])
    assert.deepEqual(results.map(r => r.status), ['rejected', 'rejected'])
    assert.equal(downloads, 1)
    assert.equal((await s.store.getInvoiceXml(INV)).source, 'ksef')
    assert.equal(downloads, 2)
  })

  test('różne faktury: najwyżej 2 pobrania z KSeF naraz (wspólny ogranicznik)', async () => {
    let active = 0
    let peak = 0
    const s = setup({
      download: async () => { active++; peak = Math.max(peak, active); await sleep(5); active--; return XML },
    })
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
    const results = await Promise.all(ids.map(id => s.store.getInvoiceXml({ id, ksef_number: `ksef-${id}` })))
    assert.equal(peak, 2)
    assert.equal(results.length, ids.length)
    assert.equal(s.cache.size, ids.length)
  })

  test('odczyt z cache nie czeka w kolejce pobrań z KSeF', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    const s = setup({ download: async () => { await gate; return XML } })
    s.cache.set('cached', XML)
    // dwa wolne pobrania zajmują oba sloty, trzecie czeka w kolejce
    const slow = ['a', 'b', 'c'].map(id => s.store.getInvoiceXml({ id, ksef_number: `ksef-${id}` }))
    assert.deepEqual(await s.store.getInvoiceXml({ id: 'cached', ksef_number: 'ksef-cached' }), { xml: XML, source: 'cache' })
    release()
    await Promise.all(slow)
  })
})
