'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import {
  Banknote,
  BellRing,
  Copy,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  Variable,
} from 'lucide-react';
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
  ITEM_VARIABLE_SUFFIXES,
  formatBs,
  shortDate,
  usdToBs,
} from '@/lib/ai/pricing';
import type { PricingResponse } from '@/lib/ai/pricing-response';

interface EditableItem {
  /** Stable React key — rows can be reordered by deletion. */
  uid: string;
  label: string;
  key: string;
  usd: string;
}

const KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,39}$/;

let uidCounter = 0;
const nextUid = () => `row-${++uidCounter}`;

/**
 * Accepts `27,50`, `27.50` and `1.234,56`. With a comma present, dots are
 * thousands separators (Venezuelan style); otherwise a dot is decimal.
 */
export function parseAmount(raw: string): number {
  const s = raw.trim().replace(/\s/g, '');
  if (!s) return NaN;
  const normalised = s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s;
  return /^\d+(\.\d+)?$/.test(normalised) ? Number(normalised) : NaN;
}

function toEditable(items: PricingResponse['items']): EditableItem[] {
  return items.map((i) => ({
    uid: nextUid(),
    label: i.label,
    key: i.key,
    usd: String(i.usd).replace('.', ','),
  }));
}

export function AiPricing() {
  const t = useTranslations('Agents.pricing');
  const { accountId, accountRole } = useAuth();
  const canEdit = accountRole ? canEditSettings(accountRole) : false;

  const [data, setData] = useState<PricingResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [testing, setTesting] = useState(false);

  const [autoUpdate, setAutoUpdate] = useState(true);
  const [manualRate, setManualRate] = useState('');
  const [items, setItems] = useState<EditableItem[]>([]);

  const apply = useCallback((res: PricingResponse) => {
    setData(res);
    setAutoUpdate(res.auto_update);
    setManualRate(res.rate ? String(res.rate).replace('.', ',') : '');
    setItems(toEditable(res.items));
  }, []);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await fetch('/api/ai/pricing');
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok) toast.error(json.error ?? t('loadFailed'));
        else apply(json);
      } catch {
        if (!cancelled) toast.error(t('loadFailed'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId, apply, t]);

  // Rate used for the live Bs preview: the typed one when manual.
  const previewRate = autoUpdate ? data?.rate ?? null : parseAmount(manualRate) || null;

  const updateItem = (uid: string, patch: Partial<EditableItem>) =>
    setItems((prev) => prev.map((i) => (i.uid === uid ? { ...i, ...patch } : i)));

  const validate = (): string | null => {
    const seen = new Set<string>();
    for (let i = 0; i < items.length; i++) {
      const row = i + 1;
      const key = items[i].key.trim().toUpperCase();
      if (!KEY_PATTERN.test(key)) return t('errorKey', { row });
      if (seen.has(key)) return t('errorDuplicate', { row, key });
      seen.add(key);
      const usd = parseAmount(items[i].usd);
      if (!Number.isFinite(usd) || usd < 0) return t('errorUsd', { row });
    }
    if (!autoUpdate) {
      const rate = parseAmount(manualRate);
      if (!Number.isFinite(rate) || rate <= 0) return t('errorManualRate');
    }
    return null;
  };

  const handleSave = async () => {
    const problem = validate();
    if (problem) {
      toast.error(problem);
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/ai/pricing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          auto_update: autoUpdate,
          manual_rate: autoUpdate ? null : parseAmount(manualRate),
          items: items.map((i) => ({
            key: i.key.trim().toUpperCase(),
            label: i.label.trim(),
            usd: parseAmount(i.usd),
          })),
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error ?? t('saveFailed'));
        return;
      }
      apply(json);
      toast.success(t('saveSuccess'));
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      const res = await fetch('/api/ai/pricing/refresh', { method: 'POST' });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error ?? t('refreshFailed'));
        return;
      }
      // Keep unsaved edits to the price list; only the rate changed.
      setData(json);
      toast.success(t('refreshSuccess'));
    } catch {
      toast.error(t('refreshFailed'));
    } finally {
      setRefreshing(false);
    }
  };

  const handleTestAlert = async () => {
    setTesting(true);
    try {
      const res = await fetch('/api/ai/notify-test', { method: 'POST' });
      const json = await res.json().catch(() => ({}));
      if (res.ok) toast.success(t('telegramTestSuccess'));
      else toast.error(json.error ?? t('telegramTestFailed'));
    } catch {
      toast.error(t('telegramTestFailed'));
    } finally {
      setTesting(false);
    }
  };

  const copyVariable = async (name: string) => {
    try {
      await navigator.clipboard.writeText(`{{${name}}}`);
      toast.success(t('copied', { name }));
    } catch {
      // Clipboard can be blocked (insecure context); nothing to do.
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {t('loading')}
      </div>
    );
  }

  const disabled = !canEdit || saving;
  const sourceLabel =
    data?.rate_source === 'bcv'
      ? t('sourceBcv')
      : data?.rate_source === 'dolarapi'
        ? t('sourceDolarapi')
        : data?.rate_source === 'manual'
          ? t('sourceManual')
          : null;

  const builtins: { name: string; hint: string }[] = [
    { name: 'TASA_BCV', hint: t('builtinRate') },
    { name: 'FECHA_HOY', hint: t('builtinToday') },
    { name: 'FECHA_TASA', hint: t('builtinRateDate') },
    { name: 'FECHA_CORTE_2P', hint: t('builtinCutoff') },
  ];
  const suffixHint: Record<(typeof ITEM_VARIABLE_SUFFIXES)[number], string> = {
    _BS: t('varBs'),
    _USD: t('varUsd'),
    _BS_COPIAR: t('varBsCopy'),
  };

  return (
    <div className="space-y-6">
      {!canEdit && (
        <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          {t('adminOnly')}
        </p>
      )}

      {/* Exchange rate */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Banknote className="h-4 w-4 text-primary" /> {t('rateTitle')}
          </CardTitle>
          <CardDescription>{t('rateDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {data?.rate ? (
            <div>
              <p className="text-2xl font-semibold text-foreground">
                {formatBs(data.rate)}{' '}
                <span className="text-sm font-normal text-muted-foreground">
                  {t('ratePerUsd')}
                </span>
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {[
                  data.rate_date ? t('rateValueDate', { date: shortDate(data.rate_date) }) : null,
                  sourceLabel ? t('rateSource', { source: sourceLabel }) : null,
                  data.checked_at
                    ? t('lastChecked', {
                        time: new Date(data.checked_at).toLocaleString(),
                      })
                    : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t('noRate')}</p>
          )}

          <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
            <div>
              <p className="text-sm font-medium text-foreground">{t('autoUpdate')}</p>
              <p className="text-xs text-muted-foreground">{t('autoUpdateDesc')}</p>
            </div>
            <Switch checked={autoUpdate} onCheckedChange={setAutoUpdate} disabled={disabled} />
          </div>

          {autoUpdate ? (
            data?.configured &&
            data.auto_update && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleRefresh}
                disabled={!canEdit || refreshing}
              >
                {refreshing ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="mr-2 h-4 w-4" />
                )}
                {t('refreshNow')}
              </Button>
            )
          ) : (
            <div className="space-y-2 sm:max-w-xs">
              <Label htmlFor="pricing-manual-rate">{t('manualRate')}</Label>
              <Input
                id="pricing-manual-rate"
                inputMode="decimal"
                value={manualRate}
                onChange={(e) => setManualRate(e.target.value)}
                placeholder="875,65"
                disabled={disabled}
              />
            </div>
          )}
        </CardContent>
      </Card>

      {/* Price list */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('pricesTitle')}</CardTitle>
          <CardDescription>{t('pricesDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {items.length === 0 && (
            <p className="text-sm text-muted-foreground">{t('noPrices')}</p>
          )}
          {items.map((item) => {
            const usd = parseAmount(item.usd);
            const key = item.key.trim().toUpperCase();
            const bs =
              previewRate && Number.isFinite(usd) ? formatBs(usdToBs(usd, previewRate)) : '—';
            return (
              <div key={item.uid} className="rounded-md border border-border p-3">
                <div className="grid gap-2 sm:grid-cols-[1fr_11rem_7rem_auto] sm:items-end">
                  <div className="space-y-1">
                    <Label className="text-xs">{t('colLabel')}</Label>
                    <Input
                      value={item.label}
                      onChange={(e) => updateItem(item.uid, { label: e.target.value })}
                      placeholder={t('labelPlaceholder')}
                      disabled={disabled}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">{t('colKey')}</Label>
                    <Input
                      value={item.key}
                      onChange={(e) =>
                        updateItem(item.uid, {
                          key: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''),
                        })
                      }
                      placeholder={t('keyPlaceholder')}
                      className="font-mono"
                      disabled={disabled}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">{t('colUsd')}</Label>
                    <Input
                      inputMode="decimal"
                      value={item.usd}
                      onChange={(e) => updateItem(item.uid, { usd: e.target.value })}
                      placeholder="50"
                      disabled={disabled}
                    />
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setItems((prev) => prev.filter((i) => i.uid !== item.uid))}
                    disabled={disabled}
                    className="justify-self-start text-muted-foreground hover:text-destructive"
                    aria-label={t('removePrice')}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  {t('colBs')}: <span className="font-medium text-foreground">{bs} Bs</span>
                  {KEY_PATTERN.test(key) && (
                    <span className="ml-2 break-all font-mono">
                      {ITEM_VARIABLE_SUFFIXES.map((s) => `{{${key}${s}}}`).join('  ')}
                    </span>
                  )}
                </p>
              </div>
            );
          })}
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setItems((prev) => [...prev, { uid: nextUid(), label: '', key: '', usd: '' }])
            }
            disabled={disabled}
          >
            <Plus className="mr-2 h-4 w-4" /> {t('addPrice')}
          </Button>
        </CardContent>
      </Card>

      {/* Variables reference */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Variable className="h-4 w-4 text-primary" /> {t('variablesTitle')}
          </CardTitle>
          <CardDescription>{t('variablesDesc')}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="divide-y divide-border rounded-md border border-border">
            {[
              ...builtins,
              ...(data?.items ?? []).flatMap((item) =>
                ITEM_VARIABLE_SUFFIXES.map((s) => ({
                  name: `${item.key}${s}`,
                  hint: `${item.label || item.key} · ${suffixHint[s]}`,
                })),
              ),
            ].map(({ name, hint }) => (
              <button
                key={name}
                type="button"
                onClick={() => void copyVariable(name)}
                className="flex w-full flex-wrap items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-muted/50"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <Copy className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="break-all font-mono text-foreground">{`{{${name}}}`}</span>
                  <span className="text-xs text-muted-foreground">{hint}</span>
                </span>
                <span className="font-medium text-foreground">
                  {data?.variables[name] ?? '—'}
                </span>
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Telegram alerts */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <BellRing className="h-4 w-4 text-primary" /> {t('telegramTitle')}
          </CardTitle>
          <CardDescription>{t('telegramDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <p
            className={
              data?.telegram_configured
                ? 'text-sm text-emerald-600 dark:text-emerald-400'
                : 'text-sm text-amber-600 dark:text-amber-400'
            }
          >
            {data?.telegram_configured ? t('telegramReady') : t('telegramMissing')}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={handleTestAlert}
            disabled={!canEdit || testing || !data?.telegram_configured}
          >
            {testing ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <BellRing className="mr-2 h-4 w-4" />
            )}
            {t('telegramTest')}
          </Button>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={disabled}>
          {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {t('save')}
        </Button>
      </div>
    </div>
  );
}
