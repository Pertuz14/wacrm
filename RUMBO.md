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

### 7. Negrita, cursiva y tachado como en WhatsApp (20-nov-2026)
- **Qué pasaba:** los mensajes del bot traen el formato de WhatsApp (`*negrita*`, `_cursiva_`, `~tachado~`). En el
  teléfono del cliente se ven bien, pero en la bandeja del CRM salían los asteriscos tal cual («*Resumen de su compra*»).
- **Qué hace:** la bandeja muestra el formato con las mismas reglas de WhatsApp (una marca por línea, junto a un espacio o
  a la puntuación) y nunca toca los enlaces (el enlace de pago puede tener `_` o `~`).
- **Archivos:** nuevo `src/lib/rumbo/whatsapp-format.tsx` (+ prueba). En `src/lib/inbox/linkify-text.tsx`: 1 import y el
  texto pasa por `nodosWhatsApp(text)` (marcado).

### 8. Instagram sin asteriscos (20-nov-2026)
- **Qué pasaba:** Instagram no muestra negritas y el bot no siempre quitaba los asteriscos que pide la nota de
  Instagram: llegaban tal cual («*Arquitectura* e *Ingeniería*»).
- **Qué hace:** antes de enviar un texto por Instagram (bot, bandeja y automatizaciones) se quitan las marcas de
  WhatsApp con las mismas reglas del cambio 7; los enlaces no se tocan. En la base queda el mensaje con su formato.
- **Archivos:** `textoSinFormato` en `src/lib/rumbo/whatsapp-format.tsx` (+ prueba). En `src/lib/instagram/send.ts`:
  1 import y el texto pasa por `textoSinFormato` (marcado).

### 9. Subir el texto del bot desde un archivo, con historial (22-nov-2026)
- **Por qué:** el contexto del bot (unos 120 000 caracteres) se pegaba a mano en Agentes › Contexto del negocio y en la nota
  de Instagram, sin forma de volver a la versión anterior si algo salía mal. Gabriel pidió poder subir el archivo y volver atrás.
- **Qué hace:** debajo de esos dos campos, «Subir archivo» lee el .txt en el navegador, revisa que sea el de ese canal
  (el de WhatsApp lleva `<base_conocimiento>`; la nota de Instagram no) y lo pone en el campo; se aplica con el «Guardar» de
  siempre (misma ruta y permisos del original). «Versiones anteriores» lista las últimas 30 de cada canal, con «Descargar» y
  «Usar esta». Las versiones las guarda un disparador en la base al cambiar el texto, venga de la pantalla, de la API o de
  una actualización directa (Claude sube los cambios del bot así).
- **Archivos propios:** `src/lib/rumbo/bot-text.ts` (+ prueba), `src/components/rumbo/bot-text-tools.tsx`,
  `src/app/api/rumbo/bot-versions/route.ts` (solo lectura, sesión y cuenta de quien pregunta).
  En `src/components/settings/ai-config.tsx` e `instagram-config.tsx`: 1 import y 1 línea cada uno (marcados).
- **Migración:** `supabase/migrations/076_rumbo_bot_versions.sql` (tabla `rumbo_bot_versions` con RLS de solo lectura para
  miembros, función y disparadores `rumbo_*`, y `redeem_invitation` de la 075 con la tabla nueva en su lista). Aplicada el 22-nov.
  Al traer cambios del original que redefinan `redeem_invitation`, conservar las líneas de `capi_events` y `rumbo_bot_versions`.

### 10. El campo del texto del bot, plegable (22-nov-2026)
- **Qué pasaba:** el campo del original crece con todo su contenido (`field-sizing-content`) y el texto del bot pasa de
  120 000 caracteres: para llegar a los ajustes de abajo había que recorrerlo entero.
- **Qué hace:** con más de 600 caracteres, el campo sale plegado: un resumen (cuántos caracteres y cómo empieza) con
  «Ver y editar»; abierto, el texto se desplaza dentro de una caja de 60 % de la pantalla y se puede volver a ocultar.
  Un texto corto o vacío se ve como siempre. Mismos datos y mismo «Guardar».
- **Archivos:** nuevo `src/components/rumbo/bot-text-box.tsx` (incluye las herramientas del cambio 9). En
  `ai-config.tsx` el `<Textarea id="ai-prompt">` pasa a `<BotTextBox>` (y se quitó su import, que quedó sin uso); en
  `instagram-config.tsx` el `<Textarea>` de la nota de la IA pasa a `<BotTextBox>` (marcados). Al traer cambios del
  original en esas dos pantallas, conservar `<BotTextBox>` en lugar del `<Textarea>`.

### 11. La estrellita (borrador con IA) y el enlace que el bot olvidó (22-nov-2026)
- **Qué pasaba:** (1) la estrellita ✨ daba «OpenAI-compatible provider API error (400)» cuando lo último del chat era
  nuestro (del bot o de un agente): el historial terminaba en un turno del asistente y los modelos Claude no lo aceptan.
  (2) Aunque funcionara, el borrador nunca creaba el enlace de pago (solo lo hacía el bot automático). (3) En Instagram el
  bot respondió «Le preparo su enlace…» con la línea `[[PEDIDO|…]]` pero sin `{{ENLACE_PAGO}}`, y el enlace no se creó.
- **Qué hace:** (1) si el historial termina en un mensaje nuestro, el borrador agrega una nota interna para que la IA siga
  donde quedó (`transcriptForDraft`); (2) el borrador pasa por el mismo `withCheckoutLink` que el bot (`draftWithLink`):
  si trae el enlace, se crea en la plataforma y llega listo al compositor; (3) red de seguridad en `withCheckoutLink`
  (`ensureLinkSlot`): una respuesta con pedido y sin el espacio del enlace recibe al final un mensaje con el enlace.
- **Archivos:** nuevo `src/lib/rumbo/borrador.ts` (+ prueba); `src/lib/rumbo/checkout-link.ts` (+ prueba). En
  `src/app/api/ai/draft/route.ts` (del original): 1 import y 2 líneas marcadas (el historial y el texto del borrador).
  Al traer cambios del original en esa ruta, conservar `transcriptForDraft(messages)` y `draftWithLink(...)`.

### 12. Instagram: un mensaje largo ya no aparece dos veces en la bandeja (22-nov-2026)
- **Qué pasaba:** Instagram acepta hasta 1000 caracteres; un mensaje más largo sale en varias partes y la fila guarda solo
  el id de la última. Los ecos de las partes anteriores no se reconocían y la bandeja los mostraba como mensajes nuevos
  (el enlace de pago de una clienta apareció dos veces, una sin negritas). La clienta siempre lo recibió una sola vez.
- **Qué hace:** antes de guardar un eco, se mira si es una de las partes (partidas igual que al enviar, sin las marcas de
  WhatsApp) de un mensaje nuestro de los últimos 3 minutos en esa conversación; si lo es, no se guarda. Un mensaje
  escrito desde la app de Instagram nunca se esconde: solo cuentan las partes exactas de un mensaje que se partió.
- **Archivos:** nuevo `src/lib/rumbo/instagram-echo.ts` (+ prueba). En `src/app/api/instagram/webhook/route.ts`: 1 import
  y 1 línea en el bloque del eco (marcado).

### 13. El enlace de pago lleva el colegio aliado (23-nov-2026, archivo propio)
- **Por qué:** desde el 23-nov, en el plan A la familia que llega con el enlace de un colegio paga 10 % menos. El enlace de pago lo calcula la plataforma, que no ve el chat; el código del colegio viaja invisible en los primeros mensajes de la persona.
- **Qué hace:** al crear el enlace de pago, `withCheckoutLink` lee ese código con `conversationSchoolRef` (ya existía en `src/lib/leads/school-ref.ts`) y lo manda como `colegio`. La plataforma lo valida, cobra con el 10 % y atribuye la venta al colegio. Si no hay código, se manda lo mismo de siempre.
- **Archivos:** `src/lib/rumbo/checkout-link.ts` (+ prueba en `checkout-link.test.ts`). Sin migración.

### 14. Stickers de Instagram marcados como «[Sticker]» (25-nov-2026)
- **Qué pasaba:** un sticker de Instagram llegaba al bot como «el cliente envió una imagen» y, después del enlace de pago,
  el bot lo tomó por un comprobante (pidió el registro y salió el aviso «Pago por verificar» en Telegram).
- **Qué hace:** si Meta marca el adjunto como sticker o GIF (`type` `sticker` o `animated_image`, o `payload.sticker_id`),
  el mensaje lleva el texto «[Sticker]»: lo ve la bandeja y lo ve el bot, que tiene la regla de no tratarlo como pago.
  Sigue siendo una imagen en la bandeja. El arreglo de fondo está en el prompt (después del enlace, una imagen no es un pago).
- **Archivos:** nuevo `src/lib/rumbo/instagram-sticker.ts` (+ prueba). En `src/lib/instagram/webhook-parse.ts`: 1 import y
  1 línea (la etiqueta del adjunto, marcada).

### Pruebas
`npx vitest run src/lib/rumbo` (27 pruebas) y la suite completa `npm test`. `npx tsc --noEmit` sin errores.

### Para activarlo (lo hace Gabriel, en este orden)
1. Publicar el CRM con esta rama (con su «sí»).
2. Cargar `RUMBO_CHECKOUT_SECRET` en el CRM (el mismo valor que `CHECKOUT_SECRETO` en Hostinger).
3. Pegar el contexto del bot con checkout cuando la plataforma tenga `CHECKOUT_ACTIVO=si` (hecho el 18-nov; desde el 20-nov es `crm/Comportamiento AI/PEGAR_EN_CONTEXTO_DEL_NEGOCIO.txt`).
Sin esos pasos, los cambios no hacen nada: sin `{{ENLACE_PAGO}}` en la respuesta ni `[[ENVIAR:…]]`, el bot funciona igual que antes.
