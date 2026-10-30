"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";

interface StageOption {
  id: string;
  name: string;
  color: string;
}

interface PipelineRow {
  id: string;
  name: string;
  stages: StageOption[];
  /** Stage of the contact's newest card in this pipeline, or "" for none. */
  current: string;
  value: number;
  currency: string | null;
  won: boolean;
}

/**
 * One picker per pipeline showing where the contact's card sits. Picking
 * a stage moves the card there (creating it if needed); "No card" takes
 * the contact out of that pipeline. Goes through the DB function
 * set_contact_pipeline_stage (migration 057), which also keeps the
 * contact's stage tags in sync.
 */
export function ContactPipelineStages({
  contactId,
  onChanged,
  compact = false,
}: {
  contactId: string;
  onChanged?: () => void;
  compact?: boolean;
}) {
  const t = useTranslations("Inbox.sidebar");
  const { accountId } = useAuth();
  const [rows, setRows] = useState<PipelineRow[] | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!accountId) return;
    const supabase = createClient();
    const [{ data: pipelines }, { data: deals }] = await Promise.all([
      supabase
        .from("pipelines")
        .select("id, name, pipeline_stages(id, name, color, position)")
        .eq("account_id", accountId)
        .order("created_at", { ascending: true }),
      supabase
        .from("deals")
        .select("pipeline_id, stage_id, status, value, currency, created_at")
        .eq("contact_id", contactId)
        .order("created_at", { ascending: false }),
    ]);
    type P = { id: string; name: string; pipeline_stages: (StageOption & { position: number })[] | null };
    type D = { pipeline_id: string; stage_id: string; status: string; value: number; currency: string | null };
    const dealList = (deals ?? []) as D[];
    setRows(
      ((pipelines ?? []) as P[]).map((p) => {
        const deal = dealList.find((d) => d.pipeline_id === p.id); // newest first
        return {
          id: p.id,
          name: p.name,
          stages: [...(p.pipeline_stages ?? [])].sort((a, b) => a.position - b.position),
          current: deal?.stage_id ?? "",
          value: Number(deal?.value) || 0,
          currency: deal?.currency ?? null,
          won: deal?.status === "won",
        };
      }),
    );
  }, [accountId, contactId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  async function change(pipelineId: string, stageId: string) {
    setSavingId(pipelineId);
    const supabase = createClient();
    const { data, error } = await supabase.rpc("set_contact_pipeline_stage", {
      p_contact: contactId,
      p_pipeline: pipelineId,
      p_stage: stageId || null,
    });
    setSavingId(null);
    if (error) {
      console.error("[pipeline stage] update failed:", error);
      toast.error(t("stageFailed"));
    } else if (data === false) {
      toast.error(t("wonKept"));
    } else {
      toast.success(t("stageUpdated"));
    }
    await load();
    onChanged?.();
  }

  if (!rows) {
    return <Loader2 className="mx-1 my-2 h-4 w-4 animate-spin text-muted-foreground" />;
  }
  if (rows.length === 0) {
    return <p className="px-1 text-xs text-muted-foreground">{t("noPipelines")}</p>;
  }

  return (
    <div className={compact ? "space-y-2" : "space-y-3"}>
      {rows.map((row) => {
        const stage = row.stages.find((s) => s.id === row.current);
        return (
          <label key={row.id} className="block">
            <span className="flex items-center justify-between px-1 text-xs font-medium text-foreground">
              {row.name}
              {row.value > 0 ? (
                <span className="text-[11px] font-normal text-muted-foreground">
                  {row.currency ?? "$"} {row.value.toLocaleString()}
                </span>
              ) : null}
            </span>
            <span className="relative mt-1 flex items-center">
              <span
                aria-hidden
                className="pointer-events-none absolute left-2.5 h-2 w-2 rounded-full"
                style={{ backgroundColor: stage?.color ?? "transparent", border: stage ? "none" : "1px solid currentColor" }}
              />
              <select
                value={row.current}
                disabled={savingId === row.id}
                onChange={(e) => change(row.id, e.target.value)}
                aria-label={t("stageIn", { pipeline: row.name })}
                className="h-9 w-full rounded-lg border border-border bg-muted pl-6 pr-2 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary disabled:opacity-60"
              >
                <option value="">{t("noCard")}</option>
                {row.stages.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              {savingId === row.id ? (
                <Loader2 className="absolute right-7 h-3.5 w-3.5 animate-spin text-muted-foreground" />
              ) : null}
            </span>
          </label>
        );
      })}
    </div>
  );
}
