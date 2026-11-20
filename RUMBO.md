# RUMBO.md · cambios locales de Rumbo a la U en wacrm

Este repositorio es una copia (`Pertuz14/wacrm`) del proyecto de código abierto de ArnasDon. Gabriel permitió **cambios mínimos**, solo donde la API pública no alcanza. Cada uno está aquí, con su porqué, para poder traer actualizaciones del original sin conflictos: al unir, conserve estos cambios y vuelva a correr sus pruebas (`npx vitest run src/lib/rumbo`).

Los archivos **propios** (no existen en el original, no chocan nunca) están en `src/lib/rumbo/` y `src/app/api/v1/rumbo/`. Los cambios **dentro** de archivos del original están marcados con un comentario `Rumbo (RUMBO.md)`.

> Cambios anteriores a este archivo (avisos de pago con ✅, pipelines por programa, origen de clientes, CAPI…) están en el historial de git y en la wiki del cerebro (`Rumbo/Wiki/Canales/`). Desde el 17-nov-2026 todo cambio nuevo se anota aquí.

## Cierre por WhatsApp (17-nov-2026, rama `rumbo/cierre-whatsapp`)

Manual completo: `web/simadi/docs/cierre-whatsapp.md` (en el repositorio de la plataforma).

### 1. El bot pone el enlace de pago privado en su respuesta
- **Por qué no alcanza la API:** el enlace tiene que ir en el MISMO mensaje que escribe el bot, antes de enviarse. Ni la API ni los webhooks salientes permiten cambiar una respuesta del bot.
- **Qué hace:** si la respuesta trae `{{ENLACE_PAGO}}` (y `{{ENLACE_PAGO_VENCE}}`) y una línea `[[PEDIDO|programa=…|producto=…|plan=…|area=…]]`, se pide el enlace a la plataforma (`POST {RUMBO_PLATFORM_URL}/api/crm/checkout`, con `Authorization: Bearer RUMBO_CHECKOUT_SECRET`) y se pone en el texto. Si la plataforma no responde o falta el secreto, la línea del enlace cambia por «En un momento le envío el enlace para el pago 🙏» y avisa a Telegram. El monto **no** viaja: la plataforma lo calcula con sus precios.
- **Además:** `[[ENVIAR:clave]]` pide a la plataforma que mande un corto o un audio fijo (`POST …/api/crm/medio`) después de la respuesta. La plataforma decide (lleva el tope de 1 nota de voz por conversación).
- **Archivos:** nuevo `src/lib/rumbo/checkout-link.ts` (+ prueba). En `src/lib/ai/auto-reply.ts`: 1 import, `parts` pasa por `withCheckoutLink(…)` y, después de enviar, `sendRequestedMedia(…)` (marcados).
- **Variables nuevas del CRM:** `RUMBO_CHECKOUT_SECRET` (el mismo valor que `CHECKOUT_SECRETO` de la plataforma, 32 caracteres o más). Usa la que ya existía `RUMBO_PLATFORM_URL`.

### 2. El comprobante del checkout termina en el mismo aviso de Telegram
- **Por qué no alcanza la API:** el aviso «💰 Pago por verificar» con ✅ Habilitar acceso solo se creaba al detectar el REGISTRO en el chat, y buscaba la captura en el chat. No había forma de crearlo desde afuera con una imagen.
- **Qué hace:** ruta propia `POST /api/v1/rumbo/checkout` (alcance `sales:write`, la clave que la plataforma ya usa). `payment_submitted` llama a `alertPaymentToVerify` con la captura y mueve la tarjeta a «Pago por verificar» con `syncDealForTurn` (la misma lógica del bot, sin duplicarla). `kind: 'cuota'` manda un texto y la captura sin ✅ (no es una venta nueva). `checkout_abandoned` manda un aviso discreto a Telegram.
- **Archivos:** nuevo `src/app/api/v1/rumbo/checkout/route.ts`. En `src/lib/ai/bot-alerts.ts`: `alertPaymentToVerify` acepta un 4.º parámetro opcional `receipt` y devuelve el id del aviso (antes `void`); sin `receipt` hace exactamente lo de siempre.

### 3. Notas de voz nativas e Instagram por la API
- **Por qué no alcanza la API:** `POST /api/v1/messages` mandaba el audio sin la marca `voice: true` de la Cloud API (sale como archivo, no como nota de voz verde), y solo aceptaba un teléfono (`to`), así que no llegaba a una conversación de Instagram.
- **Qué hace:** el cuerpo acepta `voice: true` (solo en `type: 'audio'`) y `conversation_id` (una conversación de la cuenta) en lugar de `to`.
- **Archivos:** `src/app/api/v1/messages/route.ts` (lee `conversation_id` y `voice`), `src/lib/whatsapp/send-message.ts` (campo `voice` en `SendMessageParams` y lo pasa a `sendMediaMessage`), `src/lib/whatsapp/meta-api.ts` (`audio.voice = true` si se pide). Nuevo `src/lib/rumbo/conversation.ts` (busca la conversación por id y cuenta) y `src/lib/rumbo/voice-note.test.ts`.

### 4. «No contactar» (17-nov-2026)
- **Por qué:** cuando la persona dice que no («mejor no», «no me escriban»), nada automático debe volver a escribirle. La plataforma
  ya lee las etiquetas del contacto por la API, pero el bot no tenía cómo poner una etiqueta libre (sus `[[ETIQUETA:…]]` solo mueven etapas).
- **Qué hace:** si la respuesta del bot trae `[[NO_CONTACTAR]]`, el contacto recibe la etiqueta «No contactar» (se crea si no existe).
  La plataforma no le manda rescates ni diagnósticos. Gabriel la puede poner o quitar a mano.
- **Archivos:** nuevo `src/lib/rumbo/after-reply.ts` (+ prueba); en `auto-reply.ts` la llamada de después de la respuesta pasa a
  `rumboAfterReply(…)` (hace lo de los medios y esto).

### 5. Instagram: la publicación del anuncio (18-nov-2026, archivos propios de Rumbo, no del original)
- **Qué pasaba:** quien escribe desde un anuncio de Instagram manda primero la publicación del anuncio (un adjunto de
  `lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=…` de un tipo que el CRM no conocía) y después la pregunta del anuncio.
  En el chat salía el enlace largo, el bot creía que era una imagen que no podía ver, y Meta a veces no manda el
  `referral` del anuncio: esas personas quedaban como «Instagram» y el bot no sabía de qué producto venían.
- **Qué hace:** `webhook-parse.ts` escribe «[Compartió una publicación de Instagram]» (sin el enlace temporal) y guarda
  el id de la publicación; `leads/source.ts` guarda esa publicación en `lead_sources.source_url` (también en la llegada
  con `referral`, aunque llegue en el mensaje siguiente) y, si alguien llega con la misma publicación sin `referral`,
  toma el anuncio de una llegada anterior. El bot recibe el contexto del anuncio como siempre (`ad-context.ts`, que
  ahora también explica la publicación compartida). Sin migración.

### 6. Burbujas con enlaces largos en la tablet (20-nov-2026, archivo del original)
- **Qué pasaba:** en la tablet (con la ficha del contacto abierta) los mensajes con el enlace de pago salían cortados a la
  izquierda y con barra de desplazamiento: el enlace es una sola «palabra» larga y ensanchaba la burbuja por encima de
  su 75 %.
- **Qué hace:** la burbuja lleva `min-w-0 max-w-full`, así el enlace se parte dentro de ella.
- **Archivo:** `src/components/inbox/message-bubble.tsx` (una clase, marcada).

### Pruebas
`npx vitest run src/lib/rumbo` (8 pruebas) y la suite completa `npm test`. `npx tsc --noEmit` sin errores.

### Para activarlo (lo hace Gabriel, en este orden)
1. Publicar el CRM con esta rama (con su «sí»).
2. Cargar `RUMBO_CHECKOUT_SECRET` en el CRM (el mismo valor que `CHECKOUT_SECRETO` en Hostinger).
3. Pegar el contexto del bot con checkout cuando la plataforma tenga `CHECKOUT_ACTIVO=si` (hecho el 18-nov; desde el 20-nov es `crm/Comportamiento AI/PEGAR_EN_CONTEXTO_DEL_NEGOCIO.txt`).
Sin esos pasos, los cambios no hacen nada: sin `{{ENLACE_PAGO}}` en la respuesta ni `[[ENVIAR:…]]`, el bot funciona igual que antes.
