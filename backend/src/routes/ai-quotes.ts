import { Router, Request, Response } from 'express'
import { v4 as uuidv4 } from 'uuid'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import Anthropic from '@anthropic-ai/sdk'
import * as XLSX from 'xlsx'
import JSZip from 'jszip'
import { jsonrepair } from 'jsonrepair'
import db from '../db'

const router = Router({ mergeParams: true })

function now() {
  return new Date().toISOString()
}

// Reuse the same attachments directory
const UPLOADS_DIR = path.join(__dirname, '..', '..', 'data', 'attachments')
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true })
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const unique = `floorplan-${Date.now()}-${Math.round(Math.random() * 1e6)}`
    const ext = path.extname(file.originalname).toLowerCase()
    cb(null, `${unique}${ext}`)
  },
})

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['.pdf', '.jpg', '.jpeg', '.png', '.xlsx', '.xls']
    const ext = path.extname(file.originalname).toLowerCase()
    if (allowed.includes(ext)) {
      cb(null, true)
    } else {
      cb(new Error('Dozwolone formaty: PDF, JPG, PNG, XLSX'))
    }
  },
})

function computeTotal(items: any[]): number {
  return items.reduce((s: number, i: any) => {
    const base = (Number(i.qty) || 0) * (Number(i.unit_price) || 0)
    const disc = Math.max(0, Math.min(100, Number(i.discount_pct) || 0))
    return s + base * (1 - disc / 100)
  }, 0)
}

function computeGrandTotal(totalEquipment: number, discountPct: number, laborPct: number): {
  total_after_discount: number; labor_cost: number; grand_total: number
} {
  const disc = Math.max(-100, Math.min(100, discountPct || 0))
  const totalAfterDiscount = totalEquipment * (1 - disc / 100)
  const laborCost = totalAfterDiscount * ((laborPct ?? 100) / 100)
  return { total_after_discount: totalAfterDiscount, labor_cost: laborCost, grand_total: totalAfterDiscount + laborCost }
}

// ─── Generowanie opisu "Instalacja bazowa" z faktycznych pozycji wyceny ───────

function buildMustHaveDescription(items: any[], rooms: string[]): string {
  if (!items.length) return ''

  const uniqueRooms = Array.from(new Set(items.map((i: any) => i.room).filter(Boolean)))
  const roomCount = uniqueRooms.filter(r => r !== 'Instalacja / Rozdzielnia').length
  const totalItems = items.length

  // Grupuj po brand → kategoria → liczba sztuk
  const byBrand: Record<string, Record<string, number>> = {}
  for (const item of items) {
    const brand = item.brand || 'Inne'
    const cat = item.category || 'Inne'
    if (!byBrand[brand]) byBrand[brand] = {}
    byBrand[brand][cat] = (byBrand[brand][cat] || 0) + (Number(item.qty) || 1)
  }

  const parts: string[] = []

  // KNX
  if (byBrand['KNX']) {
    const cats = byBrand['KNX']
    const subs: string[] = []
    const panels = Object.entries(cats).filter(([k]) => k.toLowerCase().includes('panel') || k.toLowerCase().includes('dotyk'))
    const blinds = Object.entries(cats).filter(([k]) => k.toLowerCase().includes('żaluzj') || k.toLowerCase().includes('rolety') || k.toLowerCase().includes('zasłon'))
    const lighting = Object.entries(cats).filter(([k]) => k.toLowerCase().includes('oświetl') || k.toLowerCase().includes('ściemn') || k.toLowerCase().includes('dali') || k.toLowerCase().includes('switch') || k.toLowerCase().includes('relay'))
    const sensors = Object.entries(cats).filter(([k]) => k.toLowerCase().includes('czujnik') || k.toLowerCase().includes('sensor') || k.toLowerCase().includes('pir'))
    const hvac = Object.entries(cats).filter(([k]) => k.toLowerCase().includes('hvac') || k.toLowerCase().includes('ogrzew') || k.toLowerCase().includes('klimat') || k.toLowerCase().includes('termostat'))

    const totalPanels = panels.reduce((s, [, n]) => s + n, 0)
    const totalBlinds = blinds.reduce((s, [, n]) => s + n, 0)
    const totalLighting = lighting.reduce((s, [, n]) => s + n, 0)
    const totalSensors = sensors.reduce((s, [, n]) => s + n, 0)
    const totalHvac = hvac.reduce((s, [, n]) => s + n, 0)

    if (totalPanels) subs.push(`${totalPanels} ${totalPanels === 1 ? 'panel dotykowy' : totalPanels < 5 ? 'panele dotykowe' : 'paneli dotykowych'}`)
    if (totalLighting) subs.push(`sterowanie oświetleniem (${totalLighting} ${totalLighting === 1 ? 'moduł' : 'modułów'})`)
    if (totalBlinds) subs.push(`sterowanie żaluzjami (${totalBlinds} ${totalBlinds === 1 ? 'siłownik' : totalBlinds < 5 ? 'siłowniki' : 'siłowników'})`)
    if (totalHvac) subs.push(`regulacja temperatury (${totalHvac} szt.)`)
    if (totalSensors) subs.push(`${totalSensors} ${totalSensors === 1 ? 'czujnik' : 'czujników'} KNX`)

    if (subs.length) parts.push(`KNX: ${subs.join(', ')}`)
  }

  // Control4
  if (byBrand['Control4']) {
    const cats = byBrand['Control4']
    const subs: string[] = []
    const ctrl = Object.entries(cats).filter(([k]) => k.toLowerCase().includes('kontroler') || k.toLowerCase().includes('sterownik') || k.toLowerCase().includes('ea-'))
    const audio = Object.entries(cats).filter(([k]) => k.toLowerCase().includes('audio') || k.toLowerCase().includes('amplif') || k.toLowerCase().includes('nagłośn'))
    const keys = Object.entries(cats).filter(([k]) => k.toLowerCase().includes('keypad') || k.toLowerCase().includes('panel') || k.toLowerCase().includes('dotyk'))

    const totalCtrl = ctrl.reduce((s, [, n]) => s + n, 0)
    const totalAudio = audio.reduce((s, [, n]) => s + n, 0)
    const totalKeys = keys.reduce((s, [, n]) => s + n, 0)
    const other = Object.values(cats).reduce((s, n) => s + n, 0) - totalCtrl - totalAudio - totalKeys

    if (totalCtrl) subs.push(`${totalCtrl} kontroler`)
    if (totalKeys) subs.push(`${totalKeys} ${totalKeys === 1 ? 'keypad' : 'keypady'}`)
    if (totalAudio) subs.push('system audio multi-room')
    if (other > 0) subs.push(`${other} szt. akcesoriów`)

    if (subs.length) parts.push(`Control4: ${subs.join(', ')}`)
  }

  // Hikvision — kamery to wszystkie pozycje oprócz NVR i domofonu
  if (byBrand['Hikvision']) {
    const hikItems = items.filter((i: any) => i.brand === 'Hikvision')
    const isNvr = (i: any) => {
      const lo = (i.category + ' ' + i.name).toLowerCase()
      return lo.includes('nvr') || lo.includes('rejestr')
    }
    const isDoor = (i: any) => {
      const lo = (i.category + ' ' + i.name).toLowerCase()
      return lo.includes('domofon') || lo.includes('wideo') || lo.includes('intercom') || lo.includes('monitor')
    }
    const totalCam = hikItems.filter((i: any) => !isNvr(i) && !isDoor(i)).reduce((s: number, i: any) => s + (Number(i.qty) || 1), 0)
    const totalNvr = hikItems.filter(isNvr).reduce((s: number, i: any) => s + (Number(i.qty) || 1), 0)
    const hasDoor = hikItems.some(isDoor)
    const subs: string[] = []

    if (totalCam) subs.push(`${totalCam} ${totalCam === 1 ? 'kamera' : totalCam < 5 ? 'kamery' : 'kamer'} zewnętrznych`)
    if (totalNvr) subs.push(`${totalNvr} rejestrator NVR`)
    if (hasDoor) subs.push('wideodomofon')

    if (subs.length) parts.push(`Hikvision (CCTV): ${subs.join(', ')}`)
  }

  // Satel
  if (byBrand['Satel']) {
    const cats = byBrand['Satel']
    const central = Object.entries(cats).filter(([k]) => k.toLowerCase().includes('centrala') || k.toLowerCase().includes('integra'))
    const pir = Object.entries(cats).filter(([k]) => k.toLowerCase().includes('pir') || k.toLowerCase().includes('czujka') || k.toLowerCase().includes('czujnik'))
    const mag = Object.entries(cats).filter(([k]) => k.toLowerCase().includes('magnet'))
    const siren = Object.entries(cats).filter(([k]) => k.toLowerCase().includes('sygnaliz') || k.toLowerCase().includes('syrena'))

    const subs: string[] = []
    if (central.length) subs.push(`centrala alarmowa`)
    const totalPir = pir.reduce((s, [, n]) => s + n, 0)
    if (totalPir) subs.push(`${totalPir} ${totalPir === 1 ? 'czujnik ruchu' : 'czujników ruchu'}`)
    const totalMag = mag.reduce((s, [, n]) => s + n, 0)
    if (totalMag) subs.push(`${totalMag} kontaktronów`)
    if (siren.length) subs.push('sygnalizator alarmowy')

    if (subs.length) parts.push(`Satel (alarm): ${subs.join(', ')}`)
  }

  const header = `Wycena obejmuje ${totalItems} pozycji w ${roomCount} ${roomCount === 1 ? 'pomieszczeniu' : roomCount < 5 ? 'pomieszczeniach' : 'pomieszczeniach'}.`
  const body = parts.length ? ` Zakres instalacji: ${parts.join('; ')}.` : ''

  return header + body
}

// ─── AI SYSTEM PROMPT ─────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Jesteś ekspertem od systemów inteligentnego domu (smart home) w Polsce z wieloletnim doświadczeniem w projektowaniu i wycenie instalacji KNX, Control4, Hikvision i Satel. Przeanalizuj dostarczony rzut i przygotuj profesjonalną wycenę ORAZ opis oferty.

ZADANIE:
1. Zidentyfikuj pomieszczenia na rzucie. Oszacuj powierzchnię całkowitą.
2. Zaproponuj dobór urządzeń dla każdego pomieszczenia.
3. W polu "description" napisz po 2-3 zwięzłe zdania dla każdej sekcji (must_have / nice_to_have / premium).
4. Zwróć wynik WYŁĄCZNIE jako JSON w bloku \`\`\`json ... \`\`\`.

SYSTEMY I ICH ZASTOSOWANIA:
- KNX: sterowanie oświetleniem (ściemniacze DALI/PWM, przekaźniki), żaluzje/rolety (siłowniki w rozdzielni), klimatyzacja/ogrzewanie (regulatory temperatury), multi-room audio, panele dotykowe, czujniki obecności
- Control4: kontrolery systemu (EA-1, EA-3), keypady dotykowe, pilot SR-260, matrix audio/wideo, integracja TV, streaming
- Hikvision: kamery IP zewnętrzne (bullet/tubowe, PTZ), rejestratory NVR, domofon IP, czytniki kart dostępu — BRAK kamer wewnętrznych
- Satel: centrale alarmowe (INTEGRA 32/128), czujniki PIR, czujniki magnetyczne, czujniki rozbicia szyby, klawiatury LCD, sygnalizatory, moduły GSM/Ethernet

POMIESZCZENIA (stosuj polskie nazwy):
Salon, Sypialnia główna, Sypialnia 2, Sypialnia 3, Pokój dziecięcy, Kuchnia, Jadalnia, Łazienka główna, Łazienka 2, Łazienka 3, WC, Przedpokój, Hol, Korytarz, Gabinet/Biuro, Garderoba, Pralnia, Kotłownia, Schowek, Garaż, Taras, Ogród, Balkon

ZASADY WYCENY — PRODUKTY HDL KNX (ceny netto PLN, cennik 07.10.2024):
Używaj WYŁĄCZNIE poniższych modeli HDL i ich cen katalogowych:

KNX — Panele dotykowe:
- M/PT2RA.1 — Tile 2-przyciskowy plastik: 505 PLN | metal: 615 PLN (sypialnia, mały pokój)
- M/PT4RA.1 — Tile 4-przyciskowy plastik: 563 PLN | metal: 673 PLN (salon, kuchnia, gabinet)
- M/PT4RB.1 — Tile 8-przyciskowy plastik: 639 PLN | metal: 749 PLN (duży salon)
- M/PTL35.1 — Tile Display 3.5" LCD: 1 991 PLN (przedpokój, korytarz)
- M/PTL4.1 — Granite Display 4" LCD: 2 322 PLN (salon premium)
- M/MPTLC43.1-A2 — Enviro Touch Screen 4.3": 2 426 PLN (salon/gabinet premium)
- MGWSIPD-LK.18 — Source 7 Touch Screen 7" Android: 3 376 PLN (salon/główny panel)
- M/PTCI.1 — Panel Power Interface EU (wymagany dla każdego panelu): 348 PLN

KNX — Sterowanie oświetleniem:
- M/DALI.1 — DALI Master Actuator DIN: 1 829 PLN (MAKS 1 szt. na 100m², w rozdzielni)
- M/DA6.10.1 — 6CH 10A Ballast Dimming Actuator: 1 916 PLN (w rozdzielni)
- M/DM04.1 — 4CH 1.5A Trailing Edge Dimmer DIN: 2 595 PLN (w rozdzielni)
- M/DM06.1 — 6CH 1.5A Trailing Edge Dimmer DIN: 3 141 PLN (w rozdzielni)
- M/FME1D.1 — 1CH Flush-mount Mosfet Dimmer: 981 PLN (w puszce)
- M/R8.16.1 — 8CH 16A Switch Actuator DIN: 1 898 PLN (w rozdzielni)
- M/R12.16.1 — 12CH 16A Switch Actuator DIN: 2 583 PLN (w rozdzielni)
- M/R4.16.1 — 4CH 16A Switch Actuator DIN: 1 202 PLN (w rozdzielni)
- M/DRGBW4.1 — 4CH RGBW Driver DIN: 1 041 PLN (strip LED RGB)

KNX — Sterowanie żaluzjami:
- M/W04.10.1 — 4CH 10A Curtain Actuator DIN: 1 434 PLN (ZAWSZE w rozdzielni; 1 szt. na 4 rolety)
- M/AG40B.1 — KNX Blind Motor tubowy: 3 618 PLN (motor wbudowany w rurę)
- HDL-230 — Dry Contact Curtain Motor 230V: 668 PLN (szt., gdy potrzebny motor)

KNX — Czujniki:
- M/SIS05.1 — PIR + temp + lux podtynkowy (sufitowy): 900 PLN (salon, biuro, korytarz)
- M/IS05.1 — PIR & Lux podtynkowy: 749 PLN (sypialnia, kuchnia)
- M/HS05.1 — PIR & Lux natynkowy: 749 PLN (garaż, pom. techniczne)
- M/WS05.1-A — Mikrofala zewnętrzna + lux + wilgotność: 911 PLN (taras, ogród)
- MSA200D RC — Presence Sensor 24GHz sufitowy: 639 PLN (łazienka, WC)

KNX — HVAC:
- M/FCU01.10.1 — FCU & Floor Heating Actuator 5CH: 1 167 PLN (strefa ogrzewania podłogowego)
- M/FCHC.4.1 — Klimatyzacja Fan Coil Actuator DIN: 1 318 PLN (strefa klimatyzacji)
- TS/C 1.0 — Czujnik temperatury 2.5m (do M/FCU): 41 PLN

KNX — Infrastruktura:
- M/P960.1 — Zasilacz 960mA DIN: 929 PLN (1 na ~12 urządzeń KNX)
- M/PTCI.1 — Power Interface dla paneli EU: 348 PLN (1 szt. na każdy panel dotykowy)
- M/IPRT.1 — KNX IP Router DIN: 3 942 PLN (1 szt. w instalacji)
- M/LCR.1 — KNX Line Coupler DIN: 3 193 PLN (gdy ponad 1 linia)
- M/S08.1 — 8-Zone Dry Contact Module: 795 PLN (integracja z innymi systemami)
- M/GWASC.1 — HDL Link-KNX Gateway: 3 077 PLN (integracja z systemem BMS/IP)

Control4 (ceny netto wg cennika integratora 01.2025, przeliczone ~4,25 PLN/EUR):
Kontrolery — ZAWSZE 1 szt. w "Instalacja / Rozdzielnia":
- C4-CA1 — Control4® CA-1 Hub and Automation Controller (małe mieszkanie): 1 752 PLN
- C4-CORE1 — Control4® CORE 1 Controller (dom do 150m²): 2 975 PLN
- C4-CORE3 — Control4® CORE 3 Controller (dom 150–300m²): 5 338 PLN
- C4-EA1-1-V2 — Control4® EA-1 Entertainment Controller V2 (mieszkanie/strefa): 2 574 PLN
- C4-EA1-POE-V2 — Control4® EA-1 PoE Entertainment Controller V2: 2 921 PLN
- C4-EA3-V2 — Control4® EA-3 Entertainment Controller V2 (główny dom): 5 321 PLN
- C4-EA5-V2 — Control4® EA-5 Entertainment Controller V2 (rezydencja/hotel): 11 138 PLN

Piloty i interfejsy zdalne:
- C4-SR260 — Control4® System Remote Control SR260: 1 000 PLN (każda strefa AV)
- C4-HALO-BL — Control4® Halo Remote (Black): 1 768 PLN (premium)
- C4-HALO-TS-BL — Control4® Halo Touch Remote (Black): 3 121 PLN (top)

Panele dotykowe (ekrany):
- C4-T4IW8-WH — Control4® T4 Series 8" In-Wall Touchscreen PoE (White): 4 930 PLN (salon, korytarz)
- C4-T4IW10-WH — Control4® T4 Series 10" In-Wall Touchscreen PoE (White): 6 253 PLN (salon główny)
- C4-T4T8-WH — Control4® T4 Series 8" Tabletop Touchscreen (White): 4 930 PLN (biurko, stolik)
- C4-T4T10-WH — Control4® T4 Series 10" Tabletop Touchscreen (White): 6 253 PLN

Stacja drzwiowa / domofon Control4:
- C4-DS2FM-BL — Control4® DS2 Door Station Flush Mount (Black): 4 828 PLN (wejście główne)
- C4-DS2SM-BL — Control4® DS2 Door Station Surface Mount (Black): 4 828 PLN
- C4-DS2BFMKP-BL — Control4® DS2 Bundle z klawiaturą Flush Mount (Black): 5 930 PLN
- C4-DS2MINI-BL — Control4® DS2 Mini Door Station (Black): 4 685 PLN (mniejsze wejście)
- C4-VDB-E-BL — Control4® Chime Video Doorbell PoE (Black): 2 302 PLN (podstawowy wideodomofon)

Wzmacniacze audio (multi-room):
- TS-SAMP1-100-WH — Triad One 1-strefowy amplifier (White): 3 376 PLN (1 strefa audio)
- EA-DYN-2D-200 — Episode® Dynamic 200W×2CH Amplifier: 3 009 PLN (2 strefy)
- EA-DYN-8D-100 — Episode® Dynamic 100W×8CH Amplifier: 5 202 PLN (8 stref)

Oprogramowanie / licencje:
- C4-4Sight-E — Subskrypcja 4Sight 1 rok (zdalne sterowanie): 466 PLN/rok (OBOWIĄZKOWA)
- SATEL DRIVER — Licencja integracji Satel z Control4: 1 020 PLN (gdy system Satel + Control4)

Hikvision (ceny netto wg montersi.pl):
Kamery zewnętrzne (bullet/tubowe) — JEDYNE dopuszczalne kamery w wycenie:
- DS-2CD1041G0-I — Tubowa 4 Mpx, IR, PoE, H.265+: 393 PLN (elewacje, wjazd)
- DS-2CD1047G3H-LIUF/SL (2.8mm) — Tubowa 4 Mpx, ColorVu: 972 PLN (ogród, taras)
- DS-2CD2047G2H-LIU/SL (2.8mm) — Tubowa 4 Mpx, AcuSense, ColorVu: 1 420 PLN (elewacje premium)

Rejestratory NVR:
- DS-7108NI-Q1/M — NVR 8-kanałowy, 6 Mpx, H.265+: 468 PLN (system do 8 kamer)
- DS-7108NI-Q1/8P/M — NVR 8-kanałowy z PoE 8-port (72W): 772 PLN (gdy kamery bez osobnego PoE)
- DS-7616NXI-K1 — NVR 16-kanałowy: 1 117 PLN (system do 16 kamer)
- DS-7616NXI-K2/16P — NVR 16-kanałowy z PoE 16-port: 2 619 PLN (duże instalacje)

Wideodomofon IP:
- DS-KD8003-IME1(B) — Moduł stacji bramowej IP (door station): 984 PLN (wejście główne)
- DS-KIS604-S — Zestaw wideodomofonu z monitorem i switchem PoE: 1 999 PLN (kompletny zestaw)

Satel (ceny netto wg montersi.pl):
Centrale alarmowe:
- Satel INTEGRA 32 — Centrala alarmowa 32 linie: 479 PLN (mieszkanie, mały dom)
- Satel INTEGRA 64 — Centrala alarmowa 64 linie: 700 PLN (średni dom)
- Satel INTEGRA 128 — Centrala alarmowa 128 linii: 785 PLN (duży dom, obiekt)
- Satel INTEGRA 128 Plus — Centrala alarmowa Grade 3: 947 PLN (instalacja podwyższonego ryzyka)

Czujniki ruchu PIR:
- Satel AMBER — Czujka ruchu PIR (podstawowa): 30 PLN (pomieszczenia pomocnicze)
- Satel TOPAZ — Czujka ruchu PIR: 39 PLN (standardowe pomieszczenia)
- Satel AQUA Plus — Czujka ruchu PIR Grade 2: 56 PLN (każde pomieszczenie mieszkalne)
- Satel AQUA Luna — Czujka ruchu PIR (estetyczna): 70 PLN (salon, sypialnia)
- Satel AQUA Ring — Sufitowa czujka ruchu PIR 360°: 89 PLN (środek pomieszczenia)
- Satel SLIM-PIR-LUNA — Czujka PIR płaska Grade 2: 99 PLN (nowoczesne wnętrza)
- Satel SLIM-DUAL-LUNA — Dualna czujka PIR+MW Grade 2 (odporna na fałszywe alarmy): 185 PLN

Kontaktrony magnetyczne (drzwi i okna):
- Satel B-1 — Kontaktron wpuszczany biały: 11 PLN (każde okno parterowe, drzwi)
- Satel B-2FL — Kontaktron wpuszczany (wersja płaska): 11 PLN (drzwi wejściowe)

Czujniki stłuczenia szyby:
- Satel MAGENTA — Czujka stłuczeniowa akustyczna: 88 PLN (salon, taras, parter)
- Satel INDIGO — Czujka stłuczeniowa: 96 PLN (salon premium)

Klawiatury LCD (manipulatory do INTEGRA):
- Satel INT-KLCDS-GR — Manipulator LCD strefowy (zielony): 440 PLN (wejście do domu)
- Satel INT-KLCD-W — Manipulator LCD (biały): 479 PLN (sypialnia główna)
- Satel INT-KLCDR-W — Manipulator LCD z czytnikiem kart UNIQUE: 655 PLN (wejście premium)
- Satel INT-TSI-W — Manipulator z ekranem dotykowym 7" (biały): 1 447 PLN (salon premium)

Sygnalizatory:
- Satel SPW-210 R — Sygnalizator akustyczny wewnętrzny: 57 PLN (wewnątrz)
- Satel SP-4001 R — Sygnalizator optyczno-akustyczny (wewnętrzny/zewnętrzny): 129 PLN
- Satel SP-4003 R — Sygnalizator optyczno-akustyczny (mocniejszy): 163 PLN (elewacja)

Moduły komunikacyjne:
- Satel ETHM-1 Plus — Moduł ethernetowy (powiadomienia IP/web): 572 PLN (OBOWIĄZKOWY)
- Satel INT-GSM LTE — Moduł GSM/LTE (powiadomienia SMS/tel.): 679 PLN (gdy potrzebne GSM)

ZASADY PROJEKTOWANIA — BEZWZGLĘDNIE OBOWIĄZKOWE:

1. DALI — MAKSYMALNIE 1 sterownik DALI na ~100 m² powierzchni całkowitej budynku.
   Przykład: dom 200 m² = 2 sterowniki DALI, mieszkanie 80 m² = 1 sterownik DALI.
   Sterowniki DALI umieszczaj WYŁĄCZNIE w "Instalacja / Rozdzielnia".
   NIE dodawaj osobnego sterownika DALI do każdego pokoju.

2. SIŁOWNIKI ROLET/ŻALUZJI — ZAWSZE przypisuj do room: "Instalacja / Rozdzielnia".
   Zlicz wszystkie rolety/żaluzje w całym budynku i dodaj odpowiednią ilość siłowników
   (1 siłownik 2-kanałowy = 2 rolety). Nigdy nie wstawiaj siłowników per pokój.

3. INFRASTRUKTURA w "Instalacja / Rozdzielnia":
   - Zasilacz KNX (1 na każde 10-14 urządzeń KNX)
   - Sterowniki DALI (wg zasady 1/100m²)
   - Wszystkie siłowniki żaluzji (wg zasady powyżej)
   - Centrala Satel INTEGRA (1 szt.) + Satel ETHM-1 Plus (1 szt., OBOWIĄZKOWO)
   - Opcjonalnie: Satel INT-GSM LTE gdy wymagana komunikacja GSM
   - NVR Hikvision (1 szt., dobieraj pojemność do liczby kamer: ≤8 kamer → DS-7108NI-Q1/8P/M, ≤16 kamer → DS-7616NXI-K1 lub K2/16P)
   - Kontroler Control4: dobieraj wg metrażu:
     • mieszkanie ≤80m² → C4-CA1 (1 752 PLN) lub C4-EA1-1-V2 (2 574 PLN)
     • dom 80–150m² → C4-CORE1 (2 975 PLN) lub C4-EA1-POE-V2 (2 921 PLN)
     • dom 150–300m² → C4-CORE3 (5 338 PLN) lub C4-EA3-V2 (5 321 PLN)
     • rezydencja >300m² → C4-EA5-V2 (11 138 PLN)
   - Subskrypcja C4-4Sight-E (466 PLN/rok) — dodaj ZAWSZE jako osobną pozycję
   - Jeśli jednocześnie Satel + Control4 → dodaj licencję SATEL DRIVER (1 020 PLN)
   - Moduły I/O, sprzęgła linii KNX

4. SATEL — ZASADY LICZENIA:
   - 1 czujnik PIR (np. AQUA Plus lub AQUA Luna) per pomieszczenie mieszkalne (salon, sypialnie, kuchnia, gabinet)
   - Kontaktrony (B-1) na każde okno parterowe + drzwi wejściowe/balkonowe
   - 1 czujnik stłuczenia szyby (MAGENTA) na salon i taras/ogród
   - 1 klawiatura INT-KLCDS przy wejściu głównym, ewent. 1 przy sypialni głównej
   - 1 sygnalizator wewnętrzny (SPW-210) + 1 zewnętrzny (SP-4001 lub SP-4003) na elewacji
   - Używaj TYLKO modeli z powyższej listy z ich dokładnymi cenami netto

5. HIKVISION — ZASADY LICZENIA:
   - NIGDY nie dodawaj kamer wewnętrznych (dome wewnętrzne) — stosujemy WYŁĄCZNIE kamery zewnętrzne
   - Kamery zewnętrzne (bullet/tubowe): po 1 na każdą elewację z widokiem na wejście/ogród/podjazd
   - NVR: dobieraj z górką (min. 25% wolnych kanałów)
   - Wideodomofon: DS-KD8003-IME1 na zewnątrz przy wejściu + DS-KIS604-S jako zestaw z monitorem wewnętrznym
   - Używaj TYLKO modeli z powyższej listy z ich dokładnymi cenami netto

6. Dla małego mieszkania (50-80 m²): 8-20 pozycji, wartość 30 000-70 000 PLN
7. Dla dużego domu (150-250 m²): 30-60 pozycji, wartość 100 000-280 000 PLN
8. Dodaj realistyczne modele/producenta w nawiasach (np. MDT, Jung, Schneider dla KNX)
9. Jeśli rzut jest nieczytelny — wygeneruj wycenę dla typowego mieszkania 80 m²

FORMAT ODPOWIEDZI (ścisły JSON, bez żadnego tekstu poza tym blokiem):
\`\`\`json
{
  "rooms": ["Salon", "Kuchnia", "Sypialnia główna", "Łazienka", "Przedpokój", "Instalacja / Rozdzielnia"],
  "description": {
    "must_have": "2-3 zdania: co jest absolutnie konieczne w tej instalacji.",
    "nice_to_have": "2-3 zdania: rekomendowane rozszerzenia podnoszące komfort.",
    "premium": "2-3 zdania: funkcjonalności premium dla wymagających klientów."
  },
  "line_items": [
    {
      "room": "Salon",
      "brand": "KNX",
      "category": "Panel dotykowy",
      "name": "HDL M/PTL4.1 — Granite Display Panel 4\" LCD KNX",
      "qty": 1,
      "unit": "szt.",
      "unit_price": 2322
    },
    {
      "room": "Salon",
      "brand": "KNX",
      "category": "Zasilacz paneli",
      "name": "HDL M/PTCI.1 — Panel Power Interface EU",
      "qty": 1,
      "unit": "szt.",
      "unit_price": 348
    },
    {
      "room": "Instalacja / Rozdzielnia",
      "brand": "KNX",
      "category": "Sterowanie oświetleniem",
      "name": "HDL M/DALI.1 — DALI Master Actuator DIN-Rail",
      "qty": 2,
      "unit": "szt.",
      "unit_price": 1829
    },
    {
      "room": "Instalacja / Rozdzielnia",
      "brand": "KNX",
      "category": "Sterowanie żaluzjami",
      "name": "HDL M/W04.10.1 — 4CH 10A Curtain Actuator DIN-Rail",
      "qty": 3,
      "unit": "szt.",
      "unit_price": 1434
    },
    {
      "room": "Instalacja / Rozdzielnia",
      "brand": "KNX",
      "category": "Infrastruktura",
      "name": "HDL M/P960.1 — Power Supply 960mA DIN-Rail",
      "qty": 1,
      "unit": "szt.",
      "unit_price": 929
    },
    {
      "room": "Instalacja / Rozdzielnia",
      "brand": "Satel",
      "category": "Centrala alarmowa",
      "name": "Centrala alarmowa INTEGRA 32 (Satel INTEGRA 32)",
      "qty": 1,
      "unit": "szt.",
      "unit_price": 820
    }
  ]
}
\`\`\`
`

// ─── POST /analyze ─────────────────────────────────────────────────────────────
router.post('/analyze', upload.array('floor_plans', 10), async (req: Request, res: Response) => {
  const projectId = req.params.projectId
  const files = (req.files as Express.Multer.File[]) || []

  const cleanupFiles = () => {
    for (const f of files) {
      if (f.path && fs.existsSync(f.path)) try { fs.unlinkSync(f.path) } catch {}
    }
  }

  if (!await db.projects.find(projectId)) {
    cleanupFiles()
    res.status(404).json({ error: 'Projekt nie znaleziony' })
    return
  }

  if (files.length === 0) {
    res.status(400).json({ error: 'Brak plików do analizy' })
    return
  }

  // Read optional systems and features from form data
  const selectedSystems: string[] = req.body.systems
    ? (Array.isArray(req.body.systems) ? req.body.systems : [req.body.systems])
    : ['KNX', 'Control4', 'Hikvision', 'Satel']
  const selectedFeatures: string[] = req.body.features
    ? (Array.isArray(req.body.features) ? req.body.features : [req.body.features])
    : []
  const userNotes: string = typeof req.body.user_notes === 'string' ? req.body.user_notes.trim() : ''

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    cleanupFiles()
    res.status(500).json({ error: 'ANTHROPIC_API_KEY nie jest skonfigurowany na serwerze. Ustaw klucz w pliku backend/.env.' })
    return
  }

  try {
    const client = new Anthropic({ apiKey })

    type ContentBlock =
      | { type: 'document'; source: { type: 'base64'; media_type: 'application/pdf'; data: string } }
      | { type: 'image'; source: { type: 'base64'; media_type: 'image/jpeg' | 'image/png'; data: string } }
      | { type: 'text'; text: string }

    // Build content blocks for all files
    const fileBlocks: ContentBlock[] = []
    for (const file of files) {
      const ext = path.extname(file.originalname).toLowerCase()
      const fileBuffer = fs.readFileSync(file.path)

      if (['.xlsx', '.xls'].includes(ext)) {
        // Parse Excel to CSV text
        const workbook = XLSX.read(fileBuffer, { type: 'buffer' })
        const csvParts = workbook.SheetNames.map(name => {
          const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[name])
          return `[Arkusz: ${name}]\n${csv}`
        })
        fileBlocks.push({
          type: 'text',
          text: `Dane z pliku Excel "${file.originalname}":\n${csvParts.join('\n\n')}`,
        })
      } else if (ext === '.pdf') {
        fileBlocks.push({
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: fileBuffer.toString('base64') },
        })
      } else {
        fileBlocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: ext === '.png' ? 'image/png' : 'image/jpeg',
            data: fileBuffer.toString('base64'),
          },
        })
      }
    }

    const fileLabel = files.length > 1
      ? `${files.length} pliki (${files.map(f => f.originalname).join(', ')})`
      : files[0].originalname

    // Build dynamic instruction based on selected systems and features
    const systemsInstruction = selectedSystems.length < 4
      ? `WAŻNE: Uwzględnij TYLKO następujące systemy: ${selectedSystems.join(', ')}. Nie dodawaj urządzeń innych systemów.`
      : ''
    const featuresInstruction = selectedFeatures.length > 0
      ? `WAŻNE: Uwzględnij TYLKO następujące instalacje/funkcje: ${selectedFeatures.join(', ')}. Nie dodawaj urządzeń ani funkcji spoza tej listy.`
      : ''
    const userNotesInstruction = userNotes
      ? `WYTYCZNE KLIENTA / PROJEKTANTA (traktuj jako priorytetowe wskazówki): ${userNotes}`
      : ''

    const userInstruction = [
      `Przeanalizuj ${files.length > 1 ? 'te pliki (rzuty i/lub dane): ' + fileLabel : 'ten rzut'} i zwróć JSON zgodnie z instrukcją systemową.`,
      'Uwzględnij wszystkie pomieszczenia ze wszystkich plików.',
      systemsInstruction,
      featuresInstruction,
      userNotesInstruction,
    ].filter(Boolean).join('\n\n')

    const message = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 32000,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            ...fileBlocks,
            { type: 'text', text: userInstruction },
          ] as ContentBlock[],
        },
      ],
    })

    // Capture token usage for cost estimation
    const usage = {
      input_tokens:  message.usage?.input_tokens  ?? 0,
      output_tokens: message.usage?.output_tokens ?? 0,
    }
    // claude-sonnet-4-5: $3/MTok input, $15/MTok output (2025)
    const cost_usd = (usage.input_tokens * 3 + usage.output_tokens * 15) / 1_000_000
    console.log(`[AI Quote] Tokeny: input=${usage.input_tokens} output=${usage.output_tokens} koszt=${cost_usd.toFixed(4)} USD`)

    // Extract JSON — multiple strategies for robustness
    const rawText = message.content[0].type === 'text' ? message.content[0].text : ''
    console.log('[AI Quote] Model:', 'claude-sonnet-4-6', '| stop_reason:', message.stop_reason, '| długość:', rawText.length)
    console.log('[AI Quote] Podgląd odpowiedzi (500 znaków):\n', rawText.slice(0, 500))

    let jsonString: string | null = null

    // Strategy 1a: complete code block  ```json ... ```
    const completeBlockMatch = rawText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/)
    if (completeBlockMatch && completeBlockMatch[1]) {
      jsonString = completeBlockMatch[1].trim()
      console.log('[AI Quote] Strategia 1a (complete code block) – długość:', jsonString.length)
    }

    // Strategy 1b: opening code block without closing (truncated response)
    if (!jsonString) {
      const openBlockMatch = rawText.match(/```(?:json)?\s*\n?([\s\S]+)$/)
      if (openBlockMatch && openBlockMatch[1]) {
        const candidate = openBlockMatch[1].replace(/\n?```\s*$/, '').trim()
        if (candidate.startsWith('{')) {
          jsonString = candidate
          console.log('[AI Quote] Strategia 1b (truncated code block) – długość:', jsonString.length)
        }
      }
    }

    // Strategy 2: find first { to last } by character search
    if (!jsonString) {
      const start = rawText.indexOf('{')
      const end = rawText.lastIndexOf('}')
      if (start !== -1 && end !== -1 && end > start) {
        jsonString = rawText.slice(start, end + 1)
        console.log('[AI Quote] Strategia 2 (bracket search) – długość:', jsonString.length)
      }
    }

    if (!jsonString) {
      console.error('[AI Quote] Nie znaleziono JSON w odpowiedzi. Pełna odpowiedź:\n', rawText)
      res.status(422).json({
        error: 'AI nie zwróciło poprawnego formatu JSON. Spróbuj ponownie z wyraźniejszym rzutem.',
        raw: rawText.slice(0, 500),
      })
      return
    }

    let parsed: any
    try {
      parsed = JSON.parse(jsonrepair(jsonString))
      console.log('[AI Quote] JSON sparsowany poprawnie (jsonrepair)')
    } catch (err: any) {
      console.error('[AI Quote] Błąd JSON.parse po jsonrepair:', err.message)
      console.error('[AI Quote] jsonString (pierwsze 800 znaków):\n', jsonString.slice(0, 800))
      res.status(422).json({
        error: 'Błąd parsowania odpowiedzi AI. Spróbuj ponownie.',
        hint: err.message,
      })
      return
    }

    const rooms: string[] = Array.isArray(parsed.rooms) ? parsed.rooms : []
    const rawItems: any[] = Array.isArray(parsed.line_items) ? parsed.line_items : []

    // must_have zostanie nadpisane po zbudowaniu items — programatycznie z faktycznych pozycji
    const description = {
      must_have: '',
      nice_to_have: parsed.description?.nice_to_have || '',
      premium: parsed.description?.premium || '',
    }

    // Enrich items: try to match catalog items
    const catalogItems = await db.product_catalog.all()

    const items = rawItems.map((item: any, index: number) => {
      const itemName = (item.name || '').toLowerCase()
      const catalogMatch = catalogItems.find((c: any) =>
        c.brand === item.brand &&
        itemName.length > 8 &&
        c.name.toLowerCase().includes(itemName.slice(0, Math.min(itemName.length, 20)))
      )
      const qty = Number(item.qty) || 1
      const unit_price = Number(item.unit_price) || 0
      const discount_pct = 0
      const total = qty * unit_price * (1 - discount_pct / 100)

      return {
        id: uuidv4(),
        room: item.room || '',
        brand: item.brand || 'KNX',
        category: item.category || '',
        name: item.name || '',
        qty,
        unit: item.unit || 'szt.',
        unit_price,
        discount_pct,
        total,
        catalog_item_id: catalogMatch ? catalogMatch.id : null,
        sort_order: index,
      }
    })

    // ── Generuj must_have z faktycznych pozycji ───────────────────────────
    description.must_have = buildMustHaveDescription(items, rooms)

    const totalNet = computeTotal(items)
    const discountPct = 0
    const laborPct = 50
    const { total_after_discount, labor_cost, grand_total } = computeGrandTotal(totalNet, discountPct, laborPct)

    const quote = {
      id: uuidv4(),
      project_id: projectId,
      status: 'draft',
      floor_plan_filenames: files.map(f => f.filename),
      floor_plan_originals: files.map(f => f.originalname),
      // backward compat
      floor_plan_filename: files[0]?.filename ?? null,
      floor_plan_original: files[0]?.originalname ?? null,
      ai_analysis_raw: rawText,
      rooms_detected: rooms,
      description,
      items,
      total_net: totalNet,
      discount_pct: discountPct,
      total_after_discount,
      labor_cost_pct: laborPct,
      labor_cost,
      grand_total,
      notes: '',
      created_at: now(),
      updated_at: now(),
      created_by: (req as any).user?.id || '',
    }

    await db.ai_quotes.insert(quote)

    // Return without the heavy raw field but include token usage
    const { ai_analysis_raw: _raw, ...quoteToReturn } = quote
    res.status(201).json({
      ...quoteToReturn,
      _usage: { ...usage, cost_usd: parseFloat(cost_usd.toFixed(4)) },
    })

  } catch (err: any) {
    cleanupFiles()
    const errorMessage = err?.error?.message || err?.message || 'Nieznany błąd analizy AI'
    res.status(500).json({ error: `Błąd analizy AI: ${errorMessage}` })
  }
})

// ─── POST /manual ──────────────────────────────────────────────────────────────
// Create a quote manually from wizard-selected catalog items (no AI)
router.post('/manual', async (req: Request, res: Response) => {
  try {
  const projectId = req.params.projectId
  if (!await db.projects.find(projectId)) {
    res.status(404).json({ error: 'Projekt nie znaleziony' })
    return
  }

  const { items: rawItems = [], rooms_detected = [], notes = '', description = {} } = req.body

  const items = (rawItems as any[]).map((item: any, index: number) => {
    const qty = Number(item.qty) || 1
    const unit_price = Number(item.unit_price) || 0
    const discount_pct = 0
    return {
      id: uuidv4(),
      room: item.room || '',
      brand: item.brand || 'KNX',
      category: item.category || '',
      name: item.name || '',
      qty,
      unit: item.unit || 'szt.',
      unit_price,
      discount_pct,
      total: qty * unit_price,
      catalog_item_id: item.catalog_item_id || null,
      sort_order: index,
    }
  })

  const totalNet = computeTotal(items)
  const { total_after_discount, labor_cost, grand_total } = computeGrandTotal(totalNet, 0, 50)

  const quote = {
    id: uuidv4(),
    project_id: projectId,
    status: 'draft',
    floor_plan_filenames: [],
    floor_plan_originals: [],
    floor_plan_filename: null,
    floor_plan_original: null,
    rooms_detected,
    description: {
      must_have: description.must_have || '',
      nice_to_have: description.nice_to_have || '',
      premium: description.premium || '',
    },
    items,
    total_net: totalNet,
    discount_pct: 0,
    total_after_discount,
    labor_cost_pct: 100,
    labor_cost,
    grand_total,
    notes,
    created_at: now(),
    updated_at: now(),
    created_by: (req as any).user?.id || '',
  }

  await db.ai_quotes.insert(quote)
  res.status(201).json(quote)
  } catch {
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// ─── GET /  ────────────────────────────────────────────────────────────────────
router.get('/', async (req: Request, res: Response) => {
  try {
    const quotes = await db.ai_quotes.forProject(req.params.projectId)
    // Strip heavy raw field from list
    res.json(quotes.map((q: any) => {
      const { ai_analysis_raw: _raw, ...rest } = q
      return rest
    }))
  } catch {
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// ─── GET /:id ──────────────────────────────────────────────────────────────────
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const quote = await db.ai_quotes.find(req.params.id)
    if (!quote || quote.project_id !== req.params.projectId) {
      res.status(404).json({ error: 'Wycena nie znaleziona' })
      return
    }
    const { ai_analysis_raw: _raw, ...rest } = quote
    res.json(rest)
  } catch {
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// ─── PUT /:id ──────────────────────────────────────────────────────────────────
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const quote = await db.ai_quotes.find(req.params.id)
    if (!quote || quote.project_id !== req.params.projectId) {
      res.status(404).json({ error: 'Wycena nie znaleziona' })
      return
    }

    const { status, notes, items, rooms_detected, discount_pct, labor_cost_pct } = req.body
    const patch: any = { updated_at: now() }

    if (status !== undefined) patch.status = status
    if (notes !== undefined) patch.notes = notes
    if (rooms_detected !== undefined) patch.rooms_detected = rooms_detected
    if (discount_pct !== undefined) patch.discount_pct = Math.max(-100, Math.min(100, Number(discount_pct) || 0))
    if (labor_cost_pct !== undefined) patch.labor_cost_pct = Math.max(0, Math.min(500, Number(labor_cost_pct) || 0))

    const currentQuote: any = await db.ai_quotes.find(req.params.id)
    const effectiveItems = items !== undefined ? items : currentQuote?.items ?? []
    const effectiveDiscount = patch.discount_pct ?? currentQuote?.discount_pct ?? 0
    const effectiveLabor = patch.labor_cost_pct ?? currentQuote?.labor_cost_pct ?? 100

    if (items !== undefined) {
      const enriched = (items as any[]).map((item: any) => {
        const qty = Number(item.qty) || 0
        const unit_price = Number(item.unit_price) || 0
        const disc = Math.max(0, Math.min(100, Number(item.discount_pct) || 0))
        return { ...item, qty, unit_price, discount_pct: disc, total: qty * unit_price * (1 - disc / 100) }
      })
      patch.items = enriched
      patch.total_net = computeTotal(enriched)
    } else if (discount_pct !== undefined || labor_cost_pct !== undefined) {
      patch.total_net = computeTotal(effectiveItems)
    }

    const totalNet = patch.total_net ?? currentQuote?.total_net ?? 0
    const { total_after_discount, labor_cost, grand_total } = computeGrandTotal(totalNet, effectiveDiscount, effectiveLabor)
    patch.total_after_discount = total_after_discount
    patch.labor_cost = labor_cost
    patch.grand_total = grand_total

    await db.ai_quotes.update(req.params.id, patch)
    const updated: any = await db.ai_quotes.find(req.params.id)
    const { ai_analysis_raw: _raw, ...rest } = updated
    res.json(rest)
  } catch {
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// ─── DELETE /:id ───────────────────────────────────────────────────────────────
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const quote = await db.ai_quotes.find(req.params.id)
    if (!quote || quote.project_id !== req.params.projectId) {
      res.status(404).json({ error: 'Wycena nie znaleziona' })
      return
    }

    // Delete floor plan file
    if (quote.floor_plan_filename) {
      const fp = path.join(UPLOADS_DIR, quote.floor_plan_filename)
      if (fs.existsSync(fp)) {
        try { fs.unlinkSync(fp) } catch {}
      }
    }

    await db.ai_quotes.delete(req.params.id)
    res.json({ success: true })
  } catch {
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// ─── GET /:id/ets-export ───────────────────────────────────────────────────────
router.get('/:id/ets-export', async (req: Request, res: Response) => {
  try {
  const quote = await db.ai_quotes.find(req.params.id)
  if (!quote || quote.project_id !== req.params.projectId) {
    res.status(404).json({ error: 'Wycena nie znaleziona' })
    return
  }

  const project = await db.projects.find(req.params.projectId)
  const projectName = project?.name ?? `Projekt_${req.params.projectId}`

  const items: any[] = ((quote.items as any[]) ?? []).filter((i: any) => i.brand === 'KNX')
  if (items.length === 0) {
    res.status(400).json({ error: 'Wycena nie zawiera elementów KNX' })
    return
  }

  // Group items by room
  const roomMap = new Map<string, any[]>()
  for (const item of items) {
    const room = item.room ?? 'Instalacja / Rozdzielnia'
    if (!roomMap.has(room)) roomMap.set(room, [])
    roomMap.get(room)!.push(item)
  }
  const rooms = Array.from(roomMap.keys())

  // Assign KNX device individual addresses (area.line.device)
  let deviceCounter = 1
  interface KnxDevice { item: any; addr: string; id: string; room: string }
  const devices: KnxDevice[] = []
  for (const [room, roomItems] of roomMap.entries()) {
    for (const item of roomItems) {
      for (let i = 0; i < (item.qty ?? 1); i++) {
        const addr = `1.1.${deviceCounter}`
        const devId = `D-${String(deviceCounter).padStart(4, '0')}`
        devices.push({ item, addr, id: devId, room })
        deviceCounter++
      }
    }
  }

  // Helper: detect device function type
  function deviceType(item: any): 'lighting' | 'blinds' | 'hvac' | 'sensor' | 'other' {
    const cat = (item.category ?? '').toLowerCase()
    const name = (item.name ?? '').toLowerCase()
    if (cat.includes('oświetl') || cat.includes('panel') || name.includes('ściemniacz') || name.includes('dali')) return 'lighting'
    if (cat.includes('żaluzj') || name.includes('żaluzj') || name.includes('siłownik')) return 'blinds'
    if (cat.includes('hvac') || cat.includes('regulator') || name.includes('hvac') || name.includes('temp')) return 'hvac'
    if (cat.includes('czujnik') || name.includes('czujnik') || name.includes('sensor')) return 'sensor'
    return 'other'
  }

  // Build GroupAddress entries: three-level (main/middle/ga)
  // Main 1 = Oświetlenie, Main 2 = Żaluzje, Main 3 = HVAC, Main 4 = Czujniki
  interface GA { id: string; name: string; address: string; datapoint: string }
  const gaMap: { [main: number]: { [sub: number]: GA[] } } = { 1: {}, 2: {}, 3: {}, 4: {} }
  let gaCounter = 1

  const mainNames: Record<number, string> = { 1: 'Oświetlenie', 2: 'Żaluzje', 3: 'HVAC', 4: 'Czujniki' }
  const gaSchemas: Record<string, Array<{ name: string; dp: string }>> = {
    lighting: [
      { name: 'ON/OFF', dp: '1.001' },
      { name: 'Dimm %', dp: '5.001' },
      { name: 'Stan', dp: '1.001' },
    ],
    blinds: [
      { name: 'Góra/Dół', dp: '1.008' },
      { name: 'Pozycja %', dp: '5.001' },
      { name: 'Lamele %', dp: '5.001' },
    ],
    hvac: [
      { name: 'Temp zadana', dp: '9.001' },
      { name: 'Temp aktualna', dp: '9.001' },
      { name: 'Tryb', dp: '20.102' },
    ],
    sensor: [
      { name: 'Ruch', dp: '1.002' },
      { name: 'Jasność lux', dp: '9.004' },
    ],
  }
  const mainForType: Record<string, number> = { lighting: 1, blinds: 2, hvac: 3, sensor: 4 }

  rooms.forEach((room, roomIdx) => {
    const roomDevices = devices.filter(d => d.room === room)
    const types = new Set(roomDevices.map(d => deviceType(d.item)))
    for (const type of types) {
      if (type === 'other') continue
      const main = mainForType[type]
      const sub = roomIdx + 1
      if (!gaMap[main][sub]) gaMap[main][sub] = []
      for (const schema of gaSchemas[type] ?? []) {
        const gaId = `GA-${String(gaCounter).padStart(5, '0')}`
        // three-level: main/sub/gaCounter
        const addr = `${main}/${sub}/${gaMap[main][sub].length + 1}`
        gaMap[main][sub].push({ id: gaId, name: `${room} - ${schema.name}`, address: addr, datapoint: schema.dp })
        gaCounter++
      }
    }
  })

  // ── project.xml ──────────────────────────────────────────────────────────────
  const projectXml = `<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/20" CreatedBy="SmartHomeManager" ToolVersion="1.0">
  <Project Id="P-0001">
    <ProjectInformation Name="${projectName.replace(/"/g, '&quot;')}" GroupAddressStyle="ThreeLevel" />
  </Project>
</KNX>`

  // ── 0.xml (topology + locations + group addresses) ────────────────────────
  const deviceInstancesXml = devices.map(d =>
    `        <DeviceInstance Id="${d.id}" Address="${d.addr.split('.')[2]}" Name="${d.item.name.replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}" ProductRefId="M-0001_H-0000_HP-0000" />`
  ).join('\n')

  const locationsXml = rooms.map((room, roomIdx) => {
    const refs = devices.filter(d => d.room === room).map(d =>
      `          <DeviceInstanceRef RefId="${d.id}" />`
    ).join('\n')
    return `      <BuildingPart Type="Room" Name="${room.replace(/"/g, '&quot;')}" Id="BP-R${roomIdx + 1}">\n${refs}\n      </BuildingPart>`
  }).join('\n')

  const gaRangesXml = Object.entries(gaMap).map(([main, subs]) => {
    const subRanges = Object.entries(subs as Record<number, GA[]>).map(([sub, gas]) => {
      const roomName = rooms[parseInt(sub) - 1] ?? `Strefa ${sub}`
      const gaEntries = gas.map(ga =>
        `          <GroupAddress Id="${ga.id}" Address="${ga.address}" Name="${ga.name.replace(/"/g,'&quot;')}" DatapointType="DPT-${ga.datapoint}" />`
      ).join('\n')
      return `      <GroupRange Id="GR-${main}-${sub}" RangeStart="${parseInt(main) * 2048 + (parseInt(sub) - 1) * 256}" RangeEnd="${parseInt(main) * 2048 + parseInt(sub) * 256 - 1}" Name="${roomName.replace(/"/g,'&quot;')}">\n${gaEntries}\n      </GroupRange>`
    }).join('\n')
    return `    <GroupRange Id="GR-${main}" RangeStart="${parseInt(main) * 2048}" RangeEnd="${parseInt(main) * 2048 + 2047}" Name="${mainNames[parseInt(main)]}">\n${subRanges}\n    </GroupRange>`
  }).join('\n')

  const zeroXml = `<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/20">
  <Project Id="P-0001">
    <Installations>
      <Installation Name="Installation 1">
        <Topology>
          <Area Address="1" Name="Instalacja" Id="P-1-0">
            <Line Address="1" Name="Linia główna" Id="P-1-1">
${deviceInstancesXml}
            </Line>
          </Area>
        </Topology>
        <Locations>
          <Building Name="${projectName.replace(/"/g,'&quot;')}" Id="BP-0">
            <BuildingPart Type="Floor" Name="Parter" Id="BP-F1">
${locationsXml}
            </BuildingPart>
          </Building>
        </Locations>
        <GroupAddresses>
          <GroupRanges>
${gaRangesXml}
          </GroupRanges>
        </GroupAddresses>
      </Installation>
    </Installations>
  </Project>
</KNX>`

  // ── Build ZIP ─────────────────────────────────────────────────────────────
  const zip = new JSZip()
  zip.file('project.xml', projectXml)
  zip.file('0/0.xml', zeroXml)

  const zipBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })

  // Transliterate Polish chars and strip non-ASCII so the header stays valid
  const translitMap: Record<string, string> = {
    ą:'a',ć:'c',ę:'e',ł:'l',ń:'n',ó:'o',ś:'s',ź:'z',ż:'z',
    Ą:'A',Ć:'C',Ę:'E',Ł:'L',Ń:'N',Ó:'O',Ś:'S',Ź:'Z',Ż:'Z',
  }
  const asciiName = projectName
    .split('').map((c: string) => translitMap[c] ?? c).join('')
    .replace(/[^a-zA-Z0-9_\- ]/g, '')
    .replace(/\s+/g, '_')
    .slice(0, 60) || 'projekt'
  const filename = `${asciiName}_KNX.knxproj`
  res.setHeader('Content-Type', 'application/octet-stream')
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
  res.send(zipBuffer)
  } catch {
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// ─── POST /:id/refine — AI applies user suggestion to existing quote ───────────
router.post('/:id/refine', async (req: Request, res: Response) => {
  const quote = await db.ai_quotes.find(req.params.id)
  if (!quote || quote.project_id !== req.params.projectId) {
    res.status(404).json({ error: 'Wycena nie znaleziona' }); return
  }

  const { suggestion } = req.body as { suggestion?: string }
  if (!suggestion?.trim()) {
    res.status(400).json({ error: 'Brak treści sugestii' }); return
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    res.status(500).json({ error: 'ANTHROPIC_API_KEY nie jest skonfigurowany' }); return
  }

  try {
    const client = new Anthropic({ apiKey })

    // Compact item representation for Claude (omit internal IDs)
    const itemsForAI = (quote.items as any[]).map((i: any) => ({
      room: i.room,
      brand: i.brand,
      category: i.category,
      name: i.name,
      qty: i.qty,
      unit: i.unit,
      unit_price: i.unit_price,
      discount_pct: i.discount_pct ?? 0,
    }))

    const refinePrompt = `Masz istniejącą wycenę smart home w formacie JSON (lista pozycji).
Zastosuj następującą sugestię / korektę użytkownika do tej wyceny.

SUGESTIA UŻYTKOWNIKA:
${suggestion.trim()}

AKTUALNA WYCENA (${itemsForAI.length} pozycji):
\`\`\`json
${JSON.stringify(itemsForAI, null, 2)}
\`\`\`

ZASADY:
1. Zastosuj TYLKO zmiany wynikające z sugestii. Nie modyfikuj innych pozycji.
2. Możesz: zmieniać model/nazwę produktu, cenę, ilość, kategorię, pokój; dodawać nowe pozycje; usuwać pozycje.
3. Zachowaj te same pola: room, brand, category, name, qty, unit, unit_price, discount_pct.
4. Trzymaj się cennika z systemu (HDL KNX, Control4, Hikvision, Satel) — używaj realnych cen produktów.
5. Zwróć WYŁĄCZNIE zmodyfikowaną tablicę JSON w bloku \`\`\`json ... \`\`\` — bez żadnego tekstu poza blokiem.
6. Tablica musi zawierać WSZYSTKIE pozycje (niezmodyfikowane + zmienione).

FORMAT ODPOWIEDZI:
\`\`\`json
[
  { "room": "...", "brand": "...", "category": "...", "name": "...", "qty": 1, "unit": "szt.", "unit_price": 0, "discount_pct": 0 },
  ...
]
\`\`\``

    const message = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: refinePrompt }],
    })

    const rawText = message.content[0].type === 'text' ? message.content[0].text : ''
    console.log('[AI Refine] stop_reason:', message.stop_reason, '| długość:', rawText.length)

    // Extract JSON array
    let jsonString: string | null = null
    const blockMatch = rawText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/)
    if (blockMatch?.[1]) {
      jsonString = blockMatch[1].trim()
    } else {
      const arrStart = rawText.indexOf('[')
      const arrEnd = rawText.lastIndexOf(']')
      if (arrStart !== -1 && arrEnd > arrStart) {
        jsonString = rawText.slice(arrStart, arrEnd + 1)
      }
    }

    if (!jsonString) {
      res.status(422).json({ error: 'AI nie zwróciło poprawnego JSON. Spróbuj ponownie.' }); return
    }

    let rawItems: any[]
    try {
      const parsed = JSON.parse(jsonrepair(jsonString))
      rawItems = Array.isArray(parsed) ? parsed : parsed.line_items ?? []
    } catch (e: any) {
      console.error('[AI Refine] Błąd parsowania JSON:', e.message)
      res.status(422).json({ error: 'Błąd parsowania odpowiedzi AI.', hint: e.message }); return
    }

    const catalogItems = await db.product_catalog.all()
    const newItems = rawItems.map((item: any, index: number) => {
      const itemName = (item.name || '').toLowerCase()
      const catalogMatch = catalogItems.find((c: any) =>
        c.brand === item.brand &&
        itemName.length > 8 &&
        c.name.toLowerCase().includes(itemName.slice(0, Math.min(itemName.length, 20)))
      )
      const qty = Number(item.qty) || 1
      const unit_price = Number(item.unit_price) || 0
      const discount_pct = Math.max(0, Math.min(100, Number(item.discount_pct) || 0))
      return {
        id: uuidv4(),
        room: item.room || '',
        brand: item.brand || 'KNX',
        category: item.category || '',
        name: item.name || '',
        qty,
        unit: item.unit || 'szt.',
        unit_price,
        discount_pct,
        total: qty * unit_price * (1 - discount_pct / 100),
        catalog_item_id: catalogMatch ? catalogMatch.id : null,
        sort_order: index,
      }
    })

    const totalNet = computeTotal(newItems)
    const { total_after_discount, labor_cost, grand_total } = computeGrandTotal(
      totalNet, quote.discount_pct ?? 0, quote.labor_cost_pct ?? 100
    )

    // Save refinement history
    const prevHistory: any[] = (quote as any).refine_history ?? []
    const historyEntry = {
      suggestion: suggestion.trim(),
      applied_at: now(),
      items_before: quote.items,
    }

    const updated = {
      ...quote,
      items: newItems,
      total_net: totalNet,
      total_after_discount,
      labor_cost,
      grand_total,
      updated_at: now(),
      refine_history: [...prevHistory, historyEntry].slice(-20), // keep last 20
    }

    await db.ai_quotes.update(req.params.id, updated)
    const { ai_analysis_raw: _raw, ...toReturn } = updated as any
    res.json(toReturn)

  } catch (err: any) {
    const msg = err?.error?.message || err?.message || 'Nieznany błąd'
    res.status(500).json({ error: `Błąd AI: ${msg}` })
  }
})

export default router
