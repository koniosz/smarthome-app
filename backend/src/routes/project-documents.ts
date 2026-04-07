import { Router, Request, Response } from 'express'
import { v4 as uuidv4 } from 'uuid'
import {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  AlignmentType, BorderStyle, WidthType, ShadingType, HeadingLevel,
  Header, Footer, PageNumber, UnderlineType,
} from 'docx'
import db from '../db'

const router = Router({ mergeParams: true })

function now() { return new Date().toISOString() }

// GET /api/projects/:projectId/documents
router.get('/', async (req: Request, res: Response) => {
  try {
    const docs = await db.project_documents.forProject(req.params.projectId)
    res.json(docs.map((d: any) => { const { file_data, ...meta } = d; return meta }))
  } catch { res.status(500).json({ error: 'Błąd serwera' }) }
})

// POST /api/projects/:projectId/documents
router.post('/', async (req: Request, res: Response) => {
  try {
    const { doc_type, name, file_name, mime_type, file_data, notes } = req.body
    if (!file_data || !file_name) { res.status(400).json({ error: 'Brak pliku' }); return }
    const doc = {
      id: uuidv4(), project_id: req.params.projectId,
      doc_type: doc_type || 'offer',
      name: name || file_name,
      file_name, mime_type: mime_type || 'application/octet-stream',
      file_data, notes: notes || '',
      uploaded_at: now(), uploaded_by: '',
    }
    await db.project_documents.insert(doc)
    const { file_data: _, ...meta } = doc
    res.status(201).json(meta)
  } catch { res.status(500).json({ error: 'Błąd serwera' }) }
})

// GET /api/projects/:projectId/documents/:docId/download
router.get('/:docId/download', async (req: Request, res: Response) => {
  try {
    const doc = await db.project_documents.find(req.params.docId) as any
    if (!doc) { res.status(404).json({ error: 'Nie znaleziono' }); return }
    const buffer = Buffer.from(doc.file_data, 'base64')
    res.setHeader('Content-Type', doc.mime_type)
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(doc.file_name)}`)
    res.send(buffer)
  } catch { res.status(500).json({ error: 'Błąd serwera' }) }
})

// DELETE /api/projects/:projectId/documents/:docId
router.delete('/:docId', async (req: Request, res: Response) => {
  try {
    const doc = await db.project_documents.find(req.params.docId)
    if (!doc) { res.status(404).json({ error: 'Nie znaleziono' }); return }
    await db.project_documents.delete(req.params.docId)
    res.json({ success: true })
  } catch { res.status(500).json({ error: 'Błąd serwera' }) }
})

// ── Contract Generator ─────────────────────────────────────────────────────────
// POST /api/projects/:projectId/documents/generate-contract

function money(n: number) {
  return new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
}

function par(children: TextRun[], opts: any = {}) {
  return new Paragraph({ children, spacing: { after: 160 }, ...opts })
}

function bold(text: string) { return new TextRun({ text, bold: true }) }
function normal(text: string) { return new TextRun({ text }) }

function sectionHeader(text: string) {
  return new Paragraph({
    children: [new TextRun({ text, bold: true, size: 26 })],
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 300, after: 160 },
    alignment: AlignmentType.CENTER,
  })
}

function bullet(text: string) {
  return new Paragraph({
    children: [normal(text)],
    bullet: { level: 0 },
    spacing: { after: 80 },
  })
}

function fieldLine(label: string, value: string) {
  return par([bold(label + ': '), normal(value || '______________________')])
}

router.post('/generate-contract', async (req: Request, res: Response) => {
  try {
    const {
      contract_date,
      // Client
      client_company, client_address, client_krs, client_nip, client_representative,
      // Scope
      scope_description,
      // Schedule
      start_date, end_date,
      // Payment
      total_amount_net,
      tranches,           // [{ label: string, amount: number, due_date: string }]
      // Guarantee
      guarantee_months,
      // SHC data (override defaults)
      shc_representative,
      // Location reference (for §3)
      location_name,
    } = req.body as {
      contract_date: string
      client_company: string; client_address: string; client_krs?: string
      client_nip?: string; client_representative: string
      scope_description: string
      start_date: string; end_date: string
      total_amount_net: number
      tranches: Array<{ label: string; amount: number; due_date: string }>
      guarantee_months: number
      shc_representative?: string
      location_name?: string
    }

    const shcRep = shc_representative || 'Prezesa Zarządu - Dorotę Szychtę'
    const tranchesList = Array.isArray(tranches) ? tranches : []
    const guarMonths = guarantee_months || 24
    const loc = location_name || 'miejscu wykonywania prac'

    const border = { style: BorderStyle.SINGLE, size: 1, color: 'DDDDDD' }
    const borders = { top: border, bottom: border, left: border, right: border }

    const trancheRows = tranchesList.map((t, i) =>
      new TableRow({
        children: [
          new TableCell({
            borders, width: { size: 1500, type: WidthType.DXA },
            margins: { top: 80, bottom: 80, left: 120, right: 120 },
            children: [new Paragraph({ children: [normal(`Transza ${i + 1}`)] })],
          }),
          new TableCell({
            borders, width: { size: 3500, type: WidthType.DXA },
            margins: { top: 80, bottom: 80, left: 120, right: 120 },
            children: [new Paragraph({ children: [bold(`${money(t.amount)} PLN netto`)] })],
          }),
          new TableCell({
            borders, width: { size: 4000, type: WidthType.DXA },
            margins: { top: 80, bottom: 80, left: 120, right: 120 },
            children: [new Paragraph({ children: [normal(`płatna do dnia ${t.due_date || '___________'}${t.label ? ' (' + t.label + ')' : ''}`)] })],
          }),
        ],
      })
    )

    const doc = new Document({
      styles: {
        default: {
          document: { run: { font: 'Arial', size: 24 } },
        },
        paragraphStyles: [
          {
            id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal',
            run: { size: 26, bold: true, font: 'Arial' },
            paragraph: { spacing: { before: 300, after: 160 }, outlineLevel: 1 },
          },
        ],
      },
      sections: [{
        properties: {
          page: {
            size: { width: 11906, height: 16838 },
            margin: { top: 1440, right: 1080, bottom: 1440, left: 1440 },
          },
        },
        footers: {
          default: new Footer({
            children: [new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [
                new TextRun({ text: 'Strona ', size: 18, color: '999999' }),
                new TextRun({ children: [PageNumber.CURRENT], size: 18, color: '999999' }),
                new TextRun({ text: ' z ', size: 18, color: '999999' }),
                new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 18, color: '999999' }),
              ],
            })],
          }),
        },
        children: [
          // Title
          new Paragraph({
            children: [new TextRun({ text: 'UMOWA', bold: true, size: 52, font: 'Arial' })],
            alignment: AlignmentType.CENTER,
            spacing: { before: 480, after: 240 },
          }),
          par([normal(`zawarta w dniu ${contract_date || '___________'} pomiędzy:`)], { alignment: AlignmentType.CENTER }),

          // Client party
          new Paragraph({
            children: [
              bold(client_company || '______________________'),
              normal(` z siedzibą w ${client_address || '______________________'}`),
              ...(client_krs ? [normal(`, wpisaną do Rejestru Przedsiębiorców prowadzonego przez Sąd Rejonowy pod numerem KRS: ${client_krs}`)] : []),
              ...(client_nip ? [normal(`, NIP: ${client_nip}`)] : []),
              normal(`, reprezentowaną przez ${client_representative || '______________________'},`),
            ],
            spacing: { after: 80 },
          }),
          par([bold('zwanym w dalszej części umowy ZAMAWIAJĄCYM')]),
          par([bold('a')], { alignment: AlignmentType.CENTER }),

          // SHC party
          new Paragraph({
            children: [
              bold('Smart Home Center Sp. z o.o.'),
              normal(' z siedzibą w Warszawie, wpisaną do Rejestru Przedsiębiorców prowadzonego przez Sąd Rejonowy dla Miasta Stołecznego Warszawy, XIII Wydział Gospodarczy KRS, Adres: Gieysztora 6 lok. U8, 02-999 Warszawa, NIP: PL9512423139, reprezentowaną przez '),
              normal(shcRep),
              normal(','),
            ],
            spacing: { after: 80 },
          }),
          par([bold('zwanym w dalszej części umowy WYKONAWCĄ')]),

          // §1
          sectionHeader('§1\nPRZEDMIOT UMOWY'),
          par([
            normal('Przedmiotem umowy jest '),
            normal(scope_description || 'wykonanie instalacji domu inteligentnego zgodnie z ofertą stanowiącą Załącznik nr 1 do Umowy.'),
          ]),
          par([normal('Szczegółowy spis urządzeń i zakresu prac określa Załącznik nr 1 do umowy.')]),
          par([
            normal('W trakcie realizacji umowy WYKONAWCA może wykonać konieczne roboty dodatkowe, które – wraz z wyceną – zostaną zgłoszone przez WYKONAWCĘ ZAMAWIAJĄCEMU w formie poczty e-mail i zostaną zatwierdzone przez ZAMAWIAJĄCEGO. Roboty dodatkowe rozliczone zostaną na podstawie odrębnej faktury wystawionej przez WYKONAWCĘ po cenach zaakceptowanych przez ZAMAWIAJĄCEGO.'),
          ]),
          par([bold('WYKONAWCA zobowiązuje się, że Przedmiot Umowy wykona:')]),
          bullet(`termin rozpoczęcia prac: ${start_date || '___________'}`),
          bullet(`termin zakończenia prac: ${end_date || '___________'}`),
          par([
            normal('WYKONAWCA zastrzega sobie prawo przedłużenia terminu zakończenia robót w przypadku wystąpienia nieprzewidywalnych i niezależnych od Wykonawcy przeszkód.'),
          ]),

          // §2
          sectionHeader('§2\nOBOWIĄZKI I PRAWA ZAMAWIAJĄCEGO'),
          par([normal('ZAMAWIAJĄCY ma obowiązek:')]),
          bullet('Nieodpłatnie udostępnić pobór energii elektrycznej w celu wykonania Przedmiotu Umowy.'),
          bullet('Udostępnić klucze lub w inny sposób zapewnić dostęp do pomieszczeń, w których planowane jest przeprowadzenie prac.'),
          par([
            normal('ZAMAWIAJĄCY zobowiązuje się do dokonania odbioru zadania lub etapu zadania w terminie do 14 dni roboczych od dnia zgłoszenia zakończenia prac przez WYKONAWCĘ.'),
          ]),

          // §3
          sectionHeader('§3\nOBOWIĄZKI WYKONAWCY'),
          par([normal('WYKONAWCA oświadcza, że będzie prowadzić roboty z najwyższą starannością, zgodnie z obowiązującymi przepisami, standardami i normami obowiązującymi na terenie Rzeczypospolitej Polskiej.')]),
          par([normal('WYKONAWCA oświadcza, że posiada niezbędne kwalifikacje, wiedzę i uprawnienia oraz niezbędne środki i narzędzia do prawidłowego i kompletnego wykonania robót.')]),
          ...(location_name ? [par([normal(`WYKONAWCA oświadcza, że prace zostaną wykonane zgodnie z regulaminem i przepisami obowiązującymi w ${loc}.`)])] : []),
          par([normal('WYKONAWCA może w ramach niniejszej umowy zlecać innym podmiotom, jako podwykonawcom, wykonanie części zakresu niniejszej umowy.')]),
          par([normal('WYKONAWCA zobowiązany jest do zabezpieczenia miejsca wykonania prac ze szczególnym uwzględnieniem bezpieczeństwa osób trzecich. WYKONAWCA oświadcza, iż posiada ubezpieczenie OC.')]),
          par([normal('WYKONAWCA jest zobowiązany do zachowania w poufności wszelkich informacji, których dowiedział się przy realizacji lub w związku z niniejszą umową.')]),
          par([normal('Wszelkie szkody wynikłe z okoliczności leżących po stronie WYKONAWCY pokrywa WYKONAWCA w całości.')]),

          // §4
          sectionHeader('§4\nWYNAGRODZENIE WYKONAWCY I ROZLICZENIA'),
          par([
            normal('Za wykonanie Przedmiotu Umowy WYKONAWCA otrzyma od ZAMAWIAJĄCEGO wynagrodzenie w wysokości '),
            bold(`${money(total_amount_net || 0)} zł netto`),
            normal('.'),
          ]),
          par([normal('Kwota powyżej odpowiada wstępnym założeniom. Szczegółowy zakres prac i urządzeń może się zmienić na zasadach określonych Umową za zgodą ZAMAWIAJĄCEGO.')]),
          par([normal('Rozliczenie zostanie podzielone na transze, płatne na podstawie faktury VAT zgodnie z zaakceptowaną ofertą stanowiącą Załącznik nr 1:')]),
          ...(tranchesList.length > 0 ? [
            new Table({
              width: { size: 9000, type: WidthType.DXA },
              columnWidths: [1500, 3500, 4000],
              rows: [
                new TableRow({
                  children: [
                    new TableCell({
                      borders, width: { size: 1500, type: WidthType.DXA },
                      margins: { top: 80, bottom: 80, left: 120, right: 120 },
                      shading: { fill: 'F3F0FF', type: ShadingType.CLEAR },
                      children: [new Paragraph({ children: [bold('Transza')] })],
                    }),
                    new TableCell({
                      borders, width: { size: 3500, type: WidthType.DXA },
                      margins: { top: 80, bottom: 80, left: 120, right: 120 },
                      shading: { fill: 'F3F0FF', type: ShadingType.CLEAR },
                      children: [new Paragraph({ children: [bold('Kwota')] })],
                    }),
                    new TableCell({
                      borders, width: { size: 4000, type: WidthType.DXA },
                      margins: { top: 80, bottom: 80, left: 120, right: 120 },
                      shading: { fill: 'F3F0FF', type: ShadingType.CLEAR },
                      children: [new Paragraph({ children: [bold('Termin płatności')] })],
                    }),
                  ],
                }),
                ...trancheRows,
              ],
            }),
            new Paragraph({ children: [], spacing: { after: 160 } }),
          ] : [par([normal('(szczegóły transz określone w Załączniku nr 1)')])]),

          // §5
          sectionHeader('§5\nGWARANCJA'),
          par([normal(`WYKONAWCA udziela ZAMAWIAJĄCEMU gwarancji na poprawność montażu dostarczanych instalacji, systemów i urządzeń. Termin gwarancji wynosi ${guarMonths} miesięcy od daty końcowego odbioru Przedmiotu Umowy.`)]),
          par([normal('WYKONAWCA zobowiązuje się do bezzwłocznego usunięcia na własny koszt wad i usterek stwierdzonych w okresie gwarancji, w uzgodnionym przez obie strony terminie.')]),
          par([normal('O istnieniu wady ZAMAWIAJĄCY jest zobowiązany powiadomić WYKONAWCĘ na piśmie lub za pośrednictwem poczty e-mail. W ciągu 7 dni od otrzymania informacji, WYKONAWCA zobowiązany jest udzielić odpowiedzi o terminie usunięcia usterki.')]),
          par([normal('WYKONAWCA nie odpowiada za szkody związane z ingerencją osób trzecich w dostarczone systemy.')]),
          par([normal('ZAMAWIAJĄCEMU przysługuje 1 serwis w zakresie zmiany konfiguracji systemu w okresie trwania gwarancji. Dodatkowe prace związane ze zmianą konfiguracji będą uzgadniane indywidualnie.')]),

          // §6
          sectionHeader('§6\nPOSTANOWIENIA KOŃCOWE'),
          par([normal('Wszelkie zmiany treści niniejszej Umowy wymagają formy pisemnej lub elektronicznej z podpisem kwalifikowanym pod rygorem ich nieważności.')]),
          par([normal('Uzgodnienia wymagające formy email będą dokonywane z następujących adresów:')]),
          fieldLine('dla ZAMAWIAJĄCEGO', ''),
          fieldLine('dla WYKONAWCY', ''),
          par([normal('W sprawach nieuregulowanych w niniejszej Umowie zastosowanie mają przepisy Kodeksu Cywilnego.')]),
          par([normal('Spory wynikłe z wykonania niniejszej umowy strony będą rozwiązywać polubownie, a jeśli nie będzie to możliwe, spór będzie rozstrzygany przez Sąd właściwy dla miejsca zamieszkania WYKONAWCY.')]),
          par([normal('Umowę sporządzono w dwóch jednobrzmiących egzemplarzach po jednym egzemplarzu dla każdej ze Stron.')]),
          par([]),
          par([bold('Załączniki:')]),
          bullet('Załącznik nr 1 – oferta/wycena'),

          // Signatures
          new Paragraph({ children: [], spacing: { before: 600, after: 0 } }),
          new Table({
            width: { size: 9000, type: WidthType.DXA },
            columnWidths: [4200, 600, 4200],
            rows: [
              new TableRow({
                children: [
                  new TableCell({
                    borders: { top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE } },
                    width: { size: 4200, type: WidthType.DXA },
                    children: [
                      new Paragraph({ children: [bold('WYKONAWCA')], alignment: AlignmentType.CENTER }),
                      new Paragraph({ children: [new TextRun({ text: ' ', size: 48 })], spacing: { before: 600 } }),
                      new Paragraph({
                        children: [new TextRun({ text: '________________________________', color: '999999' })],
                        alignment: AlignmentType.CENTER,
                      }),
                      new Paragraph({ children: [normal('Smart Home Center Sp. z o.o.')], alignment: AlignmentType.CENTER }),
                    ],
                  }),
                  new TableCell({
                    borders: { top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE } },
                    width: { size: 600, type: WidthType.DXA },
                    children: [new Paragraph({ children: [] })],
                  }),
                  new TableCell({
                    borders: { top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE } },
                    width: { size: 4200, type: WidthType.DXA },
                    children: [
                      new Paragraph({ children: [bold('ZAMAWIAJĄCY')], alignment: AlignmentType.CENTER }),
                      new Paragraph({ children: [new TextRun({ text: ' ', size: 48 })], spacing: { before: 600 } }),
                      new Paragraph({
                        children: [new TextRun({ text: '________________________________', color: '999999' })],
                        alignment: AlignmentType.CENTER,
                      }),
                      new Paragraph({ children: [normal(client_company || '')], alignment: AlignmentType.CENTER }),
                    ],
                  }),
                ],
              }),
            ],
          }),
        ],
      }],
    })

    const buffer = await Packer.toBuffer(doc)
    const safeName = `Umowa_${(client_company || 'Klient').replace(/[^a-zA-Z0-9]/g, '_')}_${(contract_date || '').replace(/-/g, '')}.docx`

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}`)
    res.send(buffer)
  } catch (e) {
    console.error('[generate-contract]', e)
    res.status(500).json({ error: 'Błąd generowania umowy' })
  }
})

export default router
