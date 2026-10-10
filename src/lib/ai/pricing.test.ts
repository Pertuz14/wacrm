import { describe, it, expect } from 'vitest'
import {
  PriceItemsError,
  applyTemplateVariables,
  buildPriceVariables,
  chooseRate,
  formatBs,
  formatBsPlain,
  formatUsd,
  readStoredPriceItems,
  shortDate,
  todayInCaracas,
  usdToBs,
  validatePriceItems,
} from './pricing'

describe('amount formatting', () => {
  it('formats bolívares Venezuelan-style', () => {
    expect(formatBs(43782.525)).toBe('43.782,53')
    expect(formatBs(875.6505)).toBe('875,65')
    expect(formatBs(1234567.8)).toBe('1.234.567,80')
    expect(formatBs(0)).toBe('0,00')
  })

  it('formats a bank-pasteable amount without thousands separators', () => {
    expect(formatBsPlain(43782.53)).toBe('43782,53')
  })

  it('keeps whole dollars whole and shows cents otherwise', () => {
    expect(formatUsd(50)).toBe('50')
    expect(formatUsd(27.5)).toBe('27,50')
    expect(formatUsd(12.1)).toBe('12,10')
  })

  it('converts USD to Bs rounded to cents', () => {
    expect(usdToBs(50, 875.6505)).toBe(43782.53)
    expect(usdToBs(27.5, 875.6505)).toBe(24080.39)
  })

  it('renders an ISO date as dd/mm/yyyy', () => {
    expect(shortDate('2026-10-13')).toBe('13/10/2026')
  })
})

describe('todayInCaracas', () => {
  it('uses Caracas time, not UTC', () => {
    // 02:00 UTC on the 11th is still 22:00 on the 10th in Caracas (UTC−4).
    expect(todayInCaracas(new Date('2026-10-11T02:00:00Z'))).toBe('2026-10-10')
    expect(todayInCaracas(new Date('2026-10-11T05:00:00Z'))).toBe('2026-10-11')
  })
})

describe('validatePriceItems', () => {
  it('normalises keys to upper case and rounds USD to cents', () => {
    expect(validatePriceItems([{ key: ' p_paquete ', label: ' Paquete ', usd: '50.004' }])).toEqual([
      { key: 'P_PAQUETE', label: 'Paquete', usd: 50 },
    ])
  })

  it('rejects bad keys, duplicates and amounts', () => {
    expect(() => validatePriceItems([{ key: '1ABC', usd: 1 }])).toThrow(PriceItemsError)
    expect(() => validatePriceItems([{ key: 'A-B', usd: 1 }])).toThrow(PriceItemsError)
    expect(() =>
      validatePriceItems([
        { key: 'A', usd: 1 },
        { key: 'a', usd: 2 },
      ]),
    ).toThrow(/duplicate/)
    expect(() => validatePriceItems([{ key: 'A', usd: -1 }])).toThrow(PriceItemsError)
    expect(() => validatePriceItems([{ key: 'A', usd: 'x' }])).toThrow(PriceItemsError)
    expect(() => validatePriceItems('nope')).toThrow(PriceItemsError)
  })

  it('reads a stored list leniently, skipping broken rows', () => {
    expect(
      readStoredPriceItems([{ key: 'OK', label: '', usd: 1 }, { key: '', usd: 2 }, null]),
    ).toEqual([{ key: 'OK', label: '', usd: 1 }])
    expect(readStoredPriceItems(null)).toEqual([])
  })
})

describe('chooseRate', () => {
  const bcvLatest = { source: 'bcv' as const, rate: 876.7976, date: '2026-10-13' }
  const apiOlder = { source: 'dolarapi' as const, rate: 875.6505, date: '2026-10-09' }

  it('charges the latest rate the BCV published, even if its value date is ahead', () => {
    // Saturday 10th: the BCV homepage already shows Tuesday 13th's rate.
    expect(chooseRate([apiOlder, bcvLatest])).toEqual(bcvLatest)
  })

  it('prefers the BCV when both sources agree on the date', () => {
    const bcvSameDay = { source: 'bcv' as const, rate: 875.65, date: '2026-10-09' }
    expect(chooseRate([apiOlder, bcvSameDay])).toEqual(bcvSameDay)
  })

  it('lets a fresh quote replace a stored one with the same date', () => {
    const corrected = { source: 'bcv' as const, rate: 876.8, date: '2026-10-13' }
    expect(chooseRate([corrected, bcvLatest])).toEqual(corrected)
  })

  it('returns nothing usable when every source failed', () => {
    expect(chooseRate([null, null])).toBeNull()
  })
})

describe('buildPriceVariables + applyTemplateVariables', () => {
  const now = new Date('2026-10-10T15:00:00Z')
  const items = [
    { key: 'P_PAQUETE', label: 'Paquete', usd: 50 },
    { key: 'PAQUETE_2P', label: 'Paquete 2 partes', usd: 27.5 },
  ]

  it('exposes Bs, USD and copy-friendly amounts per item', () => {
    const vars = buildPriceVariables({ rate: 875.6505, rateDate: '2026-10-09', items, now })
    expect(vars).toMatchObject({
      TASA_BCV: '875,65',
      FECHA_TASA: '09/10/2026',
      P_PAQUETE_USD: '50',
      P_PAQUETE_BS: '43.782,53',
      P_PAQUETE_BS_COPIAR: '43782,53',
      PAQUETE_2P_USD: '27,50',
      PAQUETE_2P_BS: '24.080,39',
    })
    expect(vars.FECHA_HOY).toMatch(/10 de octubre de 2026/)
  })

  it('leaves Bs placeholders unset (not wrong) when there is no rate', () => {
    const vars = buildPriceVariables({ rate: null, rateDate: null, items, now })
    expect(vars).not.toHaveProperty('TASA_BCV')
    expect(vars).not.toHaveProperty('P_PAQUETE_BS')
    expect(vars.P_PAQUETE_USD).toBe('50')
  })

  it('substitutes known variables and leaves unknown ones visible', () => {
    const out = applyTemplateVariables(
      'Paquete: {{P_PAQUETE_USD}} USD = {{ P_PAQUETE_BS }} Bs · {{NO_EXISTE}} · {{p_minuscula}}',
      { P_PAQUETE_USD: '50', P_PAQUETE_BS: '43.782,53' },
    )
    expect(out).toBe('Paquete: 50 USD = 43.782,53 Bs · {{NO_EXISTE}} · {{p_minuscula}}')
  })
})
