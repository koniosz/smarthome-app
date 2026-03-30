import { Router, Request, Response } from 'express'
import db from '../db'

const router = Router()

router.get('/', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user
    let projects = await db.projects.all()

    if (user && user.role === 'employee') {
      const members = await db.project_members.forUser(user.id)
      const memberProjectIds = new Set(members.map((m: any) => m.project_id))
      projects = projects.filter((p: any) => memberProjectIds.has(p.id))
    }

    let totalBudget = 0
    let totalCosts = 0
    let totalPayments = 0
    let totalProfit = 0
    let activeCount = 0
    const overBudget: any[] = []
    const byStatus: Record<string, number> = {}
    const byType: Record<string, number> = {}
    const profitByProject: any[] = []

    // Dzienny zysk: suma (zysk / dni trwania) dla projektów z datą rozpoczęcia
    let totalDailyProfit = 0
    let dailyProfitProjectCount = 0

    for (const p of projects) {
      const [costItems, laborEntries, payments, extraCosts] = await Promise.all([
        db.cost_items.forProject(p.id),
        db.labor_entries.forProject(p.id),
        db.client_payments.forProject(p.id),
        db.extra_costs.forProject(p.id),
      ])
      const costTotal = costItems.reduce((s: number, i: any) => s + i.total_price, 0)
        + laborEntries.reduce((s: number, e: any) => s + e.hours * e.hourly_rate, 0)
        + extraCosts.reduce((s: number, e: any) => s + e.amount, 0)
      const paymentsTotal = payments.reduce((s: number, pay: any) => s + pay.amount, 0)
      // Przychód = faktycznie wpłacone (jeśli > 0) lub wartość oferty
      const revenue = paymentsTotal > 0 ? paymentsTotal : p.budget_amount
      const profit_pln = revenue - costTotal
      const profit_pct = revenue > 0 ? (profit_pln / revenue) * 100 : 0

      // Liczba dni trwania projektu (od created_at do dziś)
      const startDate = new Date(p.created_at)
      const today = new Date()
      const daysRunning = Math.max(1, Math.ceil((today.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)))
      const daily_profit = profit_pln / daysRunning

      const isActive = !['closing', 'cancelled'].includes(p.status)
      if (isActive) {
        totalBudget += p.budget_amount
        totalCosts += costTotal
        totalPayments += paymentsTotal
        totalProfit += profit_pln
        activeCount++

        if (costTotal > 0 || p.budget_amount > 0) {
          totalDailyProfit += daily_profit
          dailyProfitProjectCount++
        }
      }

      byStatus[p.status] = (byStatus[p.status] || 0) + 1
      byType[p.project_type] = (byType[p.project_type] || 0) + 1

      if (costTotal > revenue && revenue > 0) {
        overBudget.push({
          id: p.id, name: p.name, client_name: p.client_name,
          status: p.status, budget_amount: p.budget_amount,
          payments_total: paymentsTotal, cost_total: costTotal,
          profit_pln, profit_pct,
        })
      }

      // Tabela zysk/strata per projekt (wszystkie aktywne)
      if (isActive) {
        profitByProject.push({
          id: p.id,
          name: p.name,
          client_name: p.client_name,
          status: p.status,
          budget_amount: p.budget_amount,
          payments_total: paymentsTotal,
          cost_total: costTotal,
          profit_pln,
          profit_pct,
          daily_profit,
          days_running: daysRunning,
        })
      }
    }

    // Sortuj: największa strata na górze, największy zysk na dole
    profitByProject.sort((a, b) => a.profit_pln - b.profit_pln)

    const averageMargin = totalBudget > 0
      ? ((totalBudget - totalCosts) / totalBudget) * 100
      : 0

    const recentProjects = await Promise.all(
      [...projects]
        .sort((a: any, b: any) => b.created_at.localeCompare(a.created_at))
        .slice(0, 5)
        .map(async (p: any) => {
          const [costItems, laborEntries] = await Promise.all([
            db.cost_items.forProject(p.id),
            db.labor_entries.forProject(p.id),
          ])
          const cost_total = costItems.reduce((s: number, i: any) => s + i.total_price, 0)
            + laborEntries.reduce((s: number, e: any) => s + e.hours * e.hourly_rate, 0)
          const margin_pct = p.budget_amount > 0
            ? ((p.budget_amount - cost_total) / p.budget_amount) * 100
            : 0
          return { ...p, cost_total, margin_pct }
        })
    )

    res.json({
      total_projects: projects.length,
      active_projects: activeCount,
      total_budget: totalBudget,
      total_costs: totalCosts,
      total_payments: totalPayments,
      total_profit: totalProfit,
      daily_profit: totalDailyProfit,
      average_margin_pct: averageMargin,
      over_budget_count: overBudget.length,
      over_budget_projects: overBudget,
      profit_by_project: profitByProject,
      by_status: byStatus,
      by_type: byType,
      recent_projects: recentProjects,
    })
  } catch (e) {
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

export default router
