'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CheckCircle2, Copy, Loader2, XCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useCan } from '@/hooks/use-can';
import { SettingsPanelHead } from './settings-panel-head';

interface InstagramState {
  connected: boolean;
  username?: string | null;
  igAccountId?: string;
  verifyToken?: string | null;
  hasAppSecret?: boolean;
  tokenRefreshedAt?: string | null;
  tokenExpiresAt?: string | null;
  aiChannelNote?: string | null;
  defaultAiNote: string;
  commentReplyEnabled?: boolean;
  commentKeywords?: string[];
  commentReplyText?: string | null;
  commentPublicReply?: string | null;
}

async function call<T>(method: string, body?: unknown): Promise<T> {
  const res = await fetch('/api/instagram/config', {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Error ${res.status}`);
  return json as T;
}

function CopyField({ label, value }: { label: string; value: string }) {
  const t = useTranslations('Settings.instagram');
  return (
    <div className="space-y-1.5">
      <Label className="text-muted-foreground">{label}</Label>
      <div className="flex gap-2">
        <Input readOnly value={value} className="font-mono text-xs" />
        <Button
          type="button"
          variant="outline"
          size="icon"
          title={t('copy')}
          onClick={() => {
            void navigator.clipboard.writeText(value);
            toast.success(t('copied'));
          }}
        >
          <Copy className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

export function InstagramConfig() {
  const t = useTranslations('Settings.instagram');
  const isAdmin = useCan('edit-settings');
  const [state, setState] = useState<InstagramState | null>(null);
  const [token, setToken] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [commentOn, setCommentOn] = useState(false);
  const [keywords, setKeywords] = useState('');
  const [dmText, setDmText] = useState('');
  const [publicReply, setPublicReply] = useState('');

  const load = useCallback(async () => {
    try {
      const s = await call<InstagramState>('GET');
      setState(s);
      setNote(s.aiChannelNote ?? '');
      setCommentOn(Boolean(s.commentReplyEnabled));
      setKeywords((s.commentKeywords ?? []).join(', '));
      setDmText(s.commentReplyText ?? '');
      setPublicReply(s.commentPublicReply ?? '');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: loads or resets state when its inputs change
    void load();
  }, [load]);

  const webhookUrl = typeof window !== 'undefined' ? `${window.location.origin}/api/instagram/webhook` : '/api/instagram/webhook';

  const connect = async () => {
    setBusy('connect');
    try {
      const r = await call<{ username: string | null; subscribed: boolean; subscribeError: string | null }>('POST', {
        accessToken: token,
        appSecret: secret,
      });
      setToken('');
      setSecret('');
      toast.success(t('connectedToast', { username: r.username ?? '' }));
      if (r.subscribeError) toast.warning(t('subscribeWarning', { error: r.subscribeError }));
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const save = async (what: 'note' | 'comments') => {
    setBusy(what);
    try {
      await call(
        'PATCH',
        what === 'note'
          ? { aiChannelNote: note }
          : { commentReplyEnabled: commentOn, commentKeywords: keywords, commentReplyText: dmText, commentPublicReply: publicReply },
      );
      toast.success(t('saved'));
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async () => {
    if (!window.confirm(t('disconnectConfirm'))) return;
    setBusy('disconnect');
    try {
      await call('DELETE');
      toast.success(t('disconnected'));
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  if (!state) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> {t('loading')}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <SettingsPanelHead title={t('title')} description={t('description')} />

      {/* Connection */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            {state.connected ? (
              <>
                <CheckCircle2 className="h-4 w-4 text-emerald-500" /> {t('connectedAs', { username: state.username ?? state.igAccountId ?? '' })}
              </>
            ) : (
              <>
                <XCircle className="h-4 w-4 text-muted-foreground" /> {t('notConnected')}
              </>
            )}
          </CardTitle>
          <CardDescription>
            {state.connected
              ? t('tokenInfo', { date: state.tokenRefreshedAt ? new Date(state.tokenRefreshedAt).toLocaleDateString() : '—' })
              : t('connectHint')}
          </CardDescription>
        </CardHeader>
        {isAdmin && (
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="ig-token">{t('tokenLabel')}</Label>
                <Input id="ig-token" type="password" autoComplete="off" placeholder="IGAA…" value={token} onChange={(e) => setToken(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ig-secret">{t('secretLabel')}</Label>
                <Input
                  id="ig-secret"
                  type="password"
                  autoComplete="off"
                  placeholder={state.hasAppSecret ? t('secretKeep') : ''}
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">{t('secretHint')}</p>
            <div className="flex flex-wrap gap-2">
              <Button onClick={connect} disabled={!token.trim() || (!state.hasAppSecret && !secret.trim()) || busy !== null}>
                {busy === 'connect' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {state.connected ? t('reconnect') : t('connect')}
              </Button>
              {state.connected && (
                <Button variant="outline" onClick={disconnect} disabled={busy !== null}>
                  {t('disconnect')}
                </Button>
              )}
            </div>
          </CardContent>
        )}
      </Card>

      {/* Webhook details for Meta */}
      {state.connected && isAdmin && state.verifyToken && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('webhookTitle')}</CardTitle>
            <CardDescription>{t('webhookDesc')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <CopyField label={t('webhookUrl')} value={webhookUrl} />
            <CopyField label={t('verifyToken')} value={state.verifyToken} />
            <p className="text-xs text-muted-foreground">{t('webhookFields')}</p>
          </CardContent>
        </Card>
      )}

      {state.connected && (
        <>
          {/* AI note */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('aiTitle')}</CardTitle>
              <CardDescription>{t('aiDesc')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Textarea rows={4} value={note} placeholder={state.defaultAiNote} onChange={(e) => setNote(e.target.value)} disabled={!isAdmin} />
              <p className="text-xs text-muted-foreground">{t('aiDefaultHint')}</p>
              {isAdmin && (
                <Button size="sm" onClick={() => save('note')} disabled={busy !== null}>
                  {busy === 'note' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {t('save')}
                </Button>
              )}
            </CardContent>
          </Card>

          {/* Comment → DM */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('commentsTitle')}</CardTitle>
              <CardDescription>{t('commentsDesc')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <label className="flex items-center gap-3 text-sm">
                <Switch checked={commentOn} onCheckedChange={setCommentOn} disabled={!isAdmin} />
                {t('commentsEnable')}
              </label>
              <div className="space-y-1.5">
                <Label htmlFor="ig-keywords">{t('keywordsLabel')}</Label>
                <Input id="ig-keywords" placeholder="GUIA, INFO" value={keywords} onChange={(e) => setKeywords(e.target.value)} disabled={!isAdmin} />
                <p className="text-xs text-muted-foreground">{t('keywordsHint')}</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ig-dm">{t('dmLabel')}</Label>
                <Textarea id="ig-dm" rows={4} value={dmText} onChange={(e) => setDmText(e.target.value)} disabled={!isAdmin} maxLength={1000} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ig-public">{t('publicLabel')}</Label>
                <Input id="ig-public" value={publicReply} onChange={(e) => setPublicReply(e.target.value)} disabled={!isAdmin} maxLength={300} />
                <p className="text-xs text-muted-foreground">{t('publicHint')}</p>
              </div>
              {isAdmin && (
                <Button size="sm" onClick={() => save('comments')} disabled={busy !== null}>
                  {busy === 'comments' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {t('save')}
                </Button>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
