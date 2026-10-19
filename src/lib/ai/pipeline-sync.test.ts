import { describe, it, expect } from 'vitest'
import {
  closeWonDeal,
  decideStageMove,
  isUsable,
  resolveWonStage,
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
  stageWonId: null,
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

// ---- closed sales (POST /api/v1/sales) ---------------------------------

/** Minimal chainable Supabase stand-in: answers per table, records writes. */
function fakeDb(tables: Record<string, unknown>) {
  const writes: { table: string; op: string; row: unknown }[] = []
  const from = (table: string) => {
    const q: Record<string, unknown> = {}
    const chain = () => q
    for (const m of ['select', 'eq', 'order', 'limit', 'in']) q[m] = chain
    q.maybeSingle = async () => ({ data: tables[table] ?? null, error: null })
    q.single = async () => ({ data: { id: 'new-deal' }, error: null })
    q.then = (ok: (v: unknown) => unknown) => ok({ data: tables[table] ?? [], error: null })
    q.update = (row: unknown) => {
      writes.push({ table, op: 'update', row })
      return q
    }
    q.insert = (row: unknown) => {
      writes.push({ table, op: 'insert', row })
      return q
    }
    return q
  }
  return { db: { from } as unknown as Parameters<typeof closeWonDeal>[0], writes }
}

const SYNC_ROW = {
  enabled: true,
  pipeline_id: 'pipe',
  stage_new_id: 'new',
  stage_interested_id: 'int',
  stage_verify_id: 'ver',
  stage_lost_id: 'lost',
  stage_won_id: null,
  lost_after_days: 20,
  last_sweep_at: null,
}
const ARGS = {
  accountId: 'acc',
  contactId: 'c1',
  conversationId: 'conv',
  auditUserId: 'u1',
  title: 'María Pérez',
  valueUsd: 50,
}

describe('closeWonDeal', () => {
  it('finds the "Compra finalizada" stage by name when none is configured', async () => {
    const { db } = fakeDb({
      ai_pipeline_sync: SYNC_ROW,
      pipeline_stages: [
        { id: 'new', name: 'Nuevo' },
        { id: 'done', name: 'Compra finalizada' },
      ],
    })
    expect(await resolveWonStage(db, rowToSettings(SYNC_ROW))).toBe('done')
  })

  it('moves the existing deal to the won stage with its USD value and name', async () => {
    const { db, writes } = fakeDb({
      ai_pipeline_sync: { ...SYNC_ROW, stage_won_id: 'won' },
      deals: [{ id: 'd1', notes: null }],
    })
    const res = await closeWonDeal(db, ARGS)
    expect(res).toEqual({ dealId: 'd1', stageId: 'won', created: false })
    expect(writes[0]).toMatchObject({
      table: 'deals',
      op: 'update',
      row: { stage_id: 'won', status: 'won', value: 50, currency: 'USD', title: 'María Pérez' },
    })
  })

  it('creates a won deal when the contact has none', async () => {
    const { db, writes } = fakeDb({ ai_pipeline_sync: { ...SYNC_ROW, stage_won_id: 'won' }, deals: [] })
    const res = await closeWonDeal(db, ARGS)
    expect(res).toEqual({ dealId: 'new-deal', stageId: 'won', created: true })
    expect(writes[0]).toMatchObject({ op: 'insert', row: { stage_id: 'won', status: 'won', value: 50 } })
  })

  it('does nothing when there is no won stage', async () => {
    const { db, writes } = fakeDb({ ai_pipeline_sync: SYNC_ROW, pipeline_stages: [{ id: 'new', name: 'Nuevo' }] })
    expect(await closeWonDeal(db, ARGS)).toBeNull()
    expect(writes).toHaveLength(0)
  })
})
