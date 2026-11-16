/**
 * Testy wizualizacji faktury KSeF (XML FA(2)/FA(3) → model → HTML) — czyste funkcje, bez bazy i sieci.
 * Fikstury są syntetyczne (zmyślone firmy, NIP-y i rachunki).
 * Uruchomienie: cd backend && npx tsx --test src/__tests__/ksef-document.test.ts
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseXml, parseKsefInvoice, renderKsefInvoiceHtml, buildKsefInvoiceHtml, ksefInvoiceTitle, KsefDocumentError,
} from '../services/ksef-document'

// ── pomocnicze ──────────────────────────────────────────────────────────────

/** Fragment HTML między dwoma znacznikami (do sprawdzania, co trafiło do której sekcji). */
function between(html: string, from: string, to: string): string {
  const a = html.indexOf(from)
  assert.ok(a >= 0, `brak znacznika początku: ${from}`)
  const b = html.indexOf(to, a + from.length)
  assert.ok(b > a, `brak znacznika końca: ${to}`)
  return html.slice(a, b)
}

/** Sekcja dokumentu o danym tytule (od <h2> do końca <section>). */
function sectionOf(html: string, title: string): string {
  return between(html, `<h2>${title}</h2>`, '</section>')
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

function assertClean(html: string): void {
  assert.ok(!html.includes('undefined'), 'HTML zawiera „undefined”')
  assert.ok(!html.includes('NaN'), 'HTML zawiera „NaN”')
  assert.ok(!/\bnull\b/.test(html), 'HTML zawiera „null”')
  assert.ok(!/<script/i.test(html), 'HTML zawiera <script')
  // żaden prawdziwy znacznik nie niesie src / href / on* (dane z faktury są zawsze escapowane)
  assert.ok(!/<[a-z][^>]*\s(?:src|href|on[a-z]+)\s*=/i.test(html), 'HTML zawiera atrybut src/href/on*')
  assert.ok(html.startsWith('<!DOCTYPE html>'))
  assert.ok(html.includes(CSP_META))
}

const CSP_META = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">`

/** Znaki sterujące kierunkiem tekstu — zapisane escapami, żeby w pliku nie było niewidocznych znaków. */
const BIDI_RE = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/

const ADNOTACJE_BRAK = `<Adnotacje><P_16>2</P_16><P_17>2</P_17><P_18>2</P_18><P_18A>2</P_18A>
      <Zwolnienie><P_19N>1</P_19N></Zwolnienie><NoweSrodkiTransportu><P_22N>1</P_22N></NoweSrodkiTransportu>
      <P_23>2</P_23><PMarzy><P_PMarzyN>1</P_PMarzyN></PMarzy></Adnotacje>`

// ── Fikstura 1: standardowa faktura FA(2), domyślna przestrzeń nazw, 2 stawki VAT ──
const FA2_STANDARD = `\uFEFF<?xml version="1.0" encoding="UTF-8"?>
<!-- faktura testowa -->
<Faktura xmlns="http://crd.gov.pl/wzor/2023/06/29/12648/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Naglowek>
    <KodFormularza kodSystemowy="FA (2)" wersjaSchemy="1-0E">FA</KodFormularza>
    <WariantFormularza>2</WariantFormularza>
    <DataWytworzeniaFa>2026-03-10T09:15:00Z</DataWytworzeniaFa>
    <SystemInfo>Testowy ERP 1.0</SystemInfo>
  </Naglowek>
  <Podmiot1>
    <DaneIdentyfikacyjne><NIP>1111111111</NIP><Nazwa>Alfa Instalacje Sp. z o.o.</Nazwa></DaneIdentyfikacyjne>
    <Adres><KodKraju>PL</KodKraju><AdresL1>ul. Testowa 1</AdresL1><AdresL2>00-001 Warszawa</AdresL2></Adres>
    <DaneKontaktowe><Email>biuro@alfa.example</Email><Telefon>221234567</Telefon></DaneKontaktowe>
  </Podmiot1>
  <Podmiot2>
    <DaneIdentyfikacyjne><NIP>2222222222</NIP><Nazwa>Beta Dom Sp. z o.o.</Nazwa></DaneIdentyfikacyjne>
    <Adres><KodKraju>PL</KodKraju><AdresL1>ul. Przykładowa 5/7</AdresL1><AdresL2>30-002 Kraków</AdresL2></Adres>
    <NrKlienta>K-0042</NrKlienta>
  </Podmiot2>
  <Fa>
    <KodWaluty>PLN</KodWaluty>
    <P_1>2026-03-10</P_1>
    <P_1M>Warszawa</P_1M>
    <P_2>FV/12/2026</P_2>
    <P_6>2026-03-08</P_6>
    <P_13_1>1200.00</P_13_1>
    <P_14_1>276.00</P_14_1>
    <P_13_2>100.50</P_13_2>
    <P_14_2>8.04</P_14_2>
    <P_15>1584.54</P_15>
    <Adnotacje><P_16>2</P_16><P_17>2</P_17><P_18>2</P_18><P_18A>1</P_18A>
      <Zwolnienie><P_19N>1</P_19N></Zwolnienie><NoweSrodkiTransportu><P_22N>1</P_22N></NoweSrodkiTransportu>
      <P_23>2</P_23><PMarzy><P_PMarzyN>1</P_PMarzyN></PMarzy></Adnotacje>
    <RodzajFaktury>VAT</RodzajFaktury>
    <FaWiersz>
      <NrWierszaFa>1</NrWierszaFa><P_7>Montaż sterownika</P_7><P_8A>szt.</P_8A><P_8B>2.000</P_8B>
      <P_9A>600.00</P_9A><P_11>1200.00</P_11><P_12>23</P_12>
    </FaWiersz>
    <FaWiersz>
      <NrWierszaFa>2</NrWierszaFa><P_7>Przewód instalacyjny</P_7><Indeks>PRZ-01</Indeks><GTU>GTU_06</GTU><P_8A>m</P_8A><P_8B>12.5</P_8B>
      <P_9A>8.0400</P_9A><P_10>0.00</P_10><P_11>100.50</P_11><P_12>8</P_12>
    </FaWiersz>
    <Platnosc>
      <TerminPlatnosci><Termin>2026-03-24</Termin><TerminOpis>14 dni</TerminOpis></TerminPlatnosci>
      <FormaPlatnosci>6</FormaPlatnosci>
      <RachunekBankowy><NrRB>61109010140000071219812874</NrRB><SWIFT>TESTPLPW</SWIFT><NazwaBanku>Bank Testowy S.A.</NazwaBanku></RachunekBankowy>
    </Platnosc>
  </Fa>
  <Stopka>
    <Informacje><StopkaFaktury>Kapitał zakładowy 5 000 zł</StopkaFaktury></Informacje>
    <Rejestry><KRS>0000123456</KRS><REGON>123456789</REGON><BDO>000012345</BDO></Rejestry>
  </Stopka>
</Faktura>
`

// ── Fikstura 2: FA(3) — prefiks przestrzeni nazw na KAŻDYM elemencie, strukturalny TerminOpis ──
const FA3_PREFIXED = `<?xml version='1.0' encoding='UTF-8'?>
<fa:Faktura xmlns:fa="http://crd.gov.pl/wzor/2025/06/25/13775/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <fa:Naglowek>
    <fa:KodFormularza kodSystemowy="FA (3)" wersjaSchemy="1-0E">FA</fa:KodFormularza>
    <fa:WariantFormularza>3</fa:WariantFormularza>
    <fa:DataWytworzeniaFa>2026-04-30T12:00:00+02:00</fa:DataWytworzeniaFa>
  </fa:Naglowek>
  <fa:Podmiot1>
    <fa:DaneIdentyfikacyjne><fa:NIP>4444444444</fa:NIP><fa:Nazwa>Epsilon Automatyka S.A.</fa:Nazwa></fa:DaneIdentyfikacyjne>
    <fa:Adres><fa:KodKraju>PL</fa:KodKraju><fa:AdresL1>al. Fikcyjna 10, 80-001 Gdańsk</fa:AdresL1></fa:Adres>
  </fa:Podmiot1>
  <fa:Podmiot2>
    <fa:DaneIdentyfikacyjne><fa:NIP>5555555555</fa:NIP><fa:Nazwa>Zeta Budownictwo Sp. k.</fa:Nazwa></fa:DaneIdentyfikacyjne>
    <fa:Adres><fa:KodKraju>PL</fa:KodKraju><fa:AdresL1>ul. Wymyślona 3</fa:AdresL1><fa:AdresL2>50-003 Wrocław</fa:AdresL2></fa:Adres>
    <fa:JST>2</fa:JST>
    <fa:GV>2</fa:GV>
  </fa:Podmiot2>
  <fa:Fa>
    <fa:KodWaluty>PLN</fa:KodWaluty>
    <fa:P_1>2026-04-30</fa:P_1>
    <fa:P_2>F/2026/04/0017</fa:P_2>
    <fa:OkresFa><fa:P_6_Od>2026-04-01</fa:P_6_Od><fa:P_6_Do>2026-04-30</fa:P_6_Do></fa:OkresFa>
    <fa:P_13_1>2500.00</fa:P_13_1>
    <fa:P_14_1>575.00</fa:P_14_1>
    <fa:P_15>3075.00</fa:P_15>
    <fa:Adnotacje><fa:P_16>2</fa:P_16><fa:P_17>2</fa:P_17><fa:P_18>2</fa:P_18><fa:P_18A>2</fa:P_18A>
      <fa:Zwolnienie><fa:P_19N>1</fa:P_19N></fa:Zwolnienie><fa:NoweSrodkiTransportu><fa:P_22N>1</fa:P_22N></fa:NoweSrodkiTransportu>
      <fa:P_23>2</fa:P_23><fa:PMarzy><fa:P_PMarzyN>1</fa:P_PMarzyN></fa:PMarzy></fa:Adnotacje>
    <fa:RodzajFaktury>VAT</fa:RodzajFaktury>
    <fa:FaWiersz>
      <fa:NrWierszaFa>1</fa:NrWierszaFa><fa:UU_ID>a1b2</fa:UU_ID><fa:P_7>Serwis miesięczny</fa:P_7><fa:P_8A>usł.</fa:P_8A><fa:P_8B>1</fa:P_8B>
      <fa:P_9A>2500.00</fa:P_9A><fa:P_11>2500.00</fa:P_11><fa:P_12>23</fa:P_12>
    </fa:FaWiersz>
    <fa:Platnosc>
      <fa:TerminPlatnosci>
        <fa:Termin>2026-05-30</fa:Termin>
        <fa:TerminOpis><fa:Ilosc>30</fa:Ilosc><fa:Jednostka>dni</fa:Jednostka><fa:ZdarzeniePoczatkowe>wystawienie faktury</fa:ZdarzeniePoczatkowe></fa:TerminOpis>
      </fa:TerminPlatnosci>
      <fa:FormaPlatnosci>6</fa:FormaPlatnosci>
      <fa:RachunekBankowy><fa:NrRB>PL27114020040000300201355387</fa:NrRB></fa:RachunekBankowy>
    </fa:Platnosc>
    <fa:WarunkiTransakcji>
      <fa:Umowy><fa:DataUmowy>2026-01-02</fa:DataUmowy><fa:NrUmowy>U/7/2026</fa:NrUmowy></fa:Umowy>
      <fa:Zamowienia><fa:DataZamowienia>2026-03-28</fa:DataZamowienia><fa:NrZamowienia>ZAM-991</fa:NrZamowienia></fa:Zamowienia>
      <fa:WarunkiDostawy>DAP Wrocław</fa:WarunkiDostawy>
    </fa:WarunkiTransakcji>
  </fa:Fa>
</fa:Faktura>`

// ── Fikstura 3: faktura korygująca — kwoty ujemne, DaneFaKorygowanej, wiersze StanPrzed ──
const KOR = `<?xml version="1.0" encoding="UTF-8"?>
<Faktura xmlns="http://crd.gov.pl/wzor/2023/06/29/12648/">
  <Naglowek><KodFormularza kodSystemowy="FA (2)" wersjaSchemy="1-0E">FA</KodFormularza><WariantFormularza>2</WariantFormularza></Naglowek>
  <Podmiot1><DaneIdentyfikacyjne><NIP>1111111111</NIP><Nazwa>Alfa Instalacje Sp. z o.o.</Nazwa></DaneIdentyfikacyjne>
    <Adres><KodKraju>PL</KodKraju><AdresL1>ul. Testowa 1, 00-001 Warszawa</AdresL1></Adres></Podmiot1>
  <Podmiot2><DaneIdentyfikacyjne><NIP>2222222222</NIP><Nazwa>Beta Dom Sp. z o.o.</Nazwa></DaneIdentyfikacyjne></Podmiot2>
  <Fa>
    <KodWaluty>PLN</KodWaluty><P_1>2026-02-20</P_1><P_2>KOR/3/2026</P_2>
    <P_13_1>-200.00</P_13_1><P_14_1>-46.00</P_14_1><P_15>-246.00</P_15>
    ${ADNOTACJE_BRAK}
    <RodzajFaktury>KOR</RodzajFaktury>
    <PrzyczynaKorekty>Zwrot części towaru</PrzyczynaKorekty>
    <TypKorekty>2</TypKorekty>
    <DaneFaKorygowanej>
      <DataWystFaKorygowanej>2026-01-15</DataWystFaKorygowanej>
      <NrFaKorygowanej>FV/5/2026</NrFaKorygowanej>
      <NrKSeF>1</NrKSeF>
      <NrKSeFFaKorygowanej>1111111111-20260115-0A1B2C3D4E5F-01</NrKSeFFaKorygowanej>
    </DaneFaKorygowanej>
    <FaWiersz><NrWierszaFa>1</NrWierszaFa><P_7>Czujnik ruchu</P_7><P_8A>szt.</P_8A><P_8B>10</P_8B><P_9A>100.00</P_9A><P_11>1000.00</P_11><P_12>23</P_12><StanPrzed>1</StanPrzed></FaWiersz>
    <FaWiersz><NrWierszaFa>2</NrWierszaFa><P_7>Czujnik ruchu</P_7><P_8A>szt.</P_8A><P_8B>8</P_8B><P_9A>100.00</P_9A><P_11>800.00</P_11><P_12>23</P_12></FaWiersz>
  </Fa>
</Faktura>`

// ── Fikstura 4: faktura w EUR — KursWaluty w wierszach, P_14_1W, nabywca z VAT UE ──
const EUR = `<?xml version="1.0" encoding="UTF-8"?>
<Faktura xmlns="http://crd.gov.pl/wzor/2023/06/29/12648/">
  <Naglowek><KodFormularza kodSystemowy="FA (2)" wersjaSchemy="1-0E">FA</KodFormularza><WariantFormularza>2</WariantFormularza></Naglowek>
  <Podmiot1><PrefiksPodatnika>PL</PrefiksPodatnika>
    <DaneIdentyfikacyjne><NIP>1111111111</NIP><Nazwa>Alfa Instalacje Sp. z o.o.</Nazwa></DaneIdentyfikacyjne>
    <Adres><KodKraju>PL</KodKraju><AdresL1>ul. Testowa 1, 00-001 Warszawa</AdresL1></Adres></Podmiot1>
  <Podmiot2>
    <DaneIdentyfikacyjne><KodUE>DE</KodUE><NrVatUE>123456789</NrVatUE><Nazwa>Omega Technik GmbH</Nazwa></DaneIdentyfikacyjne>
    <Adres><KodKraju>DE</KodKraju><AdresL1>Musterstrasse 12</AdresL1><AdresL2>10115 Berlin</AdresL2></Adres>
  </Podmiot2>
  <Fa>
    <KodWaluty>EUR</KodWaluty><P_1>2026-05-05</P_1><P_2>FV/EUR/1/2026</P_2><P_6>2026-05-04</P_6>
    <P_13_1>1000.00</P_13_1><P_14_1>230.00</P_14_1><P_14_1W>989.69</P_14_1W><P_15>1230.00</P_15>
    ${ADNOTACJE_BRAK}
    <RodzajFaktury>VAT</RodzajFaktury>
    <FaWiersz><NrWierszaFa>1</NrWierszaFa><P_7>Moduł wykonawczy</P_7><P_8A>szt.</P_8A><P_8B>4</P_8B><P_9A>125.00</P_9A><P_11>500.00</P_11><P_12>23</P_12><KursWaluty>4.3030</KursWaluty></FaWiersz>
    <FaWiersz><NrWierszaFa>2</NrWierszaFa><P_7>Panel dotykowy</P_7><P_8A>szt.</P_8A><P_8B>1</P_8B><P_9A>500.00</P_9A><P_11>500.00</P_11><P_12>23</P_12><KursWaluty>4.3030</KursWaluty></FaWiersz>
    <Platnosc><FormaPlatnosci>6</FormaPlatnosci>
      <RachunekBankowy><NrRB>PL61109010140000071219812874</NrRB><SWIFT>TESTPLPW</SWIFT></RachunekBankowy></Platnosc>
  </Fa>
</Faktura>`

// ── Fikstura 5: faktura zaliczkowa z wierszami zamówienia ──
const ZAL = `<?xml version="1.0" encoding="UTF-8"?>
<Faktura xmlns="http://crd.gov.pl/wzor/2023/06/29/12648/">
  <Naglowek><KodFormularza kodSystemowy="FA (2)" wersjaSchemy="1-0E">FA</KodFormularza><WariantFormularza>2</WariantFormularza></Naglowek>
  <Podmiot1><DaneIdentyfikacyjne><NIP>1111111111</NIP><Nazwa>Alfa Instalacje Sp. z o.o.</Nazwa></DaneIdentyfikacyjne></Podmiot1>
  <Podmiot2><DaneIdentyfikacyjne><NIP>2222222222</NIP><Nazwa>Beta Dom Sp. z o.o.</Nazwa></DaneIdentyfikacyjne></Podmiot2>
  <Fa>
    <KodWaluty>PLN</KodWaluty><P_1>2026-06-01</P_1><P_2>ZAL/1/2026</P_2><P_6>2026-05-29</P_6>
    <P_13_1>813.01</P_13_1><P_14_1>186.99</P_14_1><P_15>1000.00</P_15>
    ${ADNOTACJE_BRAK}
    <RodzajFaktury>ZAL</RodzajFaktury>
    <Platnosc><Zaplacono>1</Zaplacono><DataZaplaty>2026-05-29</DataZaplaty><FormaPlatnosci>6</FormaPlatnosci></Platnosc>
    <Zamowienie>
      <WartoscZamowienia>6150.00</WartoscZamowienia>
      <ZamowienieWiersz><NrWierszaZam>1</NrWierszaZam><P_7Z>System sterowania oświetleniem</P_7Z><P_8AZ>kpl.</P_8AZ><P_8BZ>1</P_8BZ>
        <P_9AZ>5000.00</P_9AZ><P_11NettoZ>5000.00</P_11NettoZ><P_11VatZ>1150.00</P_11VatZ><P_12Z>23</P_12Z></ZamowienieWiersz>
    </Zamowienie>
  </Fa>
</Faktura>`

// ── Fikstura 6: bogata — Podmiot3, rozliczenie, zapłaty częściowe, adnotacje, pola nieznane ──
const RICH = `<Faktura xmlns="http://crd.gov.pl/wzor/2023/06/29/12648/">
  <Naglowek><KodFormularza kodSystemowy="FA (2)" wersjaSchemy="1-0E">FA</KodFormularza><WariantFormularza>2</WariantFormularza></Naglowek>
  <Podmiot1><DaneIdentyfikacyjne><NIP>1111111111</NIP><Nazwa>Alfa Instalacje Sp. z o.o.</Nazwa></DaneIdentyfikacyjne>
    <Adres><KodKraju>PL</KodKraju><AdresL1>ul. Testowa 1</AdresL1></Adres><StatusInfoPodatnika>2</StatusInfoPodatnika></Podmiot1>
  <Podmiot2><DaneIdentyfikacyjne><NIP>2222222222</NIP><Nazwa>Beta Dom Sp. z o.o.</Nazwa></DaneIdentyfikacyjne>
    <Adres><KodKraju>PL</KodKraju><AdresL1>ul. Przykładowa 5/7</AdresL1></Adres></Podmiot2>
  <Podmiot3>
    <DaneIdentyfikacyjne><NIP>3333333333</NIP><Nazwa>Delta Faktoring S.A.</Nazwa></DaneIdentyfikacyjne>
    <Adres><KodKraju>PL</KodKraju><AdresL1>ul. Trzecia 3, 90-003 Łódź</AdresL1></Adres>
    <Rola>1</Rola>
  </Podmiot3>
  <Podmiot3>
    <DaneIdentyfikacyjne><IDWew>2222222222-00017</IDWew><Nazwa>Beta Dom — oddział Sopot</Nazwa></DaneIdentyfikacyjne>
    <RolaInna>1</RolaInna><OpisRoli>Miejsce realizacji</OpisRoli><Udzial>50.00</Udzial>
  </Podmiot3>
  <Fa>
    <KodWaluty>PLN</KodWaluty><P_1>2026-07-01</P_1><P_2>FV/77/2026</P_2>
    <P_13_1>1234567.80</P_13_1><P_14_1>283950.59</P_14_1>
    <P_13_7>50.00</P_13_7>
    <P_15>1518568.39</P_15>
    <Adnotacje><P_16>1</P_16><P_17>2</P_17><P_18>2</P_18><P_18A>1</P_18A>
      <Zwolnienie><P_19>1</P_19><P_19A>art. 43 ust. 1 pkt 29 ustawy</P_19A></Zwolnienie>
      <NoweSrodkiTransportu><P_22N>1</P_22N></NoweSrodkiTransportu>
      <P_23>2</P_23><PMarzy><P_PMarzyN>1</P_PMarzyN></PMarzy></Adnotacje>
    <RodzajFaktury>VAT</RodzajFaktury>
    <FP>1</FP><TP>1</TP>
    <DodatkowyOpis><Klucz>Nr projektu</Klucz><Wartosc>PRJ-2026-015</Wartosc></DodatkowyOpis>
    <NoweNieznanePole>wartość spoza schematu</NoweNieznanePole>
    <FaWiersz><NrWierszaFa>1</NrWierszaFa><P_7>Dostawa i uruchomienie instalacji</P_7><P_8A>kpl.</P_8A><P_8B>1.500</P_8B>
      <P_9A>823045.20</P_9A><P_10>10.005</P_10><P_11>1234567.80</P_11><P_12>23</P_12></FaWiersz>
    <FaWiersz><NrWierszaFa>2</NrWierszaFa><P_7>Szkolenie</P_7><P_8A>godz.</P_8A><P_8B>0.250</P_8B>
      <P_9A>200.12345</P_9A><P_11>50.00</P_11><P_12>zw</P_12></FaWiersz>
    <FaWiersz><NrWierszaFa>3</NrWierszaFa><P_7>Opłata paragonowa</P_7><P_8B>1</P_8B><P_9B>12.3</P_9B><P_11A>12.30</P_11A><P_12>23</P_12></FaWiersz>
    <Rozliczenie>
      <Obciazenia><Kwota>100.00</Kwota><Powod>Kaucja za opakowania</Powod></Obciazenia><SumaObciazen>100.00</SumaObciazen>
      <Odliczenia><Kwota>18.39</Kwota><Powod>Nadpłata z poprzedniej faktury</Powod></Odliczenia><SumaOdliczen>18.39</SumaOdliczen>
      <DoZaplaty>1518650.00</DoZaplaty>
    </Rozliczenie>
    <Platnosc>
      <ZnacznikZaplatyCzesciowej>1</ZnacznikZaplatyCzesciowej>
      <ZaplataCzesciowa><KwotaZaplatyCzesciowej>500000.00</KwotaZaplatyCzesciowej><DataZaplatyCzesciowej>2026-07-02</DataZaplatyCzesciowej></ZaplataCzesciowa>
      <TerminPlatnosci><Termin>2026-07-15</Termin></TerminPlatnosci>
      <TerminPlatnosci><Termin>2026-08-15</Termin></TerminPlatnosci>
      <PlatnoscInna>1</PlatnoscInna><OpisPlatnosci>Kompensata</OpisPlatnosci>
      <RachunekBankowy><NrRB>61 1090 1014 0000 0712 1981 2874</NrRB><NazwaBanku>Bank Testowy S.A.</NazwaBanku><OpisRachunku>Rachunek VAT</OpisRachunku></RachunekBankowy>
      <RachunekBankowyFaktora><NrRB>27114020040000300201355387</NrRB></RachunekBankowyFaktora>
      <Skonto><WarunkiSkonta>Zapłata w 7 dni</WarunkiSkonta><WysokoscSkonta>2%</WysokoscSkonta></Skonto>
      <LinkDoPlatnosci>https://platnosci.example/p/abc?x=1&amp;y=2</LinkDoPlatnosci>
      <PoleZPrzyszlejWersji><Zagniezdzone>123</Zagniezdzone></PoleZPrzyszlejWersji>
    </Platnosc>
  </Fa>
  <Stopka><Informacje><StopkaFaktury>Linia pierwsza
Linia druga</StopkaFaktury></Informacje></Stopka>
</Faktura>`

// ═════════════════════════════════════════════════════════════════════════════

describe('parseXml', () => {
  test('BOM, prolog, komentarze, CDATA, tagi samozamykające, atrybuty w obu rodzajach cudzysłowów', () => {
    const root = parseXml(`\uFEFF<?xml version="1.0" encoding="UTF-8"?>
<!-- komentarz <z> znacznikami -->
<!DOCTYPE root [ <!ENTITY x "y"> ]>
<root a="1" b='dwa "trzy"' xmlns="urn:x">
  <puste/>
  <puste2 flaga="tak" />
  <tekst>  ala ma kota  </tekst>
  <cdata><![CDATA[<b>surowe</b> &amp; ]]>dalej &amp; koniec</cdata>
  <!-- w środku -->
  <dziecko><wnuk>1</wnuk><wnuk>2</wnuk></dziecko>
</root>
<!-- po elemencie głównym -->`)
    assert.ok(root)
    assert.equal(root.name, 'root')
    assert.deepEqual(root.attrs, { a: '1', b: 'dwa "trzy"', xmlns: 'urn:x' })
    assert.equal(root.text, '', 'tekst z samych białych znaków → pusty')
    assert.deepEqual(root.children.map(c => c.name), ['puste', 'puste2', 'tekst', 'cdata', 'dziecko'])
    assert.deepEqual(root.children[0], { name: 'puste', attrs: {}, children: [], text: '' })
    assert.deepEqual(root.children[1].attrs, { flaga: 'tak' })
    assert.equal(root.children[2].text, 'ala ma kota')
    assert.equal(root.children[3].text, '<b>surowe</b> &amp; dalej & koniec', 'CDATA dosłownie, tekst obok dekodowany')
    assert.deepEqual(root.children[4].children.map(c => c.text), ['1', '2'])
  })

  test('przestrzenie nazw: nazwa lokalna elementów i atrybutów, deklaracje xmlns zostają', () => {
    const root = parseXml('<tns:Faktura xmlns:tns="urn:a" xmlns:xsi="urn:b" xsi:schemaLocation="urn:a a.xsd"><tns:Fa tns:id="7"><tns:P_2>X</tns:P_2></tns:Fa></tns:Faktura>')
    assert.ok(root)
    assert.equal(root.name, 'Faktura')
    assert.deepEqual(root.attrs, { 'xmlns:tns': 'urn:a', 'xmlns:xsi': 'urn:b', schemaLocation: 'urn:a a.xsd' })
    assert.equal(root.children[0].name, 'Fa')
    assert.equal(root.children[0].attrs.id, '7')
    assert.equal(root.children[0].children[0].name, 'P_2')
    assert.equal(root.children[0].children[0].text, 'X')
  })

  test('encje: nazwane, dziesiętne, szesnastkowe; bez podwójnego dekodowania; nieznane zostają', () => {
    const root = parseXml('<a t="&quot;x&quot; &amp; &#65;"><b>&amp; &lt; &gt; &quot; &apos; &#123; &#x1F; &#x41; &amp;lt; &nbsp; &#xD83D;</b></a>')
    assert.ok(root)
    assert.equal(root.attrs.t, '"x" & A')
    assert.equal(root.children[0].text, '& < > " \' { \u001f A &lt; &nbsp; �')
  })

  test('tekst mieszany skleja fragmenty; pusty element główny', () => {
    assert.equal(parseXml('<a>raz <b/>dwa<![CDATA[ trzy]]></a>')!.text, 'raz dwa trzy')
    assert.deepEqual(parseXml('<a/>'), { name: 'a', attrs: {}, children: [], text: '' })
  })

  test('dokument uszkodzony / ucięty / nie-XML → null (bez wyjątku)', () => {
    const bad = [
      '', '   ', 'zwykły tekst', '{"error":"x"}',
      '<a>', '<a><b></a>', '<a></b>', '<a><b>', '<a attr></a>', '<a attr=x></a>', '<a attr="x></a>',
      '<a><!-- niezamknięty', '<a><![CDATA[niezamknięte', '<?xml version="1.0"', '<a', '<', '< a></a>', '<a><1b/></a>',
      '</a>', '<a b="1" b', '<a /b>', '<![CDATA[x]]>',
    ]
    for (const xml of bad) assert.equal(parseXml(xml), null, `oczekiwano null dla: ${JSON.stringify(xml)}`)
    assert.equal(parseXml(undefined as unknown as string), null)
    assert.equal(parseXml(null as unknown as string), null)
  })

  test('wejścia patologiczne nie wieszają parsera i nie przepełniają stosu', () => {
    const started = Date.now()
    assert.equal(parseXml('<a>'.repeat(200_000)), null, 'głębokie zagnieżdżenie bez zamknięć')
    assert.equal(parseXml('<a>'.repeat(50_000) + '</a>'.repeat(50_000)), null, 'zagnieżdżenie ponad limit głębokości')
    assert.equal(parseXml('<a ' + 'x'.repeat(2_000_000)), null)
    assert.equal(parseXml('<a b="' + 'x'.repeat(2_000_000)), null)
    assert.equal(parseXml('<'.repeat(500_000)), null)
    assert.equal(parseXml('<a>' + '&'.repeat(1_000_000)), null)
    assert.equal(parseXml('<a>' + '<!--'.repeat(300_000)), null)
    // szeroki, poprawny dokument (dużo rodzeństwa) parsuje się normalnie
    const wide = parseXml('<a>' + '<b x="1">t</b>'.repeat(100_000) + '</a>')
    assert.equal(wide?.children.length, 100_000)
    assert.ok(Date.now() - started < 5000, 'parser działa liniowo')
  })

  test('nazwa elementu dłuższa niż 128 znaków → null (nazwy FA mają poniżej 40)', () => {
    const ok = 'E'.repeat(128)
    const tooLong = 'E'.repeat(129)
    assert.equal(parseXml(`<a><${ok}>1</${ok}></a>`)?.children[0].name, ok)
    assert.equal(parseXml(`<a><ns:${'E'.repeat(124)}/></a>`)?.children[0].name, 'E'.repeat(124), 'limit liczy pełną nazwę z prefiksem')
    assert.equal(parseXml(`<a><${tooLong}>1</${tooLong}></a>`), null)
    assert.equal(parseXml(`<a><${tooLong}/></a>`), null)
    assert.equal(parseXml(`<${tooLong}/>`), null)
  })

  test('limit rozmiaru: XML powyżej 8 MB jest odrzucany od razu, tuż pod limitem czytany normalnie', () => {
    const LIMIT = 8 * 1024 * 1024
    const invoice = '<Faktura><Fa><P_2>F/1</P_2></Fa></Faktura>'
    const padded = (total: number) => `<!--${' '.repeat(total - invoice.length - 7)}-->${invoice}`
    const started = Date.now()
    const over = padded(LIMIT + 1)
    assert.equal(over.length, LIMIT + 1)
    assert.equal(parseXml(over), null)
    assert.throws(() => buildKsefInvoiceHtml(over), KsefDocumentError)
    const atLimit = padded(LIMIT)
    assert.equal(atLimit.length, LIMIT)
    assert.equal(buildKsefInvoiceHtml(atLimit).title, 'Faktura F/1')
    assert.ok(Date.now() - started < 2000)
  })
})

describe('faktura FA(2) — standardowa, domyślna przestrzeń nazw', () => {
  const meta = { ksefNumber: '1111111111-20260310-ABCDEF123456-7A', direction: 'incoming' }

  test('model: sprzedawca i nabywca nie są zamienione, sumy, stawki, termin', () => {
    const doc = parseKsefInvoice(FA2_STANDARD)
    assert.equal(doc.schema, 'FA (2)')
    assert.equal(doc.type, 'VAT')
    assert.equal(doc.number, 'FV/12/2026')
    assert.equal(doc.currency, 'PLN')
    assert.equal(doc.seller?.name, 'Alfa Instalacje Sp. z o.o.')
    assert.deepEqual(doc.seller?.ids, [{ label: 'NIP', value: '1111111111' }])
    assert.deepEqual(doc.seller?.address, { countryCode: 'PL', lines: ['ul. Testowa 1', '00-001 Warszawa'], gln: '' })
    assert.deepEqual(doc.seller?.contacts, [{ email: 'biuro@alfa.example', phone: '221234567' }])
    assert.equal(doc.buyer?.name, 'Beta Dom Sp. z o.o.')
    assert.deepEqual(doc.buyer?.ids, [{ label: 'NIP', value: '2222222222' }])
    assert.equal(doc.buyer?.customerNo, 'K-0042')
    assert.deepEqual(doc.otherParties, [])
    assert.equal(doc.lines.length, 2)
    assert.equal(doc.lines[1].index, 'PRZ-01')
    assert.deepEqual(doc.vatRows, [
      { key: '1', label: '23%', net: '1200.00', vat: '276.00', vatPln: '', gross: '1476.00' },
      { key: '2', label: '8%', net: '100.50', vat: '8.04', vatPln: '', gross: '108.54' },
    ])
    assert.equal(doc.total, '1584.54')
    assert.deepEqual(doc.payment?.terms, [{ date: '2026-03-24', description: '14 dni' }])
    assert.equal(doc.payment?.method, 'Przelew')
    assert.deepEqual(doc.annotations, ['Mechanizm podzielonej płatności'])
    assert.deepEqual(doc.footerTexts, ['Kapitał zakładowy 5 000 zł'])
    assert.deepEqual(doc.registries, [{ fullName: '', krs: '0000123456', regon: '123456789', bdo: '000012345' }])
    assert.deepEqual(doc.extra, [], 'wszystkie pola fikstury są obsłużone')
  })

  test('HTML: nagłówek, strony, pozycje, podsumowanie, płatność, stopka', () => {
    const { html, title } = buildKsefInvoiceHtml(FA2_STANDARD, meta)
    assertClean(html)
    assert.equal(title, 'Faktura FV/12/2026')
    assert.ok(html.includes('<title>Faktura FV/12/2026</title>'))
    assert.ok(html.includes('Faktura VAT'))
    assert.ok(html.includes('<h1 class="docno">FV/12/2026</h1>'))
    assert.ok(html.includes('Numer KSeF'))
    assert.ok(html.includes('1111111111-20260310-ABCDEF123456-7A'))
    assert.ok(html.includes('Schemat FA (2)'))
    assert.ok(html.includes('<dt>Data wystawienia</dt><dd>10.03.2026</dd>'))
    assert.ok(html.includes('<dt>Miejsce wystawienia</dt><dd>Warszawa</dd>'))
    assert.ok(html.includes('<dt>Data dostawy / wykonania usługi</dt><dd>08.03.2026</dd>'))
    assert.ok(html.includes('<dt>Waluta</dt><dd>PLN</dd>'))

    const sellerBlock = between(html, '<h2>Sprzedawca</h2>', '<h2>Nabywca</h2>')
    assert.ok(sellerBlock.includes('Alfa Instalacje Sp. z o.o.'))
    assert.ok(sellerBlock.includes('1111111111'))
    assert.ok(sellerBlock.includes('ul. Testowa 1<br>00-001 Warszawa'))
    assert.ok(sellerBlock.includes('biuro@alfa.example'))
    assert.ok(!sellerBlock.includes('Beta Dom') && !sellerBlock.includes('2222222222'))
    const buyerBlock = between(html, '<h2>Nabywca</h2>', '<h2>Pozycje</h2>')
    assert.ok(buyerBlock.includes('Beta Dom Sp. z o.o.') && buyerBlock.includes('2222222222') && buyerBlock.includes('K-0042'))
    assert.ok(!buyerBlock.includes('Alfa Instalacje') && !buyerBlock.includes('1111111111'))
    assert.ok(!buyerBlock.includes('Polska') && !buyerBlock.includes('(PL)'), 'kraj PL nie jest wypisywany')

    const items = sectionOf(html, 'Pozycje')
    assert.ok(items.includes('Cena jedn. netto') && items.includes('Wartość netto') && items.includes('Stawka VAT'))
    assert.ok(!items.includes('Rabat'), 'rabat 0,00 nie tworzy kolumny')
    assert.ok(items.includes('Montaż sterownika'))
    assert.ok(items.includes('<td class="num">2</td>'), 'ilość 2.000 → 2')
    assert.ok(items.includes('<td class="num">12,5</td>'))
    assert.ok(items.includes('<td class="num">600,00</td>'))
    assert.ok(items.includes('<td class="num">8,04</td>'), 'cena 8.0400 → 8,04')
    assert.ok(items.includes('<td class="num">1 200,00</td>'))
    assert.ok(items.includes('<td class="num">23%</td>') && items.includes('<td class="num">8%</td>'))
    assert.ok(items.includes('Indeks: PRZ-01 · GTU: GTU_06'))

    const summary = sectionOf(html, 'Podsumowanie stawek VAT')
    assert.ok(summary.includes('<tr><td>23%</td><td class="num">1 200,00</td><td class="num">276,00</td><td class="num">1 476,00</td></tr>'))
    assert.ok(summary.includes('<tr><td>8%</td><td class="num">100,50</td><td class="num">8,04</td><td class="num">108,54</td></tr>'))
    assert.ok(summary.includes('<tr><td>Razem</td><td class="num">1 300,50</td><td class="num">284,04</td><td class="num">1 584,54</td></tr>'))
    assert.ok(!summary.includes('VAT w PLN'))
    assert.ok(!summary.includes('lub'), 'grupy opisane stawką faktycznie użytą w wierszach')
    assert.ok(summary.includes('Kwota należności ogółem</span><strong>1 584,54 PLN</strong>'))

    const payment = sectionOf(html, 'Płatność')
    assert.ok(payment.includes('<dt>Termin płatności</dt><dd>24.03.2026 (14 dni)</dd>'))
    assert.ok(payment.includes('<dt>Forma płatności</dt><dd>Przelew</dd>'))
    assert.ok(payment.includes('61 1090 1014 0000 0712 1981 2874'), 'NRB w grupach 2 + 6×4')
    assert.ok(payment.includes('Bank Testowy S.A. · SWIFT: TESTPLPW'))

    const notes = sectionOf(html, 'Adnotacje')
    assert.ok(notes.includes('Mechanizm podzielonej płatności'))
    assert.ok(!html.includes('Metoda kasowa') && !html.includes('Samofakturowanie') && !html.includes('Odwrotne obciążenie'))
    assert.ok(!html.includes('Procedura marży') && !html.includes('zwolnione od podatku'))

    const footer = sectionOf(html, 'Stopka')
    assert.ok(footer.includes('Kapitał zakładowy 5 000 zł'))
    assert.ok(footer.includes('<dt>KRS</dt><dd>0000123456</dd>') && footer.includes('<dt>REGON</dt><dd>123456789</dd>') && footer.includes('<dt>BDO</dt><dd>000012345</dd>'))

    assert.ok(html.includes('Wizualizacja faktury ustrukturyzowanej wygenerowana z pliku XML pobranego z KSeF. Dokumentem źródłowym jest faktura w KSeF (numer KSeF powyżej).'))
    assert.ok(html.includes('Data wytworzenia faktury: 10.03.2026 09:15 UTC · System wystawcy: Testowy ERP 1.0'))
    assert.ok(html.includes('Faktura zakupowa (otrzymana)'))
    assert.ok(!html.includes('Pozostałe dane z pliku XML'))
    for (const empty of ['Rozliczenie', 'Warunki transakcji', 'Dodatkowy opis', 'Dane faktury korygowanej', 'Zaliczki', 'Zamówienie / umowa']) {
      assert.ok(!html.includes(`<h2>${empty}</h2>`), `pusta sekcja „${empty}” nie powinna się pojawić`)
    }
  })

  test('druk A4: @page, powtarzany nagłówek tabeli, brak dzielenia wierszy, brak zasobów zewnętrznych', () => {
    const { html } = buildKsefInvoiceHtml(FA2_STANDARD, meta)
    assert.ok(html.includes('@page{size:A4;margin:12mm}'))
    assert.ok(html.includes('thead{display:table-header-group}'))
    assert.ok(html.includes('break-inside:avoid'))
    assert.ok(html.includes('overflow-wrap:anywhere'))
    assert.ok(html.includes('@media print'))
    assert.ok(!/url\(|@import|<link|<img|<iframe|<object|<embed|<form|<a\s/i.test(html))
    assert.ok(!/https?:\/\//i.test(html), 'żadnych adresów zewnętrznych w dokumencie tej faktury')
  })

  test('brak meta: nie ma numeru KSeF ani dopisku o nim; meta null jest dopuszczalne', () => {
    const { html, title } = buildKsefInvoiceHtml(FA2_STANDARD)
    assertClean(html)
    assert.equal(title, 'Faktura FV/12/2026')
    assert.ok(!html.includes('Numer KSeF'))
    assert.ok(html.includes('Dokumentem źródłowym jest faktura w KSeF.'))
    assert.ok(!html.includes('Faktura zakupowa') && !html.includes('Faktura sprzedażowa'))
    const viaNull = buildKsefInvoiceHtml(FA2_STANDARD, { ksefNumber: null, direction: null })
    assert.equal(viaNull.html, html)
    assert.equal(renderKsefInvoiceHtml(parseKsefInvoice(FA2_STANDARD), null), html)
    assert.ok(buildKsefInvoiceHtml(FA2_STANDARD, { direction: 'outgoing' }).html.includes('Faktura sprzedażowa (wystawiona)'))
  })
})

describe('faktura FA(3) — prefiks przestrzeni nazw na każdym elemencie', () => {
  test('model i HTML: schemat, okres, strukturalny opis terminu, warunki transakcji', () => {
    const doc = parseKsefInvoice(FA3_PREFIXED)
    assert.equal(doc.schema, 'FA (3)')
    assert.equal(doc.seller?.name, 'Epsilon Automatyka S.A.')
    assert.equal(doc.buyer?.name, 'Zeta Budownictwo Sp. k.')
    assert.deepEqual(doc.buyer?.notes, [], 'JST = 2 / GV = 2 → brak adnotacji')
    assert.equal(doc.periodFrom, '2026-04-01')
    assert.deepEqual(doc.payment?.terms, [{ date: '2026-05-30', description: '30 dni, zdarzenie początkowe: wystawienie faktury' }])
    assert.deepEqual(doc.terms?.contracts, [{ date: '2026-01-02', number: 'U/7/2026' }])
    assert.deepEqual(doc.annotations, [])
    assert.deepEqual(doc.extra, [])

    const { html, title } = buildKsefInvoiceHtml(FA3_PREFIXED, { ksefNumber: '4444444444-20260430-AAAAAABBBBBB-11' })
    assertClean(html)
    assert.equal(title, 'Faktura F/2026/04/0017')
    assert.ok(html.includes('Schemat FA (3)'))
    assert.ok(html.includes('<dt>Okres, którego dotyczy faktura</dt><dd>01.04.2026 – 30.04.2026</dd>'))
    assert.ok(!html.includes('Data dostawy / wykonania usługi'))
    assert.ok(between(html, '<h2>Sprzedawca</h2>', '<h2>Nabywca</h2>').includes('4444444444'))
    const payment = sectionOf(html, 'Płatność')
    assert.ok(payment.includes('30.05.2026 (30 dni, zdarzenie początkowe: wystawienie faktury)'))
    assert.ok(payment.includes('PL27 1140 2004 0000 3002 0135 5387'), 'IBAN w grupach po 4')
    const terms = sectionOf(html, 'Warunki transakcji')
    assert.ok(terms.includes('<dt>Umowa</dt><dd>U/7/2026 z dnia 02.01.2026</dd>'))
    assert.ok(terms.includes('<dt>Zamówienie</dt><dd>ZAM-991 z dnia 28.03.2026</dd>'))
    assert.ok(terms.includes('<dt>Warunki dostawy</dt><dd>DAP Wrocław</dd>'))
    assert.ok(!html.includes('<h2>Adnotacje</h2>'), 'żadna adnotacja nie dotyczy → brak sekcji')
    assert.ok(html.includes('Data wytworzenia faktury: 30.04.2026 12:00 +02:00'))
    const summary = sectionOf(html, 'Podsumowanie stawek VAT')
    assert.ok(summary.includes('<tr><td>23%</td><td class="num">2 500,00</td><td class="num">575,00</td><td class="num">3 075,00</td></tr>'))
    assert.ok(!summary.includes('Razem'), 'jedna grupa → bez wiersza Razem')
  })
})

describe('faktura korygująca (KOR)', () => {
  test('kwoty ujemne, dane faktury korygowanej, wiersz „stan przed korektą”', () => {
    const doc = parseKsefInvoice(KOR)
    assert.equal(doc.type, 'KOR')
    assert.equal(doc.correction?.reason, 'Zwrot części towaru')
    assert.deepEqual(doc.correction?.corrected, [{
      date: '2026-01-15', number: 'FV/5/2026', ksefNumber: '1111111111-20260115-0A1B2C3D4E5F-01', outsideKsef: false,
    }])
    assert.deepEqual(doc.lines.map(l => l.before), [true, false])
    assert.equal(doc.vatRows[0].gross, '-246.00')
    assert.deepEqual(doc.extra, [])

    const { html, title } = buildKsefInvoiceHtml(KOR, { ksefNumber: '1111111111-20260220-FFFFFF000000-02' })
    assertClean(html)
    assert.equal(title, 'Faktura korygująca KOR/3/2026')
    assert.ok(html.includes('<div class="doctype">Faktura korygująca</div>'))
    const corr = sectionOf(html, 'Dane faktury korygowanej')
    assert.ok(corr.includes('<dt>Przyczyna korekty</dt><dd>Zwrot części towaru</dd>'))
    assert.ok(corr.includes('Korekta skutkująca w dacie wystawienia faktury korygującej'))
    assert.ok(corr.includes('<td>FV/5/2026</td><td>15.01.2026</td><td>1111111111-20260115-0A1B2C3D4E5F-01</td>'))
    const items = sectionOf(html, 'Pozycje')
    assert.equal(count(items, '<tr class="before">'), 1)
    assert.equal(count(items, '<span class="tag">stan przed korektą</span>'), 1)
    assert.ok(items.indexOf('stan przed korektą') < items.indexOf('<td class="num">800,00</td>'))
    const summary = sectionOf(html, 'Podsumowanie stawek VAT')
    assert.ok(summary.includes('<tr><td>23%</td><td class="num">-200,00</td><td class="num">-46,00</td><td class="num">-246,00</td></tr>'))
    assert.ok(summary.includes('<strong>-246,00 PLN</strong>'))
  })

  test('faktura korygowana wystawiona poza KSeF + dane nabywcy przed korektą nie przeciekają do stron', () => {
    const xml = KOR
      .replace('<NrKSeF>1</NrKSeF>', '<NrKSeFN>1</NrKSeFN>')
      .replace('<NrKSeFFaKorygowanej>1111111111-20260115-0A1B2C3D4E5F-01</NrKSeFFaKorygowanej>', '')
      .replace('<FaWiersz>', '<Podmiot2K><DaneIdentyfikacyjne><NIP>9999999999</NIP><Nazwa>Stara Nazwa Nabywcy</Nazwa></DaneIdentyfikacyjne></Podmiot2K><FaWiersz>')
    const doc = parseKsefInvoice(xml)
    assert.equal(doc.buyer?.name, 'Beta Dom Sp. z o.o.')
    assert.equal(doc.correction?.buyersBefore[0].name, 'Stara Nazwa Nabywcy')
    assert.equal(doc.correction?.corrected[0].outsideKsef, true)
    const html = renderKsefInvoiceHtml(doc)
    assertClean(html)
    assert.ok(html.includes('faktura wystawiona poza KSeF'))
    assert.ok(!between(html, '<h2>Nabywca</h2>', '<h2>Dane faktury korygowanej</h2>').includes('Stara Nazwa'))
    assert.ok(sectionOf(html, 'Dane faktury korygowanej').includes('Nabywca — dane przed korektą'))
  })
})

describe('faktura w walucie obcej (EUR)', () => {
  test('waluta przy kwocie, kolumna „VAT w PLN”, wspólny kurs w nagłówku, identyfikator VAT UE', () => {
    const doc = parseKsefInvoice(EUR)
    assert.equal(doc.currency, 'EUR')
    assert.deepEqual(doc.seller?.ids, [{ label: 'NIP', value: 'PL 1111111111' }])
    assert.deepEqual(doc.buyer?.ids, [{ label: 'Nr VAT UE', value: 'DE123456789' }])
    assert.deepEqual(doc.vatRows, [{ key: '1', label: '23%', net: '1000.00', vat: '230.00', vatPln: '989.69', gross: '1230.00' }])
    assert.deepEqual(doc.extra, [])

    const { html } = buildKsefInvoiceHtml(EUR, { ksefNumber: '1111111111-20260505-ABCABCABCABC-0F' })
    assertClean(html)
    assert.ok(html.includes('<dt>Waluta</dt><dd>EUR</dd>'))
    assert.ok(html.includes('<dt>Kurs waluty</dt><dd>4,3030</dd>'))
    assert.ok(!sectionOf(html, 'Pozycje').includes('Kurs waluty'), 'wspólny kurs nie jest powtarzany w wierszach')
    const buyerBlock = between(html, '<h2>Nabywca</h2>', '<h2>Pozycje</h2>')
    assert.ok(buyerBlock.includes('Nr VAT UE:</span> <b>DE123456789</b>'))
    assert.ok(buyerBlock.includes('Musterstrasse 12<br>10115 Berlin<br>Niemcy (DE)'))
    const summary = sectionOf(html, 'Podsumowanie stawek VAT')
    assert.ok(summary.includes('<th class="num">VAT w PLN</th>'))
    assert.ok(summary.includes('<tr><td>23%</td><td class="num">1 000,00</td><td class="num">230,00</td><td class="num">1 230,00</td><td class="num">989,69</td></tr>'))
    assert.ok(summary.includes('<strong>1 230,00 EUR</strong>'))
    assert.ok(sectionOf(html, 'Płatność').includes('PL61 1090 1014 0000 0712 1981 2874'))
  })

  test('różne kursy w wierszach → kurs przy każdej pozycji, nie w nagłówku', () => {
    const xml = EUR.replace('<KursWaluty>4.3030</KursWaluty>', '<KursWaluty>4.2500</KursWaluty>') // tylko pierwszy wiersz
    assert.notEqual(xml, EUR)
    const html = buildKsefInvoiceHtml(xml).html
    assert.ok(!html.includes('<dt>Kurs waluty</dt>'))
    const items = sectionOf(html, 'Pozycje')
    assert.ok(items.includes('Kurs waluty: 4,2500') && items.includes('Kurs waluty: 4,3030'))
  })
})

describe('faktura zaliczkowa (ZAL)', () => {
  test('wiersze zamówienia w osobnej tabeli, stawka grupy z wiersza zamówienia, zapłacono', () => {
    const doc = parseKsefInvoice(ZAL)
    assert.equal(doc.type, 'ZAL')
    assert.equal(doc.lines.length, 0)
    assert.equal(doc.orderLines.length, 1)
    assert.equal(doc.orderLines[0].name, 'System sterowania oświetleniem')
    assert.equal(doc.orderValue, '6150.00')
    assert.equal(doc.vatRows[0].label, '23%')
    assert.equal(doc.vatRows[0].gross, '1000.00')
    assert.deepEqual(doc.extra, [])

    const { html, title } = buildKsefInvoiceHtml(ZAL, { ksefNumber: '1111111111-20260601-121212121212-AB' })
    assertClean(html)
    assert.equal(title, 'Faktura zaliczkowa ZAL/1/2026')
    assert.ok(html.includes('<div class="doctype">Faktura zaliczkowa</div>'))
    assert.ok(html.includes('<dt>Data otrzymania zapłaty</dt><dd>29.05.2026</dd>'), 'P_6 na zaliczkowej = data otrzymania zapłaty')
    assert.ok(!html.includes('Data dostawy / wykonania usługi'))
    assert.ok(!html.includes('<h2>Pozycje</h2>'), 'brak FaWiersz → brak pustej tabeli pozycji')
    const order = sectionOf(html, 'Zamówienie / umowa')
    assert.ok(order.includes('System sterowania oświetleniem'))
    assert.ok(order.includes('<td class="num">5 000,00</td>') && order.includes('<td class="num">1 150,00</td>'))
    assert.ok(order.includes('Kwota VAT'))
    assert.ok(order.includes('6 150,00 PLN'))
    const summary = sectionOf(html, 'Podsumowanie stawek VAT')
    assert.ok(summary.includes('<tr><td>23%</td><td class="num">813,01</td><td class="num">186,99</td><td class="num">1 000,00</td></tr>'))
    const payment = sectionOf(html, 'Płatność')
    assert.ok(payment.includes('<dt>Informacja o płatności</dt><dd>Zapłacono</dd>'))
    assert.ok(payment.includes('<dt>Data zapłaty</dt><dd>29.05.2026</dd>'))
  })
})

describe('bezpieczeństwo — treść faktury jest wroga', () => {
  const HOSTILE = `<Faktura>
  <Podmiot1><DaneIdentyfikacyjne><NIP>1111111111</NIP><Nazwa>Gamma &quot;Q&quot; &amp; Synowie &lt;b&gt;pogrubione&lt;/b&gt;</Nazwa></DaneIdentyfikacyjne>
    <Adres><KodKraju>PL</KodKraju><AdresL1>ul. &lt;img src=x onerror=alert(4)&gt; 1</AdresL1></Adres></Podmiot1>
  <Podmiot2><DaneIdentyfikacyjne><NIP>2222222222</NIP><Nazwa>O'Beta &#60;script&#62;alert(5)&#60;/script&#62;</Nazwa></DaneIdentyfikacyjne></Podmiot2>
  <Fa>
    <KodWaluty>PLN&lt;script&gt;</KodWaluty>
    <P_1>2026-01-01&lt;script&gt;alert(6)&lt;/script&gt;</P_1>
    <P_2>FV/1&lt;/title&gt;&lt;script&gt;alert(3)&lt;/script&gt;</P_2>
    <P_13_1>100.00&lt;script&gt;</P_13_1><P_14_1>23.00</P_14_1><P_15>&lt;svg onload=alert(7)&gt;</P_15>
    <RodzajFaktury>VAT</RodzajFaktury>
    <DodatkowyOpis><Klucz>&lt;script&gt;alert(8)&lt;/script&gt;</Klucz><Wartosc><![CDATA[<img src=x onerror=alert(2)> "cudzysłów" & 'apostrof' </td></tr></table><script>alert(9)</script>]]></Wartosc></DodatkowyOpis>
    <FaWiersz><NrWierszaFa>1&lt;script&gt;</NrWierszaFa><P_7>&lt;script&gt;alert(1)&lt;/script&gt;</P_7><P_8A>&lt;b&gt;szt&lt;/b&gt;</P_8A><P_8B>1&lt;i&gt;</P_8B>
      <P_9A>100.00</P_9A><P_11>100.00</P_11><P_12>23&lt;script&gt;</P_12><GTU>&lt;script&gt;gtu&lt;/script&gt;</GTU></FaWiersz>
    <Platnosc><LinkDoPlatnosci>javascript:alert(10)//&quot;&gt;&lt;a href=&quot;https://zly.example&quot;&gt;</LinkDoPlatnosci>
      <RachunekBankowy><NrRB>&lt;script&gt;alert(11)&lt;/script&gt;</NrRB></RachunekBankowy></Platnosc>
    <ZlosliwePole>&lt;script&gt;alert(12)&lt;/script&gt;</ZlosliwePole>
  </Fa>
  <Stopka><Informacje><StopkaFaktury>&lt;style&gt;body{display:none}&lt;/style&gt;&lt;/main&gt;</StopkaFaktury></Informacje></Stopka>
</Faktura>`
  const hostileMeta = { ksefNumber: '"><script>alert(13)</script>', direction: '<script>alert(14)</script>' }

  test('model trzyma wartości zdekodowane (surowe), render je escapuje', () => {
    const doc = parseKsefInvoice(HOSTILE)
    assert.equal(doc.lines[0].name, '<script>alert(1)</script>')
    assert.equal(doc.seller?.name, 'Gamma "Q" & Synowie <b>pogrubione</b>')
    assert.equal(doc.buyer?.name, "O'Beta <script>alert(5)</script>")
    assert.ok(doc.additional[0].value.startsWith('<img src=x onerror=alert(2)> "cudzysłów" & \'apostrof\''))

    const { html, title } = buildKsefInvoiceHtml(HOSTILE, hostileMeta)
    assertClean(html)
    assert.equal(title, 'Faktura FV/1</title><script>alert(3)</script>', 'tytuł wraca surowy — escapuje go dopiero HTML')
    assert.ok(html.includes('<title>Faktura FV/1&lt;/title&gt;&lt;script&gt;alert(3)&lt;/script&gt;</title>'))
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'))
    assert.ok(html.includes('Gamma &quot;Q&quot; &amp; Synowie &lt;b&gt;pogrubione&lt;/b&gt;'))
    assert.ok(html.includes('O&#39;Beta &lt;script&gt;alert(5)&lt;/script&gt;'))
    assert.ok(html.includes('&lt;img src=x onerror=alert(2)&gt; &quot;cudzysłów&quot; &amp; &#39;apostrof&#39; &lt;/td&gt;&lt;/tr&gt;&lt;/table&gt;&lt;script&gt;alert(9)&lt;/script&gt;'))
    assert.ok(html.includes('&quot;&gt;&lt;script&gt;alert(13)&lt;/script&gt;'), 'numer KSeF z meta też jest escapowany')
    assert.ok(html.includes('javascript:alert(10)//&quot;&gt;&lt;a href=&quot;https://zly.example&quot;&gt;'), 'link do płatności wyłącznie jako tekst')
    assert.ok(!html.includes('alert(14)'), 'nieznany kierunek nie jest wypisywany')
    assert.ok(html.includes('Fa › ZlosliwePole'))
    assert.ok(html.includes('&lt;style&gt;body{display:none}&lt;/style&gt;&lt;/main&gt;'))

    // po usunięciu szablonowych znaczników nie zostaje żaden „<” pochodzący z danych
    const tags = html.match(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g) ?? []
    const allowed = new Set(['html', 'head', 'meta', 'title', 'style', 'body', 'main', 'header', 'footer', 'section', 'div', 'span',
      'h1', 'h2', 'h3', 'p', 'b', 'strong', 'br', 'dl', 'dt', 'dd', 'ul', 'li', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td'])
    for (const t of tags) assert.ok(allowed.has(t.replace(/^<\/?/, '').toLowerCase()), `nieoczekiwany znacznik ${t}`)
    assert.equal(count(html, '<title>'), 1)
    assert.equal(count(html, '</main>'), 1)
    assert.equal(count(html, '<style>'), 1)
  })

  test('znaki sterujące z encji numerycznych są usuwane z HTML; klucze słowników nie sięgają prototypu', () => {
    const xml = `<Faktura><Podmiot3><DaneIdentyfikacyjne><Nazwa>Kappa</Nazwa></DaneIdentyfikacyjne><Rola>constructor</Rola></Podmiot3>
      <Fa><P_2>A&#x1F;B&#0;C</P_2><RodzajFaktury>toString</RodzajFaktury>
      <Platnosc><FormaPlatnosci>__proto__</FormaPlatnosci></Platnosc></Fa></Faktura>`
    const doc = parseKsefInvoice(xml)
    assert.equal(doc.typeLabel, 'Faktura')
    assert.equal(doc.otherParties[0].role, 'Rola constructor')
    assert.equal(doc.payment?.method, 'Forma płatności __proto__')
    const { html } = buildKsefInvoiceHtml(xml)
    assertClean(html)
    assert.ok(!html.includes('\u001f') && !html.includes('\u0000'))
    assert.ok(!html.includes('function') && !html.includes('[native code]') && !html.includes('[object'))
  })

  test('CSP: pełna polityka zaraz po <meta charset>, przed <title> i jakąkolwiek treścią z faktury', () => {
    const { html } = buildKsefInvoiceHtml(HOSTILE, hostileMeta)
    assert.ok(html.includes(`<head>\n<meta charset="utf-8">\n${CSP_META}\n`))
    assert.ok(html.indexOf(CSP_META) < html.indexOf('<title>'))
    assert.equal(count(html, 'Content-Security-Policy'), 1)
    for (const directive of [`default-src 'none'`, `style-src 'unsafe-inline'`, `base-uri 'none'`, `form-action 'none'`]) {
      assert.ok(CSP_META.includes(directive), directive)
    }
  })

  test('znaki sterujące kierunkiem tekstu (bidi) nie trafiają do dokumentu; rachunek zachowuje grupowanie', () => {
    // U+202E (RLO) odwraca na ekranie kolejność znaków aż do U+202C (PDF) — wydruk pokazałby inny numer niż XML
    const xml = `<Faktura>
      <Podmiot1><DaneIdentyfikacyjne><NIP>1111111111</NIP><Nazwa>Alfa &#x202E;ejcalatsnI&#x202C; Sp. z o.o.</Nazwa></DaneIdentyfikacyjne></Podmiot1>
      <Fa><KodWaluty>PLN</KodWaluty><P_2>B/&#x2067;1&#x2069;</P_2><P_15>100.00</P_15>
        <DodatkowyOpis><Klucz>Uwagi</Klucz><Wartosc>a&#x61C;b&#x200E;c&#x200F;d&#x202A;e&#x202B;f&#x202D;g&#x2066;h&#x2068;i</Wartosc></DodatkowyOpis>
        <Platnosc>
          <RachunekBankowy><NrRB>&#x202E;61109010140000071219812874&#x202C;</NrRB></RachunekBankowy>
          <RachunekBankowy><NrRB>\u202EPL27114020040000300201355387\u202C</NrRB></RachunekBankowy>
        </Platnosc></Fa></Faktura>`
    const doc = parseKsefInvoice(xml)
    assert.equal(doc.payment?.accounts[0].number, '\u202E61109010140000071219812874\u202C', 'model trzyma wartość z XML bez zmian')
    assert.equal(doc.seller?.name, 'Alfa \u202EejcalatsnI\u202C Sp. z o.o.')

    const { html } = buildKsefInvoiceHtml(xml)
    assertClean(html)
    assert.ok(!BIDI_RE.test(html), 'żaden znak bidi nie zostaje w HTML')
    const payment = sectionOf(html, 'Płatność')
    assert.ok(payment.includes('<b class="nw">61 1090 1014 0000 0712 1981 2874</b>'), 'NRB w zwykłej kolejności, w grupach 2 + 6×4')
    assert.ok(payment.includes('<b class="nw">PL27 1140 2004 0000 3002 0135 5387</b>'), 'IBAN w grupach po 4')
    assert.ok(html.includes('<div class="name">Alfa ejcalatsnI Sp. z o.o.</div>'))
    assert.ok(html.includes('<h1 class="docno">B/1</h1>'))
    assert.ok(html.includes('<title>Faktura B/1</title>'))
    assert.ok(html.includes('<td class="pre">abcdefghi</td>'))
  })

  test('ogromna nazwa elementu (1 MB XML, który dawał 100 MB HTML) jest odrzucana — szybko', () => {
    const name = 'N'.repeat(500_000)
    const xml = `<Faktura><Fa><P_2>F/1</P_2><${name}>${'<a>x</a>'.repeat(200)}</${name}></Fa></Faktura>`
    assert.ok(xml.length > 1_000_000)
    const started = Date.now()
    assert.equal(parseXml(xml), null)
    assert.throws(() => buildKsefInvoiceHtml(xml), KsefDocumentError)
    assert.ok(Date.now() - started < 1000, 'bez zawieszenia')
  })

  test('długie ścieżki w „Pozostałych danych” są przycinane od początku — dokument nie rośnie z głębokością', () => {
    // 100 poziomów × nazwa 120 znaków: bez limitu każdy z 200 wierszy niósłby ścieżkę ~12 KB (razem ~2,5 MB)
    const names = Array.from({ length: 100 }, (_, i) => `Poziom${String(i).padStart(3, '0')}_${'x'.repeat(110)}`)
    const open = names.map(n => `<${n}>`).join('')
    const close = [...names].reverse().map(n => `</${n}>`).join('')
    const leaves = Array.from({ length: 200 }, (_, i) => `<Pole${i}>w${i}</Pole${i}>`).join('')
    const xml = `<Faktura><Fa><P_2>F/1</P_2>${open}${leaves}${close}</Fa></Faktura>`
    const started = Date.now()
    const doc = parseKsefInvoice(xml)
    assert.equal(doc.extra.length, 200)
    assert.equal(doc.extraTruncated, false)
    for (const x of doc.extra) assert.ok(x.path.length <= 300, `ścieżka ma ${x.path.length} znaków`)
    assert.ok(doc.extra[0].path.startsWith('…'))
    assert.ok(doc.extra[0].path.endsWith(` › ${names[99]} › Pole0`), 'zostaje koniec ścieżki: rodzic i nazwa pola')
    assert.deepEqual(doc.extra.map(x => x.value), Array.from({ length: 200 }, (_, i) => `w${i}`))
    const { html } = buildKsefInvoiceHtml(xml)
    assertClean(html)
    assert.ok(html.length < 200_000, `HTML ma ${html.length} znaków`)
    assert.ok(Date.now() - started < 1000)
  })

  test('dokument większy niż 10 MB nie jest zwracany (KsefDocumentError → 422); zwykła duża faktura przechodzi', () => {
    const full = '<FaWiersz><NrWierszaFa>1</NrWierszaFa><P_7>Towar</P_7><P_8A>szt.</P_8A><P_8B>1</P_8B><P_9A>1.00</P_9A><P_10>0.10</P_10>'
      + '<P_11>1.00</P_11><P_11A>1.23</P_11A><P_11Vat>0.23</P_11Vat><P_12>23</P_12></FaWiersz>'
    const mk = (emptyRows: number) => `<Faktura><Fa><P_2>F/1</P_2>${full}${'<FaWiersz/>'.repeat(emptyRows)}</Fa></Faktura>`
    const started = Date.now()
    // 10 000 wierszy to górny limit schematu FA — taka faktura musi się zmieścić z zapasem
    const legit = buildKsefInvoiceHtml(mk(9_999))
    assert.ok(legit.html.length < 5 * 1024 * 1024, `HTML ma ${legit.html.length} znaków`)
    // 0,7 MB pustych wierszy → kilkanaście MB HTML
    const hostile = mk(60_000)
    assert.ok(hostile.length < 1_000_000)
    assert.throws(() => buildKsefInvoiceHtml(hostile), (err: unknown) => {
      assert.ok(err instanceof KsefDocumentError)
      assert.ok(err.message.length > 10)
      return true
    })
    assert.ok(Date.now() - started < 5000, 'bez zawieszenia')
  })

  test('więcej wierszy niż dopuszcza schemat FA (10 000) → odrzucenie już przy czytaniu, przed renderowaniem', () => {
    const row = '<FaWiersz><NrWierszaFa>1</NrWierszaFa><P_7>T</P_7><P_11>1.00</P_11><P_12>23</P_12></FaWiersz>'
    const mk = (n: number) => `<Faktura><Fa><P_2>F/1</P_2>${row.repeat(n)}</Fa></Faktura>`
    assert.equal(parseKsefInvoice(mk(10_000)).lines.length, 10_000)
    assert.throws(() => parseKsefInvoice(mk(10_001)), KsefDocumentError)
    const orderRow = '<ZamowienieWiersz><NrWierszaZam>1</NrWierszaZam><P_7Z>T</P_7Z></ZamowienieWiersz>'
    const zal = `<Faktura><Fa><P_2>Z/1</P_2><RodzajFaktury>ZAL</RodzajFaktury><Zamowienie>${orderRow.repeat(10_001)}</Zamowienie></Fa></Faktura>`
    assert.throws(() => parseKsefInvoice(zal), KsefDocumentError)
  })

  test('tytuł dokumentu (nagłówek okna, nazwa PDF) nie przenosi znaków sterujących kierunkiem tekstu', () => {
    const { title } = buildKsefInvoiceHtml('<Faktura><Fa><P_2>FV/\u202E1/2026\u202C</P_2></Fa></Faktura>')
    assert.equal(title, 'Faktura FV/1/2026')
  })
})

describe('inne podmioty (Podmiot3), rozliczenie, płatność — faktura „bogata”', () => {
  const doc = parseKsefInvoice(RICH)
  const html = renderKsefInvoiceHtml(doc, { ksefNumber: '1111111111-20260701-0000000000AA-01' })

  test('Podmiot3 nie przecieka do sprzedawcy / nabywcy; role opisane', () => {
    assertClean(html)
    assert.equal(doc.seller?.name, 'Alfa Instalacje Sp. z o.o.')
    assert.deepEqual(doc.seller?.ids, [{ label: 'NIP', value: '1111111111' }])
    assert.deepEqual(doc.seller?.notes, ['Podatnik w trakcie postępowania restrukturyzacyjnego'])
    assert.equal(doc.buyer?.name, 'Beta Dom Sp. z o.o.')
    assert.deepEqual(doc.buyer?.ids, [{ label: 'NIP', value: '2222222222' }])
    assert.equal(doc.otherParties.length, 2)
    assert.equal(doc.otherParties[0].name, 'Delta Faktoring S.A.')
    assert.equal(doc.otherParties[0].role, 'Faktor')
    assert.deepEqual(doc.otherParties[1].ids, [{ label: 'Identyfikator wewnętrzny', value: '2222222222-00017' }])
    assert.equal(doc.otherParties[1].role, 'Miejsce realizacji')

    const main = between(html, '<h2>Sprzedawca</h2>', '<h2>Inny podmiot — Faktor</h2>')
    assert.ok(main.includes('Alfa Instalacje') && main.includes('Beta Dom Sp. z o.o.'))
    assert.ok(!main.includes('Delta') && !main.includes('3333333333') && !main.includes('ul. Trzecia'))
    const others = between(html, '<h2>Inny podmiot — Faktor</h2>', '<h2>Pozycje</h2>')
    assert.ok(others.includes('Delta Faktoring S.A.') && others.includes('3333333333') && others.includes('ul. Trzecia 3, 90-003 Łódź'))
    assert.ok(others.includes('<h2>Inny podmiot — Miejsce realizacji</h2>'))
    assert.ok(others.includes('Udział:</span> 50%'))
  })

  test('Podmiot3 umieszczony PRZED Podmiot1 też nie przecieka (odczyt względem rodzica, nie „pierwsze trafienie”)', () => {
    const p3 = '<Podmiot3><DaneIdentyfikacyjne><NIP>7777777777</NIP><Nazwa>Sigma Odbiorca</Nazwa></DaneIdentyfikacyjne>'
      + '<Adres><KodKraju>CZ</KodKraju><AdresL1>Vymyšlená 1, Praha</AdresL1></Adres><Rola>2</Rola></Podmiot3>'
    const d = parseKsefInvoice(FA2_STANDARD.replace('<Podmiot1>', p3 + '<Podmiot1>'))
    assert.equal(d.seller?.name, 'Alfa Instalacje Sp. z o.o.')
    assert.equal(d.seller?.address?.countryCode, 'PL')
    assert.equal(d.buyer?.name, 'Beta Dom Sp. z o.o.')
    assert.equal(d.otherParties[0].name, 'Sigma Odbiorca')
    assert.equal(d.otherParties[0].role, 'Odbiorca')
    const h = renderKsefInvoiceHtml(d)
    assert.ok(!between(h, '<h2>Sprzedawca</h2>', '<h2>Inny podmiot — Odbiorca</h2>').includes('Sigma'))
    assert.ok(h.includes('Czechy (CZ)'))
  })

  test('liczby: separator tysięcy, zaokrąglenie kwot, precyzja cen, ilości bez zer, ceny brutto', () => {
    const items = sectionOf(html, 'Pozycje')
    assert.ok(items.includes('<th class="num">Cena jedn.</th>'), 'mieszane ceny netto/brutto → neutralny nagłówek')
    assert.ok(items.includes('<td class="num">823 045,20 <span class="sub-inline">netto</span></td>'))
    assert.ok(items.includes('<td class="num">12,30 <span class="sub-inline">brutto</span></td>'), 'P_9B 12.3 → 12,30 brutto')
    assert.ok(items.includes('<td class="num">200,12345 <span class="sub-inline">netto</span></td>'), 'cena zachowuje precyzję > 2 miejsc')
    assert.ok(items.includes('<td class="num">1,5</td>') && items.includes('<td class="num">0,25</td>'))
    assert.ok(items.includes('<th class="num">Rabat</th>') && items.includes('<td class="num">10,005</td>'), 'rabat 10.005 zachowuje precyzję (P_10 ma do 8 miejsc)')
    assert.ok(!items.includes('<td class="num">10,01</td>'))
    assert.ok(!items.includes('Cena jedn. brutto:'), 'wiersz z samą ceną netto albo samą brutto nie dostaje dopisku')
    assert.ok(items.includes('<td class="num">1 234 567,80</td>'))
    assert.ok(items.includes('<td class="num">zw</td>'))
    assert.ok(items.includes('<th class="num">Wartość netto</th>') && items.includes('<th class="num">Wartość brutto</th>'))
    assert.ok(items.includes('<th class="c-unit">J.m.</th>'))

    const summary = sectionOf(html, 'Podsumowanie stawek VAT')
    assert.ok(summary.includes('<tr><td>23%</td><td class="num">1 234 567,80</td><td class="num">283 950,59</td><td class="num">1 518 518,39</td></tr>'))
    assert.ok(summary.includes('<tr><td>zwolnione (zw)</td><td class="num">50,00</td><td class="num">—</td><td class="num">50,00</td></tr>'))
    assert.ok(summary.includes('<tr><td>Razem</td><td class="num">1 234 617,80</td><td class="num">283 950,59</td><td class="num">1 518 568,39</td></tr>'))
    assert.ok(summary.includes('<strong>1 518 568,39 PLN</strong>'))
  })

  test('rozliczenie, zapłaty częściowe, terminy, forma „inna”, rachunki, skonto, link jako tekst', () => {
    const settlement = sectionOf(html, 'Rozliczenie')
    assert.ok(settlement.includes('<td>Obciążenie: Kaucja za opakowania</td><td class="num">100,00 PLN</td>'))
    assert.ok(settlement.includes('<td>Suma odliczeń</td><td class="num">18,39 PLN</td>'))
    assert.ok(settlement.includes('<td>Do zapłaty</td><td class="num">1 518 650,00 PLN</td>'))

    const payment = sectionOf(html, 'Płatność')
    assert.ok(payment.includes('<dt>Informacja o płatności</dt><dd>Zapłacono częściowo</dd>'))
    assert.ok(payment.includes('<td>02.07.2026</td><td class="num">500 000,00 PLN</td>'))
    assert.ok(payment.includes('<dt>Terminy płatności</dt><dd>15.07.2026; 15.08.2026</dd>'))
    assert.ok(payment.includes('<dt>Forma płatności</dt><dd>Inna: Kompensata</dd>'))
    assert.ok(payment.includes('Rachunek bankowy:</span> <b class="nw">61 1090 1014 0000 0712 1981 2874</b>'))
    assert.ok(payment.includes('Bank Testowy S.A. · Rachunek VAT'))
    assert.ok(payment.includes('Rachunek bankowy faktora:</span> <b class="nw">27 1140 2004 0000 3002 0135 5387</b>'))
    assert.ok(payment.includes('<dt>Skonto — warunki</dt><dd>Zapłata w 7 dni</dd>') && payment.includes('<dt>Skonto — wysokość</dt><dd>2%</dd>'))
    assert.ok(payment.includes('<dt>Link do płatności</dt><dd>https://platnosci.example/p/abc?x=1&amp;y=2</dd>'))
  })

  test('adnotacje (tylko te, które dotyczą), dodatkowy opis, stopka wielowierszowa', () => {
    assert.deepEqual(doc.annotations, [
      'Metoda kasowa',
      'Mechanizm podzielonej płatności',
      'Dostawa towarów lub świadczenie usług zwolnione od podatku — przepis ustawy: art. 43 ust. 1 pkt 29 ustawy',
      'Faktura wystawiona do paragonu',
      'Podmioty powiązane (istniejące powiązania między nabywcą a dostawcą)',
    ])
    const notes = sectionOf(html, 'Adnotacje')
    assert.equal(count(notes, '<li>'), 5)
    assert.ok(!notes.includes('Samofakturowanie') && !notes.includes('Procedura marży') && !notes.includes('trójstronna'))
    assert.ok(sectionOf(html, 'Dodatkowy opis').includes('<td>Nr projektu</td><td class="pre">PRJ-2026-015</td>'))
    assert.ok(sectionOf(html, 'Stopka').includes('<p class="pre">Linia pierwsza\nLinia druga</p>'))
  })

  test('pola nieznane modelowi trafiają do „Pozostałe dane z pliku XML” (nic nie znika po cichu)', () => {
    assert.deepEqual(doc.extra, [
      { path: 'Fa › NoweNieznanePole', value: 'wartość spoza schematu' },
      { path: 'Fa › Platnosc › PoleZPrzyszlejWersji › Zagniezdzone', value: '123' },
    ])
    const extra = sectionOf(html, 'Pozostałe dane z pliku XML')
    assert.ok(extra.includes('<td class="path">Fa › NoweNieznanePole</td><td class="pre">wartość spoza schematu</td>'))
    assert.ok(extra.includes('Fa › Platnosc › PoleZPrzyszlejWersji › Zagniezdzone'))
    assert.equal(doc.extraTruncated, false)
    assert.ok(!extra.includes('Pokazano pierwsze'), 'lista w całości → bez dopisku o ucięciu')
  })

  test('ponad 200 nieznanych pól: lista jest ucinana i dokument mówi o tym wprost', () => {
    const mk = (n: number) =>
      `<Faktura><Fa><P_2>X/1</P_2>${Array.from({ length: n }, (_, i) => `<Nowe${i}>v${i}</Nowe${i}>`).join('')}</Fa></Faktura>`
    const cut = parseKsefInvoice(mk(260))
    assert.equal(cut.extra.length, 200)
    assert.equal(cut.extraTruncated, true)
    assert.deepEqual(cut.extra[0], { path: 'Fa › Nowe0', value: 'v0' })
    assert.deepEqual(cut.extra[199], { path: 'Fa › Nowe199', value: 'v199' })
    const html = renderKsefInvoiceHtml(cut)
    assertClean(html)
    const extra = sectionOf(html, 'Pozostałe dane z pliku XML')
    assert.ok(extra.includes('Pokazano pierwsze 200 pól — pozostałe dane są w pliku XML.'))
    assert.ok(extra.includes('<td class="pre">v199</td>') && !extra.includes('<td class="pre">v200</td>'))

    // dokładnie 200 pól → nic nie ucięto; 201 → już tak
    const exact = parseKsefInvoice(mk(200))
    assert.equal(exact.extra.length, 200)
    assert.equal(exact.extraTruncated, false)
    assert.ok(!renderKsefInvoiceHtml(exact).includes('Pokazano pierwsze'))
    const onePast = parseKsefInvoice(mk(201))
    assert.equal(onePast.extra.length, 200)
    assert.equal(onePast.extraTruncated, true)
  })
})

describe('pozostałe warianty schematu', () => {
  test('podsumowanie: wszystkie grupy P_13_x, opis „lub” gdy stawki nie da się ustalić z wierszy', () => {
    const xml = `<Faktura><Fa><KodWaluty>PLN</KodWaluty><P_2>S/1</P_2>
      <P_13_1>100.00</P_13_1><P_14_1>23.00</P_14_1>
      <P_13_2>100.00</P_13_2><P_14_2>8.00</P_14_2>
      <P_13_3>100.00</P_13_3><P_14_3>5.00</P_14_3>
      <P_13_6_1>10.00</P_13_6_1><P_13_6_2>20.00</P_13_6_2><P_13_6_3>30.00</P_13_6_3>
      <P_13_7>40.00</P_13_7><P_13_8>50.00</P_13_8><P_13_9>60.00</P_13_9><P_13_10>70.00</P_13_10><P_13_11>80.00</P_13_11>
      <P_15>696.00</P_15><RodzajFaktury>VAT</RodzajFaktury>
      <FaWiersz><P_7>A</P_7><P_11>50.00</P_11><P_12>23</P_12></FaWiersz>
      <FaWiersz><P_7>B</P_7><P_11>50.00</P_11><P_12>22</P_12></FaWiersz>
      <FaWiersz><P_7>C</P_7><P_11>100.00</P_11><P_12>7</P_12></FaWiersz>
      <FaWiersz><P_7>D</P_7><P_11>10.00</P_11><P_12>0 KR</P_12></FaWiersz>
      <FaWiersz><P_7>E</P_7><P_11>20.00</P_11><P_12>0 WDT</P_12></FaWiersz>
      <FaWiersz><P_7>F</P_7><P_11>50.00</P_11><P_12>np I</P_12></FaWiersz>
      <FaWiersz><P_7>G</P_7><P_11>70.00</P_11><P_12>oo</P_12></FaWiersz>
    </Fa></Faktura>`
    const doc = parseKsefInvoice(xml)
    assert.deepEqual(doc.vatRows.map(v => v.label), [
      '23% lub 22%', '7%', '5%', '0% (kraj)', '0% (WDT)', '0% (eksport)', 'zwolnione (zw)',
      'np. — poza terytorium kraju', 'np. — art. 100 ust. 1 pkt 4', 'odwrotne obciążenie (oo)', 'procedura marży',
    ])
    const html = renderKsefInvoiceHtml(doc)
    assertClean(html)
    const items = sectionOf(html, 'Pozycje')
    for (const label of ['23%', '22%', '7%', '0% (kraj)', '0% (WDT)', 'np. I', 'oo']) {
      assert.ok(items.includes(`<td class="num">${label}</td>`), `stawka ${label}`)
    }
    assert.ok(items.includes('<td class="c-lp">3</td>'), 'brak NrWierszaFa → numeracja kolejna')
    const summary = sectionOf(html, 'Podsumowanie stawek VAT')
    assert.ok(summary.includes('<tr><td>Razem</td><td class="num">660,00</td><td class="num">36,00</td><td class="num">696,00</td></tr>'))
  })

  test('nabywca bez NIP: identyfikator zagraniczny / brak identyfikatora; adres korespondencyjny', () => {
    const mk = (ident: string) => `<Faktura><Podmiot2><DaneIdentyfikacyjne>${ident}<Nazwa>Jan Testowy</Nazwa></DaneIdentyfikacyjne>
      <AdresKoresp><KodKraju>US</KodKraju><AdresL1>1 Sample Rd</AdresL1></AdresKoresp></Podmiot2><Fa><P_2>N/1</P_2></Fa></Faktura>`
    const foreign = parseKsefInvoice(mk('<KodKraju>US</KodKraju><NrID>98-7654321</NrID>'))
    assert.deepEqual(foreign.buyer?.ids, [{ label: 'Identyfikator podatkowy', value: '98-7654321 (US)' }])
    assert.equal(foreign.buyer?.address, null)
    assert.deepEqual(foreign.buyer?.corrAddress, { countryCode: 'US', lines: ['1 Sample Rd'], gln: '' })
    const none = parseKsefInvoice(mk('<BrakID>1</BrakID>'))
    assert.deepEqual(none.buyer?.ids, [{ label: '', value: 'Brak identyfikatora podatkowego' }])
    const html = renderKsefInvoiceHtml(none)
    assertClean(html)
    assert.ok(html.includes('Brak identyfikatora podatkowego'))
    assert.ok(html.includes('Adres korespondencyjny:</span> 1 Sample Rd<br>Stany Zjednoczone (US)'))
  })

  test('faktura opakowana w inny element główny też jest rozpoznawana', () => {
    const doc = parseKsefInvoice(`<Koperta><Meta>x</Meta><ns:Faktura xmlns:ns="urn:x"><ns:Fa><ns:P_2>W/1</ns:P_2></ns:Fa></ns:Faktura></Koperta>`)
    assert.equal(doc.number, 'W/1')
  })

  test('FA(3): załącznik z tabelą jest renderowany', () => {
    const xml = `<Faktura><Fa><P_2>Z/1</P_2></Fa><Zalacznik><BlokDanych><ZNaglowek>Zużycie energii</ZNaglowek>
      <MetaDane><ZKlucz>Punkt poboru</ZKlucz><ZWartosc>PPE-001</ZWartosc></MetaDane>
      <Tekst><Akapit>Rozliczenie za okres.</Akapit></Tekst>
      <Tabela><Opis>Odczyty</Opis><TNaglowek><Kol Typ="txt"><NKom>Strefa</NKom></Kol><Kol Typ="dec"><NKom>kWh</NKom></Kol></TNaglowek>
        <Wiersz><WKom>Dzienna</WKom><WKom>120</WKom></Wiersz><Wiersz><WKom>Nocna</WKom><WKom>80</WKom></Wiersz>
        <Suma><SKom>Razem</SKom><SKom>200</SKom></Suma></Tabela></BlokDanych></Zalacznik></Faktura>`
    const doc = parseKsefInvoice(xml)
    assert.deepEqual(doc.extra, [])
    const html = renderKsefInvoiceHtml(doc)
    assertClean(html)
    const att = sectionOf(html, 'Załącznik do faktury')
    assert.ok(att.includes('<h3>Zużycie energii</h3>'))
    assert.ok(att.includes('<dt>Punkt poboru</dt><dd>PPE-001</dd>'))
    assert.ok(att.includes('<th>Strefa</th><th>kWh</th>'))
    assert.ok(att.includes('<tr><td>Nocna</td><td>80</td></tr>'))
    assert.ok(att.includes('<tfoot><tr><td>Razem</td><td>200</td></tr></tfoot>'))
  })

  test('wiersz: rabat z pełną precyzją, cena brutto obok ceny netto, stawka OSS obok stawki podstawowej', () => {
    const xml = `<Faktura><Fa><KodWaluty>PLN</KodWaluty><P_2>W/9</P_2><RodzajFaktury>VAT</RodzajFaktury>
      <FaWiersz><NrWierszaFa>1</NrWierszaFa><P_7>Towar A</P_7><P_8B>1</P_8B><P_9A>100.00</P_9A><P_9B>123.4500</P_9B><P_10>0.125</P_10><P_11>99.88</P_11><P_12>23</P_12><P_12_XII>21</P_12_XII></FaWiersz>
      <FaWiersz><NrWierszaFa>2</NrWierszaFa><P_7>Towar B</P_7><Indeks>IDX-2</Indeks><P_8B>1</P_8B><P_9A>50.00</P_9A><P_10>0.004</P_10><P_11>50.00</P_11><P_12_XII>19.50</P_12_XII></FaWiersz>
      <FaWiersz><NrWierszaFa>3</NrWierszaFa><P_7>Towar C</P_7><P_8B>1</P_8B><P_9A>10.00</P_9A><P_10>4</P_10><P_11>6.00</P_11><P_12>np I</P_12><P_12_XII>21</P_12_XII></FaWiersz>
      <FaWiersz><NrWierszaFa>4</NrWierszaFa><P_7>Towar D</P_7><P_8B>1</P_8B><P_9A>10.00</P_9A><P_10>0.000</P_10><P_11>10.00</P_11><P_12>8</P_12></FaWiersz>
    </Fa></Faktura>`
    const doc = parseKsefInvoice(xml)
    assert.deepEqual(doc.extra, [])
    assert.equal(doc.lines[0].unitNet, '100.00')
    assert.equal(doc.lines[0].unitGross, '123.4500')
    const html = renderKsefInvoiceHtml(doc)
    assertClean(html)
    const items = sectionOf(html, 'Pozycje')

    // P_10: bez zaokrąglania do groszy (0.125 nie staje się 0,13, a 0.004 nie znika jako 0,00)
    assert.ok(items.includes('<td class="num">0,125</td>'))
    assert.ok(items.includes('<td class="num">0,004</td>'))
    assert.ok(items.includes('<td class="num">4,00</td>'), 'rabat całkowity dostaje 2 miejsca')
    assert.ok(!items.includes('<td class="num">0,13</td>') && !items.includes('<td class="num">0,00</td>'))

    // P_9A i P_9B w jednym wierszu: kolumna pokazuje netto, brutto trafia do opisu pozycji
    assert.ok(items.includes('<th class="num">Cena jedn. netto</th>'))
    assert.ok(items.includes('<td class="num">100,00</td>'))
    assert.ok(items.includes('<div class="sub">Cena jedn. brutto: 123,45</div>'))
    assert.ok(items.includes('<div class="sub">Indeks: IDX-2</div>'), 'wiersz bez P_9B — opis bez ceny brutto')
    assert.equal(count(items, 'Cena jedn. brutto:'), 1)

    // P_12 i P_12_XII: obie stawki, żadna nie znika
    assert.ok(items.includes('<td class="num">23% · 21% (OSS)</td>'))
    assert.ok(items.includes('<td class="num">19,5% (OSS)</td>'), 'sama stawka OSS — jak dotąd')
    assert.ok(items.includes('<td class="num">np. I · 21% (OSS)</td>'))
    assert.ok(items.includes('<td class="num">8%</td>'), 'sama stawka podstawowa — jak dotąd')

    // to samo w wierszach zamówienia (P_12Z + P_12Z_XII)
    const order = buildKsefInvoiceHtml(`<Faktura><Fa><P_2>Z/2</P_2><RodzajFaktury>ZAL</RodzajFaktury><Zamowienie>
      <ZamowienieWiersz><NrWierszaZam>1</NrWierszaZam><P_7Z>Usługa</P_7Z><P_11NettoZ>100.00</P_11NettoZ><P_12Z>23</P_12Z><P_12Z_XII>20</P_12Z_XII></ZamowienieWiersz>
    </Zamowienie></Fa></Faktura>`).html
    assert.ok(sectionOf(order, 'Zamówienie / umowa').includes('<td class="num">23% · 20% (OSS)</td>'))
  })

  test('P_6A w wierszu: na fakturze zaliczkowej (ZAL / KOR_ZAL) to data otrzymania zapłaty', () => {
    const mk = (type: string) => `<Faktura><Fa><KodWaluty>PLN</KodWaluty><P_2>D/1</P_2><P_6>2026-03-11</P_6><RodzajFaktury>${type}</RodzajFaktury>
      <FaWiersz><NrWierszaFa>1</NrWierszaFa><P_7>Zaliczka na dostawę</P_7><P_6A>2026-03-12</P_6A><P_11>100.00</P_11><P_12>23</P_12></FaWiersz></Fa></Faktura>`
    for (const type of ['ZAL', 'KOR_ZAL']) {
      const html = buildKsefInvoiceHtml(mk(type)).html
      assertClean(html)
      assert.ok(html.includes('<dt>Data otrzymania zapłaty</dt><dd>11.03.2026</dd>'), `${type}: nagłówek`)
      const items = sectionOf(html, 'Pozycje')
      assert.ok(items.includes('<div class="sub">Data otrzymania zapłaty: 12.03.2026</div>'), `${type}: wiersz`)
      assert.ok(!html.includes('Data dostawy'), `${type}: nagłówek i wiersz mówią to samo`)
    }
    for (const type of ['VAT', 'KOR', 'ROZ', 'KOR_ROZ']) {
      const items = sectionOf(buildKsefInvoiceHtml(mk(type)).html, 'Pozycje')
      assert.ok(items.includes('<div class="sub">Data dostawy / wykonania: 12.03.2026</div>'), type)
      assert.ok(!items.includes('Data otrzymania zapłaty'), type)
    }
  })

  test('transport: GLN adresów wysyłki i przewoźnika jest wypisywany', () => {
    const xml = `<Faktura><Fa><P_2>T/1</P_2><WarunkiTransakcji><Transport><RodzajTransportu>3</RodzajTransportu>
      <Przewoznik><DaneIdentyfikacyjne><NIP>6666666666</NIP><Nazwa>Trans Test Sp. z o.o.</Nazwa></DaneIdentyfikacyjne>
        <AdresPrzewoznika><KodKraju>PL</KodKraju><AdresL1>ul. Bazowa 2</AdresL1><GLN>5900000000004</GLN></AdresPrzewoznika></Przewoznik>
      <WysylkaZ><KodKraju>PL</KodKraju><AdresL1>Magazyn A</AdresL1><GLN>5900000000011</GLN></WysylkaZ>
      <WysylkaPrzez><KodKraju>CZ</KodKraju><AdresL1>Sklad B</AdresL1><GLN>5900000000028</GLN></WysylkaPrzez>
      <WysylkaPrzez><KodKraju>PL</KodKraju><AdresL1>Hub D</AdresL1></WysylkaPrzez>
      <WysylkaDo><KodKraju>DE</KodKraju><AdresL1>Lager C</AdresL1><AdresL2>10115 Berlin</AdresL2><GLN>5900000000035</GLN></WysylkaDo>
    </Transport></WarunkiTransakcji></Fa></Faktura>`
    const doc = parseKsefInvoice(xml)
    assert.deepEqual(doc.extra, [])
    assert.deepEqual(doc.terms?.transports, [[
      { label: 'Rodzaj transportu', value: 'Transport drogowy' },
      { label: 'Przewoźnik', value: 'Trans Test Sp. z o.o., NIP 6666666666, ul. Bazowa 2, GLN: 5900000000004' },
      { label: 'Wysyłka z', value: 'Magazyn A, GLN: 5900000000011' },
      { label: 'Wysyłka przez', value: 'Sklad B, Czechy (CZ), GLN: 5900000000028' },
      { label: 'Wysyłka przez', value: 'Hub D' },
      { label: 'Wysyłka do', value: 'Lager C, 10115 Berlin, Niemcy (DE), GLN: 5900000000035' },
    ]])
    const html = renderKsefInvoiceHtml(doc)
    assertClean(html)
    const terms = sectionOf(html, 'Warunki transakcji')
    assert.ok(terms.includes('<dt>Wysyłka z</dt><dd>Magazyn A, GLN: 5900000000011</dd>'))
    for (const gln of ['5900000000004', '5900000000011', '5900000000028', '5900000000035']) assert.ok(terms.includes(`GLN: ${gln}`), gln)
  })

  test('faktury zaliczkowe: numer KSeF bez dopisku, faktura wystawiona poza KSeF z dopiskiem „(poza KSeF)”', () => {
    const xml = `<Faktura><Fa><KodWaluty>PLN</KodWaluty><P_2>ROZ/1</P_2><RodzajFaktury>ROZ</RodzajFaktury>
      <FakturaZaliczkowa><NrKSeFZN>1</NrKSeFZN><NrFaZaliczkowej>ZAL/7</NrFaZaliczkowej></FakturaZaliczkowa>
      <FakturaZaliczkowa><NrKSeFFaZaliczkowej>1111111111-20260601-121212121212-AB</NrKSeFFaZaliczkowej></FakturaZaliczkowa>
      <FakturaZaliczkowa><NrFaZaliczkowej>ZAL/8</NrFaZaliczkowej></FakturaZaliczkowa>
      <FakturaZaliczkowa><NrKSeFZN>1</NrKSeFZN></FakturaZaliczkowa>
    </Fa></Faktura>`
    const doc = parseKsefInvoice(xml)
    assert.deepEqual(doc.advanceInvoices, [
      'ZAL/7 (poza KSeF)',
      '1111111111-20260601-121212121212-AB',
      'ZAL/8 (poza KSeF)',
    ], 'sam znacznik bez numeru nie tworzy pozycji')
    assert.deepEqual(doc.extra, [])
    const html = renderKsefInvoiceHtml(doc)
    assertClean(html)
    assert.ok(sectionOf(html, 'Zaliczki').includes(
      'Faktury zaliczkowe:</span> ZAL/7 (poza KSeF), 1111111111-20260601-121212121212-AB, ZAL/8 (poza KSeF)</div>'))
  })

  test('podsumowanie: P_13_5 / P_14_5 to procedura szczególna OSS (nie IOSS)', () => {
    const doc = parseKsefInvoice('<Faktura><Fa><KodWaluty>EUR</KodWaluty><P_2>O/1</P_2><P_13_5>100.00</P_13_5><P_14_5>19.00</P_14_5><P_15>119.00</P_15></Fa></Faktura>')
    assert.deepEqual(doc.vatRows, [{ key: '5', label: 'procedura szczególna (OSS)', net: '100.00', vat: '19.00', vatPln: '', gross: '119.00' }])
    const html = renderKsefInvoiceHtml(doc)
    assertClean(html)
    assert.ok(sectionOf(html, 'Podsumowanie stawek VAT').includes(
      '<tr><td>procedura szczególna (OSS)</td><td class="num">100,00</td><td class="num">19,00</td><td class="num">119,00</td></tr>'))
    assert.ok(!html.includes('IOSS'))
  })
})

describe('błędne wejście → KsefDocumentError', () => {
  const cases: [string, string][] = [
    ['pusty tekst', ''],
    ['same białe znaki', '  \n '],
    ['zwykły tekst', 'Invoice not found'],
    ['JSON z błędem', '{"exception":{"serviceCode":"x"}}'],
    ['HTML strony błędu', '<html><head><title>502</title></head><body><h1>Bad Gateway</h1></body></html>'],
    ['XML, ale nie faktura', '<?xml version="1.0"?><UPO><Numer>1</Numer></UPO>'],
    ['Faktura bez Fa', '<Faktura><Naglowek/><Podmiot1/></Faktura>'],
    ['ucięty w połowie', FA2_STANDARD.slice(0, Math.floor(FA2_STANDARD.length / 2))],
    ['ucięty tuż przed końcem', FA2_STANDARD.trimEnd().slice(0, -3)],
    ['niesparowane znaczniki', '<Faktura><Fa><P_2>x</P_3></Fa></Faktura>'],
    ['głębokie zagnieżdżenie', '<Faktura>' + '<Fa>'.repeat(100_000)],
  ]
  for (const [name, xml] of cases) {
    test(name, () => {
      const started = Date.now()
      assert.throws(() => buildKsefInvoiceHtml(xml, { ksefNumber: 'X' }), (err: unknown) => {
        assert.ok(err instanceof KsefDocumentError)
        assert.ok(err instanceof Error)
        assert.equal(err.name, 'KsefDocumentError')
        assert.ok(err.message.length > 10)
        return true
      })
      assert.ok(Date.now() - started < 2000, 'bez zawieszenia')
    })
  }

  test('wartości nie-tekstowe też dają KsefDocumentError', () => {
    for (const v of [undefined, null, 42, {}, Buffer.from('<Faktura/>')]) {
      assert.throws(() => parseKsefInvoice(v as unknown as string), KsefDocumentError)
    }
  })

  test('formatowanie liczb z NAPISÓW: zaokrąglenia, znak, zera wiodące, bez artefaktów float', () => {
    const total = (v: string) => {
      const html = buildKsefInvoiceHtml(`<Faktura><Fa><KodWaluty>PLN</KodWaluty><P_15>${v}</P_15></Fa></Faktura>`).html
      return between(html, '<strong>', '</strong>').slice('<strong>'.length)
    }
    const expected: [string, string][] = [
      ['9.995', '10,00 PLN'], ['0.005', '0,01 PLN'], ['0.004', '0,00 PLN'], ['-0.004', '0,00 PLN'], ['-0.005', '-0,01 PLN'],
      ['-1234.5', '-1 234,50 PLN'], ['1000', '1 000,00 PLN'], ['999', '999,00 PLN'], ['.5', '0,50 PLN'], ['007.10', '7,10 PLN'],
      ['+12.3', '12,30 PLN'], ['1234567890123.45', '1 234 567 890 123,45 PLN'], ['-0', '0,00 PLN'], [' 12.345 ', '12,35 PLN'],
      ['2.675', '2,68 PLN'], ['1.005', '1,01 PLN'],
    ]
    for (const [raw, shown] of expected) assert.equal(total(raw), shown, `P_15 = ${JSON.stringify(raw)}`)

    // brutto grupy = netto + VAT liczone dziesiętnie (0.1 + 0.2 = 0.30, nie 0.30000000000000004)
    const doc = parseKsefInvoice(`<Faktura><Fa><P_13_1>0.1</P_13_1><P_14_1>0.2</P_14_1><P_13_2>-10.105</P_13_2><P_14_2>-0.81</P_14_2>
      <P_13_3>99999999999999.99</P_13_3><P_14_3>0.01</P_14_3></Fa></Faktura>`)
    assert.deepEqual(doc.vatRows.map(v => v.gross), ['0.3', '-10.915', '100000000000000.00'])
    const summary = sectionOf(renderKsefInvoiceHtml(doc), 'Podsumowanie stawek VAT')
    assert.ok(summary.includes('<td class="num">0,10</td><td class="num">0,20</td><td class="num">0,30</td>'))
    assert.ok(summary.includes('<td class="num">-10,11</td><td class="num">-0,81</td><td class="num">-10,92</td>'))
    assert.ok(summary.includes('<td class="num">100 000 000 000 000,00</td>'))
  })

  test('liczby-pułapki (bardzo długie / nieliczbowe) nie wieszają formatowania i są wypisywane dosłownie', () => {
    const big = '9'.repeat(200_000)
    const xml = `<Faktura><Fa><KodWaluty>PLN</KodWaluty><P_2>L/1</P_2><P_13_1>${big}</P_13_1><P_14_1>abc</P_14_1><P_15>1e5</P_15>
      <FaWiersz><P_7>X</P_7><P_8B>${'0'.repeat(100_000)}1</P_8B><P_9A>--5</P_9A><P_11>12,5</P_11><P_12>23</P_12></FaWiersz></Fa></Faktura>`
    const started = Date.now()
    const { html } = buildKsefInvoiceHtml(xml)
    assert.ok(Date.now() - started < 2000)
    assertClean(html)
    assert.ok(html.includes('<td class="num">abc</td>'))
    assert.ok(html.includes('<strong>1e5 PLN</strong>'))
    assert.ok(html.includes('<td class="num">--5</td>'))
    assert.ok(html.includes('<td class="num">12,50</td>'), 'przecinek dziesiętny w XML jest tolerowany')
  })
})

describe('faktura minimalna — żadnych „undefined” / „NaN” / „null”, żadnych pustych sekcji', () => {
  test('tylko numer faktury', () => {
    const { html, title } = buildKsefInvoiceHtml('<Faktura><Fa><P_2>1/2026</P_2></Fa></Faktura>')
    assertClean(html)
    assert.equal(title, 'Faktura 1/2026')
    assert.ok(html.includes('<h1 class="docno">1/2026</h1>'))
    assert.equal(count(html, '<section'), 0, 'brak danych → brak sekcji')
    assert.equal(count(html, '<table'), 0)
    assert.equal(count(html, '<dl'), 0)
    assert.ok(!html.includes('<h2>'))
  })

  test('pusty element Fa i brak numeru → tytuł z numeru KSeF albo sam „Faktura”', () => {
    const empty = buildKsefInvoiceHtml('<Faktura><Fa/></Faktura>')
    assertClean(empty.html)
    assert.equal(empty.title, 'Faktura')
    assert.ok(!empty.html.includes('<h1'))
    const withKsef = buildKsefInvoiceHtml('<Faktura><Fa></Fa></Faktura>', { ksefNumber: ' 1111111111-20260101-AAAAAAAAAAAA-01 ' })
    assert.equal(withKsef.title, 'Faktura 1111111111-20260101-AAAAAAAAAAAA-01')
    assertClean(withKsef.html)
  })

  test('wymagane pola FA(2) bez sekcji opcjonalnych; puste elementy opcjonalne nie tworzą sekcji', () => {
    const xml = `<Faktura xmlns="http://crd.gov.pl/wzor/2023/06/29/12648/">
      <Naglowek><KodFormularza kodSystemowy="FA (2)" wersjaSchemy="1-0E">FA</KodFormularza><WariantFormularza>2</WariantFormularza><DataWytworzeniaFa>2026-01-02T08:00:00Z</DataWytworzeniaFa></Naglowek>
      <Podmiot1><DaneIdentyfikacyjne><NIP>1111111111</NIP><Nazwa>Alfa Instalacje Sp. z o.o.</Nazwa></DaneIdentyfikacyjne><Adres><KodKraju>PL</KodKraju><AdresL1>ul. Testowa 1</AdresL1></Adres></Podmiot1>
      <Podmiot2><DaneIdentyfikacyjne><BrakID>1</BrakID></DaneIdentyfikacyjne></Podmiot2>
      <Fa><KodWaluty>PLN</KodWaluty><P_1>2026-01-02</P_1><P_2>MIN/1</P_2><P_15>0</P_15>
        ${ADNOTACJE_BRAK}
        <RodzajFaktury>UPR</RodzajFaktury>
        <Platnosc/><Rozliczenie></Rozliczenie><WarunkiTransakcji/><Zamowienie/><DodatkowyOpis/>
      </Fa><Stopka/></Faktura>`
    const doc = parseKsefInvoice(xml)
    assert.equal(doc.payment, null)
    assert.equal(doc.settlement, null)
    assert.equal(doc.terms, null)
    assert.equal(doc.correction, null)
    assert.deepEqual(doc.extra, [])
    const html = renderKsefInvoiceHtml(doc, {})
    assertClean(html)
    assert.ok(html.includes('Faktura uproszczona'))
    assert.ok(html.includes('<strong>0,00 PLN</strong>'))
    assert.ok(html.includes('<h2>Podsumowanie</h2>'))
    for (const s of ['Pozycje', 'Płatność', 'Rozliczenie', 'Warunki transakcji', 'Dodatkowy opis', 'Stopka', 'Adnotacje', 'Zamówienie / umowa']) {
      assert.ok(!html.includes(`<h2>${s}</h2>`), `pusta sekcja „${s}”`)
    }
    assert.equal(ksefInvoiceTitle(doc), 'Faktura MIN/1')
  })

  test('wszystkie fikstury renderują się czysto', () => {
    for (const xml of [FA2_STANDARD, FA3_PREFIXED, KOR, EUR, ZAL, RICH]) {
      assertClean(buildKsefInvoiceHtml(xml, { ksefNumber: '1111111111-20260101-AAAAAAAAAAAA-01', direction: 'incoming' }).html)
      assertClean(buildKsefInvoiceHtml(xml).html)
    }
  })
})
