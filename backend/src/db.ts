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
    findByUserId: (userId: string) =>
      prisma.employee.findFirst({ where: { user_id: userId } }),
    findByEmail: (email: string) =>
      prisma.employee.findFirst({ where: { email } }),
    insert: (item: any) =>
      prisma.employee.create({ data: item }),
    update: (id: string, patch: any) =>
      prisma.employee.update({ where: { id }, data: patch }),
    delete: (id: string) =>
      prisma.employee.delete({ where: { id } }),
    allForAlerts: () =>
      prisma.employee.findMany({
        where: { OR: [{ medical_exam_date: { not: null } }, { bhp_date: { not: null } }] },
        select: { id: true, name: true, medical_exam_date: true, bhp_date: true },
      }),
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

  warehouse_items: {
    all: () => prisma.warehouseItem.findMany({ orderBy: { name: 'asc' } }),
    find: (id: string) => prisma.warehouseItem.findUnique({ where: { id } }),
    insert: (item: any) => prisma.warehouseItem.create({ data: item }),
    update: (id: string, patch: any) => prisma.warehouseItem.update({ where: { id }, data: patch }),
    delete: (id: string) => prisma.warehouseItem.delete({ where: { id } }),
  },

  stock_movements: {
    forItem: (warehouseItemId: string) =>
      prisma.stockMovement.findMany({ where: { warehouse_item_id: warehouseItemId }, orderBy: { created_at: 'desc' } }),
    recent: (limit = 200) =>
      prisma.stockMovement.findMany({ orderBy: { created_at: 'desc' }, take: limit }),
    insert: (item: any) => prisma.stockMovement.create({ data: item }),
  },

  warehouse_docs: {
    all: () => prisma.warehouseDoc.findMany({ orderBy: { created_at: 'desc' } }),
    find: (id: string) => prisma.warehouseDoc.findUnique({ where: { id }, include: { lines: true } }),
    countForPrefix: (prefix: string, type: string) =>
      prisma.warehouseDoc.count({ where: { type, number: { startsWith: prefix } } }),
    insert: (item: any) => prisma.warehouseDoc.create({ data: item }),
    update: (id: string, patch: any) => prisma.warehouseDoc.update({ where: { id }, data: patch }),
    delete: (id: string) => prisma.warehouseDoc.delete({ where: { id } }),
  },
  warehouse_doc_lines: {
    insert: (item: any) => prisma.warehouseDocLine.create({ data: item }),
  },

  leave_balances: {
    forEmployeeYear: (employeeId: string, year: number) =>
      prisma.leaveBalance.findUnique({ where: { employee_id_year: { employee_id: employeeId, year } } }),
    forYear: (year: number) =>
      prisma.leaveBalance.findMany({ where: { year } }),
    upsert: (employeeId: string, year: number, patch: any, createDefaults: any) =>
      prisma.leaveBalance.upsert({
        where: { employee_id_year: { employee_id: employeeId, year } },
        update: patch,
        create: { ...createDefaults, ...patch, employee_id: employeeId, year },
      }),
  },

  leave_requests: {
    forEmployee: (employeeId: string) =>
      prisma.leaveRequest.findMany({ where: { employee_id: employeeId }, orderBy: { created_at: 'desc' } }),
    all: (status?: string) =>
      prisma.leaveRequest.findMany({
        where: status ? { status } : undefined,
        include: { employee: { select: { id: true, name: true } } },
        orderBy: { created_at: 'desc' },
      }),
    approvedInRange: (employeeId: string, from: string, to: string) =>
      prisma.leaveRequest.findMany({
        where: { employee_id: employeeId, status: 'approved', date_from: { lte: to }, date_to: { gte: from } },
      }),
    find: (id: string) => prisma.leaveRequest.findUnique({ where: { id } }),
    insert: (item: any) => prisma.leaveRequest.create({ data: item }),
    update: (id: string, patch: any) => prisma.leaveRequest.update({ where: { id }, data: patch }),
  },

  work_time_entries: {
    forEmployeeMonth: (employeeId: string, monthPrefix: string) =>
      prisma.workTimeEntry.findMany({
        where: { employee_id: employeeId, date: { startsWith: monthPrefix } },
        orderBy: { date: 'asc' },
      }),
    forEmployeeRange: (employeeId: string, from: string, to: string) =>
      prisma.workTimeEntry.findMany({
        where: { employee_id: employeeId, date: { gte: from, lte: to } },
        orderBy: { date: 'asc' },
      }),
    find: (id: string) => prisma.workTimeEntry.findUnique({ where: { id } }),
    upsertForDay: (employeeId: string, date: string, patch: any, createDefaults: any) =>
      prisma.workTimeEntry.upsert({
        where: { employee_id_date: { employee_id: employeeId, date } },
        update: patch,
        create: { ...createDefaults, ...patch, employee_id: employeeId, date },
      }),
    delete: (id: string) => prisma.workTimeEntry.delete({ where: { id } }),
  },

  handover_protocols: {
    forProject: (projectId: string) =>
      prisma.handoverProtocol.findMany({ where: { project_id: projectId }, orderBy: { created_at: 'desc' } }),
    find: (id: string) => prisma.handoverProtocol.findUnique({ where: { id } }),
    findByToken: (token: string) => prisma.handoverProtocol.findFirst({ where: { token } }),
    countForPrefix: (prefix: string) => prisma.handoverProtocol.count({ where: { number: { startsWith: prefix } } }),
    insert: (item: any) => prisma.handoverProtocol.create({ data: item }),
    update: (id: string, patch: any) => prisma.handoverProtocol.update({ where: { id }, data: patch }),
    delete: (id: string) => prisma.handoverProtocol.delete({ where: { id } }),
  },

  ai_quotes: {
    forProject: (projectId: string) =>
      prisma.aiQuote.findMany({
        where: { project_id: projectId },
        orderBy: { created_at: 'desc' },
      }),
    // Wyceny samodzielne (bez projektu) — dla zakładki „Wycena"
    allStandalone: () =>
      prisma.aiQuote.findMany({
        where: { project_id: null },
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

  tasks: {
    all: () =>
      prisma.task.findMany({
        include: {
          project: { select: { id: true, name: true } },
          assignees: { include: { employee: { select: { id: true, name: true, email: true } } } },
        },
        orderBy: [{ date: 'asc' }, { time: 'asc' }],
      }),
    find: (id: string) =>
      prisma.task.findUnique({
        where: { id },
        include: {
          project: { select: { id: true, name: true } },
          assignees: { include: { employee: { select: { id: true, name: true, email: true } } } },
        },
      }),
    insert: (item: any) =>
      prisma.task.create({
        data: item,
        include: {
          project: { select: { id: true, name: true } },
          assignees: { include: { employee: { select: { id: true, name: true, email: true } } } },
        },
      }),
    update: (id: string, patch: any) =>
      prisma.task.update({
        where: { id },
        data: patch,
        include: {
          project: { select: { id: true, name: true } },
          assignees: { include: { employee: { select: { id: true, name: true, email: true } } } },
        },
      }),
    delete: (id: string) =>
      prisma.task.delete({ where: { id } }),
    addAssignee: (taskId: string, employeeId: string, createdAt: string) =>
      prisma.taskAssignee.create({
        data: { id: require('uuid').v4(), task_id: taskId, employee_id: employeeId, created_at: createdAt },
      }),
    removeAssignee: (id: string) =>
      prisma.taskAssignee.delete({ where: { id } }),
    setAssigneeEvent: (id: string, eventId: string | null, owner: string | null) =>
      prisma.taskAssignee.update({ where: { id }, data: { outlook_event_id: eventId, outlook_event_owner: owner } }),
  },

  extra_costs: {
    allWithProjects: () =>
      prisma.extraCost.findMany({
        include: { project: { select: { id: true, name: true } } },
        orderBy: { created_at: 'desc' },
      }),
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

  employee_assets: {
    forEmployee: (employeeId: string) => prisma.employeeAsset.findMany({ where: { employee_id: employeeId }, orderBy: { created_at: 'desc' } }),
    find: (id: string) => prisma.employeeAsset.findUnique({ where: { id } }),
    insert: (data: any) => prisma.employeeAsset.create({ data }),
    update: (id: string, data: any) => prisma.employeeAsset.update({ where: { id }, data }),
    delete: (id: string) => prisma.employeeAsset.delete({ where: { id } }),
    allCars: () => prisma.employeeAsset.findMany({
      where: { asset_type: 'car' },
      include: { employee: { select: { id: true, name: true } } },
    }),
  },
  employee_documents: {
    forEmployee: (employeeId: string) => prisma.employeeDocument.findMany({ where: { employee_id: employeeId }, orderBy: { uploaded_at: 'desc' } }),
    find: (id: string) => prisma.employeeDocument.findUnique({ where: { id } }),
    insert: (data: any) => prisma.employeeDocument.create({ data }),
    delete: (id: string) => prisma.employeeDocument.delete({ where: { id } }),
  },

  project_documents: {
    forProject: (projectId: string) =>
      prisma.projectDocument.findMany({ where: { project_id: projectId }, orderBy: { uploaded_at: 'desc' } }),
    find: (id: string) =>
      prisma.projectDocument.findUnique({ where: { id } }),
    insert: (data: any) =>
      prisma.projectDocument.create({ data }),
    delete: (id: string) =>
      prisma.projectDocument.delete({ where: { id } }),
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

  client_surveys: {
    forProject: (projectId: string) =>
      prisma.clientSurvey.findMany({
        where: { project_id: projectId },
        orderBy: { created_at: 'desc' },
      }),
    find: (id: string) =>
      prisma.clientSurvey.findUnique({ where: { id }, include: { attachments: true } }),
    findByToken: (token: string) =>
      prisma.clientSurvey.findUnique({ where: { token }, include: { project: { select: { name: true } }, attachments: true } }),
    insert: (data: any) =>
      prisma.clientSurvey.create({ data }),
    update: (id: string, patch: any) =>
      prisma.clientSurvey.update({ where: { id }, data: patch }),
    delete: (id: string) =>
      prisma.clientSurvey.delete({ where: { id } }),
  },

  client_survey_attachments: {
    find: (id: string) =>
      prisma.clientSurveyAttachment.findUnique({ where: { id } }),
    insert: (data: any) =>
      prisma.clientSurveyAttachment.create({ data }),
    delete: (id: string) =>
      prisma.clientSurveyAttachment.delete({ where: { id } }),
  },
}

export default db
