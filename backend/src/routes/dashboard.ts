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
    let activeCount = 0
    const overBudget: any[] = []
    const byStatus: Record<string, number> = {}
    const byType: Record<string, number> = {}

    for (const p of projects) {
      const [costItems, laborEntries, payments] = await Promise.all([
        db.cost_items.forProject(p.id),
        db.labor_entries.forProject(p.id),
        db.client_payments.forProject(p.id),
      ])
      const costTotal = costItems.reduce((s: number, i: any) => s + i.total_price, 0)
        + laborEntries.reduce((s: number, e: any) => s + e.hours * e.hourly_rate, 0)
      const paymentsTotal = payments.reduce((s: number, pay: any) => s + pay.amount, 0)
      const revenue = Math.max(p.budget_amount, paymentsTotal)
      const margin_pln = revenue - costTotal
      const margin_pct = revenue > 0 ? (margin_pln / revenue) * 100 : 0

      if (!['closing', 'cancelled'].includes(p.status)) {
        totalBudget += p.budget_amount
        totalCosts += costTotal
        totalPayments += paymentsTotal
        activeCount++
      }

      byStatus[p.status] = (byStatus[p.status] || 0) + 1
      byType[p.project_type] = (byType[p.project_type] || 0) + 1

      if (costTotal > revenue && revenue > 0) {
        overBudget.push({
          id: p.id, name: p.name, client_name: p.client_name,
          status: p.status, budget_amount: p.budget_amount,
          payments_total: paymentsTotal, cost_total: costTotal,
          margin_pln, margin_pct,
        })
      }
    }

    const averageMargin = totalBudget > 0
      ? ((totalBudget - totalCosts) / totalBudget) * 100
      : 0

    // ── Car expiry alerts (within 7 days) ─────────────────────────────────
    const cars = await db.employee_assets.allCars()
    const today = new Date(); today.setHours(0, 0, 0, 0)
    const in7 = new Date(today); in7.setDate(in7.getDate() + 7)

    const carAlerts: any[] = []
    for (const car of cars as any[]) {
      for (const { field, label } of [
        { field: 'car_inspection_date', label: 'Badanie techniczne' },
        { field: 'car_insurance_date',  label: 'Ubezpieczenie' },
      ]) {
        const dateStr = car[field]
        if (!dateStr) continue
        const d = new Date(dateStr); d.setHours(0, 0, 0, 0)
        const daysLeft = Math.round((d.getTime() - today.getTime()) / 86_400_000)
        if (daysLeft <= 7) {
          carAlerts.push({
            employee_id:   car.employee.id,
            employee_name: car.employee.name,
            car_name:      car.name,
            serial_no:     car.serial_no,
            alert_type:    field,
            alert_label:   label,
            expires_at:    dateStr,
            days_left:     daysLeft,
          })
        }
      }
    }
    carAlerts.sort((a, b) => a.days_left - b.days_left)

    // ── Employee medical/BHP alerts (within 7 days) ────────────────────────
    const empList = await db.employees.allForAlerts()
    const employeeAlerts: any[] = []
    for (const emp of empList as any[]) {
      for (const { field, label } of [
        { field: 'medical_exam_date', label: 'Badania okresowe' },
        { field: 'bhp_date',          label: 'Szkolenie BHP' },
      ]) {
        const dateStr = emp[field]
        if (!dateStr) continue
        const d = new Date(dateStr); d.setHours(0, 0, 0, 0)
        const daysLeft = Math.round((d.getTime() - today.getTime()) / 86_400_000)
        if (daysLeft <= 7) {
          employeeAlerts.push({
            employee_id:   emp.id,
            employee_name: emp.name,
            alert_type:    field,
            alert_label:   label,
            expires_at:    dateStr,
            days_left:     daysLeft,
          })
        }
      }
    }
    employeeAlerts.sort((a, b) => a.days_left - b.days_left)

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
      average_margin_pct: averageMargin,
      over_budget_count: overBudget.length,
      over_budget_projects: overBudget,
      by_status: byStatus,
      by_type: byType,
      recent_projects: recentProjects,
      car_alerts: carAlerts,
      employee_alerts: employeeAlerts,
    })
  } catch (e) {
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

export default router
