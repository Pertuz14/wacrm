// Rumbo a la U — local change (see RUMBO.md, cambio 9).
import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { UUID_RE } from '@/lib/rumbo/conversation'

/**
 * GET /api/rumbo/bot-versions?channel=whatsapp|instagram
 *   → { versions: [{ id, created_at, length }] } (las últimas 30, sin el texto)
 * GET /api/rumbo/bot-versions?id=<uuid>
 *   → { id, channel, created_at, content } (una versión con su texto)
 *
 * Versiones anteriores del texto del bot que guarda el disparador de la migración 076.
 * Solo lectura y solo de la cuenta de quien pregunta (la política de la tabla lo exige también).
 */
export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const url = new URL(request.url)
    const id = url.searchParams.get('id')

    if (id) {
      if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Versión no encontrada.' }, { status: 404 })
      const { data, error } = await supabase
        .from('rumbo_bot_versions')
        .select('id, channel, created_at, content')
        .eq('account_id', accountId)
        .eq('id', id)
        .maybeSingle()
      if (error) throw error
      if (!data) return NextResponse.json({ error: 'Versión no encontrada.' }, { status: 404 })
      return NextResponse.json(data)
    }

    const channel = url.searchParams.get('channel')
    if (channel !== 'whatsapp' && channel !== 'instagram') {
      return NextResponse.json({ error: 'Canal no válido.' }, { status: 400 })
    }
    const { data, error } = await supabase
      .from('rumbo_bot_versions')
      .select('id, created_at, content')
      .eq('account_id', accountId)
      .eq('channel', channel)
      .order('created_at', { ascending: false })
      .limit(30)
    if (error) throw error
    const versions = (data ?? []).map((v) => ({ id: v.id, created_at: v.created_at, length: [...v.content].length }))
    return NextResponse.json({ versions })
  } catch (err) {
    return toErrorResponse(err)
  }
}
