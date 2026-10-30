"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Loader2, Search } from "lucide-react";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { contactSearchFilter } from "@/lib/contacts/search-filter";
import { CONTACT_PICKER_LIMIT, withSelectedContact } from "@/lib/contacts/contact-picker";
import { cn } from "@/lib/utils";
import type { Contact, PipelineStage } from "@/types";

type Filter = "all" | "free" | "inPipeline";

/** How many recent chats / pipeline members are listed before typing. */
const RECENT_LIMIT = 40;

/**
 * Contact picker for a deal. Before typing it lists the people who wrote
 * most recently (the ones you usually want to add); typing searches by
 * name or phone. Every row shows whether that contact already has a card
 * in this pipeline, and in which stage, and a filter narrows the list to
 * contacts with or without a card here. Loads at most a few dozen rows at
 * a time, however many contacts the account has.
 */
export function DealContactPicker({
  accountId,
  pipelineId,
  stages,
  value,
  selected,
  onChange,
  isNewDeal,
}: {
  accountId: string | null;
  pipelineId: string;
  stages: PipelineStage[];
  value: string;
  selected: Contact | null;
  onChange: (contact: Contact) => void;
  isNewDeal: boolean;
}) {
  const t = useTranslations("Pipelines.form");
  const supabase = useMemo(() => createClient(), []);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [results, setResults] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  /** contact id → stage id of its newest card in this pipeline */
  const [membership, setMembership] = useState<Map<string, string>>(new Map());
  const seq = useRef(0);

  const stageById = useMemo(() => new Map(stages.map((s) => [s.id, s])), [stages]);

  // Who already has a card in this pipeline (ids only — cheap).
  useEffect(() => {
    if (!accountId || !pipelineId) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("deals")
        .select("contact_id, stage_id, created_at")
        .eq("account_id", accountId)
        .eq("pipeline_id", pipelineId)
        .not("contact_id", "is", null)
        .order("created_at", { ascending: false })
        .limit(5000);
      if (cancelled) return;
      const map = new Map<string, string>();
      for (const d of (data ?? []) as { contact_id: string; stage_id: string }[]) {
        if (!map.has(d.contact_id)) map.set(d.contact_id, d.stage_id);
      }
      setMembership(map);
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId, pipelineId, supabase]);

  // The list: recent chats (or pipeline members) before typing, a search after.
  useEffect(() => {
    if (!accountId) return;
    const mine = ++seq.current;
    const timer = setTimeout(
      async () => {
        setLoading(true);
        let list: Contact[] = [];
        if (search.trim()) {
          let query = supabase
            .from("contacts")
            .select("*")
            .eq("account_id", accountId)
            .order("name")
            .limit(CONTACT_PICKER_LIMIT);
          const or = contactSearchFilter(search);
          if (or) query = query.or(or);
          const { data } = await query;
          list = (data ?? []) as Contact[];
        } else if (filter === "inPipeline") {
          const ids = [...membership.keys()].slice(0, RECENT_LIMIT);
          if (ids.length > 0) {
            const { data } = await supabase.from("contacts").select("*").in("id", ids);
            const byId = new Map(((data ?? []) as Contact[]).map((c) => [c.id, c]));
            list = ids.map((id) => byId.get(id)).filter((c): c is Contact => Boolean(c));
          }
        } else {
          const { data } = await supabase
            .from("conversations")
            .select("contact_id, last_message_at, contact:contacts(*)")
            .eq("account_id", accountId)
            .order("last_message_at", { ascending: false, nullsFirst: false })
            .limit(RECENT_LIMIT * 2);
          const seen = new Set<string>();
          for (const row of (data ?? []) as unknown as { contact: Contact | null }[]) {
            const c = row.contact;
            if (c && !seen.has(c.id)) {
              seen.add(c.id);
              list.push(c);
            }
          }
        }
        if (mine !== seq.current) return;
        setResults(list);
        setLoading(false);
      },
      search.trim() ? 250 : 0,
    );
    return () => clearTimeout(timer);
  }, [accountId, search, filter, membership, supabase]);

  const shown = withSelectedContact(
    results.filter((c) =>
      filter === "free" ? !membership.has(c.id) : filter === "inPipeline" ? membership.has(c.id) : true,
    ),
    selected && selected.id === value ? selected : null,
  ).slice(0, RECENT_LIMIT + 10);

  const selectedStage = value ? stageById.get(membership.get(value) ?? "") : undefined;

  const FILTERS: { id: Filter; label: string }[] = [
    { id: "all", label: t("pickerAll") },
    { id: "free", label: t("pickerNoCard") },
    { id: "inPipeline", label: t("pickerInPipeline") },
  ];

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("searchContacts")}
          aria-label={t("searchContacts")}
          className="h-9 w-full rounded-lg border border-border bg-muted pl-8 pr-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
        />
      </div>

      <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("pickerFilter")}>
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            aria-pressed={filter === f.id}
            onClick={() => setFilter(f.id)}
            className={cn(
              "min-h-8 rounded-full border px-3 text-xs transition-colors",
              filter === f.id
                ? "border-primary bg-primary/10 font-medium text-primary"
                : "border-border text-muted-foreground hover:bg-muted",
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      <p className="px-0.5 text-[11px] text-muted-foreground">
        {search.trim() ? t("pickerResults") : filter === "inPipeline" ? t("pickerMembers") : t("pickerRecent")}
      </p>

      <div
        role="listbox"
        aria-label={t("contact")}
        className="max-h-60 overflow-y-auto rounded-lg border border-border bg-muted/40"
      >
        {loading && shown.length === 0 ? (
          <div className="flex justify-center py-4">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : shown.length === 0 ? (
          <p className="px-3 py-4 text-center text-xs text-muted-foreground">{t("pickerEmpty")}</p>
        ) : (
          shown.map((c) => {
            const stage = stageById.get(membership.get(c.id) ?? "");
            const isSelected = c.id === value;
            return (
              <button
                key={c.id}
                type="button"
                role="option"
                aria-selected={isSelected}
                onClick={() => onChange(c)}
                className={cn(
                  "flex min-h-11 w-full items-center gap-2.5 border-b border-border/50 px-3 py-1.5 text-left last:border-b-0 hover:bg-muted",
                  isSelected && "bg-primary/10",
                )}
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-foreground">
                  {(c.name || c.phone || "?").charAt(0).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-foreground">{c.name || c.phone}</span>
                  {c.name && c.phone ? (
                    <span className="block truncate text-[11px] text-muted-foreground">+{c.phone.replace(/^\+/, "")}</span>
                  ) : null}
                </span>
                {stage ? (
                  <span
                    className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium"
                    style={{ backgroundColor: `${stage.color}20`, color: stage.color }}
                  >
                    {stage.name}
                  </span>
                ) : null}
                {isSelected ? <Check className="h-4 w-4 shrink-0 text-primary" /> : null}
              </button>
            );
          })
        )}
      </div>

      {isNewDeal && selectedStage ? (
        <p className="rounded-md bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-700 dark:text-amber-300">
          {t("pickerAlreadyHere", { stage: selectedStage.name })}
        </p>
      ) : null}
    </div>
  );
}
