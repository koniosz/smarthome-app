/**
 * Ustawienia per firma (CompanySettings, ImapSettings) — rekord na firmę. Historyczny wiersz id='default'
 * należy do firmy domyślnej; dla pozostałych firm id = company_id. Wszystkie odczyty idą przez aktywny
 * kontekst firmy (zadania w tle muszą działać w runWithCompany / forEachCompany).
 */
import { prisma, basePrisma } from './db'
import { currentCompanyId, getDefaultCompanyId } from './tenant'

async function cid(): Promise<string | null> {
  const c = currentCompanyId() ?? getDefaultCompanyId()
  if (c) return c
  const d = await basePrisma.company.findFirst({ where: { is_default: true }, select: { id: true } })
  return d?.id ?? null
}
// Nowe wiersze: id = company_id (unikalne); historyczny wiersz 'default' został przypisany do firmy domyślnej przez backfill
const rowId = (companyId: string | null) => companyId ?? 'default'

export async function getCompanySettings() {
  const c = await cid()
  return c ? prisma.companySettings.findFirst({ where: { company_id: c } }) : prisma.companySettings.findFirst()
}
export async function saveCompanySettings(patch: Record<string, any>) {
  const c = await cid()
  const existing = c ? await prisma.companySettings.findFirst({ where: { company_id: c } }) : await prisma.companySettings.findFirst()
  if (existing) return prisma.companySettings.update({ where: { id: existing.id }, data: patch })
  const { id: _i, company_id: _c, ...rest } = patch
  return prisma.companySettings.create({ data: { ...rest, id: rowId(c), company_id: c ?? undefined } })
}

export async function getImapSettings() {
  const c = await cid()
  return c ? prisma.imapSettings.findFirst({ where: { company_id: c } }) : prisma.imapSettings.findFirst()
}
export async function saveImapSettings(patch: Record<string, any>) {
  const c = await cid()
  const existing = c ? await prisma.imapSettings.findFirst({ where: { company_id: c } }) : await prisma.imapSettings.findFirst()
  if (existing) return prisma.imapSettings.update({ where: { id: existing.id }, data: patch })
  const { id: _i, company_id: _c, ...rest } = patch
  return prisma.imapSettings.create({ data: { ...rest, id: rowId(c), company_id: c ?? undefined } })
}
