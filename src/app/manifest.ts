import type { MetadataRoute } from 'next'

// Makes the CRM installable ("Add to home screen"). On iPhone/iPad this is
// required for notifications: iOS only delivers Web Push to web apps opened
// from the home screen.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'CRM WhatsApp',
    short_name: 'CRM',
    description: 'Bandeja de WhatsApp, contactos y ventas',
    start_url: '/inbox',
    scope: '/',
    display: 'standalone',
    background_color: '#020617',
    theme_color: '#020617',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}
