// ============================================================
// DELETE /api/contacts/[id] — owner only.
//
// Deletes a contact together with its conversations and messages
// (ON DELETE CASCADE from contacts → conversations → messages) and its
// pipeline cards. Broadcast rows keep their history with
// contact_id = NULL (migration 004). Meant for test conversations: the next message from
// that number starts from scratch, as a brand-new contact.
//
// RLS still applies (ctx.supabase is the signed-in user's client), and
// the row must belong to the caller's account.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('owner');

    const limit = checkRateLimit(`owner:deleteContact:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 });
    }

    // Its pipeline cards go too: deals.conversation_id has no ON DELETE
    // action, so they would block the cascade (and a test lead's card
    // has no history worth keeping).
    const { error: dealsError } = await ctx.supabase
      .from('deals')
      .delete()
      .eq('contact_id', id)
      .eq('account_id', ctx.accountId);
    if (dealsError) {
      console.error('[contacts delete] deals failed:', dealsError);
      return NextResponse.json({ error: 'Could not delete the contact' }, { status: 500 });
    }

    const { data, error } = await ctx.supabase
      .from('contacts')
      .delete()
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .select('id');
    if (error) {
      console.error('[contacts delete] failed:', error);
      return NextResponse.json({ error: 'Could not delete the contact' }, { status: 500 });
    }
    if (!data?.length) {
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
