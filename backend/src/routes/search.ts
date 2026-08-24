/**
 * Wyszukiwarka globalna (⌘K) — szuka po wszystkich modułach z poszanowaniem uprawnień:
 * - projekty (nazwa, klient, adres) i produkty z katalogu: każdy zalogowany
 * - zadania z kalendarza: każdy zalogowany; prywatne to-do: tylko własne
 * - faktury KSeF: admin wszystkie, pracownik tylko udostępnione
 * - faktury sprzedażowe: admin lub can_view_invoices
 * - magazyn: admin lub can_view_warehouse
 * - pracownicy: tylko admin
 */
import { Router, Request, Response } from 'express'
import db, { prisma } from '../db'

const router = Router()

const TAKE = 6

router.get('/', async (req: Request, res: Response) => {
  try {
    const q = String(req.query.q ?? '').trim()
    if (q.length < 2) { res.json({ query: q, groups: [] }); return }

    const jwtUser: any = (req as any).user
    const u: any = await db.users.find(jwtUser?.id).catch(() => null)
    const isAdmin = u?.role === 'admin'
    const canWarehouse = isAdmin || !!u?.can_view_warehouse
    const canInvoices = isAdmin || !!u?.can_view_invoices

    const c = { contains: q, mode: 'insensitive' as const }

    const [projects, products, tasks, todos, ksefInvoices, salesInvoices, warehouseItems, employees] = await Promise.all([
      prisma.project.findMany({
        where: { OR: [{ name: c }, { client_name: c }, { client_contact: c }] },
        select: { id: true, name: true, client_name: true, status: true },
        take: TAKE,
      }),
      prisma.productCatalog.findMany({
        where: { OR: [{ name: c }, { sku: c }, { brand: c }] },
        select: { id: true, name: true, sku: true, brand: true, unit_price: true },
        take: TAKE,
      }),
      prisma.task.findMany({
        where: { title: c },
        select: { id: true, title: true, date: true, project: { select: { name: true } } },
        orderBy: { date: 'desc' },
        take: 4,
      }),
      prisma.personalTodo.findMany({
        where: { user_id: jwtUser?.id ?? '', title: c, done: false },
        select: { id: true, title: true, due_date: true },
        take: 4,
      }),
      prisma.ksefInvoice.findMany({
        where: {
          ...(isAdmin ? {} : { is_shared: true }),
          OR: [{ invoice_number: c }, { seller_name: c }, { buyer_name: c }, { ksef_number: c }],
        },
        select: { id: true, invoice_number: true, seller_name: true, buyer_name: true, gross_amount: true, invoice_date: true, invoice_direction: true },
        orderBy: { invoice_date: 'desc' },
        take: TAKE,
      }),
      canInvoices
        ? prisma.salesInvoice.findMany({
            where: { OR: [{ number: c }, { buyer_name: c }, { buyer_nip: c }] },
            select: { id: true, number: true, buyer_name: true, total_gross: true, status: true },
            orderBy: { issue_date: 'desc' },
            take: 4,
          })
        : Promise.resolve([]),
      canWarehouse
        ? prisma.warehouseItem.findMany({
            where: { OR: [{ name: c }, { sku: c }] },
            select: { id: true, name: true, sku: true, quantity: true, unit: true },
            take: TAKE,
          })
        : Promise.resolve([]),
      isAdmin
        ? prisma.employee.findMany({
            where: { OR: [{ name: c }, { email: c }, { position: c }] },
            select: { id: true, name: true, position: true, email: true },
            take: TAKE,
          })
        : Promise.resolve([]),
    ])

    const groups: Array<{ type: string; label: string; items: Array<{ id: string; title: string; subtitle: string }> }> = []
    const push = (type: string, label: string, items: any[]) => { if (items.length) groups.push({ type, label, items }) }

    push('projects', 'Projekty i klienci', projects.map((p: any) => ({
      id: p.id, title: p.name, subtitle: [p.client_name, p.status].filter(Boolean).join(' · '),
    })))
    push('products', 'Produkty', products.map((p: any) => ({
      id: p.id, title: p.name, subtitle: [p.brand, p.sku, p.unit_price ? `${p.unit_price.toFixed(2)} zł` : null].filter(Boolean).join(' · '),
    })))
    push('invoices', 'Faktury (KSeF)', ksefInvoices.map((i: any) => ({
      id: i.id,
      title: `${i.invoice_number ?? 'b/n'} · ${(i.invoice_direction === 'outgoing' ? i.buyer_name : i.seller_name) ?? '—'}`,
      subtitle: [i.invoice_date?.slice(0, 10), `${(i.gross_amount ?? 0).toFixed(2)} zł`, i.invoice_direction === 'outgoing' ? 'sprzedaż' : 'koszt'].filter(Boolean).join(' · '),
    })))
    push('sales_invoices', 'Faktury sprzedażowe (moduł)', (salesInvoices as any[]).map(i => ({
      id: i.id, title: `${i.number ?? 'szkic'} · ${i.buyer_name}`, subtitle: `${(i.total_gross ?? 0).toFixed(2)} zł · ${i.status}`,
    })))
    push('warehouse', 'Magazyn', (warehouseItems as any[]).map(w => ({
      id: w.id, title: w.name, subtitle: [w.sku, `stan: ${w.quantity} ${w.unit ?? ''}`].filter(Boolean).join(' · '),
    })))
    push('employees', 'Pracownicy', (employees as any[]).map(e => ({
      id: e.id, title: e.name, subtitle: [e.position, e.email].filter(Boolean).join(' · '),
    })))
    push('tasks', 'Zadania (kalendarz)', tasks.map((t: any) => ({
      id: t.id, title: t.title, subtitle: [t.date, t.project?.name].filter(Boolean).join(' · '),
    })))
    push('todos', 'Moja lista', todos.map((t: any) => ({
      id: t.id, title: t.title, subtitle: t.due_date ? `termin ${t.due_date}` : 'bez terminu',
    })))

    res.json({ query: q, groups })
  } catch (e) {
    console.error('[search]', e)
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

export default router
