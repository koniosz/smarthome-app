/**
 * Skrypt migracji: db.json → PostgreSQL (Prisma)
 * Uruchom: npm run db:seed
 *
 * Wymaga zmiennej DATABASE_URL w .env
 */

import { PrismaClient } from '@prisma/client'
import fs from 'fs'
import path from 'path'
import dotenv from 'dotenv'

dotenv.config({ path: path.resolve(__dirname, '..', '.env') })

const prisma = new PrismaClient()

const DB_PATH = path.join(__dirname, '..', 'data', 'db.json')

async function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.log('Nie znaleziono db.json — brak danych do migracji.')
    console.log('Baza PostgreSQL jest pusta i gotowa do użycia.')
    return
  }

  const raw = fs.readFileSync(DB_PATH, 'utf-8')
  const data = JSON.parse(raw)

  console.log('🔄 Migracja db.json → PostgreSQL...\n')

  // Users
  if (data.users?.length) {
    console.log(`👤 Migruję użytkowników: ${data.users.length}`)
    for (const u of data.users) {
      await prisma.user.upsert({
        where: { id: u.id },
        update: {},
        create: {
          id: u.id,
          email: u.email,
          display_name: u.display_name || u.name || u.email,
          role: u.role || 'employee',
          azure_oid: u.azure_oid || null,
          password_hash: u.password_hash || null,
          created_at: u.created_at || new Date().toISOString(),
        },
      })
    }
  }

  // Employees
  if (data.employees?.length) {
    console.log(`👷 Migruję pracowników: ${data.employees.length}`)
    for (const e of data.employees) {
      await prisma.employee.upsert({
        where: { id: e.id },
        update: {},
        create: {
          id: e.id,
          name: e.name,
          hourly_rate: e.hourly_rate || 0,
          created_at: e.created_at || new Date().toISOString(),
        },
      })
    }
  }

  // Projects
  if (data.projects?.length) {
    console.log(`🏗️  Migruję projekty: ${data.projects.length}`)
    for (const p of data.projects) {
      await prisma.project.upsert({
        where: { id: p.id },
        update: {},
        create: {
          id: p.id,
          name: p.name,
          client_name: p.client_name || '',
          client_contact: p.client_contact || '',
          project_type: p.project_type || 'installation',
          status: p.status || 'offer_submitted',
          budget_amount: p.budget_amount || 0,
          area_m2: p.area_m2 || null,
          smart_features: p.smart_features || [],
          start_date: p.start_date || null,
          end_date: p.end_date || null,
          description: p.description || '',
          created_at: p.created_at || new Date().toISOString(),
          updated_at: p.updated_at || new Date().toISOString(),
          created_by: p.created_by || null,
        },
      })
    }
  }

  // Project Members
  if (data.project_members?.length) {
    console.log(`🔗 Migruję członków projektów: ${data.project_members.length}`)
    for (const m of data.project_members) {
      await prisma.projectMember.upsert({
        where: { project_id_user_id: { project_id: m.project_id, user_id: m.user_id } },
        update: {},
        create: { project_id: m.project_id, user_id: m.user_id },
      })
    }
  }

  // Cost Items
  if (data.cost_items?.length) {
    console.log(`💰 Migruję pozycje kosztów: ${data.cost_items.length}`)
    for (const c of data.cost_items) {
      await prisma.costItem.upsert({
        where: { id: c.id },
        update: {},
        create: {
          id: c.id,
          project_id: c.project_id,
          category: c.category || 'materials',
          description: c.description || '',
          quantity: c.quantity || 1,
          unit_price: c.unit_price || 0,
          total_price: c.total_price || 0,
          supplier: c.supplier || '',
          invoice_number: c.invoice_number || '',
          date: c.date || new Date().toISOString().slice(0, 10),
          created_at: c.created_at || new Date().toISOString(),
          attachment_filename: c.attachment_filename || null,
          attachment_original: c.attachment_original || null,
        },
      })
    }
  }

  // Labor Entries
  if (data.labor_entries?.length) {
    console.log(`🔨 Migruję robociznę: ${data.labor_entries.length}`)
    for (const l of data.labor_entries) {
      await prisma.laborEntry.upsert({
        where: { id: l.id },
        update: {},
        create: {
          id: l.id,
          project_id: l.project_id,
          worker_name: l.worker_name || '',
          date: l.date || new Date().toISOString().slice(0, 10),
          hours: l.hours || 0,
          hourly_rate: l.hourly_rate || 0,
          description: l.description || '',
          created_at: l.created_at || new Date().toISOString(),
        },
      })
    }
  }

  // Client Payments
  if (data.client_payments?.length) {
    console.log(`💳 Migruję płatności: ${data.client_payments.length}`)
    for (const p of data.client_payments) {
      await prisma.clientPayment.upsert({
        where: { id: p.id },
        update: {},
        create: {
          id: p.id,
          project_id: p.project_id,
          amount: p.amount || 0,
          date: p.date || new Date().toISOString().slice(0, 10),
          description: p.description || '',
          invoice_number: p.invoice_number || '',
          payment_type: p.payment_type || 'standard',
          created_at: p.created_at || new Date().toISOString(),
        },
      })
    }
  }

  // Extra Costs
  if (data.extra_costs?.length) {
    console.log(`📋 Migruję koszty dodatkowe: ${data.extra_costs.length}`)
    for (const e of data.extra_costs) {
      await prisma.extraCost.upsert({
        where: { id: e.id },
        update: {},
        create: {
          id: e.id,
          project_id: e.project_id,
          description: e.description || '',
          quantity: e.quantity || 1,
          unit_price: e.unit_price || 0,
          total_price: e.total_price || 0,
          date: e.date || new Date().toISOString().slice(0, 10),
          is_out_of_scope: e.is_out_of_scope || false,
          status: e.status || 'pending',
          notes: e.notes || '',
          created_at: e.created_at || new Date().toISOString(),
          updated_at: e.updated_at || new Date().toISOString(),
          sent_at: e.sent_at || null,
        },
      })
    }
  }

  // Product Catalog
  if (data.product_catalog?.length) {
    console.log(`📦 Migruję katalog produktów: ${data.product_catalog.length}`)
    for (const p of data.product_catalog) {
      await prisma.productCatalog.upsert({
        where: { id: p.id },
        update: {},
        create: {
          id: p.id,
          sku: p.sku || null,
          brand: p.brand || null,
          manufacturer: p.manufacturer || null,
          category: p.category || null,
          name: p.name,
          unit: p.unit || 'szt.',
          unit_price: p.unit_price || 0,
          active: p.active !== false,
        },
      })
    }
  }

  // AI Quotes
  if (data.ai_quotes?.length) {
    console.log(`🤖 Migruję wyceny AI: ${data.ai_quotes.length}`)
    for (const q of data.ai_quotes) {
      await prisma.aiQuote.upsert({
        where: { id: q.id },
        update: {},
        create: {
          id: q.id,
          project_id: q.project_id,
          name: q.name || null,
          status: q.status || 'draft',
          discount_pct: q.discount_pct || 0,
          items: q.items || null,
          description: q.description || null,
          created_at: q.created_at || new Date().toISOString(),
        },
      })
    }
  }

  // Access Requests
  if (data.access_requests?.length) {
    console.log(`🔑 Migruję wnioski o dostęp: ${data.access_requests.length}`)
    for (const r of data.access_requests) {
      await prisma.accessRequest.upsert({
        where: { id: r.id },
        update: {},
        create: {
          id: r.id,
          project_id: r.project_id,
          project_name: r.project_name || '',
          requester_id: r.requester_id,
          requester_name: r.requester_name || '',
          requester_email: r.requester_email || '',
          status: r.status || 'pending',
          created_at: r.created_at || new Date().toISOString(),
          updated_at: r.updated_at || new Date().toISOString(),
        },
      })
    }
  }

  // Notifications
  if (data.notifications?.length) {
    console.log(`🔔 Migruję powiadomienia: ${data.notifications.length}`)
    for (const n of data.notifications) {
      await prisma.notification.upsert({
        where: { id: n.id },
        update: {},
        create: {
          id: n.id,
          user_id: n.user_id,
          type: n.type || 'info',
          message: n.message || '',
          data: n.data || null,
          read: n.read || false,
          created_at: n.created_at || new Date().toISOString(),
        },
      })
    }
  }

  // Cost Audit Log
  if (data.cost_audit_log?.length) {
    console.log(`📝 Migruję log audytu: ${data.cost_audit_log.length}`)
    for (const e of data.cost_audit_log) {
      await prisma.costAuditLog.upsert({
        where: { id: e.id },
        update: {},
        create: {
          id: e.id,
          project_id: e.project_id,
          action: e.action || 'unknown',
          entity: e.entity || null,
          entity_id: e.entity_id || null,
          description: e.description || null,
          user_id: e.user_id || null,
          user_name: e.user_name || null,
          created_at: e.created_at || new Date().toISOString(),
        },
      })
    }
  }

  console.log('\n✅ Migracja zakończona pomyślnie!')
  console.log('💡 Możesz teraz usunąć lub zarchiwizować plik data/db.json')
}

main()
  .catch((e) => {
    console.error('❌ Błąd migracji:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
