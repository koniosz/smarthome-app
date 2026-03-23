import { Router, Request, Response } from 'express'
import { v4 as uuidv4 } from 'uuid'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import XLSX from 'xlsx'
import Anthropic from '@anthropic-ai/sdk'
import db from '../db'
import { requireAdmin, requireAuth } from '../middleware/auth'
import { jsonrepair } from 'jsonrepair'

const ATTACHMENTS_DIR = path.join(__dirname, '..', 'data', 'attachments')
if (!fs.existsSync(ATTACHMENTS_DIR)) fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true })

const importStorage = multer.diskStorage({
  destination: ATTACHMENTS_DIR,
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname)
    cb(null, `pricelist-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`)
  },
})
const importUpload = multer({
  storage: importStorage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase()
    if (['.xlsx', '.xls', '.pdf'].includes(ext)) cb(null, true)
    else cb(new Error('Tylko pliki Excel (.xlsx, .xls) i PDF'))
  },
})

const router = Router()

function now() {
  return new Date().toISOString()
}

// Pre-populated catalog seed data (Polish market prices, PLN net)
export const CATALOG_SEED = [
  // ─── KNX / HDL (Cennik 07.10.2024) ───────────────────────────────────────
  { sku: 'M/PT1RA.1', brand: 'KNX', category: 'Panel dotykowy', name: 'Tile Series 1 Button Smart Panel EU 2.0, used to control lighting, curtain and scene, plastic(ivory', unit: 'szt.', unit_price: 435.38, description: '' },
  { sku: 'M/PT1RA.1-v2', brand: 'KNX', category: 'Panel dotykowy', name: 'Tile Series 1 Button Smart Panel EU 2.0, used to control lighting, curtain and scene, metal(champagn', unit: 'szt.', unit_price: 545.67, description: '' },
  { sku: 'M/PT2RA.1', brand: 'KNX', category: 'Panel dotykowy', name: 'Tile Series 2 Button Smart Panel EU 2.0, used to control lighting, curtain and scene, plastic(ivory', unit: 'szt.', unit_price: 505.04, description: '' },
  { sku: 'M/PT2RA.1-v2', brand: 'KNX', category: 'Panel dotykowy', name: 'Tile Series 2 Button Smart Panel EU 2.0, used to control lighting, curtain and scene, metal(champagn', unit: 'szt.', unit_price: 615.33, description: '' },
  { sku: 'M/PT2RB.1', brand: 'KNX', category: 'Panel dotykowy', name: 'Tile Series 2 Button Smart Panel EU 2.0, used to control lighting, curtain and scene, plastic(ivory', unit: 'szt.', unit_price: 534.06, description: '' },
  { sku: 'M/PT2RB.1-v2', brand: 'KNX', category: 'Panel dotykowy', name: 'Tile Series 2 Button Smart Panel EU 2.0, used to control lighting, curtain and scene, metal(champagn', unit: 'szt.', unit_price: 644.36, description: '' },
  { sku: 'M/PT4RA.1', brand: 'KNX', category: 'Panel dotykowy', name: 'Tile Series 4 Button Smart Panel EU 2.0, used to control lighting, curtain and scene, plastic materi', unit: 'szt.', unit_price: 563.09, description: '' },
  { sku: 'M/PT4RA.1-v2', brand: 'KNX', category: 'Panel dotykowy', name: 'Tile Series 4 Button Smart Panel EU 2.0, used to control lighting, curtain and scene, metal(champagn', unit: 'szt.', unit_price: 673.38, description: '' },
  { sku: 'M/PT4RB.1', brand: 'KNX', category: 'Panel dotykowy', name: 'Tile Series 8 Button Smart Panel EU 2.0, used to control lighting, curtain and scene, plastic(ivory', unit: 'szt.', unit_price: 638.55, description: '' },
  { sku: 'M/PT4RB.1-v2', brand: 'KNX', category: 'Panel dotykowy', name: 'Tile Series 8 Button Smart Panel EU 2.0, used to control lighting, curtain and scene, metal(champagn', unit: 'szt.', unit_price: 748.85, description: '' },
  { sku: 'M/PTOL6.1', brand: 'KNX', category: 'Panel dotykowy', name: 'Tile Series Thermostat 2.0, used to control air conditioning, floor heating and fresh air system, pl', unit: 'szt.', unit_price: 1033.29, description: '' },
  { sku: 'M/PTOL6.1-v2', brand: 'KNX', category: 'Panel dotykowy', name: 'Tile Series Thermostat 2.0, used to control air conditioning, floor heating and fresh air system, me', unit: 'szt.', unit_price: 1143.59, description: '' },
  { sku: 'M/PTL35.1', brand: 'KNX', category: 'Panel dotykowy', name: 'Tile Display, With 3.5-inch 480*480 LCD Touch screen, Built-in temperature, humidity and proximity s', unit: 'szt.', unit_price: 1991.12, description: '' },
  { sku: 'HDL-MP1-W-CARD/TILE.48', brand: 'KNX', category: 'Panel dotykowy', name: 'Tile Series Dry contact Card Holder Panel, master card panel for energy control of hotel guest room', unit: 'szt.', unit_price: 336.69, description: '' },
  { sku: 'HDL-MP1-S-SR/TILE.48', brand: 'KNX', category: 'Panel dotykowy', name: 'Tile / Single Rocker On/Off Switch, Rated voltage: 250V AC~ 16A, four colors(ivory white, ash gray,', unit: 'szt.', unit_price: 63.86, description: '' },
  { sku: 'HDL-MP2-S-DR/TILE.48', brand: 'KNX', category: 'Panel dotykowy', name: 'Tile / Duplex Rocker On/Off Switch, Rated voltage: 250V AC~ 16A, four colors(ivory white, ash gray,', unit: 'szt.', unit_price: 98.69, description: '' },
  { sku: 'HDL-MP3-S-TR/TILE.48', brand: 'KNX', category: 'Panel dotykowy', name: 'Tile / Triple Rocker On/Off Switch, Rated voltage: 250V AC~ 16A, four colors(ivory white, ash gray,', unit: 'szt.', unit_price: 121.91, description: '' },
  { sku: 'HDL-MP1-P-SD/TILE.48', brand: 'KNX', category: 'Panel dotykowy', name: 'Tile / Single Dry Contact Push Switch, Rated voltage: 250V AC~ 16A, four colors (ivory white, ash gr', unit: 'szt.', unit_price: 69.66, description: '' },
  { sku: 'HDL-MP2-P-DD/TILE.48', brand: 'KNX', category: 'Panel dotykowy', name: 'Tile / Duplex Dry Contact Push Switch, Rated voltage: 250V AC~ 16A, four colors (ivory white, ash gr', unit: 'szt.', unit_price: 110.3, description: '' },
  { sku: 'HDL-MP3-P-TD/TILE.48', brand: 'KNX', category: 'Panel dotykowy', name: 'Tile / Triple Dry Contact Push Switch, Rated voltage: 250V AC~ 16A, four colors(ivory white, ash gra', unit: 'szt.', unit_price: 139.32, description: '' },
  { sku: 'HDL-MP1-S-EU/TILE.48', brand: 'KNX', category: 'Panel dotykowy', name: 'Tile EU Socket, Rated voltage: 250V AC~ 16A, four colors(ivory white, ash gray, champagne gold and s', unit: 'szt.', unit_price: 121.91, description: '' },
  { sku: 'HDL-MP1-S-M-EU/TILE.48', brand: 'KNX', category: 'Panel dotykowy', name: 'Tile Universal Socket, Rated voltage: 250V AC~ 10A, four colors(ivory white, ash gray, champagne gol', unit: 'szt.', unit_price: 75.47, description: '' },
  { sku: 'HDL-MP2-W-USB/TILE.48', brand: 'KNX', category: 'Panel dotykowy', name: 'Tile Dual USB Charger Wall Outlet, AC 100-240V~, 50/60Hz, Maximum current 0.3A, Output 2.4A DC5V, fo', unit: 'szt.', unit_price: 278.64, description: '' },
  { sku: 'HDL-MP1-USB-HDMI', brand: 'KNX', category: 'Panel dotykowy', name: 'Tile HDMI with USB Charger, AC 100-240V~, 50/60Hz, Maximum current 0.3A, Output 2.4A DC5V, four colo', unit: 'szt.', unit_price: 452.79, description: '' },
  { sku: 'HDL-MP1-USB-Type C/TILE.48-A', brand: 'KNX', category: 'Panel dotykowy', name: 'Tile USB2.0 and Type-C Socket, AC 100-240V~, 50/60Hz, Maximum current 0.3A, Output Power 20W, Type-C', unit: 'szt.', unit_price: 388.94, description: '' },
  { sku: 'HDL-MP1-USB-Type C/TILE.48-B', brand: 'KNX', category: 'Panel dotykowy', name: 'Tile USB2.0 and Type-C Socket, AC 100-240V~, 50/60Hz, Maximum current 0.3A, Output Power 20W, Type-C', unit: 'szt.', unit_price: 388.94, description: '' },
  { sku: 'HDL-MP1-USB-Type C/TILE.48-C', brand: 'KNX', category: 'Panel dotykowy', name: 'Tile USB2.0 and Type-C Socket, AC 100-240V~, 50/60Hz, Maximum current 0.3A, Output Power 20W, Type-C', unit: 'szt.', unit_price: 388.94, description: '' },
  { sku: 'HDL-MP1-USB-Type C/TILE.48-D', brand: 'KNX', category: 'Panel dotykowy', name: 'Tile USB2.0 and Type-C Socket, AC 100-240V~, 50/60Hz, Maximum current 0.3A, Output Power 20W, Type-C', unit: 'szt.', unit_price: 388.94, description: '' },
  { sku: 'HDL-MP1-W-ETH/TILE.48', brand: 'KNX', category: 'Panel dotykowy', name: 'Tile 1 Port Ethernet Wall Plate, four colors(ivory white, ash gray, champagne gold and space gray) a', unit: 'szt.', unit_price: 214.79, description: '' },
  { sku: 'HDL-MP1-W-TEL/TILE.48', brand: 'KNX', category: 'Panel dotykowy', name: 'Tile 1 Port Telephone Wall Jack, four colors(ivory white, ash gray, champagne gold and space gray) a', unit: 'szt.', unit_price: 133.52, description: '' },
  { sku: 'HDL-MP1-W-CATV/TILE.48', brand: 'KNX', category: 'Panel dotykowy', name: 'Tile 1 Port Toslink Wall Plate(CATV), four colors(ivory white, ash gray, champagne gold and space gr', unit: 'szt.', unit_price: 133.52, description: '' },
  { sku: 'HDL-MP1-W-BBTV/TILE.48', brand: 'KNX', category: 'Panel dotykowy', name: 'Tile 1 Port Coax Cable TV-F-Type Wall Plate(BBTV), four colors(ivory white, ash gray, champagne gold', unit: 'szt.', unit_price: 174.15, description: '' },
  { sku: 'HDL-MP1-E-A/TILE.48', brand: 'KNX', category: 'Panel dotykowy', name: 'Tile Series Emergency Panel, Rated voltage and current: 250V AC~, 3A, four colors (ivory white, ash', unit: 'szt.', unit_price: 110.3, description: '' },
  { sku: 'HDL-MP1-EC/TILE.48', brand: 'KNX', category: 'Panel dotykowy', name: 'Tile Series 1 Gang Panel Frame, plastic(ivory white, ash gray, champagne gold and space gray)', unit: 'szt.', unit_price: 17.42, description: '' },
  { sku: 'HDL-MP1-EC/TILE.48-v2', brand: 'KNX', category: 'Panel dotykowy', name: 'Tile Series 1 Gang Panel Frame, metal (champagne gold/space gray color) material', unit: 'szt.', unit_price: 104.49, description: '' },
  { sku: 'HDL-MP2H-EC/TILE.48', brand: 'KNX', category: 'Panel dotykowy', name: 'Tile Series 2 Gangs Panel Frame, plastic(ivory white, ash gray, champagne gold and space gray) are a', unit: 'szt.', unit_price: 29.03, description: '' },
  { sku: 'HDL-MP2H-EC/TILE.48-v2', brand: 'KNX', category: 'Panel dotykowy', name: 'Tile Series 2 Gangs Panel Frame, metal (champagne gold/space gray color) material', unit: 'szt.', unit_price: 208.98, description: '' },
  { sku: 'HDL-MP3H-EC/TILE.48', brand: 'KNX', category: 'Panel dotykowy', name: 'Tile Series 3 Gangs Panel Frame, plastic(ivory white, ash gray, champagne gold and space gray) are a', unit: 'szt.', unit_price: 46.44, description: '' },
  { sku: 'HDL-MP3H-EC/TILE.48-v2', brand: 'KNX', category: 'Panel dotykowy', name: 'Tile Series 3 Gangs Panel Frame, metal (champagne gold/space gray color) material', unit: 'szt.', unit_price: 319.28, description: '' },
  { sku: 'HDL-MP4H-EC/TILE.48', brand: 'KNX', category: 'Panel dotykowy', name: 'Tile Series 4 Gangs Panel Frame, plastic(ivory white, ash gray, champagne gold and space gray) are a', unit: 'szt.', unit_price: 75.47, description: '' },
  { sku: 'HDL-MP4H-EC/TILE.48-v2', brand: 'KNX', category: 'Panel dotykowy', name: 'Tile Series 4 Gangs Panel Frame, metal (champagne gold/space gray color) material', unit: 'szt.', unit_price: 435.38, description: '' },
  { sku: 'HDL-MP2V-EC/TILE.48', brand: 'KNX', category: 'Panel dotykowy', name: 'Tile Series 2 Gangs Panel Frame, vertical installation, metal material(champagne gold/ space gray) i', unit: 'szt.', unit_price: 214.79, description: '' },
  { sku: 'HDL-MP3V-EC/TILE.48', brand: 'KNX', category: 'Panel dotykowy', name: 'Tile Series 3 Gangs Panel Frame, vertical installation, metal material(champagne gold/ space gray) i', unit: 'szt.', unit_price: 325.08, description: '' },
  { sku: 'HDL-MP4V-EC/TILE.48', brand: 'KNX', category: 'Panel dotykowy', name: 'Tile Series 4 Gangs Panel Frame, vertical installation, metal material(champagne gold/ space gray) i', unit: 'szt.', unit_price: 441.18, description: '' },
  { sku: 'GI-BOX-P', brand: 'KNX', category: 'Panel dotykowy', name: 'Plastic 86 Size Back box, for Combination installation of Tile Panel, Power interfae with Relay outp', unit: 'szt.', unit_price: 23.22, description: '' },
  { sku: 'MGWSIPD-LK.18', brand: 'KNX', category: 'Panel dotykowy', name: 'Source 7 Touch Screen, Android OS with built-in Smart home App to control lighting, curtain, air con', unit: 'szt.', unit_price: 3375.5, description: '' },
  { sku: 'MPWS2R1ETH-KT.18', brand: 'KNX', category: 'Panel dotykowy', name: 'Source 7 KNX Power Interface, input voltage:21-30V DC and Auxiliary power DC24V, to provide power su', unit: 'szt.', unit_price: 1397.5, description: '' },
  { sku: 'M/PTL4.1', brand: 'KNX', category: 'Panel dotykowy', name: 'Granite Display Panel EU, with 4-inch LCD screen and Aluminum plate, used to control lighting, curta', unit: 'szt.', unit_price: 2322.0, description: '' },
  { sku: 'M/PTL4.31', brand: 'KNX', category: 'Panel dotykowy', name: 'Granite Display Panel US, with 4.3-inch 800x480 high resolution LCD screen and Aluminum plate, used', unit: 'szt.', unit_price: 2426.49, description: '' },
  { sku: 'M/P2R.1', brand: 'KNX', category: 'Panel dotykowy', name: 'Granite Series 4 Buttons Smart Panel EU, with Metal plate, used to control lighting, curtain and sce', unit: 'szt.', unit_price: 975.24, description: '' },
  { sku: 'M/P3R.1', brand: 'KNX', category: 'Panel dotykowy', name: 'Granite Series 6 Buttons Smart Panel US, with Metal plate, used to control lighting, curtain and sce', unit: 'szt.', unit_price: 1137.78, description: '' },
  { sku: 'M/MPTLC43.1-A2', brand: 'KNX', category: 'Panel dotykowy', name: '4.3 inch Enviro Touch Screen, With LCD screen and Aluminum Frame, Multipage used to control the ligh', unit: 'szt.', unit_price: 2426.49, description: '' },
  { sku: 'M/MPT14.1-A2', brand: 'KNX', category: 'Panel dotykowy', name: 'Modern Series DLP Touch Panel US, with LCD screen and Aluminum Frame, Multipage used to control the', unit: 'szt.', unit_price: 1915.65, description: '' },
  { sku: 'M/DLP04.1-A2', brand: 'KNX', category: 'Panel dotykowy', name: 'Modern Series DLP Smart Panel EU, with LCD screen and Aluminum Frame, Multipage used to control the', unit: 'szt.', unit_price: 1509.3, description: '' },
  { sku: 'M/DLP04.1-A2-v2', brand: 'KNX', category: 'Panel dotykowy', name: 'Modern Series DLP Smart Panel US, with LCD screen and Aluminum Frame, Multipage used to control the', unit: 'szt.', unit_price: 1549.94, description: '' },
  { sku: 'M/TBP2.1-A2', brand: 'KNX', category: 'Panel dotykowy', name: 'iTouch Series 2 Buttons Touch Panel EU, with Aluminum Frame, used to control lighting, curtain and s', unit: 'szt.', unit_price: 563.09, description: '' },
  { sku: 'M/TBP4.1-A2', brand: 'KNX', category: 'Panel dotykowy', name: 'iTouch Series 4 Buttons Touch Panel EU, with Aluminum Frame, used to control lighting, curtain and s', unit: 'szt.', unit_price: 597.92, description: '' },
  { sku: 'M/TBP2.1-A2-v2', brand: 'KNX', category: 'Panel dotykowy', name: 'iTouch Series 2 Buttons Touch Panel US, with Aluminum Frame, used to control lighting, curtain and s', unit: 'szt.', unit_price: 597.92, description: '' },
  { sku: 'M/TBP4.1-A2-v2', brand: 'KNX', category: 'Panel dotykowy', name: 'iTouch Series 4 Buttons Touch Panel US, with Aluminum Frame, used to control lighting, curtain and s', unit: 'szt.', unit_price: 696.6, description: '' },
  { sku: 'M/TBP6.1-A2', brand: 'KNX', category: 'Panel dotykowy', name: 'iTouch Series 6 Buttons Touch Panel US, with Aluminum Frame, used to control lighting, curtain and s', unit: 'szt.', unit_price: 795.29, description: '' },
  { sku: 'M/PCI2PE.1', brand: 'KNX', category: 'Zasilacz paneli', name: 'Panel Power Interface EU (with External Power Supply), provides DC power and communicates to M/PTL4.', unit: 'szt.', unit_price: 348.3, description: '' },
  { sku: 'M/PCI2PU.2', brand: 'KNX', category: 'Zasilacz paneli', name: 'Panel Power Interface US (with External Power Supply), provides DC power and communicates to M/MPTLC', unit: 'szt.', unit_price: 348.3, description: '' },
  { sku: 'M/PCI.1-A', brand: 'KNX', category: 'Zasilacz paneli', name: 'Panel Power Interface EU, provides DC power and communicates to HDL Wall panel, For EU Type panel th', unit: 'szt.', unit_price: 348.3, description: '' },
  { sku: 'M/PCI.3-A', brand: 'KNX', category: 'Zasilacz paneli', name: 'Panel Power Interface US, provides DC power and communicates to HDL Wall panel For US Type panel tha', unit: 'szt.', unit_price: 348.3, description: '' },
  { sku: 'M/PCI.1', brand: 'KNX', category: 'Zasilacz paneli', name: 'Panel Power Interface EU, provides DC power and communicates to HDL Wall panel, For EU Type panel th', unit: 'szt.', unit_price: 348.3, description: '' },
  { sku: 'M/PCI.3', brand: 'KNX', category: 'Zasilacz paneli', name: 'Panel Power Interface US, provides DC power and communicates to HDL Wall panel For US Type panel tha', unit: 'szt.', unit_price: 348.3, description: '' },
  { sku: 'M/PTCI.1', brand: 'KNX', category: 'Zasilacz paneli', name: 'Panel Power Interface EU, provides DC power and communicates to HDL Tile Series Wall panel Excludes', unit: 'szt.', unit_price: 348.3, description: '' },
  { sku: 'M/PTCI2P.1', brand: 'KNX', category: 'Zasilacz paneli', name: 'Panel Power Interface EU (with External Power Supply), provides DC power and communicates to Tile Se', unit: 'szt.', unit_price: 348.3, description: '' },
  { sku: 'M/PTCI2P3R.1', brand: 'KNX', category: 'Sterowanie oświetleniem', name: 'Tile Series Power Interface With 3CH 10A Relay, Input voltage:AC100-240V (50/60Hz), Auxiliary power', unit: 'szt.', unit_price: 1033.29, description: '' },
  { sku: 'M/PTCI2P2R.1', brand: 'KNX', category: 'Sterowanie oświetleniem', name: 'Tile Series Power Interface With 2CH 10A Relay, Input voltage:AC100-240V (50/60Hz), Auxiliary power', unit: 'szt.', unit_price: 923.0, description: '' },
  { sku: 'M/PCI2PC3R.1', brand: 'KNX', category: 'Sterowanie oświetleniem', name: 'Power Interface With 3CH 10A Relay, Input voltage:AC100-240V (50/60Hz), Auxiliary current output, 10', unit: 'szt.', unit_price: 1033.29, description: '' },
  { sku: 'M/PCI2PC2R.1', brand: 'KNX', category: 'Sterowanie oświetleniem', name: 'Power Interface With 2CH 10A Relay, Input voltage:AC100-240V (50/60Hz), Auxiliary current output: 10', unit: 'szt.', unit_price: 923.0, description: '' },
  { sku: 'M/FMC3R.1', brand: 'KNX', category: 'Sterowanie oświetleniem', name: '3CH 10A Flush-mounted Switch Actuator, Input Voltage:AC100-240V, 50/60Hz), 3CH, 10A/CH relay output', unit: 'szt.', unit_price: 934.61, description: '' },
  { sku: 'M/FME2R.1', brand: 'KNX', category: 'Sterowanie oświetleniem', name: '2CH 10A Flush-mounted Switch Actuator, Input Voltage:AC100-240V, 50/60Hz), 2CH, 10A/CH relay output', unit: 'szt.', unit_price: 847.53, description: '' },
  { sku: 'M/FME1R.1', brand: 'KNX', category: 'Sterowanie oświetleniem', name: '1CH 16A Flush-mounted Switch Actuator, Input Voltage:AC100-240V, 50/60Hz), 2CH, 10A/CH relay output', unit: 'szt.', unit_price: 772.07, description: '' },
  { sku: 'M/FME1D.1', brand: 'KNX', category: 'Sterowanie oświetleniem', name: '1CH 1A Flush-mounted Mosfet Dimming Actuator, Input Voltage:AC100-240V, 50/60Hz), 1CH, 1A Mosfet dim', unit: 'szt.', unit_price: 981.05, description: '' },
  { sku: 'M/MHR17U.1', brand: 'KNX', category: 'Sterowanie oświetleniem', name: '17CH Mix Actuator, DIN-Rail Mount, totally 17CH (12CH 5A TV8 relay, 5CH 10A Magnetic latching relay)', unit: 'szt.', unit_price: 2049.17, description: '' },
  { sku: 'M/MHD02R17U.1', brand: 'KNX', category: 'Sterowanie oświetleniem', name: '19CH Mix Actuator, DIN-Rail Mount, totally 19CH (12CH 5A TV8 relay, 5CH 10A Magnetic latching relay', unit: 'szt.', unit_price: 2501.96, description: '' },
  { sku: 'M/R4.16.1-CD', brand: 'KNX', category: 'Sterowanie oświetleniem', name: '4CH 16A Energy Management Actuator, DIN-Rail Mount, 16A per Channel, both110/250 VAC, 50-60Hz, inter', unit: 'szt.', unit_price: 1294.52, description: '' },
  { sku: 'M/R8.16.1-CD', brand: 'KNX', category: 'Sterowanie oświetleniem', name: '8CH 16A Energy Management Actuator, DIN-Rail Mount, 16A per Channel, both110/250 VAC, 50-60Hz, inter', unit: 'szt.', unit_price: 2089.8, description: '' },
  { sku: 'M/R12.16.1-CD', brand: 'KNX', category: 'Sterowanie oświetleniem', name: '12CH 16A Energy Management Actuator, DIN-Rail Mount, 16A per Channel, both110/250 VAC, 50-60Hz, inte', unit: 'szt.', unit_price: 2919.92, description: '' },
  { sku: 'M/R4.16.1', brand: 'KNX', category: 'Sterowanie oświetleniem', name: '4CH 16A High Power Switch Actuator, DIN-Rail Mount, 16A per Channel, both110/250 VAC, 50-60Hz, inter', unit: 'szt.', unit_price: 1201.64, description: '' },
  { sku: 'M/R8.16.1', brand: 'KNX', category: 'Sterowanie oświetleniem', name: '8CH 16A High Power Switch Actuator, DIN-Rail Mount, 16A per Channel, both110/250 VAC, 50-60Hz, inter', unit: 'szt.', unit_price: 1898.24, description: '' },
  { sku: 'M/R12.16.1', brand: 'KNX', category: 'Sterowanie oświetleniem', name: '12CH 16A High Power Switch Actuator, DIN-Rail Mount, 16A per Channel, both 110/250 VAC, 50-60Hz, int', unit: 'szt.', unit_price: 2583.23, description: '' },
  { sku: 'M/R4.10.1', brand: 'KNX', category: 'Sterowanie oświetleniem', name: '4CH 10A High Power Switch Actuator, DIN-Rail Mount, 10A per Channel, both 110/250 VAC, 50-60Hz, inte', unit: 'szt.', unit_price: 1085.54, description: '' },
  { sku: 'M/R8.10.1', brand: 'KNX', category: 'Sterowanie oświetleniem', name: '8CH 10A High Power Switch Actuator, DIN-Rail Mount, 10A per Channel, both 110/250 VAC, 50-60Hz, inte', unit: 'szt.', unit_price: 1509.3, description: '' },
  { sku: 'M/R12.10.1', brand: 'KNX', category: 'Sterowanie oświetleniem', name: '12CH 10A High Power Switch Actuator, DIN-Rail Mount, 10A per Channel, both110/250 VAC, 50-60Hz, inte', unit: 'szt.', unit_price: 1973.7, description: '' },
  { sku: 'M/R16.10.1', brand: 'KNX', category: 'Sterowanie oświetleniem', name: '16CH 10A High Power Switch Actuator, DIN-Rail Mount, 10A per Channel, both110/250 VAC, 50-60Hz, inte', unit: 'szt.', unit_price: 2223.32, description: '' },
  { sku: 'M/DM02.1', brand: 'KNX', category: 'Sterowanie oświetleniem', name: '2CH 3A Trailing Edge Dimming Actuator, DIN-Rail Mount, 3A per Channel and totally 6A, both110/220 VA', unit: 'szt.', unit_price: 2182.68, description: '' },
  { sku: 'M/DM04.1', brand: 'KNX', category: 'Sterowanie oświetleniem', name: '4CH 1.5A Trailing Edge Dimming Actuator, DIN-Rail Mount, 1.5A per Channel and totally 6A, both110/22', unit: 'szt.', unit_price: 2594.84, description: '' },
  { sku: 'M/DM06.1', brand: 'KNX', category: 'Sterowanie oświetleniem', name: '6CH 1.5A Trailing Edge Dimming Actuator, DIN-Rail Mount, 1.5A per Channel and totally 9A, both110/22', unit: 'szt.', unit_price: 3140.51, description: '' },
  { sku: 'M/DALI.1', brand: 'KNX', category: 'Sterowanie oświetleniem', name: 'DALI Master Actuator, DIN-Rail Mount, both110/250 VAC, 50-60Hz, supports communication between the H', unit: 'szt.', unit_price: 1828.58, description: '' },
  { sku: 'M/DA6.10.1', brand: 'KNX', category: 'Sterowanie oświetleniem', name: '6CH 10A Ballast Dimming Actuator, DIN-Rail Mount, 10A per channel, both110/250 VAC, 50-60Hz, Control', unit: 'szt.', unit_price: 1915.65, description: '' },
  { sku: 'M/DMX512.1', brand: 'KNX', category: 'Sterowanie oświetleniem', name: 'DMX Recorder Module, DIN-Rail Mount, Input signal: DMX512, HDL NET DMX, ArtNet DMX, Output Singal: D', unit: 'szt.', unit_price: 2397.47, description: '' },
  { sku: 'M/DRGBW4.1', brand: 'KNX', category: 'Sterowanie oświetleniem', name: '4CH 7A RGBW Driver, each channel can be used separately or used for RGBW composite control. support', unit: 'szt.', unit_price: 1040.84, description: '' },
  { sku: 'M/EA3.16.1', brand: 'KNX', category: 'Zarządzanie energią', name: 'KNX Energy Meter Actuator, Din-rail Mounted, AC110V-240V, 3CH single phase Power meter, Able to Meas', unit: 'szt.', unit_price: 1741.5, description: '' },
  { sku: 'M/W04.10.1', brand: 'KNX', category: 'Sterowanie żaluzjami', name: '4CH 10A Curtain Actuator: DIN-Rail Mount, 10A per Channel, both110/250 VAC, 50-60Hz, internal use of', unit: 'szt.', unit_price: 1433.84, description: '' },
  { sku: 'MWC1-KT.10', brand: 'KNX', category: 'Sterowanie żaluzjami', name: 'KNX cutain motor, Rated input voltage 100 - 240V AC, 50/60Hz, Open /close / stop/ open or close at s', unit: 'szt.', unit_price: 1468.67, description: '' },
  { sku: 'M/AG40B.1', brand: 'KNX', category: 'Sterowanie żaluzjami', name: 'KNX Blind Motor, Rated input voltage AC220-240V(50Hz), Up/Down, stop, percentage control, High-accur', unit: 'szt.', unit_price: 3617.68, description: '' },
  { sku: 'KNX Blind Motor Track', brand: 'KNX', category: 'Sterowanie żaluzjami', name: 'Tube for Tubular Blind Motor, Do NOT support segmented connection, Maximum length: 2.6meters', unit: 'szt.', unit_price: 220.59, description: '' },
  { sku: 'HDL-230', brand: 'KNX', category: 'Sterowanie żaluzjami', name: 'Dry Contact Curtain Motor, input voltage AC110-220V, power 30W, open, stop, close, manual control an', unit: 'szt.', unit_price: 667.58, description: '' },
  { sku: 'HDL-210', brand: 'KNX', category: 'Sterowanie żaluzjami', name: 'Dry Contact Curtain Motor With Adapter, input voltage DC24, power 30W, open, stop, close, manual con', unit: 'szt.', unit_price: 760.46, description: '' },
  { sku: 'HDL-YR2188', brand: 'KNX', category: 'Sterowanie żaluzjami', name: 'Curtain Remote Controller, voltage: 3.3V button cell, can control 2 motors', unit: 'szt.', unit_price: 145.13, description: '' },
  { sku: 'M/FCU01.10.1', brand: 'KNX', category: 'HVAC', name: 'FCU & Floor Heating Actuator, DIN-Rail Mount, 5CH for relay output and 2CH DC 0-10V output. with FCU', unit: 'szt.', unit_price: 1166.81, description: '' },
  { sku: 'M/FCHC.4.1', brand: 'KNX', category: 'HVAC', name: 'FCHC Actuator, Din Rail Mount, it is for control air condition, fan, compressor, and floor heating.', unit: 'szt.', unit_price: 1317.74, description: '' },
  { sku: 'TS/C 1.0', brand: 'KNX', category: 'HVAC', name: '2.5 Meter Digital Thermometer, for FCU Actuator, one wire bus for all of sensor, simple installation', unit: 'szt.', unit_price: 40.64, description: '' },
  { sku: 'M/S04.1', brand: 'KNX', category: 'Wejścia/Wyjścia', name: '4 Zone Dry Contact Module, includes 4 Dry Contact input channels, coupled with a temperature sensor', unit: 'szt.', unit_price: 522.45, description: '' },
  { sku: 'TTS/APR 1.0', brand: 'KNX', category: 'Wejścia/Wyjścia', name: '2.5 Meter Temperature Probe, Analog sensor, work with Dry Contact Module for temperature collection', unit: 'szt.', unit_price: 17.42, description: '' },
  { sku: 'M/S08.1', brand: 'KNX', category: 'Wejścia/Wyjścia', name: '8 Zone Dry Contact Module, includes 8 Dry Contact input channels, which is able to control sensors a', unit: 'szt.', unit_price: 795.29, description: '' },
  { sku: 'M/S24.1', brand: 'KNX', category: 'Wejścia/Wyjścia', name: '24 Zone Dry Contact Module, includes 24 Dry Contact input channels, serves as a bridge between mecha', unit: 'szt.', unit_price: 1277.1, description: '' },
  { sku: 'M/S48.1', brand: 'KNX', category: 'Wejścia/Wyjścia', name: '48 Zone Dry Contact Module, can be used as binary inputs and binary outputs. Binary input: used to s', unit: 'szt.', unit_price: 1735.7, description: '' },
  { sku: 'M/IRAC.1', brand: 'KNX', category: 'Wejścia/Wyjścia', name: 'Infrared Emitter, Supports 4 channel infrared interfaces, totally can store up to 650 infrared codes', unit: 'szt.', unit_price: 696.6, description: '' },
  { sku: 'Infrared Emission Probe', brand: 'KNX', category: 'Wejścia/Wyjścia', name: 'Infrared Emission Probe, to work with HDL-M/IRAC.1 Infrared Emitter', unit: 'szt.', unit_price: 40.64, description: '' },
  { sku: 'HDL-MIR01L.01', brand: 'KNX', category: 'Wejścia/Wyjścia', name: 'Infrared Code Learner, USB Pluggable, IR learning/ Programming Kit. Comes with Software driver, for', unit: 'szt.', unit_price: 737.24, description: '' },
  { sku: 'M/SIS05.1', brand: 'KNX', category: 'Czujnik', name: 'Reccess Mount Presence Sensor, includes PIR sensor, temperature sensor and brightness sensor. 4 inde', unit: 'szt.', unit_price: 899.78, description: '' },
  { sku: 'M/HSD24.1', brand: 'KNX', category: 'Czujnik', name: 'Surface Mount OmniSense Sensor, includes Lux sensor, motion sensor and temperature sensor, support t', unit: 'szt.', unit_price: 1062.32, description: '' },
  { sku: 'M/WS05.1-A', brand: 'KNX', category: 'Czujnik', name: 'Wall Mount Outdoor Microwave Sensor, includes LUX sensor, microwave sensor, humidity sensor, tempera', unit: 'szt.', unit_price: 911.39, description: '' },
  { sku: 'M/WS05.1-D', brand: 'KNX', category: 'Czujnik', name: 'Surface Mount Indoor Microwave Sensor, includes 4 independent logic blocks and 1 combined logic bloc', unit: 'szt.', unit_price: 783.68, description: '' },
  { sku: 'M/IS05.1', brand: 'KNX', category: 'Czujnik', name: 'Reccess Mount PIR & Lux Sensor, Standard KNX Terminal, includes motion sensor, LUX sensor and extern', unit: 'szt.', unit_price: 748.85, description: '' },
  { sku: 'M/HS05.1', brand: 'KNX', category: 'Czujnik', name: 'Surface Mount PIR & Lux Sensor, Standard KNX Terminal, includes motion sensor, Lux sensor, temperatu', unit: 'szt.', unit_price: 748.85, description: '' },
  { sku: 'MSA021D RC', brand: 'KNX', category: 'Czujnik', name: 'Recessed Mount LifeBeing & LUX Presence Sensor, Flush mounted, built in 5.8G Hz Microwave Lifebeing', unit: 'szt.', unit_price: 522.45, description: '' },
  { sku: 'MSA200D RC', brand: 'KNX', category: 'Czujnik', name: 'Recessed Mount LifeBeing & LUX Presence Sensor, Flush mounted, built in 24G Hz Microwave Lifebeing d', unit: 'szt.', unit_price: 638.55, description: '' },
  { sku: 'MH10', brand: 'KNX', category: 'Czujnik', name: 'Infrared Remote Control of LifeBeing Presence Sensor, can set the parameters of sensitivity, hold ti', unit: 'szt.', unit_price: 754.65, description: '' },
  { sku: 'M/GWASC.1', brand: 'KNX', category: 'Akcesoria', name: 'HDL Link-KNX Gateway, gateway between HDL Link and KNX Bus communication, supports protocol http/clu', unit: 'szt.', unit_price: 3076.65, description: '' },
  { sku: 'M/RS485MNI.1', brand: 'KNX', category: 'Akcesoria', name: 'KNX-RS485 Interface Mini, Installed in junction box or on DIN rail with accessory. Supports protocol', unit: 'szt.', unit_price: 870.75, description: '' },
  { sku: 'M/KRS232/485.1', brand: 'KNX', category: 'Akcesoria', name: 'KNX/RS232/RS485 Converter, used for bidirectional data exchange between KNX and RS232, KNX and RS485', unit: 'szt.', unit_price: 1230.66, description: '' },
  { sku: 'M/P960.1', brand: 'KNX', category: 'Akcesoria', name: '960mA Power Supply Module, DIN-Rail Mount, both110/250 VAC, 50-60Hz, can output maximum 960mA Curren', unit: 'szt.', unit_price: 928.8, description: '' },
  { sku: 'M/TM04.1', brand: 'KNX', category: 'Akcesoria', name: 'Master/Slave Timer Controller This timer controller is embedded with RTC, can run real time itself,', unit: 'szt.', unit_price: 1956.29, description: '' },
  { sku: 'M/IPRT.1', brand: 'KNX', category: 'Infrastruktura', name: 'KNX IP Rounter, It can be used as line- or backbone coupler and provides a data connection between t', unit: 'szt.', unit_price: 3941.6, description: '' },
  { sku: 'M/USB.1', brand: 'KNX', category: 'Infrastruktura', name: 'KNX USB Interface, DIN-Rail Mount, with USB Connector galvanically isolated from KNX Bus that establ', unit: 'szt.', unit_price: 2089.8, description: '' },
  { sku: 'M/LCR.1', brand: 'KNX', category: 'Infrastruktura', name: 'KNX Line Coupler, DIN-Rail Mount, to be used as coupler and Repeater(to amplify the signal), if as a', unit: 'szt.', unit_price: 3192.75, description: '' },
  { sku: 'HDL GVP', brand: 'KNX', category: 'Oprogramowanie', name: 'HDL Graview Energy Management software datapoint 500, a web-based Visualization sofware specialized', unit: 'szt.', unit_price: 15789.6, description: '' },
  { sku: 'HDL GVP-v2', brand: 'KNX', category: 'Oprogramowanie', name: 'HDL Graview Energy Management software datapoint 1500, a web-based Visualization sofware specialized', unit: 'szt.', unit_price: 25832.25, description: '' },
  { sku: 'HDL GVP-v3', brand: 'KNX', category: 'Oprogramowanie', name: 'HDL Graview Energy Management software Pro, no limitation, a web-based Visualization sofware special', unit: 'szt.', unit_price: 40286.7, description: '' },
  // ─── Control4 ──────────────────────────────────────────────────────────────
  { sku: 'C4-EA3-01', brand: 'Control4', category: 'Kontroler',
    name: 'Control4 EA-3 Entertainment & Automation Controller', unit: 'szt.', unit_price: 3800, description: '' },
  { sku: 'C4-EA1-01', brand: 'Control4', category: 'Kontroler',
    name: 'Control4 EA-1 Entertainment Controller', unit: 'szt.', unit_price: 1950, description: '' },
  { sku: 'C4-KPZ6-01', brand: 'Control4', category: 'Keypad',
    name: 'Control4 Keypad 6-przyciskowy z wyświetlaczem', unit: 'szt.', unit_price: 1400, description: '' },
  { sku: 'C4-SR260-01', brand: 'Control4', category: 'Pilot',
    name: 'Control4 SR-260 Pilot uniwersalny', unit: 'szt.', unit_price: 880, description: '' },
  { sku: 'C4-AMP8-01', brand: 'Control4', category: 'Audio',
    name: 'Control4 Amplifier 8-strefowy (C4-8AMP3-B)', unit: 'szt.', unit_price: 7200, description: '' },
  { sku: 'C4-SW10-01', brand: 'Control4', category: 'Sieć',
    name: 'Control4 Switch 8-Port PoE (C4-POE8S)', unit: 'szt.', unit_price: 1100, description: '' },
  { sku: 'C4-HDMI4-01', brand: 'Control4', category: 'AV',
    name: 'Control4 HDMI Matrix 4x4', unit: 'szt.', unit_price: 4500, description: '' },
  { sku: 'C4-LIC-01', brand: 'Control4', category: 'Licencja',
    name: 'Control4 OS3 licencja wdrożeniowa', unit: 'kpl.', unit_price: 2800, description: 'Jednorazowa opłata za wdrożenie' },
  // ─── Hikvision ─────────────────────────────────────────────────────────────
  { sku: 'HIK-PTZ4-01', brand: 'Hikvision', category: 'Kamera PTZ',
    name: 'Kamera PTZ IP 4MP 4x zoom (DS-2DE4A425IWG-E)', unit: 'szt.', unit_price: 1450, description: '' },
  { sku: 'HIK-DOME4-01', brand: 'Hikvision', category: 'Kamera dome',
    name: 'Kamera dome IP 4MP IR wewnętrzna (DS-2CD2143G2-I)', unit: 'szt.', unit_price: 380, description: '' },
  { sku: 'HIK-BULL4-01', brand: 'Hikvision', category: 'Kamera bullet',
    name: 'Kamera bullet IP 4MP zewnętrzna (DS-2CD2T43G2-4I)', unit: 'szt.', unit_price: 420, description: '' },
  { sku: 'HIK-NVR8-01', brand: 'Hikvision', category: 'NVR',
    name: 'Rejestrator NVR 8-kanałowy 4K PoE (DS-7608NXI-I2/8P)', unit: 'szt.', unit_price: 1250, description: '' },
  { sku: 'HIK-NVR16-01', brand: 'Hikvision', category: 'NVR',
    name: 'Rejestrator NVR 16-kanałowy 4K PoE (DS-7616NXI-I2/16P)', unit: 'szt.', unit_price: 2100, description: '' },
  { sku: 'HIK-DOM-01', brand: 'Hikvision', category: 'Domofon IP',
    name: 'Domofon IP zewnętrzny z czytnikiem (DS-KV8113-WME1)', unit: 'szt.', unit_price: 1350, description: '' },
  { sku: 'HIK-MON-01', brand: 'Hikvision', category: 'Domofon IP',
    name: 'Monitor wewnętrzny 7" dotykowy (DS-KH6320-WTE1)', unit: 'szt.', unit_price: 780, description: '' },
  { sku: 'HIK-HDD4-01', brand: 'Hikvision', category: 'Dysk HDD',
    name: 'Dysk HDD 4TB do NVR (Seagate SkyHawk)', unit: 'szt.', unit_price: 480, description: '' },
  // ─── Satel ─────────────────────────────────────────────────────────────────
  { sku: 'SAT-INT32-01', brand: 'Satel', category: 'Centrala alarmowa',
    name: 'Centrala alarmowa INTEGRA 32 (Satel INTEGRA 32)', unit: 'szt.', unit_price: 820, description: '' },
  { sku: 'SAT-INT128-01', brand: 'Satel', category: 'Centrala alarmowa',
    name: 'Centrala alarmowa INTEGRA 128-WRL bezprzewodowa', unit: 'szt.', unit_price: 2100, description: '' },
  { sku: 'SAT-AQUA-01', brand: 'Satel', category: 'Czujnik PIR',
    name: 'Czujnik ruchu PIR AQUA (Satel AQUA-I)', unit: 'szt.', unit_price: 115, description: '' },
  { sku: 'SAT-SLIM-01', brand: 'Satel', category: 'Czujnik PIR',
    name: 'Czujnik ruchu PIR ze zwolnieniem dla zwierząt (Satel SLIM-PIR)', unit: 'szt.', unit_price: 98, description: '' },
  { sku: 'SAT-MC10-01', brand: 'Satel', category: 'Czujnik magnetyczny',
    name: 'Czujnik magnetyczny drzwi/okna (Satel MC-10)', unit: 'szt.', unit_price: 55, description: '' },
  { sku: 'SAT-SD3003-01', brand: 'Satel', category: 'Czujnik rozbicia szyby',
    name: 'Czujnik rozbicia szyby (Satel SD-3003)', unit: 'szt.', unit_price: 135, description: '' },
  { sku: 'SAT-INTKSGL-01', brand: 'Satel', category: 'Klawiatura',
    name: 'Klawiatura alarmowa LCD (Satel INT-KSG-SSW)', unit: 'szt.', unit_price: 340, description: '' },
  { sku: 'SAT-SP500-01', brand: 'Satel', category: 'Sygnalizator',
    name: 'Sygnalizator wewnętrzny (Satel SP-500)', unit: 'szt.', unit_price: 155, description: '' },
  { sku: 'SAT-SYSZEW-01', brand: 'Satel', category: 'Sygnalizator',
    name: 'Sygnalizator zewnętrzny (Satel SP-4001)', unit: 'szt.', unit_price: 285, description: '' },
  { sku: 'SAT-ETHM1-01', brand: 'Satel', category: 'Komunikacja',
    name: 'Moduł Ethernet + GSM (Satel ETHM-1 Plus)', unit: 'szt.', unit_price: 395, description: '' },
  { sku: 'SAT-APS-01', brand: 'Satel', category: 'Zasilacz',
    name: 'Zasilacz buforowy 3A (Satel APS-614)', unit: 'szt.', unit_price: 220, description: '' },
  { sku: 'SAT-INTE-01', brand: 'Satel', category: 'Ekspander',
    name: 'Ekspander wejść/wyjść 8+2 (Satel INT-E)', unit: 'szt.', unit_price: 180, description: '' },
  { sku: 'SAT-BATT-01', brand: 'Satel', category: 'Akumulator',
    name: 'Akumulator 12V 7Ah do centrali', unit: 'szt.', unit_price: 75, description: '' },
  { sku: 'SAT-CO-01', brand: 'Satel', category: 'Czujnik CO',
    name: 'Czujnik tlenku węgla CO (Satel CD-500)', unit: 'szt.', unit_price: 190, description: '' },

  // ─── Usługi ───────────────────────────────────────────────────────────────
  { sku: 'USL-INST-PT', brand: 'Usługi', manufacturer: 'Smart Home Center', category: 'Instalacja',
    name: 'Instalacja pojedynczego punktu (punkt elektryczny, gniazdo, łącznik)', unit: 'szt.', unit_price: 0, description: 'Montaż i okablowanie jednego punktu instalacyjnego' },
  { sku: 'USL-PROG-KNX-H', brand: 'Usługi', manufacturer: 'Smart Home Center', category: 'Programowanie',
    name: 'Programowanie KNX — stawka za godzinę', unit: 'h', unit_price: 0, description: 'Konfiguracja i programowanie systemu KNX (ETS)' },
  { sku: 'USL-PROG-C4-H', brand: 'Usługi', manufacturer: 'Smart Home Center', category: 'Programowanie',
    name: 'Programowanie Control4 — stawka za godzinę', unit: 'h', unit_price: 0, description: 'Konfiguracja i programowanie systemu Control4' },
  { sku: 'USL-PROG-SAT-H', brand: 'Usługi', manufacturer: 'Smart Home Center', category: 'Programowanie',
    name: 'Programowanie SATEL — stawka za godzinę', unit: 'h', unit_price: 0, description: 'Konfiguracja i programowanie centrali alarmowej Satel' },
  { sku: 'USL-PROG-CAM-H', brand: 'Usługi', manufacturer: 'Smart Home Center', category: 'Programowanie',
    name: 'Programowanie kamer Hikvision — stawka za godzinę', unit: 'h', unit_price: 0, description: 'Konfiguracja i programowanie systemu CCTV Hikvision' },
]

// GET /api/product-catalog/manufacturers — list known manufacturers grouped by brand (any auth user)
router.get('/manufacturers', async (_req: Request, res: Response) => {
  try {
    const items = await db.product_catalog.allIncludingInactive()
    const manufacturers: Record<string, string[]> = {}
    for (const item of items) {
      const brand = item.brand ?? 'Inne'
      const mfr = item.manufacturer || brand
      if (!manufacturers[brand]) manufacturers[brand] = []
      if (!manufacturers[brand].includes(mfr)) manufacturers[brand].push(mfr)
    }
    res.json(manufacturers)
  } catch {
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// GET /api/product-catalog — active items only (any auth user), optional ?brand= and ?manufacturer=
router.get('/', async (req: Request, res: Response) => {
  try {
    const brand = req.query.brand as string | undefined
    const manufacturer = req.query.manufacturer as string | undefined
    let items = await db.product_catalog.all()
    if (brand) items = items.filter((p: any) => p.brand === brand)
    if (manufacturer) items = items.filter((p: any) => (p.manufacturer || p.brand) === manufacturer)
    res.json(items)
  } catch {
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// GET /api/product-catalog/all — including inactive (wszyscy zalogowani)
router.get('/all', async (_req: Request, res: Response) => {
  try {
    res.json(await db.product_catalog.allIncludingInactive())
  } catch {
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// POST /api/product-catalog/seed — insert default catalog (admin only)
router.post('/seed', requireAdmin, async (_req: Request, res: Response) => {
  try {
    const existing = await db.product_catalog.count()
    if (existing > 0) {
      res.json({ already_seeded: true, count: existing })
      return
    }
    const seeded = CATALOG_SEED.map(item => ({
      ...item,
      id: uuidv4(),
      manufacturer: (item as any).manufacturer || (item.brand === 'KNX' ? 'HDL' : item.brand),
      active: true,
      created_at: now(),
      updated_at: now(),
    }))
    await db.product_catalog.seed(seeded)
    res.json({ seeded: seeded.length })
  } catch {
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// POST /api/product-catalog — każdy zalogowany może dodać produkt
router.post('/', async (req: Request, res: Response) => {
  try {
    const { sku, brand, manufacturer, category, name, unit, unit_price, description } = req.body
    if (!name || !brand || !unit || unit_price === undefined) {
      res.status(400).json({ error: 'Wymagane: name, brand, unit, unit_price' })
      return
    }
    const item = {
      id: uuidv4(),
      sku: sku || '',
      brand,
      manufacturer: manufacturer || (brand === 'KNX' ? 'HDL' : brand),
      category: category || '',
      name,
      unit,
      unit_price: parseFloat(unit_price) || 0,
      description: description || '',
      active: true,
      created_at: now(),
      updated_at: now(),
    }
    await db.product_catalog.insert(item)
    res.status(201).json(item)
  } catch {
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// PUT /api/product-catalog/:id (admin only)
router.put('/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const existing = await db.product_catalog.find(req.params.id)
    if (!existing) {
      res.status(404).json({ error: 'Produkt nie znaleziony' })
      return
    }
    const { sku, brand, manufacturer, category, name, unit, unit_price, description, active } = req.body
    const patch: any = { updated_at: now() }
    if (sku !== undefined) patch.sku = sku
    if (brand !== undefined) patch.brand = brand
    if (manufacturer !== undefined) patch.manufacturer = manufacturer
    if (category !== undefined) patch.category = category
    if (name !== undefined) patch.name = name
    if (unit !== undefined) patch.unit = unit
    if (unit_price !== undefined) patch.unit_price = parseFloat(unit_price) || 0
    if (description !== undefined) patch.description = description
    if (active !== undefined) patch.active = active
    await db.product_catalog.update(req.params.id, patch)
    res.json(await db.product_catalog.find(req.params.id))
  } catch {
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

// DELETE /api/product-catalog/pricelist?brand=KNX&manufacturer=HDL — usuń cały cennik (admin only)
router.delete('/pricelist', requireAdmin, async (req: Request, res: Response) => {
  const { brand, manufacturer } = req.query as { brand?: string; manufacturer?: string }
  if (!brand || !manufacturer) {
    res.status(400).json({ error: 'Wymagane parametry: brand, manufacturer' })
    return
  }
  try {
    const result = await db.product_catalog.hardDeleteByBrandManufacturer(brand, manufacturer)
    res.json({ success: true, deleted: (result as any).count, brand, manufacturer })
  } catch {
    res.status(500).json({ error: 'Błąd serwera podczas usuwania cennika' })
  }
})

// DELETE /api/product-catalog/:id — soft delete (admin only)
router.delete('/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const existing = await db.product_catalog.find(req.params.id)
    if (!existing) {
      res.status(404).json({ error: 'Produkt nie znaleziony' })
      return
    }
    await db.product_catalog.delete(req.params.id)
    res.json({ success: true })
  } catch {
    res.status(500).json({ error: 'Błąd serwera' })
  }
})

const IMPORT_SYSTEM_PROMPT = `Jesteś ekspertem od analizy cenników produktów automatyki budynkowej (KNX, Control4, Hikvision, Satel i inne).
Twoim zadaniem jest wyekstrahowanie listy produktów z dostarczonego cennika (Excel lub PDF).

Zwróć TYLKO tablicę JSON z produktami w formacie:
[
  {
    "sku": "kod produktu lub pusty string jeśli brak",
    "category": "kategoria produktu (wyodrębnij z nagłówków sekcji lub nazwy)",
    "name": "pełna nazwa produktu",
    "unit": "jednostka miary (szt., kpl., m, mb, itd. - domyślnie szt.)",
    "unit_price": cena_netto_jako_liczba
  }
]

WAŻNE — WYBÓR CENY (SRP / Katalogowa):
- Pobieraj WYŁĄCZNIE cenę katalogową SRP (Suggested Retail Price / cena detaliczna / cena katalogowa / MSRP / cena końcowa)
- IGNORUJ ceny integratorskie / dealerskie / partnerskie / hurtowe / rabatowane (często oznaczone jako: Integrator Price, Dealer Price, Partner Price, cena dla integratorów, cena zakupu, net price for resellers, itp.)
- Jeśli w cenniku są kolumny np. "SRP", "RRP", "MSRP", "Cena katalogowa", "Retail" — użyj tej kolumny
- Jeśli są kolumny np. "Integrator", "Dealer", "Partner", "Reseller", "Net", "Distributor" — POMIŃ te kolumny
- Jeśli cennik ma tylko jedną kolumnę cenową — użyj jej (to prawdopodobnie SRP)
- Jeśli nie możesz jednoznacznie określić która cena to SRP, wybierz WYŻSZĄ cenę

Zasady ogólne:
- unit_price musi być liczbą dziesiętną PLN netto (bez symboli walut, tylko wartość numeryczna)
- Jeśli cena jest w EUR, przelicz kurs 4.30; jeśli USD kurs 4.00
- Pomiń produkty bez ceny lub z ceną = 0
- Zachowaj oryginalne kody SKU/katalogowe produktu
- Kategorię wyodrębnij z nagłówków sekcji, rodziny produktów lub nazwy urządzenia
- Nie dodawaj komentarzy, zwróć TYLKO tablicę JSON bez żadnego innego tekstu
- Jeśli cennik jest pusty lub nieczytelny, zwróć pustą tablicę []`

// POST /api/product-catalog/import — import pricelist from Excel or PDF (każdy zalogowany user)
router.post('/import', requireAuth, importUpload.single('file'), async (req: Request, res: Response) => {
  if (!req.file) {
    res.status(400).json({ error: 'Brak pliku. Prześlij plik Excel (.xlsx, .xls) lub PDF.' })
    return
  }

  const { brand, manufacturer } = req.body as { brand?: string; manufacturer?: string }
  if (!brand || !manufacturer) {
    fs.unlink(req.file.path, () => {})
    res.status(400).json({ error: 'Wymagane parametry: brand, manufacturer' })
    return
  }

  const filePath = req.file.path
  const ext = path.extname(req.file.originalname).toLowerCase()

  try {
    const anthropicKey = process.env.ANTHROPIC_API_KEY
    if (!anthropicKey) {
      res.status(500).json({ error: 'Brak klucza ANTHROPIC_API_KEY — nie można przetworzyć cennika przez AI.' })
      return
    }

    const client = new Anthropic({ apiKey: anthropicKey })
    let messageContent: Anthropic.MessageParam['content']

    // ── Pomocnicza funkcja: wyekstrahuj JSON z odpowiedzi AI ─────────────────
    const extractJsonArray = (rawText: string): any[] | null => {
      let jsonString: string | null = null

      // Strategia 1: ```json ... ```
      const codeBlockMatch = rawText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/)
      if (codeBlockMatch?.[1]?.trim().startsWith('[')) {
        jsonString = codeBlockMatch[1].trim()
      }
      // Strategia 2: surowa tablica [ ... ]
      if (!jsonString) {
        const arrayMatch = rawText.match(/\[[\s\S]*\]/)
        if (arrayMatch) jsonString = arrayMatch[0]
      }
      // Strategia 3: otwierający blok bez zamknięcia (obcięty przez max_tokens)
      if (!jsonString) {
        const openBlock = rawText.match(/```(?:json)?\s*\n?([\s\S]+)$/)
        if (openBlock?.[1]?.trim().startsWith('[')) {
          jsonString = openBlock[1].replace(/\n?```\s*$/, '').trim()
        }
      }
      if (!jsonString) return null
      try {
        const parsed = JSON.parse(jsonrepair(jsonString))
        return Array.isArray(parsed) ? parsed : null
      } catch {
        return null
      }
    }

    // ── Wysyłanie do AI z obsługą chunków dla dużych plików ──────────────────
    const CHUNK_ROWS = 120   // max wierszy danych na jeden request AI
    let allParsedItems: any[] = []

    if (ext === '.pdf') {
      // PDF: wyślij jako base64 – jeden request (PDFy nie da się chunkowć)
      const pdfData = fs.readFileSync(filePath)
      const base64 = pdfData.toString('base64')
      messageContent = [
        {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: base64 },
        } as any,
        { type: 'text', text: `Przeanalizuj ten cennik (producent: ${manufacturer}, marka: ${brand}) i wyodrębnij listę produktów zgodnie z instrukcją. Zwróć TYLKO tablicę JSON.` },
      ]

      const message = await client.messages.stream({
        model: 'claude-sonnet-4-5',
        max_tokens: 32000,
        system: IMPORT_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: messageContent }],
      }).finalMessage()
      const rawText = message.content.find(c => c.type === 'text')?.text ?? ''
      console.log('[Import PDF] stop_reason:', message.stop_reason, '| długość:', rawText.length)
      const items = extractJsonArray(rawText)
      if (!items) {
        console.error('[Import PDF] Brak JSON. Pełna odpowiedź:\n', rawText)
        res.status(422).json({ error: 'AI nie zwróciło poprawnej listy produktów. Sprawdź format cennika.' })
        return
      }
      allParsedItems = items

    } else {
      // Excel: podziel na chunki po CHUNK_ROWS wierszy → procesuj każdy osobno
      const workbook = XLSX.readFile(filePath)

      // Zbierz wszystkie wiersze ze wszystkich arkuszy jako tablice wartości
      type Row = (string | number | null | undefined)[]
      const allSheetRows: { sheetName: string; header: Row; rows: Row[] }[] = []

      for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName]
        const matrix = XLSX.utils.sheet_to_json<Row>(sheet, { header: 1, blankrows: false, defval: '' })
        if (matrix.length < 2) continue          // pusty lub tylko nagłówek
        const [header, ...dataRows] = matrix
        allSheetRows.push({ sheetName, header, rows: dataRows })
      }

      if (allSheetRows.length === 0) {
        res.status(422).json({ error: 'Plik Excel jest pusty lub nie zawiera danych.' })
        return
      }

      // Dla każdego arkusza: rozbij na chunki i wyślij do AI
      for (const { sheetName, header, rows } of allSheetRows) {
        const headerCsv = header.join(',')
        for (let start = 0; start < rows.length; start += CHUNK_ROWS) {
          const chunkRows = rows.slice(start, start + CHUNK_ROWS)
          const chunkCsv = [headerCsv, ...chunkRows.map(r => r.join(','))].join('\n')
          const chunkLabel = `${sheetName} wiersze ${start + 1}–${start + chunkRows.length}`

          console.log(`[Import Excel] Chunk: ${chunkLabel} (${chunkRows.length} wierszy)`)

          const chunkMessage = await client.messages.stream({
            model: 'claude-sonnet-4-5',
            max_tokens: 32000,
            system: IMPORT_SYSTEM_PROMPT,
            messages: [{
              role: 'user',
              content: `Poniżej fragment cennika CSV (producent: ${manufacturer}, marka: ${brand}, ${chunkLabel}).\nWyodrębnij produkty i zwróć TYLKO tablicę JSON:\n\n${chunkCsv}\n\nZwróć TYLKO tablicę JSON.`,
            }],
          }).finalMessage()

          const rawText = chunkMessage.content.find(c => c.type === 'text')?.text ?? ''
          console.log(`[Import Excel] Chunk stop_reason: ${chunkMessage.stop_reason} | długość: ${rawText.length}`)

          const items = extractJsonArray(rawText)
          if (items && items.length > 0) {
            allParsedItems.push(...items)
            console.log(`[Import Excel] Chunk dodał ${items.length} produktów (łącznie: ${allParsedItems.length})`)
          }
        }
      }

      if (allParsedItems.length === 0) {
        res.status(422).json({ error: 'AI nie znalazło żadnych produktów w pliku Excel. Sprawdź format cennika.' })
        return
      }
    }

    // Hard-delete (fizyczne usunięcie) istniejących rekordów dla tej marki+producenta
    // Soft-delete zostawiałby rekordy z SKU → UNIQUE constraint failure przy ponownym imporcie
    const replacedCount = await db.product_catalog.hardDeleteByBrandManufacturer(brand, manufacturer)
      .then((r: any) => r.count)

    // Buduj nowe produkty z deduplikacją SKU
    const importedAt = now()
    const seenSkus = new Set<string>()

    const newItems = allParsedItems
      .filter((p: any) => p.name && Number(p.unit_price) > 0)
      .map((p: any, idx: number) => {
        // Pusty lub brakujący SKU → null (PostgreSQL pozwala na wiele NULL przy UNIQUE)
        let sku: string | null = String(p.sku || '').trim() || null
        // Duplikat SKU w tym samym imporcie → unikalnij dodając suffix
        if (sku && seenSkus.has(sku)) {
          sku = `${sku}-${idx}`
        }
        if (sku) seenSkus.add(sku)

        return {
          id: uuidv4(),
          sku,
          brand,
          manufacturer,
          category: String(p.category || '').trim(),
          name: String(p.name || '').trim(),
          unit: String(p.unit || 'szt.').trim(),
          unit_price: parseFloat(String(p.unit_price)) || 0,
          description: '',
          active: true,
          created_at: importedAt,
          updated_at: importedAt,
          last_import: importedAt,
          sort_order: idx,
        }
      })

    for (const item of newItems) {
      await db.product_catalog.insert(item)
    }

    res.json({
      imported: newItems.length,
      replaced: replacedCount,
      brand,
      manufacturer,
    })
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'Błąd importu cennika.' })
  } finally {
    // Clean up uploaded file
    fs.unlink(filePath, () => {})
  }
})

export default router
