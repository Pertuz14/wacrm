// ============================================================
// GET  /api/v1/sales — the exchange rate the assistant quotes with
// POST /api/v1/sales — report a closed sale           (scope: sales:write)
//
// For a store that sells over WhatsApp and registers the payment in its
// own back office (e.g. the Rumbo a la U platform). One call:
//   * names the contact as the store registered them,
//   * converts a bolívar amount to USD with the same BCV rate the AI
//     assistant uses to quote (AI Agents → Prices),
//   * moves the contact's deal in the synced pipeline to the "purchase
//     completed" stage, marked won, with the USD value.
//
// POST body:
//   {
//     "phone": "+584121234567",     // required, E.164
//     "name": "María Pérez",        // optional, renames the contact
//     "amount": 4845.86,            // required, what was charged
//     "currency": "VES",            // USD | USDT | VES (default USD)
//     "rate": 96.9,                 // optional Bs/USD; default: the stored BCV rate
//     "note": "Paquete completo",   // optional, appended to the deal notes
//     "program": "ucab"             // optional: simadi | ucab | propedeutico
//   }                               //   (default: read from the note, else the
//                                   //   contact's latest deal, else SIMADI)
//
// Response (200):
//   { "data": { "amount_usd", "rate", "rate_date", "contact_id",
//               "deal_id", "deal_created", "stage_id" } }
// `deal_id` is null when no pipeline sync / won stage is set up.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation';
import { SendMessageError } from '@/lib/whatsapp/send-message';
import { resolveAuditUserId } from '@/lib/api/v1/contacts';
import { loadPricing } from '@/lib/ai/exchange-rate';
import { closeWonDeal, programFromText } from '@/lib/ai/pipeline-sync';

const CURRENCIES = ['USD', 'USDT', 'VES'] as const;
type Currency = (typeof CURRENCIES)[number];

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'sales:write');
    const pricing = await loadPricing(ctx.supabase, ctx.accountId);
    if (!pricing?.rate) {
      return fail('not_found', 'No exchange rate set up (AI Agents → Prices)', 404);
    }
    return ok({ rate: pricing.rate, rate_date: pricing.rateDate, source: pricing.rateSource });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'sales:write');

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }

    const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
    if (!phone) return fail('bad_request', "'phone' is required", 400);

    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount < 0) {
      return fail('bad_request', "'amount' must be a non-negative number", 400);
    }

    const currency = (typeof body.currency === 'string' ? body.currency.toUpperCase() : 'USD') as Currency;
    if (!CURRENCIES.includes(currency)) {
      return fail('bad_request', "'currency' must be USD, USDT or VES", 400);
    }

    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 120) : null;
    const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 500) : null;

    // Bolívares → USD with the given rate, or the one the assistant quotes with.
    let rate: number | null = null;
    let rateDate: string | null = null;
    if (currency === 'VES') {
      const given = Number(body.rate);
      if (Number.isFinite(given) && given > 0) {
        rate = given;
      } else {
        const pricing = await loadPricing(ctx.supabase, ctx.accountId);
        rate = pricing?.rate ?? null;
        rateDate = pricing?.rateDate ?? null;
      }
      if (!rate) {
        return fail('bad_request', 'No exchange rate available to convert VES (set one in AI Agents → Prices)', 400);
      }
    }
    const amountUsd = round2(rate ? amount / rate : amount);

    // Finds the contact by phone (creating it if new) and renames it.
    const resolved = await resolveConversationByPhone(ctx.supabase, ctx.accountId, phone, name);

    const deal = await closeWonDeal(ctx.supabase, {
      accountId: ctx.accountId,
      contactId: resolved.contactId,
      conversationId: resolved.conversationId,
      auditUserId: await resolveAuditUserId(ctx.supabase, ctx.accountId),
      title: name ?? phone,
      valueUsd: amountUsd,
      note,
      // Which program's pipeline: an explicit "program", else read from the note.
      program:
        programFromText(typeof body.program === 'string' ? body.program : null) ??
        programFromText(note),
    });

    return ok({
      amount_usd: amountUsd,
      rate,
      rate_date: rateDate,
      contact_id: resolved.contactId,
      deal_id: deal?.dealId ?? null,
      deal_created: deal?.created ?? false,
      stage_id: deal?.stageId ?? null,
    });
  } catch (err) {
    if (err instanceof SendMessageError) {
      return fail(err.code, err.message, err.status);
    }
    return toApiErrorResponse(err);
  }
}
