import dotenv from 'dotenv'
import path from 'path'
// Load .env from backend root regardless of process CWD
dotenv.config({ path: path.resolve(__dirname, '..', '.env'), override: true })
import express from 'express'
import cors from 'cors'
import fs from 'fs'
import os from 'os'
import projectsRouter from './routes/projects'
import costsRouter from './routes/costs'
import { updateCost, deleteCost } from './routes/costs'
import laborRouter from './routes/labor'
import { updateLabor, deleteLabor } from './routes/labor'
import paymentsRouter, { updatePayment, deletePayment } from './routes/payments'
import employeesRouter from './routes/employees'
import dashboardRouter from './routes/dashboard'
import attachmentsRouter from './routes/attachments'
import authRouter from './routes/auth'
import usersRouter from './routes/users'
import aiQuotesRouter from './routes/ai-quotes'
import productCatalogRouter from './routes/product-catalog'
import extraCostsRouter, { updateExtraCost, deleteExtraCost, approveExtraCost, rejectExtraCost, submitRejectExtraCost, approveSmsByJwt } from './routes/extra-costs'
import accessRequestsRouter from './routes/access-requests'
import notificationsRouter from './routes/notifications'
import aiQuoteExamplesRouter from './routes/ai-quote-examples'
import ksefRouter from './routes/ksef'
import bankRouter, { updateKsefPayment, p24WebhookHandler } from './routes/bank'
import settingsRouter from './routes/settings'
import { syncInvoices } from './services/ksef'
import { requireAuth } from './middleware/auth'

const app = express()
const PORT = process.env.PORT || 4001

app.use(cors())
app.use(express.json({ limit: '10mb' }))

// Public routes
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})
app.use('/api/auth', authRouter)

// Publiczne endpointy zatwierdzenia kosztów dodatkowych (klient klika link z emaila — bez JWT)
app.get('/api/extra-costs/approve/:token',      approveExtraCost)
app.get('/api/extra-costs/reject/:token',       rejectExtraCost)
app.post('/api/extra-costs/reject/:token',      submitRejectExtraCost)
// JWT-based SMS approval — token is self-contained, no DB lookup
app.get('/api/extra-costs/approve-sms/:jwtToken', approveSmsByJwt)

// Publiczne serwowanie załączników (pliki mają losowe nazwy — bezpieczeństwo przez obscurity)
// MUSI być przed requireAuth, bo przeglądarka otwierając link w nowej karcie nie wysyła JWT
app.use('/api', attachmentsRouter)

// P24 webhook — public (przed requireAuth), weryfikacja przez podpis CRC
app.post('/api/bank/przelewy24/webhook', p24WebhookHandler)

// All routes below require authentication
app.use('/api', requireAuth)

// Dashboard
app.use('/api/dashboard', dashboardRouter)

// Projects
app.use('/api/projects', projectsRouter)
app.use('/api/projects/:projectId/costs', costsRouter)
app.use('/api/projects/:projectId/labor', laborRouter)
app.use('/api/projects/:projectId/payments', paymentsRouter)

// Employees
app.use('/api/employees', employeesRouter)

// Standalone update & delete
app.put('/api/costs/:id', updateCost)
app.delete('/api/costs/:id', deleteCost)
app.put('/api/labor/:id', updateLabor)
app.delete('/api/labor/:id', deleteLabor)
app.put('/api/payments/:id', updatePayment)
app.delete('/api/payments/:id', deletePayment)

// Users & project members management (admin only)
app.use('/api/users', usersRouter)
app.use('/api', usersRouter)

// AI Quotes & Product Catalog
app.use('/api/projects/:projectId/ai-quotes', aiQuotesRouter)
app.use('/api/product-catalog', productCatalogRouter)
app.use('/api/ai-quote-examples', aiQuoteExamplesRouter)

// Extra Costs (koszty dodatkowe)
app.use('/api/projects/:projectId/extra-costs', extraCostsRouter)
app.put('/api/extra-costs/:id', updateExtraCost)
app.delete('/api/extra-costs/:id', deleteExtraCost)

// Access requests & Notifications
app.use('/api/access-requests', accessRequestsRouter)
app.use('/api/notifications', notificationsRouter)

// KSeF — Krajowy System e-Faktur (admin only)
app.use('/api/ksef', ksefRouter)

// Bank payment verification
app.use('/api/bank', bankRouter)
app.patch('/api/ksef/invoices/:id/payment', updateKsefPayment)

// App settings (admin only)
app.use('/api/settings', settingsRouter)

// ── Serve frontend static files (production / network mode) ──────────────────
const DIST_DIR = path.join(__dirname, '..', '..', 'frontend', 'dist')
if (fs.existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR))
  // SPA fallback — every non-API route returns index.html
  app.get('*', (_req, res) => {
    res.sendFile(path.join(DIST_DIR, 'index.html'))
  })
}

// ── Determine local network IP ────────────────────────────────────────────────
function getLocalIP(): string {
  const ifaces = os.networkInterfaces()
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address
      }
    }
  }
  return 'localhost'
}

const server = app.listen(Number(PORT), '0.0.0.0', () => {
  const localIP = getLocalIP()
  const hasFrontend = fs.existsSync(DIST_DIR)
  console.log(`\n🏠 Smart Home Manager`)
  console.log(`   Lokalnie:  http://localhost:${PORT}`)
  if (localIP !== 'localhost') {
    console.log(`   Sieć LAN:  http://${localIP}:${PORT}`)
  }
  if (!hasFrontend) {
    console.log(`\n   ⚠️  Frontend nie jest zbudowany.`)
    console.log(`   Uruchom: ./start-network.sh  aby zbudować i udostępnić w sieci.`)
  }
  console.log()
})

// ── KSeF — automatyczna synchronizacja co 30 minut ───────────────────────────
if (process.env.KSEF_NIP && process.env.KSEF_TOKEN) {
  const KSEF_INTERVAL = 30 * 60 * 1000 // 30 minut
  // Pierwsze uruchomienie po 2 minutach od startu (żeby serwer zdążył się postawić)
  setTimeout(async () => {
    console.log('[KSeF] Pierwsze uruchomienie synchronizacji...')
    try { await syncInvoices() } catch (e: any) { console.error('[KSeF] Błąd:', e.message) }
    // Następnie co 30 minut
    setInterval(async () => {
      console.log('[KSeF] Automatyczna synchronizacja...')
      try { await syncInvoices() } catch (e: any) { console.error('[KSeF] Błąd:', e.message) }
    }, KSEF_INTERVAL)
  }, 2 * 60 * 1000)
  console.log('[KSeF] Automatyczna synchronizacja co 30 minut włączona')
} else {
  console.log('[KSeF] Brak konfiguracji (KSEF_NIP/KSEF_TOKEN) — synchronizacja wyłączona')
}

// Zwiększ timeout dla długich zapytań AI (rzuty, cenniki)
// Render free ma 30s timeout w proxy — to nie obejdzie limitu Render,
// ale zapobiega przedwczesnemu zamknięciu połączenia od strony Node.js
server.timeout = 120000        // 2 minuty
server.keepAliveTimeout = 120000
server.headersTimeout = 125000
