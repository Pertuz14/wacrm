'use client'

/**
 * Browser side of Web Push: registers /sw.js, subscribes this device and
 * hands the subscription to /api/push/subscription. Once a device has push,
 * the service worker shows every alert — even with the app closed — so the
 * in-tab notifications stand down to avoid duplicates.
 */

const ACTIVE_KEY = 'wacrm:push-active'

export type PushResult = 'ok' | 'unsupported' | 'not-configured' | 'denied' | 'error'

export function isPushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  )
}

/** iPhone/iPad Safari outside the installed app: push needs "Add to Home Screen". */
export function needsHomeScreenInstall(): boolean {
  if (typeof window === 'undefined') return false
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  const standalone =
    window.matchMedia?.('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  return ios && !standalone
}

export function isPushActive(): boolean {
  try {
    return window.localStorage.getItem(ACTIVE_KEY) === '1'
  } catch {
    return false
  }
}

function setPushActive(active: boolean): void {
  try {
    if (active) window.localStorage.setItem(ACTIVE_KEY, '1')
    else window.localStorage.removeItem(ACTIVE_KEY)
  } catch {
    /* private mode — non-fatal */
  }
}

function base64UrlToBytes(base64Url: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4)
  const raw = atob((base64Url + padding).replace(/-/g, '+').replace(/_/g, '/'))
  const bytes = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes
}

function sameKey(a: ArrayBuffer | null, b: Uint8Array): boolean {
  if (!a) return false
  const x = new Uint8Array(a)
  return x.length === b.length && x.every((v, i) => v === b[i])
}

async function registration(): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register('/sw.js', { scope: '/' })
  return navigator.serviceWorker.ready
}

/** Subscribe this device (idempotent: refreshes an existing subscription). */
export async function enablePush(): Promise<PushResult> {
  if (!isPushSupported()) return 'unsupported'
  if (Notification.permission !== 'granted') return 'denied'
  try {
    const res = await fetch('/api/push/subscription', { cache: 'no-store' })
    if (!res.ok) return 'error'
    const { publicKey } = (await res.json()) as { publicKey: string | null }
    if (!publicKey) {
      setPushActive(false)
      return 'not-configured'
    }
    const key = base64UrlToBytes(publicKey)
    const reg = await registration()
    let sub = await reg.pushManager.getSubscription()
    if (sub && !sameKey(sub.options.applicationServerKey, key)) {
      await sub.unsubscribe()
      sub = null
    }
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
    const saved = await fetch('/api/push/subscription', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sub.toJSON()),
    })
    if (!saved.ok) return 'error'
    setPushActive(true)
    return 'ok'
  } catch (err) {
    console.error('[push] enable failed:', err)
    return 'error'
  }
}

/** Unsubscribe this device. */
export async function disablePush(): Promise<void> {
  setPushActive(false)
  if (!isPushSupported()) return
  try {
    const reg = await navigator.serviceWorker.getRegistration('/')
    const sub = await reg?.pushManager.getSubscription()
    if (!sub) return
    await fetch('/api/push/subscription', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    }).catch(() => {})
    await sub.unsubscribe()
  } catch (err) {
    console.error('[push] disable failed:', err)
  }
}

/** Local test alert through the service worker (works on Android too). */
export async function showTestThroughWorker(title: string, body: string): Promise<boolean> {
  if (!isPushSupported()) return false
  try {
    const reg = await registration()
    await reg.showNotification(title, {
      body,
      tag: 'wacrm-test-notification',
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-96.png',
    })
    return true
  } catch {
    return false
  }
}
