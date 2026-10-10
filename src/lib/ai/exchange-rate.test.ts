import { describe, it, expect } from 'vitest'
import { mergeQuotes, parseBcvHomepage, parseDolarApi, rowToState } from './exchange-rate'

// Trimmed from the real bcv.org.ve homepage (2026-10-10).
const BCV_HTML = `
<div id="dolar" class="col-sm-12 col-xs-12 ">
  <div class="field-content">
    <div class="row recuadrotsmc">
      <div class="col-sm-6 col-xs-6"><span> USD</span></div>
      <div class="col-sm-6 col-xs-6 centrado textp"> <strong class="strong-tb">876,79760000</strong>  </div>
    </div>
  </div>
</div>
<div class="pull-right dinpro center">
Fecha Valor: <span class="date-display-single" property="dc:date" datatype="xsd:dateTime" content="2026-10-13T00:00:00-04:00">Martes, 13 Octubre  2026</span>
</div>`

describe('parseBcvHomepage', () => {
  it('reads the USD rate and its value date', () => {
    expect(parseBcvHomepage(BCV_HTML)).toEqual({
      source: 'bcv',
      rate: 876.7976,
      date: '2026-10-13',
    })
  })

  it('returns null when the page layout changed', () => {
    expect(parseBcvHomepage('<html>mantenimiento</html>')).toBeNull()
    expect(parseBcvHomepage(BCV_HTML.replace('876,79760000', 'N/A'))).toBeNull()
  })
})

describe('parseDolarApi', () => {
  it('reads the official average and its date', () => {
    expect(
      parseDolarApi({ promedio: 875.6505, fechaActualizacion: '2026-10-09T00:00:00-04:00' }),
    ).toEqual({ source: 'dolarapi', rate: 875.6505, date: '2026-10-09' })
  })

  it('rejects malformed payloads', () => {
    expect(parseDolarApi(null)).toBeNull()
    expect(parseDolarApi({ promedio: 0, fechaActualizacion: '2026-10-09' })).toBeNull()
    expect(parseDolarApi({ promedio: 875 })).toBeNull()
    expect(parseDolarApi({ promedio: 'x', fechaActualizacion: '2026-10-09' })).toBeNull()
  })
})

describe('mergeQuotes', () => {
  const saturday = new Date('2026-10-10T15:00:00Z')
  const empty = rowToState(null)

  it('stores the latest published rate, even with a value date ahead', () => {
    const merged = mergeQuotes(
      empty,
      [
        { source: 'bcv', rate: 876.7976, date: '2026-10-13' },
        { source: 'dolarapi', rate: 875.6505, date: '2026-10-09' },
      ],
      saturday,
    )
    expect(merged).toMatchObject({
      rate: 876.7976,
      rateDate: '2026-10-13',
      rateSource: 'bcv',
      nextRate: null,
      checkedAt: saturday.toISOString(),
    })
  })

  it('keeps the last known rate when both sources are down', () => {
    const stored = {
      ...empty,
      rate: 876.7976,
      rateDate: '2026-10-13',
      rateSource: 'bcv' as const,
    }
    const merged = mergeQuotes(stored, [null, null], saturday)
    expect(merged.rate).toBe(876.7976)
    expect(merged.rateDate).toBe('2026-10-13')
  })

  it('never goes back to an older rate when only DolarApi answers', () => {
    // DolarApi reports the rate in force, a day behind the BCV.
    const stored = {
      ...empty,
      rate: 876.7976,
      rateDate: '2026-10-13',
      rateSource: 'bcv' as const,
    }
    const merged = mergeQuotes(
      stored,
      [null, { source: 'dolarapi', rate: 875.6505, date: '2026-10-09' }],
      saturday,
    )
    expect(merged).toMatchObject({ rate: 876.7976, rateDate: '2026-10-13', rateSource: 'bcv' })
  })

  it('moves to a newer rate as soon as the BCV publishes it', () => {
    const stored = {
      ...empty,
      rate: 875.6505,
      rateDate: '2026-10-09',
      rateSource: 'dolarapi' as const,
    }
    const merged = mergeQuotes(
      stored,
      [{ source: 'bcv', rate: 876.7976, date: '2026-10-13' }, null],
      saturday,
    )
    expect(merged).toMatchObject({ rate: 876.7976, rateDate: '2026-10-13' })
  })
})
