import type { SupabaseClient } from '@supabase/supabase-js'
import type { ChatMessage } from './types'
import { aiContextMessageLimit } from './defaults'
import {
  isUnsupportedInboundText,
  unsupportedInboundForModel,
} from '@/lib/whatsapp/unsupported-message'

interface DbMessage {
  sender_type: 'customer' | 'agent' | 'bot'
  content_type: string
  content_text: string | null
}

/**
 * Content types the model sees. Media can't be passed to the model as
 * bytes, but it still has to know it arrived — a payment receipt is an
 * image, a question can be a voice note — so each is rendered as a short
 * bracketed placeholder (plus its caption, if any). Templates and
 * interactive payloads are left out: they carry no conversational text.
 */
export const CONTEXT_CONTENT_TYPES = ['text', 'image', 'audio', 'video', 'document', 'location']

const MEDIA_LABEL: Record<string, string> = {
  image: 'an image',
  audio: 'a voice note / audio',
  video: 'a video',
  document: 'a document',
  location: 'a location',
}

/** What the model sees for a customer image without caption — also used
 *  by the Playground to simulate a payment receipt. */
export const CUSTOMER_IMAGE_PLACEHOLDER = '[The customer sent an image]'

/** Text the model sees for one stored message; null to skip it. */
export function renderMessageForModel(m: DbMessage): string | null {
  const text = m.content_text?.trim() ?? ''
  // A message WhatsApp wouldn't hand us (often the first one from an ad):
  // explain it instead of passing the raw placeholder.
  if (m.sender_type === 'customer' && isUnsupportedInboundText(text)) {
    return unsupportedInboundForModel(text)
  }
  if (m.content_type === 'text') return text || null
  const label = MEDIA_LABEL[m.content_type]
  if (!label) return null
  const who = m.sender_type === 'customer' ? 'The customer sent' : 'Sent'
  return text
    ? `[${who} ${label} with the caption: "${text}"]`
    : `[${who} ${label}]`
}

/**
 * Fetch the last N messages of a conversation and map them to the
 * provider-neutral chat shape. Customer messages become `user`; agent
 * and bot messages become `assistant`.
 *
 * Ordered oldest-first (chronological) so the transcript reads
 * naturally and the most recent customer message lands last.
 */
export async function buildConversationContext(
  db: SupabaseClient,
  conversationId: string,
  limit: number = aiContextMessageLimit(),
): Promise<ChatMessage[]> {
  const { data, error } = await db
    .from('messages')
    .select('sender_type, content_type, content_text')
    .eq('conversation_id', conversationId)
    .in('content_type', CONTEXT_CONTENT_TYPES)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) throw error

  const rows = ((data ?? []) as DbMessage[]).reverse()
  const out: ChatMessage[] = []
  for (const m of rows) {
    const content = renderMessageForModel({
      ...m,
      // Rows written before content_type existed are text.
      content_type: m.content_type ?? 'text',
    })
    if (!content) continue
    out.push({ role: m.sender_type === 'customer' ? 'user' : 'assistant', content })
  }
  return out
}
