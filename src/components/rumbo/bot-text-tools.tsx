'use client';
// Rumbo a la U — local change (see RUMBO.md, cambio 9).
// Debajo del texto del bot (Agentes › Contexto del negocio, y la nota de Instagram):
//  - «Subir archivo»: lee el .txt en el navegador, revisa que sea el de ese canal y lo pone en el campo
//    (se aplica con el botón «Guardar» de siempre, por la misma ruta del original).
//  - «Versiones anteriores»: las que guarda el disparador de la migración 076; se pueden descargar o volver a cargar.

import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { Download, History, Loader2, RotateCcw, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { checkBotText, normalizeBotText, type BotChannel } from '@/lib/rumbo/bot-text';

type Version = { id: string; created_at: string; length: number };

const when = (iso: string) =>
  new Date(iso).toLocaleString('es-VE', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

async function fetchVersion(id: string): Promise<{ content: string; channel: string; created_at: string }> {
  const r = await fetch(`/api/rumbo/bot-versions?id=${encodeURIComponent(id)}`);
  if (!r.ok) throw new Error('No se pudo leer esa versión.');
  return r.json();
}

export function BotTextTools({
  channel,
  onText,
  disabled,
}: {
  channel: BotChannel;
  onText: (text: string) => void;
  disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const text = normalizeBotText(await file.text());
    const problem = checkBotText(channel, text);
    if (problem) {
      toast.error(problem);
      return;
    }
    onText(text);
    toast.success(`«${file.name}» cargado (${[...text].length.toLocaleString('es-VE')} caracteres). Toque «Guardar» para aplicarlo.`);
  }

  async function toggleVersions() {
    const next = !open;
    setOpen(next);
    if (!next) { setVersions(null); return; }   // al volver a abrir se leen de nuevo (incluye lo recién guardado)
    setBusy('list');
    try {
      const r = await fetch(`/api/rumbo/bot-versions?channel=${channel}`);
      if (!r.ok) throw new Error();
      setVersions((await r.json()).versions ?? []);
    } catch {
      toast.error('No se pudieron cargar las versiones anteriores.');
      setOpen(false);
    } finally {
      setBusy(null);
    }
  }

  async function loadVersion(v: Version) {
    setBusy(v.id);
    try {
      onText((await fetchVersion(v.id)).content);
      toast.success(`Versión del ${when(v.created_at)} cargada. Toque «Guardar» para volver a ella.`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function download(v: Version) {
    setBusy(`d-${v.id}`);
    try {
      const { content } = await fetchVersion(v.id);
      const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `bot-${channel}-${v.created_at.slice(0, 10)}.txt`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <input ref={input} type="file" accept=".txt,.md,text/plain,text/markdown" className="hidden" onChange={onFile} />
        <Button type="button" variant="outline" size="sm" onClick={() => input.current?.click()} disabled={disabled}>
          <Upload /> Subir archivo
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={toggleVersions} aria-expanded={open}>
          {busy === 'list' ? <Loader2 className="animate-spin" /> : <History />} Versiones anteriores
        </Button>
      </div>
      {open && versions && (
        versions.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Todavía no hay versiones: se guardan solas desde ahora, cada vez que el texto cambia.
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {versions.map((v) => (
              <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                <span>
                  {when(v.created_at)}
                  <span className="text-muted-foreground"> · {v.length.toLocaleString('es-VE')} caracteres</span>
                </span>
                <span className="flex gap-1">
                  <Button type="button" variant="ghost" size="sm" onClick={() => download(v)} disabled={busy !== null}>
                    {busy === `d-${v.id}` ? <Loader2 className="animate-spin" /> : <Download />} Descargar
                  </Button>
                  <Button type="button" variant="outline" size="sm" onClick={() => loadVersion(v)} disabled={disabled || busy !== null}>
                    {busy === v.id ? <Loader2 className="animate-spin" /> : <RotateCcw />} Usar esta
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )
      )}
    </div>
  );
}
