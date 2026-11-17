// ============================================================
// Rumbo a la U — local change (see RUMBO.md). Not part of upstream.
//
// What runs after the bot's reply was sent:
//   - `[[ENVIAR:clave]]` → the platform sends the clip / fixed voice note.
//   - `[[NO_CONTACTAR]]` → the customer said they don't want to go on
//     (or asked not to be written to): the contact gets the tag
//     «No contactar». The platform never sends an automatic message
//     (rescue, diagnosis) to a contact with that tag. The owner can also
//     add or remove it by hand.
// Best-effort: never throws.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveAuditUserId } from '@/lib/api/v1/contacts'
import { addContactTagIfAbsent } from '@/lib/contacts/tag-write'
import { sendRequestedMedia } from './checkout-link'

export const NO_CONTACT_TAG = 'No contactar'
const NO_CONTACT_RE = /\[\[\s*NO_CONTACTAR\s*\]\]/i

interface Target {
  accountId: string
  conversationId: string
  contactId: string
}

export const asksNoContact = (raw: string): boolean => NO_CONTACT_RE.test(raw ?? '')

/** Find (or create) the account's «No contactar» tag and put it on the contact. */
export async function tagNoContact(db: SupabaseClient, target: Target): Promise<boolean> {
  try {
    const { data: found } = await db
      .from('tags')
      .select('id')
      .eq('account_id', target.accountId)
      .ilike('name', NO_CONTACT_TAG)
      .limit(1)
    let tagId = (found as { id: string }[] | null)?.[0]?.id ?? null
    if (!tagId) {
      const userId = await resolveAuditUserId(db, target.accountId)
      const { data: created, error } = await db
        .from('tags')
        .insert({ account_id: target.accountId, user_id: userId, name: NO_CONTACT_TAG, color: '#64748b' })
        .select('id')
        .single()
      if (error || !created) return false
      tagId = (created as { id: string }).id
    }
    await addContactTagIfAbsent(db, { accountId: target.accountId, contactId: target.contactId, tagId })
    return true
  } catch (err) {
    console.warn('[rumbo] no-contact tag failed:', err)
    return false
  }
}

export async function rumboAfterReply(db: SupabaseClient, target: Target, raw: string, channel: string | null): Promise<void> {
  if (asksNoContact(raw)) await tagNoContact(db, target)
  await sendRequestedMedia(db, target, raw, channel)
}
