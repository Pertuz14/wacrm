import { describe, it, expect, vi } from 'vitest'
import {
  closeWonDeal,
  decideStageMove,
  isUsable,
  pickProgramPipeline,
  programFromActions,
  programFromText,
  resolveWonStage,
  rowToSettings,
  sweepStaleDeals,
  syncDealForTurn,
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

describe('programs', () => {
  const SIMADI = { ...S, program: 'simadi' as const }
  const UCAB = {
    program: 'ucab' as const,
    pipelineId: 'pipe-ucab',
    stageNewId: 'u-new',
    stageInterestedId: 'u-int',
    stageVerifyId: 'u-ver',
    stageLostId: 'u-lost',
    stageWonId: null,
  }
  const PROPE = { ...UCAB, program: 'propedeutico' as const, pipelineId: 'pipe-prope' }

  it('reads the program from the bot labels and the REGISTRO', () => {
    expect(programFromActions([{ type: 'label', value: 'programa_ucab' }])).toBe('ucab')
    expect(programFromActions([{ type: 'label', value: 'PROGRAMA_PROPEDEUTICO' }])).toBe('propedeutico')
    expect(
      programFromActions([
        { type: 'registro', fields: { area: 'Propedéutico Medicina', producto: 'Propedéutico Medicina UCV' } },
      ]),
    ).toBe('propedeutico')
    expect(programFromActions([{ type: 'label', value: 'area_definida' }])).toBeNull()
  })

  it('reads the program from a sale note', () => {
    expect(programFromText('Guía UCAB')).toBe('ucab')
    expect(programFromText('Propedéutico Medicina UCV')).toBe('propedeutico')
    expect(programFromText('Paquete completo')).toBe('simadi')
    expect(programFromText('')).toBeNull()
  })

  it('uses the named program, else the latest deal, else SIMADI', () => {
    const programs = [SIMADI, UCAB, PROPE]
    const deals = [
      { id: 'a', stage_id: 'new', pipeline_id: 'pipe', updated_at: '2026-10-01T00:00:00Z' },
      { id: 'b', stage_id: 'u-int', pipeline_id: 'pipe-ucab', updated_at: '2026-10-20T00:00:00Z' },
    ]
    expect(pickProgramPipeline(programs, 'propedeutico', deals)?.pipelineId).toBe('pipe-prope')
    expect(pickProgramPipeline(programs, null, deals)?.pipelineId).toBe('pipe-ucab')
    expect(pickProgramPipeline(programs, null, [])?.pipelineId).toBe('pipe')
    // A program without a configured pipeline falls back the same way.
    expect(pickProgramPipeline([SIMADI], 'ucab', [])?.pipelineId).toBe('pipe')
  })

  it("moves deals with each pipeline's own stages", () => {
    expect(decideStageMove(UCAB, 'u-new', 'verify')).toBe('u-ver')
    expect(decideStageMove(UCAB, 'u-lost', 'new')).toBe('u-new')
    expect(decideStageMove(UCAB, 'int', 'verify')).toBeNull()
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
      deals: [{ id: 'd1', stage_id: 'int', pipeline_id: 'pipe', notes: null }],
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

// ---- stale sweep ---------------------------------------------------------

describe('sweepStaleDeals', () => {
  function sweepDb(rpcResult: { data: unknown; error: unknown }, deals: unknown[] = []) {
    const updates: { table: string; row: unknown }[] = []
    const rpcCalls: string[] = []
    const from = (table: string) => {
      const q: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'order', 'limit', 'in', 'lt']) q[m] = () => q
      q.maybeSingle = async () => ({ data: table === 'ai_pipeline_sync' ? SYNC_ROW : null, error: null })
      q.then = (ok: (v: unknown) => unknown) => ok({ data: table === 'deals' ? deals : [], error: null })
      q.update = (row: unknown) => {
        updates.push({ table, row })
        return q
      }
      return q
    }
    const rpc = async (name: string) => {
      rpcCalls.push(name)
      return rpcResult
    }
    return { db: { from, rpc } as unknown as Parameters<typeof sweepStaleDeals>[0], updates, rpcCalls }
  }

  it('moves stale cards with one database call', async () => {
    const { db, rpcCalls, updates } = sweepDb({ data: 4, error: null })
    expect(await sweepStaleDeals(db, 'acc', new Date('2026-10-30T12:00:00Z'))).toBe(4)
    expect(rpcCalls).toEqual(['sweep_stale_deals'])
    // Only the throttle stamp; no per-card updates from the app.
    expect(updates.filter((u) => u.table === 'deals')).toHaveLength(0)
  })

  it('falls back to the per-card loop when the database function is missing', async () => {
    const { db } = sweepDb({ data: null, error: { code: 'PGRST202' } }, [])
    expect(await sweepStaleDeals(db, 'acc', new Date('2026-10-30T12:00:00Z'))).toBe(0)
  })

  it('does nothing while the hourly throttle is still fresh', async () => {
    const recent = { ...SYNC_ROW, last_sweep_at: new Date().toISOString() }
    const from = () => {
      const q: Record<string, unknown> = {}
      for (const m of ['select', 'eq']) q[m] = () => q
      q.maybeSingle = async () => ({ data: recent, error: null })
      return q
    }
    const rpc = vi.fn()
    expect(await sweepStaleDeals({ from, rpc } as unknown as Parameters<typeof sweepStaleDeals>[0], 'acc')).toBe(0)
    expect(rpc).not.toHaveBeenCalled()
  })
})

describe('syncDealForTurn — greeting without a program', () => {
  function turnDb(deals: unknown[]) {
    const inserts: unknown[] = []
    const from = (table: string) => {
      const q: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'order', 'limit', 'in']) q[m] = () => q
      q.maybeSingle = async () => ({
        data: table === 'ai_pipeline_sync' ? SYNC_ROW : table === 'contacts' ? { name: 'Ana', phone: '58' } : null,
        error: null,
      })
      q.then = (ok: (v: unknown) => unknown) => ok({ data: table === 'deals' ? deals : [], error: null })
      q.insert = async (row: unknown) => {
        inserts.push(row)
        return { error: null }
      }
      q.update = () => q
      return q
    }
    return { db: { from } as unknown as Parameters<typeof syncDealForTurn>[0], inserts }
  }
  const turn = (actions: Parameters<typeof syncDealForTurn>[1]['actions']) => ({
    accountId: 'acc',
    contactId: 'c1',
    conversationId: 'conv',
    configOwnerUserId: 'u1',
    actions,
  })

  it('creates no card while the program is unknown (M18)', async () => {
    const { db, inserts } = turnDb([])
    await syncDealForTurn(db, turn([{ type: 'label', value: 'nuevo_interesado' }]))
    expect(inserts).toHaveLength(0)
  })

  it('creates the card once the program is named', async () => {
    const { db, inserts } = turnDb([])
    await syncDealForTurn(db, turn([{ type: 'label', value: 'nuevo_interesado' }, { type: 'label', value: 'programa_simadi' }]))
    expect(inserts).toHaveLength(1)
  })

  it('still files the card (SIMADI) when the chat advances without a program label', async () => {
    const { db, inserts } = turnDb([])
    await syncDealForTurn(db, turn([{ type: 'label', value: 'area_definida' }]))
    expect(inserts).toMatchObject([{ pipeline_id: 'pipe', stage_id: 'int' }])
  })
})
