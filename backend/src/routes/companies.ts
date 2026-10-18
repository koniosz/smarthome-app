/**
 * Rejestr firm-sprzedawców: faktury sprzedażowe mogą być wystawiane z kilku spółek
 * (np. Smart Home Center Sp. z o.o. i GateLynk Sp. z o.o.) — każda z własnymi danymi,
 * logo, stopką i osobną numeracją. GET dla każdego zalogowanego (wybór sprzedawcy),
 * zmiany tylko admin. Mount: /api/companies (za requireAuth).
 */
import { Router, Request, Response } from 'express'
import { v4 as uuidv4 } from 'uuid'
import db, { prisma } from '../db'
import { requireAdmin } from '../middleware/auth'

const router = Router()
const now = () => new Date().toISOString()
const LOGO_MAX_BYTES = 700 * 1024
const BUSINESS_UNITS = ['shc', 'gatelynk', 'shared']

// Dotychczasowa firma zaszyta w kodzie (frontend/src/constants/company.ts) — zasiewana jako domyślna,
// żeby istniejące faktury (company_id = null) i wydruki działały bez migracji danych.
const LEGACY_DEFAULT = {
  name: 'Smart Home Center Sp. z o.o.', short_name: 'Smart Home Center', nip: 'PL9512423139',
  address: 'Gieysztora 6/u8, 02-999 Warszawa', bank_account: '62 1140 2004 0000 3302 7656 7828', bank_name: 'mBank',
}

const nipDigits = (s: any) => String(s ?? '').replace(/\D/g, '')

// Faktury sprzed rejestru firm (company_id = null) należą na stałe do Smart Home Center (firma zasiana
// z dotychczasowej stałej), a nie do „aktualnie domyślnej” — inaczej zmiana domyślnej przepisałaby
// historię (zły sprzedawca na wydruku, kolizje numerów). Idempotentne, raz na proces.
let legacyBackfilled = false
async function backfillLegacyInvoices(): Promise<void> {
  if (legacyBackfilled) return
  const all: any[] = await db.companies.all()
  const legacy = all.find(c => nipDigits(c.nip) === nipDigits(LEGACY_DEFAULT.nip)) ?? all.find(c => c.is_default)
  if (!legacy) return
  const r = await prisma.salesInvoice.updateMany({ where: { company_id: null }, data: { company_id: legacy.id } })
  if (r.count) console.log(`[Firmy] Przypisano ${r.count} starych faktur do: ${legacy.name}`)
  const issued = await prisma.salesInvoice.findMany({ where: { company_id: legacy.id, status: { not: 'draft' } }, select: { id: true, seller: true } })
  for (const inv of issued) if (inv.seller == null) await prisma.salesInvoice.update({ where: { id: inv.id }, data: { seller: sellerSnapshot(legacy) } })
  legacyBackfilled = true
}

export async function ensureDefaultCompany(): Promise<any> {
  const existing = await db.companies.findDefault()
  if (existing) { await backfillLegacyInvoices(); return existing }
  const any = await db.companies.all()
  if (any.length) { await db.companies.update(any[0].id, { is_default: true, updated_at: now() }); await backfillLegacyInvoices(); return db.companies.find(any[0].id) }
  const settings = await prisma.companySettings.findUnique({ where: { id: 'default' } }).catch(() => null)
  const item = {
    id: uuidv4(), ...LEGACY_DEFAULT, email: '', invoice_prefix: 'FV',
    invoice_logo: settings?.invoice_logo ?? '', invoice_footer: settings?.invoice_footer ?? '',
    business_unit: 'shc', is_default: true, active: true, created_at: now(), updated_at: now(),
  }
  await db.companies.insert(item)
  console.log('[Firmy] Zasiano firmę domyślną:', item.name)
  await backfillLegacyInvoices()
  return item
}

// Snapshot sprzedawcy zapisywany na fakturze przy wystawieniu (dane + stopka; logo z firmy po company_id)
export function sellerSnapshot(c: any) {
  return { name: c.name, address: c.address, nip: c.nip, bank_account: c.bank_account, bank_name: c.bank_name, footer: c.invoice_footer ?? '' }
}

// Zakres przychodu z modułu faktur w raportach SPÓŁKI (RZiS, Kondycja, prognoza gotówki, uzgodnienia):
// faktury firm z business_unit shc/shared = przychód spółki (bu = all); filtr BU: firmy z tym BU + shared.
// Inna spółka (np. GateLynk Sp. z o.o. z BU „gatelynk”) nie zawyża RZiS Smart Home Center.
export async function moduleInvoiceScope(): Promise<(inv: { company_id?: string | null }, bu?: string) => boolean> {
  const companies = await prisma.company.findMany({ select: { id: true, business_unit: true, is_default: true } })
  const defaultBu = companies.find(c => c.is_default)?.business_unit ?? 'shc'
  const buOf = new Map(companies.map(c => [c.id, c.business_unit]))
  return (inv, bu = 'all') => {
    const invBu = inv.company_id ? (buOf.get(inv.company_id) ?? defaultBu) : defaultBu
    if (bu === 'all') return invBu === 'shc' || invBu === 'shared'
    return invBu === bu || invBu === 'shared'
  }
}

async function prefixClash(prefix: string, excludeId?: string): Promise<string | null> {
  const all: any[] = await db.companies.all()
  const hit = all.find(c => c.id !== excludeId && String(c.invoice_prefix || '').toUpperCase() === prefix.toUpperCase())
  return hit ? `Prefiks „${prefix}” jest już używany przez firmę ${hit.name} — każda firma musi mieć inny, żeby numery faktur się nie powtarzały` : null
}

function validateLogo(logo: string): string | null {
  if (!logo) return null
  if (!/^data:image\/(png|jpeg|jpg|svg\+xml|webp);base64,/.test(logo)) return 'Logo musi być obrazem PNG, JPG, WEBP lub SVG'
  if (logo.length > LOGO_MAX_BYTES * 1.37) return 'Logo jest za duże — maksymalnie ~700 KB'
  return null
}

function readPatch(body: any, partial: boolean): { patch: any } | { error: string } {
  const patch: any = {}
  const str = (k: string, max = 300) => { if (body[k] !== undefined) patch[k] = String(body[k] ?? '').trim().slice(0, max) }
  str('name', 200); str('short_name', 60); str('nip', 20); str('address', 500); str('bank_account', 60); str('bank_name', 100); str('email', 120)
  str('invoice_prefix', 20); str('invoice_footer', 500)
  if (body.invoice_logo !== undefined) {
    const logo = String(body.invoice_logo ?? '')
    const err = validateLogo(logo); if (err) return { error: err }
    patch.invoice_logo = logo
  }
  if (body.business_unit !== undefined) {
    if (!BUSINESS_UNITS.includes(String(body.business_unit))) return { error: 'Nieprawidłowa jednostka biznesowa' }
    patch.business_unit = String(body.business_unit)
  }
  if (body.active !== undefined) patch.active = body.active !== false
  if (!partial || patch.name !== undefined) { if (!patch.name) return { error: 'Nazwa firmy jest wymagana' } }
  if (!partial || patch.nip !== undefined) {
    const digits = String(patch.nip ?? '').replace(/\D/g, '')
    if (digits.length !== 10) return { error: 'NIP musi mieć 10 cyfr (może być z prefiksem PL)' }
  }
  if (patch.invoice_prefix !== undefined && !patch.invoice_prefix) patch.invoice_prefix = 'FV'
  if (patch.invoice_prefix !== undefined) patch.invoice_prefix = patch.invoice_prefix.toUpperCase()
  if (patch.invoice_prefix !== undefined && !/^[A-Z0-9ĄĆĘŁŃÓŚŹŻ\-_]{1,20}$/.test(patch.invoice_prefix)) return { error: 'Prefiks numeracji: litery, cyfry, myślnik (np. FV, FV-GL)' }
  return { patch }
}

// GET /api/companies[?all=true] — aktywne (każdy) / wszystkie z liczbą faktur (admin)
router.get('/', async (req: Request, res: Response) => {
  try {
    await ensureDefaultCompany()
    const isAdmin = (req as any).user?.role === 'admin'
    // all=true: także nieaktywne (potrzebne do wydruku starych faktur dla każdego); liczniki tylko dla admina
    const all = String(req.query.all) === 'true'
    const list: any[] = all ? await db.companies.all() : await db.companies.active()
    if (all && isAdmin) {
      for (const c of list) c.invoices_count = await db.sales_invoices.countForCompany(c.id)
    }
    res.json(list)
  } catch (e) { console.error('[companies GET]', e); res.status(500).json({ error: 'Błąd serwera' }) }
})

// POST /api/companies — nowa firma (admin)
router.post('/', requireAdmin, async (req: Request, res: Response) => {
  try {
    const r = readPatch(req.body ?? {}, false)
    if ('error' in r) { res.status(400).json({ error: r.error }); return }
    const makeDefault = req.body?.is_default === true
    const clash = await prefixClash(r.patch.invoice_prefix || 'FV')
    if (clash) { res.status(400).json({ error: clash }); return }
    if (makeDefault) await db.companies.clearDefault()
    const item = {
      id: uuidv4(), short_name: '', nip: '', address: '', bank_account: '', bank_name: '', email: '',
      invoice_prefix: 'FV', invoice_logo: '', invoice_footer: '', business_unit: 'shc', active: true,
      ...r.patch, is_default: makeDefault, created_at: now(), updated_at: now(),
    }
    await db.companies.insert(item)
    res.status(201).json(item)
  } catch (e) { console.error('[companies POST]', e); res.status(500).json({ error: 'Błąd serwera' }) }
})

// PUT /api/companies/:id — edycja (admin); is_default=true odznacza pozostałe
router.put('/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const c: any = await db.companies.find(req.params.id)
    if (!c) { res.status(404).json({ error: 'Firma nie znaleziona' }); return }
    const r = readPatch(req.body ?? {}, true)
    if ('error' in r) { res.status(400).json({ error: r.error }); return }
    const patch: any = { ...r.patch, updated_at: now() }
    if (patch.invoice_prefix !== undefined) {
      const clash = await prefixClash(patch.invoice_prefix, c.id)
      if (clash) { res.status(400).json({ error: clash }); return }
    }
    if (req.body?.is_default === true) { await db.companies.clearDefault(); patch.is_default = true; patch.active = true }
    if (req.body?.is_default === false && c.is_default) { res.status(400).json({ error: 'Ustaw inną firmę jako domyślną — jedna musi nią być' }); return }
    if (patch.active === false && c.is_default) { res.status(400).json({ error: 'Firma domyślna nie może być nieaktywna — najpierw ustaw inną jako domyślną' }); return }
    await db.companies.update(c.id, patch)
    res.json(await db.companies.find(c.id))
  } catch (e) { console.error('[companies PUT]', e); res.status(500).json({ error: 'Błąd serwera' }) }
})

// DELETE /api/companies/:id — tylko firma bez faktur i niedomyślna (inaczej dezaktywuj)
router.delete('/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const c: any = await db.companies.find(req.params.id)
    if (!c) { res.status(404).json({ error: 'Firma nie znaleziona' }); return }
    if (c.is_default) { res.status(409).json({ error: 'Nie można usunąć firmy domyślnej — najpierw ustaw inną jako domyślną' }); return }
    const n = await db.sales_invoices.countForCompany(c.id)
    if (n > 0) { res.status(409).json({ error: `Firma ma ${n} faktur — zamiast usuwać, oznacz ją jako nieaktywną` }); return }
    await db.companies.delete(c.id)
    res.json({ ok: true })
  } catch (e) { console.error('[companies DELETE]', e); res.status(500).json({ error: 'Błąd serwera' }) }
})

export default router
