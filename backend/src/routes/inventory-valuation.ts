/**
 * Wycena magazynu do RZiS — `GET /api/finance/inventory?year=YYYY`.
 * Dostęp: admin lub księgowy (can_view_payments). Spec: docs/finance-automation-spec.md §C.
 *
 * Odpowiedź: { year, months: [{ period, value, change, unpriced_items }] (12 miesięcy), current_value, as_of }
 *  - value:  wartość zapasów (netto, po cenach zakupu) na koniec miesiąca
 *  - change: zmiana stanu = value(M) − value(M−1); dodatnia = magazyn urósł → koszt sprzedanych towarów mniejszy
 *  - unpriced_items: pozycje ze stanem, ale bez ceny zakupu (nie wchodzą do wartości)
 */
import { Router, Request, Response } from 'express'
import { requirePayments } from './payables'
import { inventoryReportForYear } from '../services/inventory-valuation'

const router = Router()
router.use(requirePayments)

router.get('/', async (req: Request, res: Response) => {
  try {
    const raw = req.query.year
    const year = raw === undefined || raw === '' ? new Date().getFullYear() : Number(raw)
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      res.status(400).json({ error: 'Nieprawidłowy rok — podaj year=YYYY' }); return
    }
    res.json(await inventoryReportForYear(year))
  } catch (e) {
    console.error('[Magazyn] Błąd wyceny:', e)
    res.status(500).json({ error: 'Błąd serwera przy wycenie magazynu' })
  }
})

export default router
