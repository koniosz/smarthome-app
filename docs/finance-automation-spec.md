# Automatyzacja rentowności — spec implementacyjny (kontrakty dla agentów)

Repo: `smart-home-manager` (backend Express+Prisma/Postgres w `backend/`, frontend React+Vite+Tailwind w `frontend/`),
mobile: `../smart-home-mobile` (Expo SDK 54). Wszystkie komentarze i teksty UI **po polsku**. Styl: patrz istniejące pliki
(`backend/src/routes/finance.ts`, `frontend/src/pages/RentownoscPage.tsx`).

## Decyzje po przeglądzie (obowiązujące)
- Waluty obce z MT940 przeliczane na PLN przy imporcie (NBP, dzień poprzedzający); koszt bez kursu → `currency` oryginalna + `pnl_mode=exclude`; sumy RZiS pomijają `currency ≠ PLN`.
- Zmiana stanu magazynu w RZiS tylko dla `business_unit=all`; ruchy `initial` (bilans otwarcia) nie są cofane przy wycenie wstecz.
- Przelew z reguły `include` jest wykluczany, gdy jest płatnością za fakturę KSeF (BankTransaction.matched_invoice_id) lub odpowiada zatwierdzonemu dokumentowi; odrzucenie dokumentu przywraca `pnl_mode` wg reguły bankowej. PIT-4/PIT-8A → koszt pensji (`ga/salary_gross`), CIT → `tax_income`.
- Raport e-mail: `reports_enabled` domyślnie **false** — włącza admin w „Ustawieniach raportu” po sprawdzeniu liczb.

## Wspólne zasady

**Backend**
- Router: `import { Router, Request, Response } from 'express'`; `import db, { prisma } from '../db'` (Prisma client),
  `import { v4 as uuidv4 } from 'uuid'`; timestamps ISO `new Date().toISOString()`; błędy `res.status(4xx|500).json({ error: '…po polsku…' })`.
- Uprawnienia: `requireAuth` i `requireAdmin` z `../middleware/auth`; `requirePayments` (admin lub `can_view_payments`) eksportowany z `./payables`.
  Wszystko pod `/api` przechodzi już przez `requireAuth` (index.ts), więc `req.user` (`{id,email,role,...}`) zawsze jest (`(req as any).user`).
- Silnik RZiS: `backend/src/routes/finance.ts` eksportuje: `computePnlYear(year, bu='all'): Promise<PnlYear>`, `PnlLines`, `EMPTY_LINES()`,
  `sumLines()`, `finalizeLines()`, `monthsOf(year)`, `addMonths(period,n)`, `costLine(cost_category, subcategory)`,
  `includeManualCostInPnl(c)`, `MT940_SAFE_SUBCATEGORIES`, `depreciationForPeriod`, `plNumber`, `plDate`, `parseCsv`.
  `PnlLines` ma pola: revenue, revenue_firmao, revenue_ksef, revenue_module, revenue_advances, cogs, cogs_purchases, inventory_change,
  gross_margin, gross_margin_pct, opex, opex_sales, opex_ga, opex_operations, opex_leasing, ebitda, ebitda_pct, depreciation, ebit,
  financial_costs, cit, net_result, provisional (bool: brak importu Firmao = przychód wstępny).
  `PnlYear` = `{ year, business_unit, revenue_scope, months: (PnlLines & {period})[12], quarters: (PnlLines & {quarter:'Q1'..})[4], ytd, firmao_months, inventory_in_pnl, quality: {unallocated_ksef_invoices, suspect_sales_records, fixed_assets_count} }`.
  **Wszystkie kwoty RZiS są NETTO.** VAT nie jest kosztem. CIT poniżej EBIT.
- Taksonomia kategorii kosztów: `COST_TAXONOMY` w `backend/src/routes/ksef.ts` (KSeF) i `MANUAL_SUBCATEGORIES` w `backend/src/routes/manual-costs.ts`.
  Kategorie główne: `cogs | sales | ga | operations | financial`; business_unit: `shc | gatelynk | shared`.
- Modele Prisma (już w `backend/prisma/schema.prisma`, klient wygenerowany): `CompanySettings` (+company_name, reports_enabled, report_day,
  report_emails, cit_rate, inventory_in_pnl), `ManualCost` (+pnl_mode auto|include|exclude, bank_rule_id, document_id; source manual|mt940|document),
  `BankBalance`, `BankRule`, `CostDocument`, `ImapSettings`, `AccountantStatement`, `ReportDispatch`, oraz istniejące `KsefInvoice`,
  `KsefInvoiceAllocation`, `BankTransaction`, `SalesRecord` (Firmao; `paid` bool, `due_date`, `gross`), `SalesInvoice`, `WarehouseItem`,
  `StockMovement` (type in|out|initial|adjust, quantity, unit_price), `WarehouseDoc/Line`, `FixedAsset`, `User` (role, can_view_payments, email).
- E-mail: `getSmtpConfig()` z `../services/mailer` + `nodemailer.createTransport({host,port,secure: port===465,auth:{user,pass},tls:{rejectUnauthorized:false}})`,
  wzorzec: `sendDueInvoicesEmail` w `services/mailer.ts`. HTML e-maila: inline CSS, tabelki, bez zewnętrznych zasobów.
- AI: `@anthropic-ai/sdk` (`new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })`), wzorzec w `routes/ai-quotes.ts` (~linia 499).
  Model: `claude-sonnet-5`, a przy błędzie not_found/invalid model → fallback `claude-sonnet-4-5`. JSON parsuj przez `jsonrepair`.
- Testy: `node:test` w `backend/src/__tests__/<nazwa>.test.ts`, uruchamiane `cd backend && npx tsx --test src/__tests__/<plik>.test.ts`.
  Testuj logikę czystą (parsery, mapowania, wyceny) na fixture'ach — bez bazy.
- Sprawdzenie typów: `cd backend && npx tsc --noEmit -p .` — musi przechodzić.
- **NIE edytuj**: `backend/src/index.ts`, `backend/prisma/schema.prisma`, `frontend/src/api/client.ts`, `frontend/src/types/index.ts`,
  `frontend/src/App.tsx`, `frontend/src/components/layout/AppHeader.tsx` — integrację (mounty, trasy, menu) robi koordynator na podstawie
  Twojego raportu. Edytuj tylko pliki wymienione w Twojej sekcji.

**Frontend**
- `import { api } from '../api/client'` (axios z tokenem; 401 → logout). Własne API w nowym pliku wskazanym w sekcji (nie w client.ts).
- `import { useAuth } from '../auth/AuthContext'` → `user.role`, `user.can_view_payments`. Strona finansowa: dostęp `admin || can_view_payments`,
  inaczej komunikat „Brak dostępu…” jak w RentownoscPage.
- Tailwind z wariantami `dark:` wszędzie (tło strony `bg-[#f8fafc] dark:bg-gray-950`, karty `bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-800`,
  tekst `text-gray-800 dark:text-gray-100`, akcent violet-600). Ikony: `lucide-react`. Format PLN: `new Intl.NumberFormat('pl-PL',{minimumFractionDigits:2,maximumFractionDigits:2})`.
- Nawigacja: `useNavigate()` z react-router. Modale: `fixed inset-0 z-50 bg-black/40` + karta `rounded-2xl` (wzorzec: ManualCostModal w RentownoscPage).
- Sprawdzenie typów: `cd frontend && npx tsc --noEmit -p .` — musi przechodzić (błędy w NOWYCH i edytowanych plikach = Twoje).
- Język UI: prosty polski dla laika. Każda liczba ma podpis „co to znaczy”.

---

## A. „Kondycja firmy” — backend: health + raport e-mail + harmonogram

Pliki (nowe): `backend/src/services/finance-health.ts`, `backend/src/services/finance-report.ts`, `backend/src/services/report-scheduler.ts`,
`backend/src/routes/finance-health.ts`, test `backend/src/__tests__/finance-health.test.ts` (status/headline/checks na fixture'ach — wydziel czyste funkcje).

Router `finance-health.ts` (mount: `/api/finance`, `router.use(requirePayments)`):

`GET /health?period=YYYY-MM | YYYY-Qn` (domyślnie poprzedni miesiąc) → `HealthResponse`:
```ts
{
  kind: 'monthly'|'quarterly', period: '2026-08'|'2026-Q3', label: 'Sierpień 2026'|'III kwartał 2026',
  range: { from: 'YYYY-MM', to: 'YYYY-MM' },
  status: 'green'|'yellow'|'red',
  headline: string,   // np. „Sierpień 2026: zarobiliście 38 400 zł na czysto (marża 11 %).” / „…strata 12 300 zł.”
  subline: string,    // np. „Dane kompletne.” / „Brakuje wyciągu MT940 — wynik może być zawyżony.”
  complete: boolean,
  tiles: { revenue, costs, ebitda, ebitda_pct, net_result, cash: number|null, cash_date: string|null },
  lines: PnlLines,                       // suma za okres
  compare: { prev: Cmp|null, yoy: Cmp|null },   // Cmp = { label, revenue, costs, ebitda, ebitda_pct }
  trend: Array<{ period: 'YYYY-MM', label: 'Sie 26', revenue, costs, ebitda }>,  // 12 miesięcy kończących się na końcu okresu
  cost_breakdown: Array<{ key, label, amount, pct }>,  // top 6 podkategorii (netto) + { key:'other', label:'Pozostałe' }
  taxes: { vat_output, vat_input, vat_due_estimate, cit_rate, cit_base_ytd, cit_estimate_ytd, cit_paid_ytd, cit_to_pay_estimate, zus, note },
  checks: Array<{ key, severity: 'error'|'warn'|'info', message, count?: number, link?: string }>,
  cash: { balances: Array<{ account, currency, closing, date }>, total_pln: number|null, receivables, overdue_receivables, payables, overdue_payables },
  generated_at: string
}
```
Reguły:
- `costs = cogs + opex + depreciation + financial_costs` (bez CIT — CIT osobno w `taxes`). `net_result` z PnlLines.
- `status`: `red` gdy `ebitda < 0`; `yellow` gdy `ebitda ≥ 0` i (`!complete` lub `ebitda_pct < 5`); inaczej `green`.
- `compare.prev` = poprzedni miesiąc/kwartał; `yoy` = ten sam okres rok wcześniej (jeśli przychód > 0, inaczej null). Trend wymaga policzenia dwóch lat (`computePnlYear(year-1)`).
- `cost_breakdown`: z `KsefInvoiceAllocation` (netto = amount × net/gross faktury, tylko incoming, `costLine ≠ excluded`) + `ManualCost` (tylko `includeManualCostInPnl`, `costLine ≠ excluded`, bez `tax_income`) — po `subcategory`, etykiety z `COST_TAXONOMY`/`MANUAL_SUBCATEGORIES` (fallback: klucz).
- `taxes`: `vat_output` = Σ `vat_amount` KSeF outgoing w okresie (po `invoice_date`), `vat_input` = Σ incoming; `vat_due_estimate = vat_output − vat_input`.
  `cit_rate` z CompanySettings (domyślnie 9). `cit_base_ytd` = Σ (ebit − financial_costs) od stycznia do końca okresu (min 0);
  `cit_estimate_ytd = base × rate/100`; `cit_paid_ytd` = Σ ManualCost `subcategory='tax_income'` (included) YTD; `cit_to_pay_estimate = max(0, estimate − paid)`.
  `zus` = Σ `zus_employer` w okresie. `note`: „Szacunek — ostateczne kwoty liczy księgowa.”
- `checks` (klucz → severity → link): `mt940_missing` (error; miesiąc w zakresie bez żadnego `ManualCost source='mt940'` i bez `BankTransaction source='mt940'`; link `/platnosci`),
  `firmao_missing` (error; miesiąc `provisional`; `/rentownosc`), `ksef_unallocated` (warn; incoming bez alokacji w zakresie; count; `/finanse`),
  `cost_docs_pending` (warn; `CostDocument status in pending|error`; `/koszty-spoza-ksef`), `bank_review_pending` (warn; `BankTransaction review_status='pending'`; `/platnosci`),
  `accountant_missing` (info; brak `AccountantStatement` dla miesięcy zakresu; `/rentownosc`), `accountant_diff` (warn; |nasz wynik − wynik księgowej| > max(500, 5 % kosztów księgowej); `/rentownosc`),
  `inventory_docs_missing` (info; `cogs_purchases > 0` a brak `WarehouseDoc type='PZ'` w zakresie; `/magazyn`), `ksef_sync_stale` (info; najnowsza `KsefInvoice.created_at` starsza niż 3 dni; `/ksef`).
  `complete = brak checków 'error'`.
- `cash.balances`: najnowszy `BankBalance` per `account` (max date); `total_pln` = Σ closing kont PLN (null gdy brak sald).
  `receivables` = Σ `SalesRecord.gross` gdzie `paid=false` + Σ `SalesInvoice.total_gross` ze `status='issued'` bez `ksef_number` i nie zdeduplikowanych (`SalesRecord.dedup_status='module_match'` → `matched_id`);
  `overdue_receivables` = te z `due_date < dziś`. `payables` = Σ `gross_amount` KSeF incoming `payment_status ≠ 'paid'`; `overdue_payables` = z `payment_due_date < dziś`.
- `headline`/`subline` po polsku, liczby zaokrąglone do pełnych zł z separatorem tysięcy (`38 400 zł`), słowa: „zarobiliście”, „strata”, „marża”.

`GET /health/report-preview?kind=monthly|quarterly&period=` → `{ subject, html, complete, missing: string[] }` (ten sam HTML co e-mail).
`POST /health/report-send { kind, period, force?: boolean }` → `{ sent: boolean, status: 'sent'|'incomplete', recipients: string[] }` — jak w harmonogramie, `force` wysyła pełny raport mimo braków.
`GET /health/report-settings` → `{ company_name, reports_enabled, report_day, report_emails, cit_rate, inventory_in_pnl, log: ReportDispatch[] (ostatnie 12, desc) }`;
`PUT /health/report-settings` (**requireAdmin**) — walidacja: report_day 1–28, cit_rate 0–40, e-maile po przecinku z `@`.

`finance-report.ts`: `buildReportEmail(health: HealthResponse, companyName): { subject, html }` — sekcje: nagłówek ze statusem (kolor), zdanie
headline, 4 kafle (Przychód / Koszty / Zysk EBITDA / Gotówka), porównanie (poprz. okres, rok temu), „Na co idą pieniądze” (tabela top 6 z %),
„Podatki” (VAT do zapłaty szacunek, CIT szacunek, ZUS), „Do sprawdzenia” (lista checków), stopka „Raport wygenerowany automatycznie przez SHC Manager; liczby zarządcze, ostateczne — biuro rachunkowe.”
`buildIncompleteEmail(health)` — „Raport za X czeka na dane: … (lista error-checków z linkami)”. `sendReport(kind, period, opts:{force})` →
odbiorcy = e-maile `User role='admin'` ∪ `User can_view_payments=true` ∪ `CompanySettings.report_emails`; log do `ReportDispatch`.
Linki w mailu: `${process.env.APP_URL || 'https://smarthome-app-ssrv.onrender.com'}${check.link}`.

`report-scheduler.ts`: `export function startReportScheduler()` — pierwszy przebieg 6 min po starcie, potem co 60 min. Data wg `Europe/Warsaw`.
Jeśli `reports_enabled` i `dzień ≥ report_day`: okres miesięczny = poprzedni miesiąc; jeśli miesiąc ∈ {1,4,7,10} także kwartalny = poprzedni kwartał.
Dla każdego (kind, period): jeśli istnieje `ReportDispatch status='sent'` → nic; jeśli `complete` → wyślij pełny, log `sent`; jeśli nie
i brak logu `incomplete` → wyślij „brakuje danych”, log `incomplete`. Błędy → log `failed` (nie częściej niż raz dziennie per okres). Nigdy nie rzucaj — `console.error('[Raport]…')`.

Raport: `{ files_created, files_modified, mount_snippet (kod do index.ts: importy + app.use + start schedulera), notes, tests_run }`.

## B. Bank: salda MT940, ujednolicony import kosztów, reguły bankowe, prognoza gotówki

Pliki: `backend/src/utils/mt940Parser.ts` (edycja), `backend/src/services/mt940-costs.ts` (nowy), `backend/src/routes/payables.ts` (edycja tylko
handlera `POST /import-mt940`), `backend/src/routes/manual-costs.ts` (edycja: eksport `autoClassifyManual`, handler `POST /import-mt940` używa wspólnego serwisu),
`backend/src/routes/bank-rules.ts` (nowy), `backend/src/routes/cashflow.ts` (nowy), testy `backend/src/__tests__/mt940-balances.test.ts`, `bank-rules.test.ts`, `cashflow.test.ts`.

1. `mt940Parser.ts`: dodaj `parseMT940Statements(content): { transactions: ParsedTransaction[]; balances: StatementBalance[] }`.
   `StatementBalance = { account: string (z :25:, znormalizowany: same cyfry/litery, bez spacji i prefiksu „/”), currency, date: 'YYYY-MM-DD', opening, closing, statement_no (z :28C:) }`.
   `:60F:`/`:60M:` i `:62F:`/`:62M:` mają format `[CD]YYMMDD<CUR><kwota,gr>` (D = saldo ujemne). Jeden plik może mieć wiele wyciągów (bloki od `:20:`). Do `ParsedTransaction` dodaj opcjonalne `currency`, `account`.
   `parseMT940` zostaje (zwraca `.transactions`). Test z fixture mBank (wiele wyciągów, saldo D, `:60M:`).
2. `mt940-costs.ts`: `export async function upsertMt940Costs(transactions, opts?: { createdBy?: string }) → { created, skipped_existing, rules_applied }`.
   Koszt = transakcja `amount < 0` i `!is_reversal`. Klucz deduplikacji `date|abs(amount).toFixed(2)|reference` (gdy brak reference — `description.slice(0,60)`);
   porównuj z istniejącymi `ManualCost source='mt940'` (pole `reference` + `date` + `amount`; jednorazowe wczytanie). Kategoria z `autoClassifyManual(description, reference)`;
   następnie `applyBankRules(cost, rules)` (czysta funkcja, eksportowana): reguła pasuje gdy `pattern` (case-insensitive, bez polskich znaków diakrytycznych po obu stronach) zawiera się
   w `counterparty` / `description` / obu (`match_field`); pierwsza pasująca (sortuj: dłuższy pattern pierwszy). Trafienie → `cost_category, subcategory, business_unit, pnl_mode, bank_rule_id`, `hits++`.
   `amount` zapisuj dodatni, `pnl_mode` domyślnie `auto`, `description` = `counterparty · description` (≤ 500 znaków), `period` = `date.slice(0,7)`.
3. `payables.ts` `POST /import-mt940`: po istniejącej logice (BankTransaction + auto-match) wywołaj `parseMT940Statements` → upsert `BankBalance`
   (`upsert` po `[account,date,statement_no]`) i `upsertMt940Costs`. Do odpowiedzi dodaj `costs_created, costs_skipped, rules_applied, balances_saved`. Nie zmieniaj reszty handlera.
   `manual-costs.ts` `POST /import-mt940`: usuń lokalny parser, użyj `parseMT940Statements` + `upsertMt940Costs` (+ zapis sald). Zwracaj `{ total_parsed, outgoing, saved: created, skipped_existing, message }`.
4. `bank-rules.ts` (mount `/api/finance/bank-rules`, `router.use(requirePayments)`):
   `GET /` → `BankRule[]`; `POST /` `{ name, pattern, match_field?, cost_category, subcategory, business_unit?, pnl_mode? }` (pattern ≥ 3 znaki; 409 gdy identyczny pattern istnieje) → 201;
   `PUT /:id`; `DELETE /:id` (koszty z `bank_rule_id` = id → `bank_rule_id=null`, `pnl_mode='auto'`);
   `POST /apply { overwrite?: boolean }` → przepuszcza wszystkie `ManualCost source='mt940'` (bez `bank_rule_id`, a z `overwrite` wszystkie) przez reguły → `{ updated, by_rule: Record<ruleId, number> }`;
   `GET /unmatched?from=YYYY-MM&to=YYYY-MM` → wychodzące koszty MT940 w zakresie, które NIE wchodzą do RZiS (`!includeManualCostInPnl`) i nie są
   płatnością za fakturę KSeF (dopasuj do `BankTransaction` z `matched_invoice_id` po `transaction_date` + |amount| ± 0.01 + reference) →
   `Array<{ id, date, amount, description, reference, subcategory, cost_category, pnl_mode, suggested_pattern }>` (suggested_pattern = najdłuższe słowo ≥ 4 liter z kontrahenta/opisu bez cyfr), sort amount desc, max 300;
   `PATCH /cost/:id { pnl_mode?, cost_category?, subcategory?, business_unit? }` → jednorazowa decyzja dla przelewu (bez reguły).
5. `cashflow.ts` (mount `/api/finance/cashflow`, `router.use(requirePayments)`): `GET /?days=30` (7–90) →
   ```ts
   { as_of: 'YYYY-MM-DD', cash: { balances, total_pln: number|null }, has_balances: boolean,
     days: Array<{ date, inflow, outflow, balance, items: Array<{ kind: 'receivable'|'payable'|'recurring', label, amount }> }>,
     min: { date, balance }, end_balance: number, warnings: string[],
     receivables: Array<{ label, amount, due_date, overdue: boolean }>, payables: Array<{ label, amount, due_date, overdue: boolean }>,
     recurring: Array<{ label, amount, day_of_month, subcategory }> }
   ```
   Wpływy: `SalesRecord paid=false` (termin = `due_date` lub `sale_date`+14; przeterminowane → zakładamy wpływ za 7 dni) + `SalesInvoice status='issued'` (jw., bez zdeduplikowanych).
   Wypływy: KSeF incoming `payment_status ≠ 'paid'` (termin = `payment_due_date` lub `invoice_date`+14; przeterminowane → za 3 dni) + „stałe” = dla podkategorii
   `salary_gross, salary_admin, zus_employer, tax_vat, tax_income, rent, leasing` średnia z ostatnich 3 pełnych miesięcy `ManualCost source='mt940'` (mediana dnia miesiąca).
   `balance` startowe = `total_pln` (lub 0 + warning „Brak sald — wgraj wyciąg MT940”). `min` = najniższy balance; warning gdy `min.balance < 0` („Za N dni może zabraknąć gotówki”).
   Czyste funkcje (`projectCashflow(inputs)`) w tym samym pliku, testowane.

Raport: `{ files_created, files_modified, mount_snippet, notes, tests_run }`.

## C. Wycena magazynu i zmiana stanu zapasów

Pliki: `backend/src/services/inventory-valuation.ts` (zastąp STUB — zachowaj sygnatury), `backend/src/routes/inventory-valuation.ts` (nowy), test `backend/src/__tests__/inventory-valuation.test.ts`.

- Wartość zapasów na koniec miesiąca `P` = Σ po `WarehouseItem` (wszystkie magazyny, także „Projekty”): `qty_at(P) × cena_zakupu`, gdzie
  `qty_at(P) = item.quantity − Σ podpisanych ruchów `StockMovement` z `created_at > P-końcowy` (in: +qty; out: −qty; adjust: sprawdź w `routes/warehouse.ts`, jak zapisywana jest korekta — znak/ilość — i odwzoruj dokładnie).
  Ruchy `initial` (stan początkowy z formularza pozycji / importu Excel) to bilans otwarcia — **nie są cofane** (traktuj je jako istniejące „od zawsze”), więc zasilenie magazynu stanem otwarcia nie tworzy Δ w miesiącu wpisania (inaczej COGS tego miesiąca spadłby o całą wartość magazynu). Faktyczne zakupy przyjmuj przez PZ (`in`).
  Cena = `item.unit_price`; gdy 0 → `unit_price` ostatniego ruchu `in/initial` z ceną > 0; gdy nadal 0 → 0 (pozycja bez wyceny; policz `unpriced_items`).
  Ujemne `qty_at` traktuj jako 0. Czysta funkcja `computeValuation(items, movements, periods: string[]) → Map<period, { value, unpriced_items }>` + testy (ruchy przed/po końcu miesiąca, MM neutralne, brak ceny).
- `inventoryValueAt(period)` i `inventoryChangeByMonth(months)`: Δ(M) = value(M) − value(M−1) (dla pierwszego miesiąca policz M−1 dodatkowo). Zaokrąglaj do groszy. Gdy brak ruchów i pozycji → 0.
- Router (mount `/api/finance/inventory`, `requirePayments`): `GET /?year=YYYY` → `{ year, months: Array<{ period, value, change, unpriced_items }>, current_value, as_of }`.

Raport: `{ files_created, files_modified, mount_snippet, notes, tests_run }`.

## D. Skrzynka kosztów: dokumenty spoza KSeF (upload / e-mail IMAP / telefon) + odczyt AI + duplikaty + NBP

Pliki (nowe): `backend/src/services/nbp-rates.ts`, `backend/src/services/cost-extract.ts`, `backend/src/services/cost-duplicates.ts`,
`backend/src/services/cost-inbox-imap.ts`, `backend/src/routes/cost-documents.ts`, `backend/src/routes/settings-imap.ts`, testy `backend/src/__tests__/cost-duplicates.test.ts`, `cost-extract-parse.test.ts`.
Zależności są zainstalowane: `imapflow`, `mailparser` (+ `@types/mailparser`), `@anthropic-ai/sdk`, `jsonrepair`, `axios`, `multer`.

1. `nbp-rates.ts`: `getNbpRate(currency, docDate) → { rate, date }`. PLN → `{rate:1,date:docDate}`. Kurs średni NBP tabela A z **ostatniego dnia roboczego poprzedzającego** `docDate`:
   próbuj `https://api.nbp.pl/api/exchangerates/rates/a/{CUR}/{YYYY-MM-DD}/?format=json` od `docDate−1` cofając się do 10 dni (404 = brak tabeli tego dnia). Cache w pamięci. Timeout 8 s. Błąd → `{ rate: 0, date: '' }` (nie rzucaj).
2. `cost-extract.ts`: `extractCostDocument({ buffer, mimeType, fileName }) → Extracted` przez Anthropic Messages: PDF → blok `{ type:'document', source:{ type:'base64', media_type:'application/pdf', data } }`,
   obraz (jpeg/png/webp/gif) → `{ type:'image', source:{ type:'base64', media_type, data } }`. Prompt systemowy po polsku: odczytaj dokument kosztowy (faktura zagraniczna,
   faktura krajowa spoza KSeF, paragon, rachunek, nota) i zwróć **wyłącznie JSON**: `{ seller_name, seller_nip (same cyfry, '' gdy brak), seller_country (ISO-2), doc_number, doc_date (YYYY-MM-DD),
   currency (ISO-3), net, vat, gross, is_receipt (bool), description (≤120 zn., co kupiono), suggested_subcategory (jedna z podanej listy kluczy), confidence (0–1) }`.
   Lista podkategorii do promptu: `hardware, hardware_eu, hardware_noneu, import_duty, import_freight, import_agency, subcontractor, installation_material, software, utilities, rent, accounting, legal, office_supplies, car_fuel, car_service, insurance, travel, tools, marketing, other` z etykietami po polsku.
   Mapowanie subcategory → cost_category: hardware*/import*/subcontractor/installation_material → `cogs`; software/utilities/rent/accounting/legal/office_supplies/other → `ga`; car_*/insurance/travel/tools → `operations`; marketing → `sales`.
   Czysta funkcja `parseExtraction(text) → Extracted` (jsonrepair, walidacja/normalizacja liczb i dat, gross = net+vat gdy brak) — testowana. Brak `ANTHROPIC_API_KEY` → rzuć `Error('Brak ANTHROPIC_API_KEY')` (route ustawia status `error`).
3. `cost-duplicates.ts`: `findDuplicate(doc, ctx) → { duplicate_of, note } | null`, `ctx = { ksefIncoming: [{id, seller_nip, seller_name, invoice_number, gross_amount, invoice_date}], mt940Costs: [{id, date, amount, description, reference}], documents: [{id, seller_name, doc_number, gross_pln, status}] }`.
   Reguły: (a) KSeF: ten sam NIP (cyfry) i |gross_pln − gross_amount| ≤ 0.02, lub ten sam numer (alfanumerycznie) i zbieżność nazwy sprzedawcy → `ksef:<id>`;
   (b) MT940: |amount − gross_pln| ≤ max(2, 2 %) i wspólny token nazwy (≥4 litery) z description, data ±60 dni → `mt940:<id>` (nota: „prawdopodobnie ten sam koszt z wyciągu — po zatwierdzeniu przelew zostanie oznaczony jako duplikat”);
   (c) inny CostDocument (status ≠ rejected) z tym samym numerem i sprzedawcą → `document:<id>`. Czysta, testowana.
4. `routes/cost-documents.ts` (mount `/api/cost-documents`; **POST / i GET /mine dla każdego zalogowanego**, reszta `requirePayments`):
   - `POST /` — multipart `file` (multer memory, 10 MB) **lub** JSON `{ file_name, mime_type, data_base64, source: 'mobile' }`; dozwolone: pdf, jpeg, png, webp. Tworzy `CostDocument status='processing'`, uruchamia ekstrakcję
     (synchronicznie, timeout 60 s), potem NBP (jeśli currency ≠ PLN: `fx_rate, fx_date, net_pln = net×rate, gross_pln = gross×rate`; PLN → rate 1) i duplikaty; status → `pending` (lub `error` + `extract_error`, pola do ręcznego uzupełnienia).
     Zwraca dokument **bez** `file_data`. `created_by = req.user.email`.
   - `GET /?status=pending|approved|rejected|error|all` → lista bez `file_data` (sort created_at desc, max 500); `GET /stats` → `{ pending, error, approved_30d }`; `GET /mine` → własne (created_by), bez file_data, max 100;
   - `GET /:id/file` → binarny plik (`Content-Type` = mime, `Content-Disposition: inline`); dozwolone dla requirePayments **lub** twórcy.
   - `PUT /:id` — edycja pól (seller_name, seller_nip, doc_number, doc_date, currency, net, vat, gross, cost_category, subcategory, business_unit, notes, is_receipt); po zmianie kwot/waluty przelicz NBP i duplikaty.
   - **Ekstrakcja asynchronicznie**: `POST /` odpowiada natychmiast 202 dokumentem ze `status='processing'`; AI + NBP + duplikaty w tle → `pending`/`error`. `GET /:id` (requirePayments lub twórca, bez file_data) do odpytywania. `POST /:id/reopen` → `rejected` → `pending`.
   - `POST /:id/approve { force?: boolean, ...override pól jak w PUT }` → gdy `duplicate_of` i `!force` → 409 `{ error, duplicate_of, duplicate_note }`; brak kursu NBP (currency ≠ PLN, fx_rate=0 po ponowieniu) → 409. Kwota kosztu: `net_pln` gdy polski NIP sprzedawcy, nie paragon i vat > 0 (VAT odliczalny); inaczej `gross_pln`. Atomowe (transakcja, status musi być `pending`). Tworzy `ManualCost`
     `{ source:'document', pnl_mode:'include', date: doc_date, amount: net_pln (gdy is_receipt i vat=0 → gross_pln), currency:'PLN', cost_category, subcategory, business_unit, period, description: '<seller> · <doc_number>' (lub description z AI), reference: doc_number, document_id, created_by }`;
     jeśli `duplicate_of` = `mt940:<id>` i `force` → tamten ManualCost → `pnl_mode='exclude'` (żeby nie liczyć dwa razy). Status → `approved`, `reviewed_by/at`, `manual_cost_id`.
   - `POST /:id/reject { reason? }` → status `rejected`; jeśli był `manual_cost_id` → usuń ten ManualCost. `POST /:id/reextract` → ponowna ekstrakcja. `DELETE /:id` (requireAdmin).
5. `cost-inbox-imap.ts`: `checkImapInbox() → { fetched, created, skipped, error? }` przez `ImapFlow` (`{ host, port, secure, auth:{user, pass}, logger:false }`), `mailbox.getMailboxLock(folder)`,
   `client.fetch({ uid: `${last_uid+1}:*` }, { uid:true, source:true })` (gdy `last_uid=0` → wiadomości z ostatnich 14 dni: `{ since }`), `simpleParser(source)`; załączniki `application/pdf`, `image/jpeg|png|webp` ≤ 10 MB →
   `CostDocument source='email'`, `email_uid = `${host}|${folder}|${uid}|${i}`` (pomiń, gdy istnieje), `email_from`, `email_subject`, `created_by='imap'`; ekstrakcja jak w POST. Aktualizuj `last_uid`, `last_checked_at`, `last_error`. Nigdy nie rzucaj.
   `startImapPoller()` — 5 min po starcie, potem co 15 min, tylko gdy `enabled`.
6. `routes/settings-imap.ts` (mount `/api/settings/imap`, **requireAdmin**): `GET /` (pass → `'••••••••'` gdy ustawione), `PUT /` (pass = maska → zachowaj stare), `POST /test` (połącz, zwróć `{ ok, mailbox: { exists, unseen } }` lub `{ ok:false, error }`), `POST /check-now` → uruchamia `checkImapInbox()` w tle i odpowiada 202 `{ started: true, started_at }` (409 gdy sprawdzanie już trwa).

Raport: `{ files_created, files_modified, mount_snippet, notes, tests_run }`.

## E. Zestawienie obrotów i sald od księgowej + uzgodnienie

Pliki: `backend/src/utils/zoisParser.ts`, `backend/src/routes/accountant-statement.ts`, test `backend/src/__tests__/zois-parser.test.ts` (fixture'y: Comarch Optima CSV `;`, Symfonia XLSX-like tablica, plik z „Obroty narastająco” i „Obroty okresu”, brak nagłówka).

1. `zoisParser.ts`: `parseZoisRows(rows: any[][]) → { rows: ZoisRow[], detected: { account_col, name_col, debit_col, credit_col, header_row, has_period_and_ytd: boolean }, warnings: string[] }`,
   `ZoisRow = { account: string, name: string, debit: number, credit: number }`. Nagłówek: skanuj pierwsze 15 wierszy; kolumny: konto `/konto|symbol|nr konta|numer/`, nazwa `/nazwa/`,
   Wn `/wn|winien|debet|dt/`, Ma `/\bma\b|credit|ct/`; gdy są kolumny „okresu” i „narastająco” — bierz **okresu** (i ustaw flagę). Liczby przez `plNumber` z `routes/finance.ts`.
   Pomijaj wiersze sum („Razem”, puste konto), konta syntetyczne, gdy istnieją analityki tego konta (np. `401` i `401-01` → licz tylko analityki), aby nie podwoić.
   Bez nagłówka: kolumna 0 pasuje do `/^\d{3}/` → account, ostatnie dwie liczbowe → Wn/Ma (warning).
   Format CSV: separator `;` lub `,` (wykryj), kodowanie utf-8/latin2 (cp1250: gdy `�` w utf-8 → `iconv`-free fallback `latin1`), XLSX przez `xlsx` (`sheet_to_json({header:1, raw:false})`).
2. `mapZoisToLines(rows) → AccountantLines`:
   `{ revenue (70x–74x: Ma−Wn), cogs (koszt sprzedanych towarów/produktów: konto 7xx o nazwie „koszt…” / „wartość sprzedan…” / „w cenie zakupu”, albo 701/711/731/741 bez nazwy przychodowej i z saldem Wn — Wn−Ma; NIE netować z przychodem), other_revenue (760, 750: Ma−Wn), depreciation (400), materials (401), services (402), taxes_fees (403), salaries (404), social (405), other_costs (406–409 oraz 761), financial_costs (751), cit (870–879: Wn−Ma), costs_total, result, source_classes: '4'|'5', warnings }`.
   Koszty rodzajowe = Wn−Ma. Pomijaj `490`. Gdy zespół 4 pusty a 5 niepusty → koszty z 50–55 jako `other_costs` + warning („brak zespołu 4, użyto 5”). `costs_total = cogs+depreciation+materials+services+taxes_fees+salaries+social+other_costs+financial_costs`; `result = revenue+other_revenue−costs_total−cit`.
   Konto 7xx policzone jako przychód, ale z obrotem netto Wn → warning („sprawdź, czy to nie koszt sprzedanych towarów”). Plik > 20 000 wierszy → 400 (to nie ZOiS); `dropParentAccounts` O(n) przez zbiór prefiksów.
3. Router (mount `/api/finance/accountant`, `requirePayments`):
   `POST /import` multipart `file` + pola `period` (YYYY-MM), `mode` (`monthly|ytd`), `dry_run` (`'true'` domyślnie) → parse+map; przy `ytd`: jeśli istnieje zestawienie za poprzedni miesiąc w trybie `ytd` → linie miesiąca = bieżące − poprzednie (inaczej warning i zapis narastających jako miesiąc);
   odpowiedź `{ period, mode, lines, rows_count, detected, warnings, dry_run, saved }`; zapis = `upsert` po `period` (`rows`, `lines`, `revenue`, `costs`, `result`, `file_name`, `created_by`).
   `GET /` → `Array<{ period, mode, revenue, costs, result, file_name, created_at }>`; `DELETE /:period`;
   `GET /:period/compare` → `{ period, ours: { revenue, depreciation, salaries_social, cit, other_costs, costs_total, result }, theirs: AccountantLines, by_line: Array<{ key, label, ours, theirs, diff }>, verdict: 'ok'|'check', threshold, hints: string[] }`.
   `ours` z `computePnlYear(rok)` (miesiąc): `revenue`, `depreciation`, `cit`, `costs_total = cogs+opex+depreciation+financial_costs`, `result = net_result`; `salaries_social` = Σ ManualCost included `salary_gross|salary_admin|zus_employer` w miesiącu (+ alokacje KSeF z tymi podkategoriami, netto);
   `other_costs = costs_total − depreciation − salaries_social`. `theirs.salaries_social = salaries+social`, `theirs.other_costs = costs_total − depreciation − salaries − social`. `verdict='check'` gdy |result diff| > `threshold = max(500, 5 % × theirs.costs_total)`.
   `hints`: np. „Księgowa ma wyższe koszty o X — sprawdź faktury KSeF bez kategorii (N)”, „Nasz przychód wyższy — miesiąc bez importu Firmao (wstępny)”, „Amortyzacja różni się — uzupełnij środki trwałe”.

Raport: `{ files_created, files_modified, mount_snippet, notes, tests_run }`.

## F. Frontend: strona „Kondycja firmy” (+ prognoza gotówki)

Pliki (nowe): `frontend/src/pages/KondycjaPage.tsx`, `frontend/src/api/health.ts` (healthApi, cashflowApi, inventoryApi + typy HealthResponse, CashflowResponse, ReportSettings — zgodne z sekcjami A/B/C),
`frontend/src/components/health/*.tsx` (dowolny podział: Headline, Tiles, TrendChart (czysty SVG/div, bez bibliotek), CostBreakdown, TaxesCard, ChecksList, CashForecastCard, CompareCard, ReportSettingsModal, ReportPreviewModal).

Trasa: `/kondycja` (dodaje koordynator). Dostęp `admin || can_view_payments`. Endpointy: `GET /finance/health?period=`, `GET /finance/health/report-preview`, `POST /finance/health/report-send`,
`GET/PUT /finance/health/report-settings`, `GET /finance/cashflow?days=30`, `GET /finance/inventory?year=`.

UX (dla laika): u góry przełącznik **Miesiąc / Kwartał** + strzałki ‹ › + nazwa okresu (domyślnie poprzedni miesiąc). Duża karta statusu (zielona/żółta/czerwona) z `headline` i `subline`.
4 kafle: Przychód · Koszty · Zysk (EBITDA) · Gotówka na koncie (z datą salda; „— wgraj MT940” gdy null) + pod każdym jedno zdanie „co to znaczy” (np. EBITDA: „czy biznes sam z siebie zarabia, bez amortyzacji i podatku”).
Porównanie: „vs poprzedni okres” i „vs rok temu” (strzałki ▲▼ z %). Wykres 12 miesięcy: słupki przychód/koszty + linia EBITDA (SVG). „Na co idą pieniądze”: poziome paski top 6 z %.
„Podatki”: VAT do zapłaty (szacunek), CIT (szacunek YTD, zapłacono, do dopłaty), ZUS; notka. „Do sprawdzenia”: lista checków (ikona wg severity, przycisk „Przejdź →” do `link`).
„Gotówka: najbliższe 30 dni”: linia salda dzień po dniu (SVG), najniższy punkt, ostrzeżenia, listy wpływów/wypływów (zwinięte). Przyciski: „📧 Wyślij raport teraz” (modal: kind/period/force → wynik), „👁 Podgląd raportu” (iframe `srcDoc`), „⚙️ Ustawienia raportu” (admin: nazwa firmy, wysyłka wł., dzień, dodatkowe e-maile, stawka CIT 9/19, magazyn w RZiS; log wysyłek). Link „Pełny RZiS →” do `/rentownosc`.
Sekwencer żądań (ignoruj odpowiedzi nieaktualnego okresu). Stany: ładowanie, błąd, brak dostępu. Wszystko `dark:`.

Raport: `{ files_created, route_snippet (fragment do App.tsx), nav_snippet (jak dodać do menu), notes }`.

## G. Frontend: strona „Koszty spoza KSeF” (skrzynka dokumentów, reguły bankowe, IMAP)

Pliki (nowe): `frontend/src/pages/KosztySpozaKsefPage.tsx`, `frontend/src/api/costInbox.ts` (costDocumentsApi, bankRulesApi, imapSettingsApi + typy zgodne z B/D),
`frontend/src/constants/costTaxonomy.ts` (kopia etykiet podkategorii z `backend/src/routes/manual-costs.ts` MANUAL_SUBCATEGORIES + `marketing`, `other`; mapa subcategory→cost_category),
`frontend/src/components/costinbox/*.tsx` (DocumentsInbox, DocumentRow/Editor, UploadDropzone, BankRulesPanel, UnmatchedTransfers, ImapSettingsCard).

Trasa `/koszty-spoza-ksef` (dodaje koordynator). Dostęp `admin || can_view_payments`. Endpointy: `/cost-documents…` (D), `/finance/bank-rules…` (B), `/settings/imap…` (D, tylko admin).
Zakładki: **📥 Dokumenty** (tabs: Do zatwierdzenia (N) / Zatwierdzone / Odrzucone / Błędy; strefa upuszczania wielu plików PDF/JPG/PNG + przycisk; wiersz: miniatura/link „📎 plik” (`GET /cost-documents/:id/file` przez `api` z `responseType:'blob'` → `URL.createObjectURL`), sprzedawca, numer, data, kwota w walucie + PLN (kurs NBP z datą), kategoria (select z etykietami), jednostka, pewność AI, ostrzeżenie o duplikacie (żółty pasek z opisem i „Zatwierdź mimo to”), przyciski „✓ Zatwierdź”, „✎ Popraw” (edycja inline pól), „✕ Odrzuć”, „↻ Odczytaj ponownie”),
**🏦 Reguły bankowe** (lista reguł z trafieniami, formularz nowej reguły: nazwa, fragment, gdzie szukać, kategoria, jednostka, „licz w RZiS / pomiń”; „Zastosuj reguły do historii”; sekcja **Nierozpoznane przelewy** z zakresu (domyślnie ostatnie 3 miesiące): data, kwota, opis, przyciski „➕ Reguła z tego” (prefill formularza `suggested_pattern`), „Licz w RZiS” / „Pomiń” (`PATCH /cost/:id`) z wyborem kategorii),
**✉️ Skrzynka e-mail** (admin: host, port, SSL, login, hasło (maska), folder, włączona; „Testuj połączenie”, „Sprawdź teraz”, ostatnie sprawdzenie/błąd; instrukcja: „Przekazuj faktury spoza KSeF na tę skrzynkę — system odczyta je automatycznie”).
Nagłówek strony: krótkie wyjaśnienie „Tu trafiają koszty, których nie ma w KSeF: faktury zagraniczne, subskrypcje, paragony. Zatwierdzone wchodzą do rentowności.” Licznik do zatwierdzenia. Wszystko `dark:`.

Raport: `{ files_created, route_snippet, nav_snippet, notes }`.

## H. Frontend: integracja w „Rentowność” (magazyn w RZiS, zestawienie księgowej, linki)

Pliki: `frontend/src/pages/RentownoscPage.tsx` (edycja), `frontend/src/components/finance/AccountantStatementModal.tsx` (nowy), `frontend/src/api/accountant.ts` (nowy: accountantApi + typy zgodne z E).
Typy `PnlLines` (już mają `cogs_purchases`, `inventory_change`) i `CostDetailsResponse.groups.non_ksef` są zaktualizowane w `frontend/src/types/index.ts` — **nie edytuj tego pliku**.

- `PnlTable`: zamiast jednego wiersza „Koszt własny sprzedaży” pokaż: „Zakupy towarów i materiałów” (`cogs_purchases`), „Zmiana stanu magazynu” (`−inventory_change`, note: „magazyn urósł → koszt mniejszy” / „magazyn zmalał → koszt większy”; wiersz ukryty gdy `inventory_in_pnl=false` lub 0 w całym roku), „= Koszt sprzedanych towarów” (`cogs`, bold). Tabela roczna (miesiące) — analogiczny wiersz zmiany stanu.
- `COST_GROUP_META`: dodaj `{ key: 'non_ksef', label: 'Spoza KSeF (dokumenty, reguły bankowe)', icon: '📥' }` przed `other_manual`.
- Nagłówek: przyciski „📊 Kondycja firmy” (`/kondycja`), „📥 Koszty spoza KSeF” (`/koszty-spoza-ksef`), „🧾 Zestawienie księgowej” (modal).
- `AccountantStatementModal`: (1) import: plik CSV/XLSX, okres (YYYY-MM, domyślnie wybrany miesiąc), tryb (miesięczne obroty / narastająco od stycznia), najpierw **podgląd** (`dry_run=true`: linie + ostrzeżenia + wykryte kolumny), potem „Zapisz”; (2) lista zapisanych zestawień (okres, przychód, koszty, wynik, usuń); (3) porównanie dla wybranego okresu: tabela linia po linii (nasz RZiS / księgowa / różnica, czerwone gdy |diff| > 1 %), werdykt „✅ Zgodne w granicach błędu” / „⚠️ Do wyjaśnienia” + podpowiedzi (`hints`).
  Wyjaśnienie dla laika na górze: „Poproś biuro rachunkowe o miesięczne zestawienie obrotów i sald (CSV/Excel). System porówna je z naszymi liczbami.”
- Pod tabelą RZiS pokaż pasek „Uzgodnienie z księgową: ✅ zgodne / ⚠️ różnica X zł / — brak zestawienia” dla wybranego miesiąca (dane z `GET /finance/accountant/:period/compare`, 404 → brak).

Raport: `{ files_created, files_modified, notes }`.

## I. Mobile (Expo): ekran „Paragon / faktura” → skrzynka kosztów

Repo: `../smart-home-mobile`. Pliki: `app/(app)/paragon.tsx` (nowy), `src/api/client.ts` (dodaj `costDocumentsApi`), `src/types/index.ts` (typ `CostDocument`), `app/(app)/_layout.tsx` (rejestracja ekranu), `app/(app)/home.tsx` (kafel „Paragony” · „zdjęcie → koszt”, widoczny dla każdego).
Wzorce: `app/(app)/todo.tsx` (ekran Liquid Glass: `Screen`, `Glass`, `Icon`, `useTheme`), `app/(app)/project/[id]/add-cost.tsx` (ImagePicker: aparat + galeria, `quality: 0.6`).
Ekran: opis „Zrób zdjęcie paragonu lub faktury spoza KSeF. System odczyta kwoty i przekaże do zatwierdzenia księgowej.”; przyciski „📷 Zrób zdjęcie” / „🖼 Z galerii”; podgląd; „Wyślij” → `POST /cost-documents` JSON `{ file_name, mime_type:'image/jpeg', data_base64, source:'mobile' }` (base64 z `ImagePicker` opcja `base64: true`), timeout 90 s;
po odpowiedzi pokaż odczyt (sprzedawca, kwota brutto + waluta, data, status „czeka na zatwierdzenie” / „błąd odczytu — księgowa uzupełni ręcznie”). Sekcja „Moje przesłane” (`GET /cost-documents/mine`): lista ze statusem (⏳ do zatwierdzenia / ✓ zatwierdzony / ✕ odrzucony / ⚠ błąd). Pull-to-refresh. **Nie zmieniaj `app.json`** (build robi koordynator).

Raport: `{ files_created, files_modified, notes }`.
