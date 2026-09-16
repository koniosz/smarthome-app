// Taksonomia kosztów po stronie frontendu — kopia etykiet z backendu
// (`backend/src/routes/manual-costs.ts` MANUAL_SUBCATEGORIES) + `marketing` (sales) i `other` (ga),
// używane przez skrzynkę kosztów spoza KSeF (sekcja D) i reguły bankowe (sekcja B).
// Źródłem prawdy pozostaje backend — tutaj tylko etykiety do selectów.

export type CostCategory = 'cogs' | 'sales' | 'ga' | 'operations' | 'financial'
export type BusinessUnit = 'shc' | 'gatelynk' | 'shared'
export type PnlMode = 'auto' | 'include' | 'exclude'

export const COST_CATEGORY_LABELS: Record<CostCategory, string> = {
  cogs:       'Koszt sprzedanych towarów (sprzęt, import, podwykonawcy)',
  sales:      'Sprzedaż i marketing',
  ga:         'Administracja (pensje, biuro, oprogramowanie)',
  operations: 'Operacyjne (auta, narzędzia, ubezpieczenia)',
  financial:  'Finansowe i podatki',
}

// Kolejność kategorii w selectach (najczęstsze na górze)
export const COST_CATEGORY_ORDER: CostCategory[] = ['cogs', 'ga', 'operations', 'sales', 'financial']

export const COST_SUBCATEGORIES: Record<CostCategory, Record<string, string>> = {
  cogs: {
    hardware:              'Sprzęt krajowy',
    hardware_eu:           'Sprzęt z UE (WNT)',
    hardware_noneu:        'Sprzęt spoza UE (import)',
    import_duty:           'Cło i opłaty celne',
    import_freight:        'Fracht / spedycja importowa',
    import_agency:         'Agencja celna / obsługa importu',
    subcontractor:         'Podwykonawca',
    installation_material: 'Materiały instalacyjne',
  },
  sales: {
    marketing:             'Marketing ogólny',
  },
  ga: {
    salary_gross:          'Wynagrodzenia brutto (UoP)',
    salary_b2b:            'Wynagrodzenia B2B / faktury',
    salary_civil:          'Wynagrodzenia UoD / UoZ',
    zus_employer:          'ZUS pracodawcy',
    rent:                  'Czynsz biuro / magazyn',
    utilities:             'Media (prąd, internet)',
    software:              'Oprogramowanie / licencje',
    accounting:            'Księgowość / doradztwo',
    legal:                 'Usługi prawne',
    office_supplies:       'Materiały biurowe',
    other:                 'Inne administracyjne',
  },
  operations: {
    car_fuel:              'Paliwo',
    car_service:           'Serwis pojazdów',
    insurance:             'Ubezpieczenie',
    travel:                'Podróże służbowe',
    tools:                 'Narzędzia',
  },
  financial: {
    tax_vat:               'VAT do US',
    tax_income:            'CIT / PIT do US',
    tax_other:             'Inne podatki i opłaty',
    bank_fee:              'Opłaty bankowe',
    interest:              'Odsetki',
    leasing:               'Leasing',
    fx:                    'Różnice kursowe / przewalutowanie',
  },
}

// subcategory → cost_category (zbudowane z tabeli powyżej)
export const SUBCATEGORY_TO_CATEGORY: Record<string, CostCategory> = (() => {
  const out: Record<string, CostCategory> = {}
  for (const cat of Object.keys(COST_SUBCATEGORIES) as CostCategory[]) {
    for (const sub of Object.keys(COST_SUBCATEGORIES[cat])) out[sub] = cat
  }
  return out
})()

export interface SubcategoryOption {
  value: string
  label: string
  cost_category: CostCategory
  group: string
}

// Płaska lista do <select> z <optgroup> — w kolejności COST_CATEGORY_ORDER
export const SUBCATEGORY_OPTIONS: SubcategoryOption[] = COST_CATEGORY_ORDER.flatMap(cat =>
  Object.entries(COST_SUBCATEGORIES[cat]).map(([value, label]) => ({
    value, label, cost_category: cat, group: COST_CATEGORY_LABELS[cat],
  }))
)

/** Etykieta podkategorii po polsku (fallback: sam klucz). */
export function subcategoryLabel(key: string | null | undefined): string {
  if (!key) return '—'
  const cat = SUBCATEGORY_TO_CATEGORY[key]
  return cat ? COST_SUBCATEGORIES[cat][key] : key
}

/** Kategoria główna dla podkategorii (fallback: `ga`). */
export function categoryForSubcategory(key: string | null | undefined): CostCategory {
  return (key && SUBCATEGORY_TO_CATEGORY[key]) || 'ga'
}

export function categoryLabel(key: string | null | undefined): string {
  return (key && (COST_CATEGORY_LABELS as Record<string, string>)[key]) || key || '—'
}

export const BUSINESS_UNITS: Record<BusinessUnit, string> = {
  shc:      'Smart Home Center',
  gatelynk: 'GateLynk',
  shared:   'Wspólne',
}

export function businessUnitLabel(key: string | null | undefined): string {
  return (key && (BUSINESS_UNITS as Record<string, string>)[key]) || key || '—'
}

export const PNL_MODE_LABELS: Record<PnlMode, string> = {
  auto:    'automatycznie (wg bezpiecznej listy)',
  include: 'licz w RZiS',
  exclude: 'pomiń (nie licz)',
}

export const MATCH_FIELD_LABELS: Record<'any' | 'counterparty' | 'description', string> = {
  any:          'kontrahent lub opis',
  counterparty: 'tylko kontrahent',
  description:  'tylko opis przelewu',
}
