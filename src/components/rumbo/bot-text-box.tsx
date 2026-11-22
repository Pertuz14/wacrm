'use client';
// Rumbo a la U — local change (see RUMBO.md, cambio 10).
// El campo del texto del bot (Agentes › Contexto del negocio y la nota de Instagram), plegable: el texto del bot tiene
// más de 120 000 caracteres y el campo del original crece con todo el contenido, así que para llegar a los ajustes
// de abajo había que recorrerlo entero. Plegado muestra un resumen (caracteres y cómo empieza); abierto, el texto se
// desplaza dentro de una caja de alto fijo. Debajo van «Subir archivo» y «Versiones anteriores» (bot-text-tools).

import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { BotTextTools } from '@/components/rumbo/bot-text-tools';
import type { BotChannel } from '@/lib/rumbo/bot-text';

// Un texto corto (o vacío) se muestra abierto, como siempre
const PLEGAR_DESDE = 600;

export function BotTextBox({
  channel,
  value,
  onChange,
  id,
  placeholder,
  disabled,
}: {
  channel: BotChannel;
  value: string;
  onChange: (text: string) => void;
  id?: string;
  placeholder?: string;
  disabled?: boolean;
}) {
  const largo = [...value].length;
  const [abierto, setAbierto] = useState(false);
  const plegado = !abierto && largo > PLEGAR_DESDE;
  const inicio = value.replace(/\s+/g, ' ').trim().slice(0, 140);

  return (
    <div className="space-y-2">
      {plegado ? (
        <button
          id={id}
          type="button"
          onClick={() => setAbierto(true)}
          aria-expanded={false}
          className="flex w-full items-start justify-between gap-3 rounded-lg border border-input px-3 py-2.5 text-left transition-colors hover:bg-muted/50 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 outline-none dark:bg-input/30"
        >
          <span className="min-w-0">
            <span className="block text-sm font-medium text-foreground">
              {largo.toLocaleString('es-VE')} caracteres
            </span>
            <span className="block truncate text-xs text-muted-foreground">{inicio}…</span>
          </span>
          <span className="flex shrink-0 items-center gap-1 text-sm font-medium text-primary">
            Ver y editar <ChevronDown className="size-4" />
          </span>
        </button>
      ) : (
        <>
          <Textarea
            id={id}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            disabled={disabled}
            rows={5}
            className={largo > PLEGAR_DESDE ? 'field-sizing-fixed h-[60vh] min-h-48 resize-y overflow-auto' : undefined}
          />
          {largo > PLEGAR_DESDE && (
            <Button type="button" variant="ghost" size="sm" onClick={() => setAbierto(false)} aria-expanded>
              <ChevronUp /> Ocultar el texto
            </Button>
          )}
        </>
      )}
      <BotTextTools channel={channel} onText={onChange} disabled={disabled} />
    </div>
  );
}
