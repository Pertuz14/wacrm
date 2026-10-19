'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { GitBranch, Loader2 } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface PipelineOption {
  id: string;
  name: string;
  stages: { id: string; name: string }[];
}

type StageField = 'stage_new_id' | 'stage_interested_id' | 'stage_verify_id' | 'stage_lost_id' | 'stage_won_id';

interface SyncState {
  enabled: boolean;
  pipeline_id: string | null;
  stage_new_id: string | null;
  stage_interested_id: string | null;
  stage_verify_id: string | null;
  stage_lost_id: string | null;
  stage_won_id: string | null;
  lost_after_days: number;
  pipelines: PipelineOption[];
}

// Radix Select can't use an empty-string value.
const NONE = '__none__';

const STAGE_FIELDS: { field: StageField; labelKey: string; hintKey: string }[] = [
  { field: 'stage_new_id', labelKey: 'stageNew', hintKey: 'stageNewHint' },
  { field: 'stage_interested_id', labelKey: 'stageInterested', hintKey: 'stageInterestedHint' },
  { field: 'stage_verify_id', labelKey: 'stageVerify', hintKey: 'stageVerifyHint' },
  { field: 'stage_lost_id', labelKey: 'stageLost', hintKey: 'stageLostHint' },
];

// Optional: closed sales reported by the store (POST /api/v1/sales).
const WON_FIELD = { field: 'stage_won_id' as const, labelKey: 'stageWon', hintKey: 'stageWonHint' };

export function AiPipelineSync() {
  const t = useTranslations('Agents.pipelineSync');
  const { accountId, accountRole } = useAuth();
  const canEdit = accountRole ? canEditSettings(accountRole) : false;

  const [state, setState] = useState<SyncState | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [days, setDays] = useState('20');

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/ai/pipeline-sync');
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          toast.error(json.error ?? t('loadFailed'));
          return;
        }
        setState(json);
        setDays(String(json.lost_after_days ?? 20));
      } catch {
        if (!cancelled) toast.error(t('loadFailed'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId, t]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8 text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {t('loading')}
      </div>
    );
  }
  if (!state) return null;

  const pipeline = state.pipelines.find((p) => p.id === state.pipeline_id) ?? null;
  const disabled = !canEdit || saving;
  // Base UI's Select.Value shows the raw value (a UUID) unless it knows the labels.
  const pipelineItems: Record<string, string> = {
    [NONE]: t('pipelinePlaceholder'),
    ...Object.fromEntries(state.pipelines.map((p) => [p.id, p.name || '—'])),
  };
  const stageItems: Record<string, string> = {
    [NONE]: t('stageNone'),
    ...Object.fromEntries((pipeline?.stages ?? []).map((st) => [st.id, st.name])),
  };
  const set = (patch: Partial<SyncState>) => setState((s) => (s ? { ...s, ...patch } : s));

  const handleSave = async () => {
    const n = Math.floor(Number(days));
    if (!Number.isFinite(n) || n < 1 || n > 365) {
      toast.error(t('errorDays'));
      return;
    }
    if (state.enabled) {
      const ids = STAGE_FIELDS.map(({ field }) => state[field]);
      if (!state.pipeline_id || ids.some((id) => !id)) {
        toast.error(t('errorIncomplete'));
        return;
      }
      if (state.stage_won_id) ids.push(state.stage_won_id);
      if (new Set(ids).size !== ids.length) {
        toast.error(t('errorDuplicate'));
        return;
      }
    }
    setSaving(true);
    try {
      const res = await fetch('/api/ai/pipeline-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: state.enabled,
          pipeline_id: state.pipeline_id,
          stage_new_id: state.stage_new_id,
          stage_interested_id: state.stage_interested_id,
          stage_verify_id: state.stage_verify_id,
          stage_lost_id: state.stage_lost_id,
          stage_won_id: state.stage_won_id,
          lost_after_days: n,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error ?? t('saveFailed'));
        return;
      }
      setState(json);
      toast.success(t('saveSuccess'));
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <GitBranch className="h-4 w-4 text-primary" /> {t('title')}
        </CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
          <div>
            <p className="text-sm font-medium text-foreground">{t('enabled')}</p>
            <p className="text-xs text-muted-foreground">{t('enabledDesc')}</p>
          </div>
          <Switch
            checked={state.enabled}
            onCheckedChange={(v) => set({ enabled: v })}
            disabled={disabled}
          />
        </div>

        {state.pipelines.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('noPipelines')}</p>
        ) : (
          <>
            <div className="space-y-2 sm:max-w-sm">
              <Label>{t('pipeline')}</Label>
              <Select
                items={pipelineItems}
                value={state.pipeline_id ?? NONE}
                onValueChange={(v) =>
                  // A new pipeline invalidates the stage picks.
                  set({
                    pipeline_id: v === NONE ? null : v,
                    stage_new_id: null,
                    stage_interested_id: null,
                    stage_verify_id: null,
                    stage_lost_id: null,
                    stage_won_id: null,
                  })
                }
                disabled={disabled}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t('pipelinePlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{t('pipelinePlaceholder')}</SelectItem>
                  {state.pipelines.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name || '—'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {pipeline && (
              <div className="grid gap-4 sm:grid-cols-2">
                {[...STAGE_FIELDS, WON_FIELD].map(({ field, labelKey, hintKey }) => (
                  <div key={field} className="space-y-1.5">
                    <Label>{t(labelKey)}</Label>
                    <Select
                      items={stageItems}
                      value={state[field] ?? NONE}
                      onValueChange={(v) =>
                        set({ [field]: v === NONE ? null : v } as Partial<SyncState>)
                      }
                      disabled={disabled}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder={t('stageNone')} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE}>{t('stageNone')}</SelectItem>
                        {pipeline.stages.map((s) => (
                          <SelectItem key={s.id} value={s.id}>
                            {s.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">{t(hintKey)}</p>
                  </div>
                ))}
              </div>
            )}

            <div className="flex items-center justify-between gap-4">
              <div>
                <Label htmlFor="pipeline-sync-days">{t('lostAfterDays')}</Label>
                <p className="text-xs text-muted-foreground">{t('lostAfterDaysDesc')}</p>
              </div>
              <Input
                id="pipeline-sync-days"
                type="number"
                min={1}
                max={365}
                value={days}
                onChange={(e) => setDays(e.target.value)}
                disabled={disabled}
                className="w-24"
              />
            </div>

            <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              {t('manualNote')}
            </p>
          </>
        )}

        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={disabled}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('save')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
