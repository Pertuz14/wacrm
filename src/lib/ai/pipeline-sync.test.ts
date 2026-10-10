import { describe, it, expect } from 'vitest'
import {
  decideStageMove,
  isUsable,
  rowToSettings,
  targetStageFromActions,
  type PipelineSyncSettings,
} from './pipeline-sync'

const S: PipelineSyncSettings = {
  enabled: true,
  pipelineId: 'pipe',
  stageNewId: 'new',
  stageInterestedId: 'int',
  stageVerifyId: 'ver',
  stageLostId: 'lost',
  lostAfterDays: 20,
  lastSweepAt: null,
}

describe('targetStageFromActions', () => {
  it('defaults to the new stage when the turn carries no label', () => {
    expect(targetStageFromActions([])).toBe('new')
  })

  it('maps the prompt labels to stages', () => {
    expect(targetStageFromActions([{ type: 'label', value: 'nuevo_interesado' }])).toBe('new')
    expect(targetStageFromActions([{ type: 'label', value: 'area_definida' }])).toBe('interested')
    expect(targetStageFromActions([{ type: 'label', value: 'datos_pago_enviados' }])).toBe(
      'interested',
    )
    expect(targetStageFromActions([{ type: 'label', value: 'pago_por_verificar' }])).toBe('verify')
  })

  it('treats a payment to verify as the verify stage even without its label', () => {
    expect(targetStageFromActions([{ type: 'verify_payment' }])).toBe('verify')
  })

  it('takes the furthest stage and ignores unknown labels', () => {
    expect(
      targetStageFromActions([
        { type: 'label', value: 'requiere_asesor' },
        { type: 'label', value: 'AREA_DEFINIDA' },
        { type: 'label', value: 'nuevo_interesado' },
      ]),
    ).toBe('interested')
  })
})

describe('decideStageMove', () => {
  it('moves forward', () => {
    expect(decideStageMove(S, 'new', 'interested')).toBe('int')
    expect(decideStageMove(S, 'int', 'verify')).toBe('ver')
  })

  it('never moves backward or sideways', () => {
    expect(decideStageMove(S, 'ver', 'interested')).toBeNull()
    expect(decideStageMove(S, 'int', 'interested')).toBeNull()
  })

  it('reopens a lost deal when the customer comes back', () => {
    expect(decideStageMove(S, 'lost', 'new')).toBe('new')
    expect(decideStageMove(S, 'lost', 'verify')).toBe('ver')
  })

  it('leaves stages the owner manages alone (e.g. purchase completed)', () => {
    expect(decideStageMove(S, 'purchase-completed', 'verify')).toBeNull()
  })
})

describe('isUsable', () => {
  it('needs the switch on and every stage chosen', () => {
    expect(isUsable(S)).toBe(true)
    expect(isUsable({ ...S, enabled: false })).toBe(false)
    expect(isUsable({ ...S, stageLostId: null })).toBe(false)
    expect(isUsable(rowToSettings(null))).toBe(false)
  })

  it('defaults to 20 days without reply', () => {
    expect(rowToSettings(null).lostAfterDays).toBe(20)
  })
})
