'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import {
  Bot,
  RotateCcw,
  Send,
  Loader2,
  UserCircle2,
  ArrowRight,
  ImageIcon,
  Zap,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import type { BotAction } from '@/lib/ai/bot-output';
import { CUSTOMER_IMAGE_PLACEHOLDER } from '@/lib/ai/context';

interface Turn {
  role: 'user' | 'assistant';
  content: string;
  /** assistant-only: the agent signalled a human handoff on this turn. */
  handoff?: boolean;
  /** assistant-only: what the live bot would do after this turn. */
  actions?: BotAction[];
}

export function AiPlayground({ onGoToSetup }: { onGoToSetup?: () => void }) {
  const t = useTranslations('Agents.playground');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [turns, sending]);

  const send = async (override?: string) => {
    const text = (override ?? input).trim();
    if (!text || sending) return;

    const next: Turn[] = [...turns, { role: 'user', content: text }];
    setTurns(next);
    if (override === undefined) setInput('');
    setSending(true);
    try {
      const res = await fetch('/api/ai/playground', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Send only role+content — the server ignores anything else.
        body: JSON.stringify({
          messages: next.map((t) => ({ role: t.role, content: t.content })),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.code === 'ai_not_configured') {
          toast.error(t('notConfigured'));
        } else {
          toast.error(data.error ?? t('noReply'));
        }
        // Roll the unsent user turn back so the transcript stays clean.
        setTurns(turns);
        if (override === undefined) setInput(text);
        return;
      }
      // One bubble per WhatsApp message the bot would send; the actions
      // and handoff marker hang off the last one.
      const replies: string[] =
        Array.isArray(data.replies) && data.replies.length > 0
          ? data.replies.filter((r: unknown): r is string => typeof r === 'string')
          : [typeof data.reply === 'string' ? data.reply : ''];
      const actions: BotAction[] = Array.isArray(data.actions) ? data.actions : [];
      const botTurns: Turn[] = replies.map((content, i) => {
        const last = i === replies.length - 1;
        return {
          role: 'assistant',
          content: content.trim(),
          handoff: last ? Boolean(data.handoff) : undefined,
          actions: last ? actions : undefined,
        };
      });
      setTurns([...next, ...botTurns]);
    } catch {
      toast.error(t('unreachable'));
      setTurns(turns);
      if (override === undefined) setInput(text);
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  const actionLabel = (action: BotAction): string | null => {
    switch (action.type) {
      case 'verify_payment':
        return t('actionVerifyPayment');
      case 'registro': {
        const fields = Object.entries(action.fields)
          .filter(([, v]) => v)
          .map(([k, v]) => `${k}: ${v}`)
          .join(' · ');
        return t('actionRegistro', { fields: fields || '—' });
      }
      case 'handoff':
        return action.reason
          ? t('actionHandoffReason', { reason: action.reason })
          : t('handoff');
      case 'label':
        return t('actionLabel', { value: action.value });
      default:
        return null;
    }
  };

  return (
    <div className="flex h-[60vh] min-h-[420px] flex-col rounded-xl border border-border bg-card">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <Bot className="h-4 w-4 text-primary" />
          <span className="text-sm font-medium text-foreground">{t('title')}</span>
          <span className="text-xs text-muted-foreground">
            {t('subtitle')}
          </span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setTurns([])}
          disabled={turns.length === 0 || sending}
          className="text-muted-foreground"
        >
          <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> {t('reset')}
        </Button>
      </div>

      {/* Transcript */}
      <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto p-4">
        {turns.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center text-center text-sm text-muted-foreground">
            <Bot className="mb-2 h-8 w-8 text-muted-foreground/60" />
            <p>{t('emptyTitle')}</p>
            <p className="mt-1 text-xs">
              {t('emptyDesc')}
            </p>
            {onGoToSetup && (
              <Button
                variant="link"
                size="sm"
                onClick={onGoToSetup}
                className="mt-1 h-auto p-0 text-xs"
              >
                {t('goToSetup')} <ArrowRight className="ml-1 h-3 w-3" />
              </Button>
            )}
          </div>
        )}

        {turns.map((turn, i) => {
          const actionLines = (turn.actions ?? [])
            .map(actionLabel)
            .filter((l): l is string => Boolean(l));
          const showHandoffChip =
            turn.handoff && !(turn.actions ?? []).some((a) => a.type === 'handoff');
          const isSimulatedImage =
            turn.role === 'user' && turn.content === CUSTOMER_IMAGE_PLACEHOLDER;
          return (
            <div
              key={i}
              className={cn(
                'flex gap-2',
                turn.role === 'user' ? 'justify-end' : 'justify-start',
              )}
            >
              {turn.role === 'assistant' && (
                <Bot className="mt-1 h-5 w-5 shrink-0 text-primary" />
              )}
              <div
                className={cn(
                  'max-w-[80%] rounded-2xl px-3.5 py-2 text-sm',
                  turn.role === 'user'
                    ? 'rounded-br-sm bg-primary text-primary-foreground'
                    : 'rounded-bl-sm bg-muted text-foreground',
                )}
              >
                {isSimulatedImage ? (
                  <p className="flex items-center gap-1.5 italic">
                    <ImageIcon className="h-4 w-4" /> {t('simulatedImage')}
                  </p>
                ) : (
                  turn.content && <p className="whitespace-pre-wrap">{turn.content}</p>
                )}
                {actionLines.length > 0 && (
                  <div
                    className={cn(
                      'space-y-1 text-xs text-amber-600 dark:text-amber-400',
                      turn.content && 'mt-1.5 border-t border-border/50 pt-1.5',
                    )}
                  >
                    {actionLines.map((line, j) => (
                      <p key={j} className="flex items-start gap-1">
                        <Zap className="mt-0.5 h-3 w-3 shrink-0" />
                        <span className="break-words">{line}</span>
                      </p>
                    ))}
                  </div>
                )}
                {turn.role === 'assistant' && showHandoffChip && (
                  <p
                    className={cn(
                      'flex items-center gap-1 text-xs text-amber-500',
                      turn.content && 'mt-1.5 border-t border-border/50 pt-1.5',
                    )}
                  >
                    <UserCircle2 className="h-3.5 w-3.5" />
                    {t('handoff')}
                  </p>
                )}
              </div>
              {turn.role === 'user' && (
                <UserCircle2 className="mt-1 h-5 w-5 shrink-0 text-muted-foreground" />
              )}
            </div>
          );
        })}

        {sending && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Bot className="h-5 w-5 text-primary" />
            <Loader2 className="h-4 w-4 animate-spin" /> {t('thinking')}
          </div>
        )}
      </div>

      {/* Composer */}
      <div className="flex items-end gap-2 border-t border-border p-3">
        <Button
          variant="outline"
          size="sm"
          onClick={() => void send(CUSTOMER_IMAGE_PLACEHOLDER)}
          disabled={sending}
          className="h-9 shrink-0"
          title={t('simulateImageHint')}
        >
          <ImageIcon className="mr-1.5 h-4 w-4" /> {t('simulateImage')}
        </Button>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t('placeholder')}
          rows={1}
          className="flex-1 resize-none rounded-xl border border-border bg-muted px-4 py-2.5 text-sm text-foreground placeholder-muted-foreground outline-none focus:border-primary/50"
        />
        <Button
          size="sm"
          onClick={() => void send()}
          disabled={!input.trim() || sending}
          className="h-9 w-9 shrink-0 p-0"
        >
          {sending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Send className="h-4 w-4" />
          )}
        </Button>
      </div>
    </div>
  );
}
