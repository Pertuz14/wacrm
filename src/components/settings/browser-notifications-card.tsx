'use client';

import { useState, useSyncExternalStore } from 'react';
import { Bell, BellRing, CircleAlert, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { useBrowserNotifyPref } from '@/hooks/use-browser-notifications';
import {
  disablePush,
  enablePush,
  isPushActive,
  isPushSupported,
  needsHomeScreenInstall,
  showTestThroughWorker,
  type PushResult,
} from '@/lib/notifications/push-client';
import {
  BROWSER_NOTIFY_CHANGE_EVENT,
  getNotificationPermission,
  writeBrowserNotifyPref,
  type BrowserNotifyPermission,
} from '@/lib/notifications/browser-notify';

// `Notification.permission` has no change event of its own. Re-read it
// whenever the tab regains focus (the user may have flipped the site
// setting in the browser UI) and whenever our own preference changes
// (right after requestPermission resolves).
function subscribePermission(onChange: () => void): () => void {
  window.addEventListener('focus', onChange);
  document.addEventListener('visibilitychange', onChange);
  window.addEventListener(BROWSER_NOTIFY_CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener('focus', onChange);
    document.removeEventListener('visibilitychange', onChange);
    window.removeEventListener(BROWSER_NOTIFY_CHANGE_EVENT, onChange);
  };
}

const serverPermission = (): BrowserNotifyPermission => 'unsupported';

/**
 * "Browser notifications" card — device-scoped opt-in for desktop
 * alerts about new customer messages (issue #516). Persistence is
 * localStorage; the browser's own permission grant is the real gate,
 * so the switch reads as off whenever that grant is missing.
 */
export function BrowserNotificationsCard({ className }: { className?: string }) {
  const t = useTranslations('Settings.browserNotifications');
  const enabled = useBrowserNotifyPref();
  const permission = useSyncExternalStore(
    subscribePermission,
    getNotificationPermission,
    serverPermission,
  );
  const [requesting, setRequesting] = useState(false);
  const [pushState, setPushState] = useState<PushResult | null>(null);
  const iosNeedsInstall = useSyncExternalStore(
    () => () => {},
    needsHomeScreenInstall,
    () => false,
  );

  // Turns on push for this device and reports the outcome.
  const turnOnPush = async () => {
    if (!isPushSupported()) {
      setPushState('unsupported');
      return;
    }
    const result = await enablePush();
    setPushState(result);
    if (result === 'not-configured') toast.message(t('pushNotConfigured'));
    else if (result === 'error') toast.error(t('pushError'));
  };

  const supported = permission !== 'unsupported';
  const checked = enabled && permission === 'granted';

  const onToggle = async (next: boolean) => {
    if (!next) {
      writeBrowserNotifyPref(false);
      await disablePush();
      setPushState(null);
      return;
    }
    if (permission === 'granted') {
      writeBrowserNotifyPref(true);
      await turnOnPush();
      return;
    }
    if (permission === 'denied') {
      toast.error(t('statusDenied'), { description: t('deniedHint') });
      return;
    }
    setRequesting(true);
    try {
      const result = await Notification.requestPermission();
      // Also dispatches the change event, which refreshes `permission`.
      writeBrowserNotifyPref(result === 'granted');
      if (result === 'granted') await turnOnPush();
      if (result === 'denied') {
        toast.error(t('permissionDeniedToast'), { description: t('deniedHint') });
      }
    } finally {
      setRequesting(false);
    }
  };

  const sendTest = async () => {
    // Through the service worker when available — Android can't show a
    // notification any other way.
    if (await showTestThroughWorker(t('testTitle'), t('testBody'))) return;
    try {
      new Notification(t('testTitle'), {
        body: t('testBody'),
        icon: '/icon',
        tag: 'wacrm-test-notification',
      });
    } catch {
      toast.error(t('unsupported'));
    }
  };

  const statusKey =
    permission === 'granted'
      ? 'statusGranted'
      : permission === 'denied'
        ? 'statusDenied'
        : 'statusDefault';

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <Bell className="size-4 text-muted-foreground" />
          {t('title')}
        </CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {iosNeedsInstall && (
          <p className="flex items-start gap-2 rounded-md border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-xs text-sky-700 dark:text-sky-300">
            <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
            <span>{t('iosInstallHint')}</span>
          </p>
        )}
        {!supported ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <CircleAlert className="size-4 shrink-0" />
            {t('unsupported')}
          </p>
        ) : (
          <>
            <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">
                  {t('toggleLabel')}
                </p>
                <p className="text-xs text-muted-foreground">{t('toggleDesc')}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {requesting && (
                  <Loader2 className="size-4 animate-spin text-muted-foreground" />
                )}
                <Switch
                  checked={checked}
                  onCheckedChange={(next) => void onToggle(next)}
                  disabled={requesting || permission === 'denied'}
                  aria-label={t('toggleLabel')}
                />
              </div>
            </div>

            <p className="text-xs text-muted-foreground">{t(statusKey)}</p>
            {checked && (
              <p className="text-xs text-muted-foreground">
                {pushState === 'ok' || (pushState === null && isPushActive())
                  ? t('pushActive')
                  : pushState === 'not-configured'
                    ? t('pushNotConfigured')
                    : pushState === 'unsupported'
                      ? t('pushUnsupported')
                      : pushState === 'error'
                        ? t('pushError')
                        : t('pushTabOnly')}
              </p>
            )}

            {permission === 'denied' && (
              <p className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
                <span>{t('deniedHint')}</span>
              </p>
            )}

            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void sendTest()}
              disabled={!checked}
            >
              <BellRing className="size-4" />
              {t('sendTest')}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
