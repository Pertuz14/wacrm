'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Pencil, Plus, Tag as TagIcon, Trash2 } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { fetchAccountTags } from '@/lib/settings/account-catalog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { useTranslations } from 'next-intl';
import type { Tag } from '@/types';

const PRESET_COLORS = [
  { name: 'red', value: '#ef4444' },
  { name: 'orange', value: '#f97316' },
  { name: 'amber', value: '#f59e0b' },
  { name: 'emerald', value: '#10b981' },
  { name: 'cyan', value: '#06b6d4' },
  { name: 'blue', value: '#3b82f6' },
  { name: 'violet', value: '#8b5cf6' },
  { name: 'pink', value: '#ec4899' },
];

type TagKind = 'manual' | 'stage' | 'origin';

const kindOf = (tag: Tag): TagKind =>
  tag.pipeline_stage_id ? 'stage' : tag.lead_source ? 'origin' : 'manual';

/**
 * Tags card — colour-coded contact labels, grouped into the owner's own
 * tags and the automatic ones (one per pipeline stage, migration 053; one
 * per lead origin, 055/056). Clicking a tag opens an editor for its name
 * and colour, with delete; creation is an inline row.
 */
export function TagManager() {
  const t = useTranslations('Settings.tagsAndFields');
  const supabase = createClient();
  const { user, accountId, loading: authLoading } = useAuth();

  const [loading, setLoading] = useState(true);
  const [tags, setTags] = useState<Tag[]>([]);
  const [saving, setSaving] = useState(false);
  const [newTagName, setNewTagName] = useState('');
  const [selectedColor, setSelectedColor] = useState(PRESET_COLORS[3].value);

  // Editor
  const [editing, setEditing] = useState<Tag | null>(null);
  const [editName, setEditName] = useState('');
  const [editColor, setEditColor] = useState('');
  const [updating, setUpdating] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (authLoading || !user || !accountId) return;
    fetchTags(accountId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, user?.id, accountId]);

  async function fetchTags(account: string) {
    try {
      setLoading(true);
      // By account, not by user: automatic tags are created under the
      // pipeline owner, and every member shares the account's tags.
      setTags(await fetchAccountTags(supabase, account));
    } catch (err) {
      console.error('Failed to fetch tags:', err);
      toast.error(t('failedToLoadTags'));
    } finally {
      setLoading(false);
    }
  }

  async function handleCreate() {
    if (!newTagName.trim()) {
      toast.error(t('nameRequired'));
      return;
    }

    try {
      setSaving(true);
      if (!user || !accountId) {
        toast.error(t('notAuthenticated'));
        return;
      }

      // account_id is mandatory on every account-scoped insert (NOT
      // NULL + RLS, no DB default).
      const { error } = await supabase.from('tags').insert({
        user_id: user.id,
        account_id: accountId,
        name: newTagName.trim(),
        color: selectedColor,
      });

      if (error) throw error;

      toast.success(t('tagCreated'));
      setNewTagName('');
      setSelectedColor(PRESET_COLORS[3].value);
      await fetchTags(accountId);
    } catch (err) {
      console.error('Create error:', err);
      toast.error(t('failedToCreateTag'));
    } finally {
      setSaving(false);
    }
  }

  function openEditor(tag: Tag) {
    setEditing(tag);
    setEditName(tag.name);
    setEditColor(tag.color);
    setConfirmingDelete(false);
  }

  async function handleUpdate() {
    if (!editing) return;
    const name = editName.trim();
    if (!name) {
      toast.error(t('nameRequired'));
      return;
    }
    try {
      setUpdating(true);
      const { error } = await supabase
        .from('tags')
        .update({ name, color: editColor })
        .eq('id', editing.id);
      if (error) throw error;
      setTags((prev) => prev.map((x) => (x.id === editing.id ? { ...x, name, color: editColor } : x)));
      toast.success(t('tagUpdated'));
      setEditing(null);
    } catch (err) {
      console.error('Update error:', err);
      toast.error(t('failedToUpdateTag'));
    } finally {
      setUpdating(false);
    }
  }

  async function handleDelete() {
    if (!editing) return;

    try {
      setDeleting(true);
      const { error } = await supabase
        .from('tags')
        .delete()
        .eq('id', editing.id);

      if (error) throw error;

      toast.success(t('tagDeleted'));
      setTags((prev) => prev.filter((x) => x.id !== editing.id));
      setEditing(null);
    } catch (err) {
      console.error('Delete error:', err);
      toast.error(t('failedToDeleteTag'));
    } finally {
      setDeleting(false);
    }
  }

  const groups: { kind: TagKind; title: string; hint: string | null }[] = [
    { kind: 'manual', title: t('groupManual'), hint: null },
    { kind: 'stage', title: t('groupStage'), hint: t('groupStageHint') },
    { kind: 'origin', title: t('groupOrigin'), hint: t('groupOriginHint') },
  ];

  function colorButtons(current: string, onPick: (v: string) => void) {
    return (
      <div className="flex flex-wrap gap-1.5">
        {PRESET_COLORS.map((color) => (
          <button
            key={color.value}
            type="button"
            onClick={() => onPick(color.value)}
            aria-label={t('useColor', { color: t(`colors.${color.name}` as Parameters<typeof t>[0]) })}
            aria-pressed={current === color.value}
            className={cn(
              'size-6 rounded-md transition-transform hover:scale-110',
              current === color.value && 'outline outline-2 outline-offset-2 outline-primary',
            )}
            style={{ backgroundColor: color.value }}
            title={t(`colors.${color.name}` as Parameters<typeof t>[0])}
          />
        ))}
      </div>
    );
  }

  const editingKind = editing ? kindOf(editing) : 'manual';

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <TagIcon className="size-4 text-primary" />
          {t('tagsTitle')}
        </CardTitle>
        <CardDescription className="text-muted-foreground">
          {t('tagsDesc')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Signed out / no account yet: nothing to load, show the empty state. */}
        {loading && (authLoading || (user && accountId)) ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-6 animate-spin text-primary" />
          </div>
        ) : (
          <>
            {tags.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('noTags')}</p>
            ) : (
              groups.map(({ kind, title, hint }) => {
                const list = tags.filter((tag) => kindOf(tag) === kind);
                if (list.length === 0) return null;
                return (
                  <section key={kind} className="space-y-2">
                    <div>
                      <h3 className="text-sm font-medium text-foreground">{title}</h3>
                      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {list.map((tag) => (
                        <button
                          key={tag.id}
                          type="button"
                          onClick={() => openEditor(tag)}
                          aria-label={t('editAria', { name: tag.name })}
                          className="group inline-flex min-h-9 items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium transition-colors hover:brightness-95"
                          style={{
                            backgroundColor: `${tag.color}20`,
                            color: tag.color,
                            border: `1px solid ${tag.color}40`,
                          }}
                        >
                          <span className="size-2 rounded-full" style={{ backgroundColor: tag.color }} />
                          {tag.name}
                          <Pencil className="size-3 opacity-50 transition-opacity group-hover:opacity-100" />
                        </button>
                      ))}
                    </div>
                  </section>
                );
              })
            )}

            {/* Inline create row */}
            <div className="flex flex-wrap items-center gap-2.5 border-t pt-4">
              <Input
                placeholder={t('placeholder')}
                value={newTagName}
                onChange={(e) => setNewTagName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreate();
                }}
                disabled={saving}
                maxLength={40}
                className="min-w-[180px] flex-1"
              />
              {colorButtons(selectedColor, setSelectedColor)}
              <Button
                variant="outline"
                size="sm"
                onClick={handleCreate}
                disabled={saving || !newTagName.trim()}
              >
                {saving ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
                {t('addTag')}
              </Button>
            </div>
          </>
        )}
      </CardContent>

      {/* Editor */}
      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{confirmingDelete ? t('deleteTag') : t('editTag')}</DialogTitle>
            <DialogDescription>
              {confirmingDelete && editing
                ? editingKind === 'manual'
                  ? t('deleteConfirm', { name: editing.name })
                  : t('deleteAutoConfirm', { name: editing.name })
                : editingKind === 'stage'
                  ? t('editStageHint')
                  : editingKind === 'origin'
                    ? t('editOriginHint')
                    : null}
            </DialogDescription>
          </DialogHeader>

          {!confirmingDelete ? (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <label htmlFor="tag-edit-name" className="text-sm font-medium">
                  {t('nameLabel')}
                </label>
                <Input
                  id="tag-edit-name"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleUpdate();
                  }}
                  maxLength={60}
                  disabled={updating}
                />
              </div>
              <div className="space-y-1.5">
                <span className="text-sm font-medium">{t('colorLabel')}</span>
                {colorButtons(editColor, setEditColor)}
              </div>
            </div>
          ) : null}

          <DialogFooter className="gap-2 sm:justify-between">
            {confirmingDelete ? (
              <>
                <Button variant="ghost" onClick={() => setConfirmingDelete(false)} disabled={deleting}>
                  {t('cancel')}
                </Button>
                <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
                  {deleting ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      {t('deleting')}
                    </>
                  ) : (
                    t('deleteTag')
                  )}
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  onClick={() => setConfirmingDelete(true)}
                  disabled={updating}
                >
                  <Trash2 className="size-4" />
                  {t('deleteTag')}
                </Button>
                <Button onClick={handleUpdate} disabled={updating || !editName.trim()}>
                  {updating ? <Loader2 className="size-4 animate-spin" /> : null}
                  {t('save')}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
