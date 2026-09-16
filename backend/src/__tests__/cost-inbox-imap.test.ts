/**
 * Testy filtrów skrzynki IMAP (czyste reguły + fixture MIME przez mailparser, bez bazy i bez serwera).
 * Uruchom: cd backend && npx tsx --test src/__tests__/cost-inbox-imap.test.ts
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { simpleParser } from 'mailparser'
import {
  classifyAttachment, structureHasCandidate,
  MAX_MESSAGE_BYTES, MIN_IMAGE_BYTES, MAX_MESSAGES_PER_RUN, IMAP_BUSY_ERROR,
} from '../services/cost-inbox-imap'
import { MAX_FILE_BYTES } from '../routes/cost-documents'

const KB = 1024
const MB = 1024 * 1024

describe('classifyAttachment — załączniki po sparsowaniu', () => {
  it('PDF przechodzi niezależnie od rozmiaru minimalnego i dyspozycji', () => {
    assert.deepEqual(classifyAttachment({ contentType: 'application/pdf', filename: 'fv.pdf', size: 900 }), { mime: 'application/pdf' })
    assert.deepEqual(classifyAttachment({ contentType: 'application/pdf', filename: 'fv.pdf', related: true, size: 900 }), { mime: 'application/pdf' })
  })
  it('application/octet-stream z nazwą .pdf → PDF', () => {
    assert.equal(classifyAttachment({ contentType: 'application/octet-stream', filename: 'Faktura 12.PDF', size: 50 * KB }).mime, 'application/pdf')
  })
  it('załącznik > 10 MB pominięty (too_large), pusty pominięty (empty)', () => {
    assert.equal(classifyAttachment({ contentType: 'application/pdf', filename: 'x.pdf', size: MAX_FILE_BYTES + 1 }).skip, 'too_large')
    assert.equal(classifyAttachment({ contentType: 'application/pdf', filename: 'x.pdf', size: MAX_FILE_BYTES }).skip, undefined)
    assert.equal(classifyAttachment({ contentType: 'application/pdf', filename: 'x.pdf', size: 0 }).skip, 'empty')
  })
  it('nieobsługiwany MIME (docx, gif, zip) → mime', () => {
    assert.equal(classifyAttachment({ contentType: 'application/zip', filename: 'a.zip', size: 5 * MB }).skip, 'mime')
    assert.equal(classifyAttachment({ contentType: 'image/gif', filename: 'a.gif', size: 300 * KB }).skip, 'mime')
  })
  it('obraz osadzony w HTML (related) → inline_image, nawet gdy duży', () => {
    assert.equal(classifyAttachment({ contentType: 'image/png', filename: 'image001.png', related: true, size: 8 * KB }).skip, 'inline_image')
    assert.equal(classifyAttachment({ contentType: 'image/jpeg', filename: 'banner.jpg', related: true, size: 400 * KB }).skip, 'inline_image')
  })
  it('obraz < 20 KB (ikona/logo bez related) → small_image; ≥ 20 KB przechodzi', () => {
    assert.equal(classifyAttachment({ contentType: 'image/png', filename: 'logo.png', size: MIN_IMAGE_BYTES - 1 }).skip, 'small_image')
    assert.deepEqual(classifyAttachment({ contentType: 'image/jpeg', filename: 'IMG_0001.jpeg', size: MIN_IMAGE_BYTES }), { mime: 'image/jpeg' })
    assert.deepEqual(classifyAttachment({ contentType: 'image/jpg', filename: 'paragon.jpg', size: 2 * MB }), { mime: 'image/jpeg' })
  })
})

describe('structureHasCandidate — pre-filtr po BODYSTRUCTURE (bez pobierania treści)', () => {
  const text = (type: string, size = 500) => ({ part: '1', type, parameters: { charset: 'utf-8' }, encoding: 'quoted-printable', size })
  const leaf = (type: string, over: any = {}) => ({ type, encoding: 'base64', ...over })

  it('brak struktury → true (decyzja po sparsowaniu)', () => {
    assert.equal(structureHasCandidate(undefined), true)
    assert.equal(structureHasCandidate(null), true)
  })
  it('sam tekst / alternative → false (nie pobieramy źródła)', () => {
    assert.equal(structureHasCandidate(text('text/plain') as any), false)
    assert.equal(structureHasCandidate({ type: 'multipart/alternative', childNodes: [text('text/plain'), text('text/html')] } as any), false)
  })
  it('logo w multipart/related (Content-ID) → false; ta sama struktura + PDF w mixed → true', () => {
    const related = {
      type: 'multipart/related',
      childNodes: [
        text('text/html', 3000),
        leaf('image/png', { id: '<image001.png@01DC>', disposition: 'inline', dispositionParameters: { filename: 'image001.png' }, size: 11 * KB }),
      ],
    }
    assert.equal(structureHasCandidate({ type: 'multipart/alternative', childNodes: [text('text/plain'), related] } as any), false)
    const mixed = {
      type: 'multipart/mixed',
      childNodes: [
        { type: 'multipart/alternative', childNodes: [text('text/plain'), related] },
        leaf('application/pdf', { disposition: 'attachment', dispositionParameters: { filename: 'FV-2026-08-015.pdf' }, size: 180 * KB }),
      ],
    }
    assert.equal(structureHasCandidate(mixed as any), true)
  })
  it('octet-stream z nazwą .pdf → true; zdjęcie inline z cid POZA related (Apple Mail) → true', () => {
    assert.equal(structureHasCandidate({
      type: 'multipart/mixed',
      childNodes: [text('text/plain'), leaf('application/octet-stream', { disposition: 'attachment', dispositionParameters: { filename: 'skan.pdf' }, size: 2 * MB })],
    } as any), true)
    assert.equal(structureHasCandidate({
      type: 'multipart/mixed',
      childNodes: [text('text/plain'), leaf('image/jpeg', { id: '<A1B2@apple>', disposition: 'inline', dispositionParameters: { filename: 'IMG_0412.jpeg' }, size: 1.8 * MB })],
    } as any), true)
  })
  it('obraz zakodowany < 20 KB → false; część > 10 MB×1,4 → false; 9,9 MB PDF (zakodowany 13,6 MB) → true', () => {
    assert.equal(structureHasCandidate({
      type: 'multipart/mixed', childNodes: [text('text/plain'), leaf('image/png', { disposition: 'attachment', dispositionParameters: { filename: 'ikona.png' }, size: 12 * KB })],
    } as any), false)
    assert.equal(structureHasCandidate({
      type: 'multipart/mixed', childNodes: [text('text/plain'), leaf('application/pdf', { disposition: 'attachment', dispositionParameters: { filename: 'duzy.pdf' }, size: 15 * MB })],
    } as any), false)
    assert.equal(structureHasCandidate({
      type: 'multipart/mixed', childNodes: [text('text/plain'), leaf('application/pdf', { disposition: 'attachment', dispositionParameters: { filename: 'ok.pdf' }, size: Math.round(9.9 * MB * 1.37) })],
    } as any), true)
  })
  it('załączona wiadomość (message/rfc822) nie jest rozwijana → false', () => {
    assert.equal(structureHasCandidate({
      type: 'multipart/mixed',
      childNodes: [
        text('text/plain'),
        { type: 'message/rfc822', size: 300 * KB, childNodes: [{ type: 'multipart/mixed', childNodes: [text('text/plain'), leaf('application/pdf', { size: 200 * KB, dispositionParameters: { filename: 'x.pdf' } })] }] },
      ],
    } as any), false)
  })
  it('limity są takie, jak ustalono', () => {
    assert.equal(MAX_MESSAGE_BYTES, 25 * MB)
    assert.equal(MIN_IMAGE_BYTES, 20 * KB)
    assert.equal(MAX_MESSAGES_PER_RUN, 30)
    assert.equal(typeof IMAP_BUSY_ERROR, 'string')
  })
})

// ─── Fixture MIME przez mailparser: logo cid w multipart/related + PDF ────────

function b64(buf: Buffer): string { return buf.toString('base64').replace(/(.{76})/g, '$1\r\n') }
const CRLF = '\r\n'

function outlookForwardFixture(): { raw: string; pdf: Buffer; logo: Buffer } {
  const pdf = Buffer.from('%PDF-1.4\n' + 'x'.repeat(3000) + '\n%%EOF')
  const logo = Buffer.alloc(8 * KB, 7)
  const raw = [
    'From: Jan Kowalski <jan@firma.pl>',
    'To: faktury@firma.pl',
    'Subject: FW: Faktura FV/2026/08/015',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="MIX"',
    '',
    '--MIX',
    'Content-Type: multipart/related; boundary="REL"',
    '',
    '--REL',
    'Content-Type: text/html; charset="utf-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    '<html><body><p>W załączeniu faktura.</p><img src="cid:image001.png@01DC"></body></html>',
    '--REL',
    'Content-Type: image/png; name="image001.png"',
    'Content-Transfer-Encoding: base64',
    'Content-ID: <image001.png@01DC>',
    'Content-Disposition: inline; filename="image001.png"',
    '',
    b64(logo),
    '--REL--',
    '--MIX',
    'Content-Type: application/pdf; name="FV-2026-08-015.pdf"',
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment; filename="FV-2026-08-015.pdf"',
    '',
    b64(pdf),
    '--MIX--',
    '',
  ].join(CRLF)
  return { raw, pdf, logo }
}

function appleMailPhotoFixture(): { raw: string; photo: Buffer } {
  const photo = Buffer.alloc(120 * KB, 9)
  const raw = [
    'From: Anna <anna@icloud.com>',
    'To: faktury@firma.pl',
    'Subject: paragon Castorama',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="APL"',
    '',
    '--APL',
    'Content-Type: text/plain; charset="utf-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    'W załączeniu paragon.',
    '--APL',
    'Content-Type: image/jpeg; name="IMG_0412.jpeg"; x-apple-part-url=A1B2',
    'Content-Transfer-Encoding: base64',
    'Content-Id: <A1B2@apple>',
    'Content-Disposition: inline; filename="IMG_0412.jpeg"',
    '',
    b64(photo),
    '--APL--',
    '',
  ].join(CRLF)
  return { raw, photo }
}

describe('fixture MIME → mailparser → classifyAttachment', () => {
  it('przekazany mail z Outlooka: logo cid w multipart/related pominięte, PDF przechodzi', async () => {
    const { raw, pdf } = outlookForwardFixture()
    const mail = await simpleParser(raw, { keepCidLinks: true })
    const atts = mail.attachments
    assert.equal(atts.length, 2, 'mailparser wrzuca logo cid do attachments — filtr jest po naszej stronie')
    const decided = atts.map((a) => ({
      name: a.filename,
      ...classifyAttachment({ contentType: a.contentType, filename: a.filename, related: a.related, size: a.content.length }),
    }))
    const logo = decided.find((d) => d.name === 'image001.png')!
    const doc = decided.find((d) => d.name === 'FV-2026-08-015.pdf')!
    assert.equal(logo.skip, 'inline_image')
    assert.equal(doc.skip, undefined)
    assert.equal(doc.mime, 'application/pdf')
    assert.equal(atts.find((a) => a.filename === 'FV-2026-08-015.pdf')!.content.length, pdf.length)
  })
  it('zdjęcie paragonu z iPhone Mail (inline + Content-Id, bez multipart/related) NIE jest pomijane', async () => {
    const { raw, photo } = appleMailPhotoFixture()
    const mail = await simpleParser(raw, { keepCidLinks: true })
    assert.equal(mail.attachments.length, 1)
    const a = mail.attachments[0]
    assert.equal(a.contentDisposition, 'inline')
    assert.equal(a.related, undefined, 'poza multipart/related mailparser nie ustawia related')
    const r = classifyAttachment({ contentType: a.contentType, filename: a.filename, related: a.related, size: a.content.length })
    assert.deepEqual(r, { mime: 'image/jpeg' })
    assert.equal(a.content.length, photo.length)
  })
})
