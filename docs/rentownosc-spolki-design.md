# Rentowność spółki — projekt systemu (Finanse 2.0)

Cel: wiarygodny rachunek wyników miesięcznie i kwartalnie (z EBITDA), dostępny dla
admina i księgowego, zbudowany na trzech źródłach: **KSeF**, **MT940**, **rejestr
sprzedaży z Firmao** (Excel/PDF).

## 1. Co już mamy (fundamenty w kodzie)

| Element | Gdzie | Stan |
|---|---|---|
| Faktury kosztowe B2B z alokacjami w taksonomii CFO (`cogs`/`sales`/`ga`/`operations`/`financial` + podkategorie + `business_unit` shc/gatelynk/shared) | `KsefInvoiceAllocation`, `COST_TAXONOMY` w `ksef.ts` | działa |
| Faktury sprzedażowe B2B (outgoing) z KSeF | sync co 6 h | działa |
| Koszty bezfakturowe z MT940 (pensje, ZUS, VAT, CIT, leasing, opłaty bankowe…) z auto-klasyfikacją do tej samej taksonomii | `manual-costs.ts` | działa |
| Faktury B2C z modułu sprzedaży (dedupe po `ksef_number`) | `sales-invoices.ts`, ujęte w `/pnl` | działa |
| Statusy płatności + MT940 (kasa) | panel Płatności (`payables.ts`) | działa |
| P&L endpoint | `GET /api/ksef/pnl` (tylko admin) | do rozbudowy |

**Luka:** pełna sprzedaż (B2C spoza modułu — jest tylko w Firmao), formalny układ
RZiS z EBITDA, okresy M/Q/YTD, amortyzacja, dostęp księgowego, rozdział
memoriał/kasa, VAT błędnie traktowany jako koszt.

## 2. Zasady rachunkowe (żeby liczby były prawdziwe)

1. **Memoriał vs kasa — rozdzielone.** RZiS liczony memoriałowo po datach
   wystawienia/sprzedaży (KSeF, Firmao). Cash flow liczony kasowo z MT940.
   Nigdy nie mieszamy w jednej tabeli.
2. **Wszystko w kwotach NETTO.** VAT jest neutralny — `tax_vat` znika z RZiS
   (zostaje tylko w cash flow jako wypływ). Pensje/ZUS z MT940 nie mają VAT — brutto = koszt.
3. **VAT/CIT/odsetki poniżej EBITDA.** Obecna kategoria `financial` zawiera
   `tax_vat` (wyłączyć z RZiS), `tax_income` (linia CIT), `leasing`
   (operacyjny → OPEX; flaga na pozycji), `bank_fee`/odsetki (koszty finansowe).
4. **Jedno źródło prawdy dla przychodu: Firmao.** KSeF B2B i moduł B2C są
   podzbiorami — dedupe gwarantuje, że nic nie liczy się podwójnie.

## 3. Układ rachunku wyników (miesiąc / kwartał / YTD)

```
A. Przychody netto            = Firmao + KSeF B2B + moduł B2C  (po dedupe)
B. COGS                       = materiały, podwykonawcy, robocizna projektowa, cła
C. Marża brutto               = A − B          (+ %)
D. OPEX                       = sprzedaż/marketing + G&A (pensje, ZUS, czynsz) + operacje (auta, narzędzia)
E. EBITDA                     = C − D          (+ % marży EBITDA)
F. Amortyzacja (D&A)          = tabela środków trwałych (ręczna) — brak źródła w KSeF/MT940
G. EBIT                       = E − F
H. Koszty finansowe           = odsetki, prowizje bankowe, część odsetkowa leasingu
I. CIT                        = zaliczki z MT940 (prezentacja w miesiącu zapłaty, z adnotacją)
J. Wynik netto (szacunkowy)   = G − H − I
```

Wymiary: okres (M/Q/YTD/rok), `business_unit` (SHC / GateLynk / wspólne),
porównania m/m, r/r, trend 12 miesięcy.

## 4. Import rejestru sprzedaży z Firmao

- **Excel (preferowany):** deterministyczne dopasowanie kolumn jak w imporcie
  katalogu produktów — nr faktury, data sprzedaży, kontrahent, NIP (puste dla
  B2C), netto / VAT / brutto, forma płatności. Podgląd przed zapisem.
- **PDF (fallback):** parsowanie AI → tabela do zatwierdzenia (bez zapisu na ślepo).
- **Model:** `SalesRecord { id, source:'firmao', invoice_number, sale_date,
  buyer_name, buyer_nip, net, vat, gross, currency, period(YYYY-MM),
  dedup_status: 'unique'|'ksef_match'|'module_match'|'suspect', matched_id }`
- **Dedupe 3-poziomowy:** (1) znormalizowany numer faktury ↔ KSeF outgoing /
  moduł; (2) NIP + kwota brutto + miesiąc; (3) sama kwota + miesiąc →
  `suspect`, ręczna decyzja w UI. Zdeduplikowane rekordy nie wchodzą do
  przychodu (wchodzi wersja KSeF/moduł), ale są widoczne.
- **Zamknięcie miesiąca:** wgrany rejestr za miesiąc M ustawia badge
  „przychody M potwierdzone Firmao" — do tego czasu przychód M oznaczony jako wstępny.

## 5. Widoki (rozbudowa strony Finanse; dostęp: admin + 💳 księgowy)

1. **Rachunek wyników** — układ z pkt 3, wybór okresu, EBITDA % wyróżnione,
   trend 12 mies. (przychód / EBITDA), m/m i r/r.
2. **Kwartały** — tabela Q1–Q4 + YTD dla każdej linii RZiS.
3. **Business unit** — SHC vs GateLynk vs wspólne (alokacja kosztów wspólnych: bez podziału, jawna kolumna).
4. **Cash flow (kasa, MT940)** — wpływy / wypływy / saldo miesięcznie; osobno
   zapłacone VAT, ZUS, CIT; zestawienie z EBITDA (konwersja gotówkowa).
5. **Jakość danych** — licznik nieprzypisanych faktur KSeF, niesklasyfikowanych
   transakcji MT940, brakujących miesięcy Firmao, rozjazd Firmao↔KSeF B2B.
   To jest warunek wiarygodności — RZiS pokazuje obok wyniku „kompletność danych: 96%".
6. **Eksport XLSX** — RZiS + arkusze źródłowe (dla księgowej / zarządu).

## 6. Etapy budowy

| Etap | Zakres | Wartość |
|---|---|---|
| 1 | Model `SalesRecord` + import Firmao (Excel) z dedupe; przebudowa `/pnl` → pełny układ RZiS z EBITDA, okresy M/Q/YTD, poprawki VAT/CIT/leasing | kompletny, prawdziwy wynik miesięczny |
| 2 | UI Finanse 2.0 (RZiS, kwartały, trendy, business unit) + dostęp księgowego | codzienne narzędzie zarządu |
| 3 | Cash flow z MT940 + panel jakości danych + eksport XLSX | kontrola płynności i zaufanie do liczb |
| 4 | Tabela środków trwałych (amortyzacja) + import Firmao z PDF | pełny EBIT/wynik netto |

## 7. Decyzje do potwierdzenia

1. **Amortyzacja:** prowadzimy w systemie prostą tabelę środków trwałych
   (nazwa, wartość, okres, miesięczny odpis), czy księgowa podaje jedną kwotę miesięczną?
2. **Firmao:** potrzebny przykładowy eksport (Excel) — nagłówki kolumn ustawią parser.
3. **Dostęp:** księgowy = istniejąca flaga 💳 (`can_view_payments`) także dla
   Finansów, czy osobna flaga?
