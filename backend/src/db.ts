import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

export const db = {
  projects: {
    all: () =>
      prisma.project.findMany({ orderBy: { created_at: 'desc' } }),
    find: (id: string) =>
      prisma.project.findUnique({ where: { id } }),
    insert: (item: any) =>
      prisma.project.create({ data: item }),
    update: (id: string, patch: any) =>
      prisma.project.update({ where: { id }, data: patch }),
    delete: (id: string) =>
      prisma.project.delete({ where: { id } }),
  },

  cost_items: {
    forProject: (projectId: string) =>
      prisma.costItem.findMany({
        where: { project_id: projectId },
        orderBy: { date: 'desc' },
      }),
    find: (id: string) =>
      prisma.costItem.findUnique({ where: { id } }),
    insert: (item: any) =>
      prisma.costItem.create({ data: item }),
    update: (id: string, patch: any) =>
      prisma.costItem.update({ where: { id }, data: patch }),
    delete: (id: string) =>
      prisma.costItem.delete({ where: { id } }),
  },

  labor_entries: {
    forProject: (projectId: string) =>
      prisma.laborEntry.findMany({
        where: { project_id: projectId },
        orderBy: { date: 'desc' },
      }),
    find: (id: string) =>
      prisma.laborEntry.findUnique({ where: { id } }),
    insert: (item: any) =>
      prisma.laborEntry.create({ data: item }),
    update: (id: string, patch: any) =>
      prisma.laborEntry.update({ where: { id }, data: patch }),
    delete: (id: string) =>
      prisma.laborEntry.delete({ where: { id } }),
  },

  client_payments: {
    forProject: (projectId: string) =>
      prisma.clientPayment.findMany({
        where: { project_id: projectId },
        orderBy: { date: 'desc' },
      }),
    find: (id: string) =>
      prisma.clientPayment.findUnique({ where: { id } }),
    insert: (item: any) =>
      prisma.clientPayment.create({ data: item }),
    update: (id: string, patch: any) =>
      prisma.clientPayment.update({ where: { id }, data: patch }),
    delete: (id: string) =>
      prisma.clientPayment.delete({ where: { id } }),
  },

  employees: {
    all: () =>
      prisma.employee.findMany({ orderBy: { name: 'asc' } }),
    find: (id: string) =>
      prisma.employee.findUnique({ where: { id } }),
    insert: (item: any) =>
      prisma.employee.create({ data: item }),
    update: (id: string, patch: any) =>
      prisma.employee.update({ where: { id }, data: patch }),
    delete: (id: string) =>
      prisma.employee.delete({ where: { id } }),
  },

  users: {
    all: () =>
      prisma.user.findMany(),
    find: (id: string) =>
      prisma.user.findUnique({ where: { id } }),
    findByEmail: (email: string) =>
      prisma.user.findUnique({ where: { email } }),
    findByAzureOid: (oid: string) =>
      prisma.user.findUnique({ where: { azure_oid: oid } }),
    count: () =>
      prisma.user.count(),
    insert: (item: any) =>
      prisma.user.create({ data: item }),
    update: (id: string, patch: any) =>
      prisma.user.update({ where: { id }, data: patch }),
    delete: (id: string) =>
      prisma.user.delete({ where: { id } }),
  },

  project_members: {
    forProject: (projectId: string) =>
      prisma.projectMember.findMany({ where: { project_id: projectId } }),
    forUser: (userId: string) =>
      prisma.projectMember.findMany({ where: { user_id: userId } }),
    has: (projectId: string, userId: string) =>
      prisma.projectMember.findUnique({
        where: { project_id_user_id: { project_id: projectId, user_id: userId } },
      }).then(Boolean),
    add: (projectId: string, userId: string) =>
      prisma.projectMember.upsert({
        where: { project_id_user_id: { project_id: projectId, user_id: userId } },
        update: {},
        create: { project_id: projectId, user_id: userId },
      }),
    remove: (projectId: string, userId: string) =>
      prisma.projectMember.deleteMany({
        where: { project_id: projectId, user_id: userId },
      }),
    removeAllForProject: (projectId: string) =>
      prisma.projectMember.deleteMany({ where: { project_id: projectId } }),
  },

  product_catalog: {
    all: () =>
      prisma.productCatalog.findMany({ where: { active: true } }),
    allIncludingInactive: () =>
      prisma.productCatalog.findMany(),
    find: (id: string) =>
      prisma.productCatalog.findUnique({ where: { id } }),
    insert: (item: any) =>
      prisma.productCatalog.create({ data: item }),
    update: (id: string, patch: any) =>
      prisma.productCatalog.update({ where: { id }, data: patch }),
    delete: (id: string) =>
      prisma.productCatalog.update({ where: { id }, data: { active: false } }),
    hardDeleteByBrandManufacturer: (brand: string, manufacturer: string) =>
      prisma.productCatalog.deleteMany({ where: { brand, manufacturer } }),
    seed: async (items: any[]) => {
      const count = await prisma.productCatalog.count()
      if (count === 0) {
        await prisma.productCatalog.createMany({ data: items, skipDuplicates: true })
      }
    },
    count: () =>
      prisma.productCatalog.count(),
  },

  ai_quotes: {
    forProject: (projectId: string) =>
      prisma.aiQuote.findMany({
        where: { project_id: projectId },
        orderBy: { created_at: 'desc' },
      }),
    find: (id: string) =>
      prisma.aiQuote.findUnique({ where: { id } }),
    insert: (item: any) =>
      prisma.aiQuote.create({ data: item }),
    update: (id: string, patch: any) =>
      prisma.aiQuote.update({ where: { id }, data: patch }),
    delete: (id: string) =>
      prisma.aiQuote.delete({ where: { id } }),
  },

  ai_quote_examples: {
    all: () =>
      prisma.aiQuoteExample.findMany({ orderBy: { created_at: 'desc' } }),
    recent: (limit = 5) =>
      prisma.aiQuoteExample.findMany({ orderBy: { created_at: 'desc' }, take: limit }),
    find: (id: string) =>
      prisma.aiQuoteExample.findUnique({ where: { id } }),
    insert: (item: any) =>
      prisma.aiQuoteExample.create({ data: item }),
    delete: (id: string) =>
      prisma.aiQuoteExample.delete({ where: { id } }),
  },

  extra_costs: {
    forProject: (projectId: string) =>
      prisma.extraCost.findMany({
        where: { project_id: projectId },
        orderBy: { created_at: 'desc' },
      }),
    find: (id: string) =>
      prisma.extraCost.findUnique({ where: { id } }),
    findByToken: (token: string) =>
      prisma.extraCost.findMany({ where: { approval_token: token } }),
    insert: (item: any) =>
      prisma.extraCost.create({ data: item }),
    update: (id: string, patch: any) =>
      prisma.extraCost.update({ where: { id }, data: patch }),
    delete: (id: string) =>
      prisma.extraCost.delete({ where: { id } }),
  },

  access_requests: {
    all: () =>
      prisma.accessRequest.findMany({ orderBy: { created_at: 'desc' } }),
    forProject: (projectId: string) =>
      prisma.accessRequest.findMany({ where: { project_id: projectId } }),
    pendingForUser: (projectId: string, userId: string) =>
      prisma.accessRequest.findFirst({
        where: { project_id: projectId, requester_id: userId, status: 'pending' },
      }),
    find: (id: string) =>
      prisma.accessRequest.findUnique({ where: { id } }),
    insert: (item: any) =>
      prisma.accessRequest.create({ data: item }),
    update: (id: string, patch: any) =>
      prisma.accessRequest.update({ where: { id }, data: patch }),
  },

  notifications: {
    forUser: (userId: string) =>
      prisma.notification.findMany({
        where: { user_id: userId },
        orderBy: { created_at: 'desc' },
        take: 50,
      }),
    unreadCount: (userId: string) =>
      prisma.notification.count({ where: { user_id: userId, read: false } }),
    insert: (item: any) =>
      prisma.notification.create({ data: item }),
    markRead: (userId: string, ids?: string[]) =>
      prisma.notification.updateMany({
        where: { user_id: userId, ...(ids ? { id: { in: ids } } : {}) },
        data: { read: true },
      }),
    resolveByRequestId: (requestId: string, type: 'access_approved' | 'access_rejected') =>
      prisma.notification.updateMany({
        where: { data: { path: ['request_id'], equals: requestId }, type: 'access_request' },
        data: { type, read: true },
      }),
  },

  cost_audit_log: {
    forProject: (projectId: string) =>
      prisma.costAuditLog.findMany({
        where: { project_id: projectId },
        orderBy: { created_at: 'desc' },
        take: 500,
      }),
    insert: (item: any) =>
      prisma.costAuditLog.create({ data: item }),
  },

  bank_transactions: {
    insert: (data: any) =>
      prisma.bankTransaction.create({ data }),
    list: (filter?: any) =>
      prisma.bankTransaction.findMany({ where: filter, orderBy: { transaction_date: 'desc' } }),
    find: (id: string) =>
      prisma.bankTransaction.findUnique({ where: { id } }),
    update: (id: string, data: any) =>
      prisma.bankTransaction.update({ where: { id }, data }),
    deleteAll: () =>
      prisma.bankTransaction.deleteMany(),
    findUnmatched: () =>
      prisma.bankTransaction.findMany({ where: { matched_invoice_id: null } }),
  },

  ksef_invoices: {
    updatePayment: (id: string, data: {
      payment_status?: string | null
      payment_source?: string | null
      paid_amount?:    number | null
      paid_at?:        string | null
      bank_tx_id?:     string | null
    }) => prisma.ksefInvoice.update({ where: { id }, data }),
    listAll: () =>
      prisma.ksefInvoice.findMany({ orderBy: { invoice_date: 'desc' } }),
  },

  smtp_settings: {
    get: () =>
      prisma.smtpSettings.findUnique({ where: { id: 'default' } }),
    save: (data: any) =>
      prisma.smtpSettings.upsert({
        where: { id: 'default' },
        update: { ...data, updated_at: new Date().toISOString() },
        create: { id: 'default', ...data, updated_at: new Date().toISOString() },
      }),
  },
}

export default db
