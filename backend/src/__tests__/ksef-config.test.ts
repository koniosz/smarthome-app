/**
 * KSeF per firma — reguła wyboru konfiguracji (resolveKsefConfig) + błąd braku konfiguracji.
 * Czyste funkcje, bez bazy. Uruchom: npx tsx --test src/__tests__/ksef-config.test.ts
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { resolveKsefConfig, KsefNotConfiguredError, KSEF_NOT_CONFIGURED_MSG } from '../services/ksef'

const ENV_SHC = { KSEF_NIP: '123-456-78-90', KSEF_TOKEN: 'env-token' }
const NO_ENV  = {}

describe('resolveKsefConfig', () => {
  test('firma z własnym tokenem → jej NIP (bez myślników/spacji) i token, source=company', () => {
    const cfg = resolveKsefConfig({ id: 'c1', nip: '111', ksef_nip: '987-654-32 10', ksef_token: 'tok-1', is_default: false }, ENV_SHC)
    assert.deepEqual(cfg, { companyId: 'c1', nip: '9876543210', token: 'tok-1', source: 'company' })
  })

  test('własny token ma pierwszeństwo przed env także dla firmy domyślnej', () => {
    const cfg = resolveKsefConfig({ id: 'def', nip: '', ksef_nip: '5555555555', ksef_token: 'tok-def', is_default: true }, ENV_SHC)
    assert.equal(cfg?.source, 'company')
    assert.equal(cfg?.token, 'tok-def')
  })

  test('token bez ksef_nip → NIP firmy (pole nip) jako fallback', () => {
    const cfg = resolveKsefConfig({ id: 'c2', nip: '777-777-77-77', ksef_nip: '', ksef_token: 'tok-2', is_default: false }, ENV_SHC)
    assert.deepEqual(cfg, { companyId: 'c2', nip: '7777777777', token: 'tok-2', source: 'company' })
  })

  test('firma domyślna bez tokenu → fallback na KSEF_NIP/KSEF_TOKEN ze środowiska, source=env', () => {
    const cfg = resolveKsefConfig({ id: 'def', nip: '', ksef_nip: '', ksef_token: '', is_default: true }, ENV_SHC)
    assert.deepEqual(cfg, { companyId: 'def', nip: '1234567890', token: 'env-token', source: 'env' })
  })

  test('firma NIEdomyślna bez tokenu → null (nie dziedziczy env innej firmy)', () => {
    assert.equal(resolveKsefConfig({ id: 'c3', nip: '999', ksef_nip: '', ksef_token: '', is_default: false }, ENV_SHC), null)
  })

  test('firma domyślna bez tokenu i bez env → null', () => {
    assert.equal(resolveKsefConfig({ id: 'def', nip: '1', ksef_nip: '', ksef_token: '', is_default: true }, NO_ENV), null)
    assert.equal(resolveKsefConfig({ id: 'def', ksef_token: '', is_default: true }, { KSEF_NIP: '123', KSEF_TOKEN: '' }), null)
  })

  test('brak firmy (null/undefined) → null', () => {
    assert.equal(resolveKsefConfig(null, ENV_SHC), null)
    assert.equal(resolveKsefConfig(undefined, ENV_SHC), null)
  })

  test('token bez żadnego NIP (ksef_nip i nip puste) → nie jest konfiguracją; firma domyślna może spaść na env', () => {
    assert.equal(resolveKsefConfig({ id: 'c4', nip: '', ksef_nip: '', ksef_token: 'tok', is_default: false }, ENV_SHC), null)
    assert.equal(resolveKsefConfig({ id: 'def', nip: '', ksef_nip: '', ksef_token: 'tok', is_default: true }, ENV_SHC)?.source, 'env')
  })
})

describe('KsefNotConfiguredError', () => {
  test('domyślny komunikat kieruje do panelu Firmy; rozpoznawalny po instanceof (trasa → 400)', () => {
    const err = new KsefNotConfiguredError()
    assert.ok(err instanceof Error)
    assert.ok(err instanceof KsefNotConfiguredError)
    assert.equal(err.name, 'KsefNotConfiguredError')
    assert.equal(err.message, KSEF_NOT_CONFIGURED_MSG)
    assert.match(err.message, /Panel admina → Firmy/)
  })
})
