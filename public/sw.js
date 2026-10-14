/* wacrm service worker — Web Push notifications for new customer messages.
 * Shows the alert even when the app is closed (PC, Android, and iPhone/iPad
 * when the app is installed on the home screen). Tapping it opens the chat. */

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

const IOS = /iPhone|iPad|iPod/.test(self.navigator.userAgent)

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = { body: event.data ? event.data.text() : '' }
  }

  event.waitUntil(
    (async () => {
      // Already looking at this very chat in a focused window? Skip the
      // alert (the thread itself shows the message). iOS always needs a
      // visible notification for every push, so it never skips.
      if (!IOS && data.conversationId) {
        const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
        const viewing = windows.some((w) => {
          try {
            const url = new URL(w.url)
            return w.focused && url.pathname.startsWith('/inbox') && url.searchParams.get('c') === data.conversationId
          } catch {
            return false
          }
        })
        if (viewing) return
      }

      await self.registration.showNotification(data.title || 'Nuevo mensaje', {
        body: data.body || '',
        tag: data.tag || 'wacrm',
        renotify: true,
        icon: '/icons/icon-192.png',
        badge: '/icons/badge-96.png',
        data: { url: data.url || '/inbox' },
      })
    })(),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = new URL((event.notification.data && event.notification.data.url) || '/inbox', self.location.origin).href

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin)
      if (open) {
        await open.focus()
        if ('navigate' in open) await open.navigate(target).catch(() => {})
        return
      }
      await self.clients.openWindow(target)
    })(),
  )
})
