import { useState } from 'react';
import { api } from '../../lib/api.js';
import { AsyncForm, ErrorNote, Field, Loading, Sheet, useAsync } from '../../ui/kit.js';
import { Icon } from '../../ui/Icon.js';
import { COMMITMENTS, COMMITMENT_LABELS } from '@shared/money.js';
import { arrange, groupArchiveBlock, moveInList, movedAnnouncement } from '@shared/arrange.js';
import type { Category, CategoryGroup, CategoryKind, Commitment } from '@shared/types.js';

const KIND_NOTES: Partial<Record<CategoryKind, string>> = { income: 'הכנסה', saving: 'חיסכון' };

type Open =
  | { kind: 'category'; id: number }
  | { kind: 'group'; id: number }
  | { kind: 'new-category'; groupId: number | null }
  | { kind: 'new-group' }
  | null;

/**
 * The budget's structure, on one page: rename, move, reorder, archive.
 *
 * Reordering is two buttons per row, not a drag. A drag needs two hands and a
 * steady one, which is not how this app is held (docs/DESIGN.md §8), and a
 * screen reader cannot drag at all. Each move saves on its own and is said
 * out loud as a position, so leaving halfway keeps what was done.
 *
 * A row opens its editor in place rather than in a second sheet: a sheet on a
 * sheet is two backdrops and two Escapes, and the list is the context the
 * edit is about.
 */
export function ArrangeSheet({ onClose }: { onClose: () => void }) {
  const data = useAsync(() => Promise.all([
    api.get<CategoryGroup[]>('/money/groups'),
    api.get<Category[]>('/money/categories'),
  ]));
  const [open, setOpen] = useState<Open>(null);
  const [said, setSaid] = useState('');
  const [error, setError] = useState<string | null>(null);

  const [groups, categories] = data.data ?? [[], []];
  const layout = arrange(groups, categories);
  const openGroups = groups.filter((g) => !g.archived_at);

  /** Writes the new order, shows it at once, and puts it back if the server refuses. */
  const reorder = async (key: 'groups' | 'categories', ids: number[], announce: string) => {
    setError(null);
    const order = new Map(ids.map((id, i) => [id, i + 1]));
    data.set((prev) => prev && [
      key === 'groups' ? prev[0].map((g) => ({ ...g, sort_order: order.get(g.id) ?? g.sort_order })) : prev[0],
      key === 'categories' ? prev[1].map((c) => ({ ...c, sort_order: order.get(c.id) ?? c.sort_order })) : prev[1],
    ]);
    setSaid(announce);
    try {
      await api.post('/money/order', { [key]: ids });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'הסדר לא נשמר');
      data.reload();
    }
  };

  const write = async (fn: () => Promise<unknown>, announce: string) => {
    setError(null);
    try {
      await fn();
      setOpen(null);
      setSaid(announce);
      data.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'השמירה נכשלה');
    }
  };

  const groupIds = layout.groups.flatMap((g) => (g.group ? [g.group.id] : []));

  return (
    <Sheet title="סידור הסעיפים" onClose={onClose}>
      {/* Read by a screen reader after every move; on screen it is the
          last thing that happened, which is also worth a glance. */}
      <p className="meta" role="status" aria-live="polite" style={{ minHeight: '1.55em', marginBottom: 'var(--s2)' }}>{said}</p>
      {error && <ErrorNote message={error} />}
      {data.loading && !data.data && <Loading />}
      {data.error && <ErrorNote message={data.error} onRetry={data.reload} />}

      {layout.groups.map(({ group, categories: cats }) => {
        const where = group ? `קבוצה ${group.name}` : 'סעיפים ללא קבוצה';
        const ids = cats.map((c) => c.id);
        return (
          <section key={group?.id ?? 'loose'} style={{ marginBottom: 'var(--s5)' }}>
            <div className="row" style={{ minHeight: 52, borderBottom: '2px solid var(--ink)' }}>
              <button
                type="button"
                className="grow label"
                style={{ textAlign: 'start', background: 'none', border: 0, fontFamily: 'inherit', minHeight: 48, padding: 0 }}
                onClick={() => group && setOpen(open?.kind === 'group' && open.id === group.id ? null : { kind: 'group', id: group.id })}
                disabled={!group}
                aria-expanded={group ? open?.kind === 'group' && open.id === group.id : undefined}
              >
                {group?.name ?? 'ללא קבוצה'}
              </button>
              {group && (
                <MoveButtons
                  name={group.name}
                  first={groupIds[0] === group.id}
                  last={groupIds[groupIds.length - 1] === group.id}
                  onMove={(dir) => {
                    const next = moveInList(groupIds, group.id, dir);
                    void reorder('groups', next, movedAnnouncement(group.name, next, group.id, 'רשימת הקבוצות'));
                  }}
                />
              )}
            </div>

            {group && open?.kind === 'group' && open.id === group.id && (
              <GroupEditor
                group={group}
                openCategories={cats.length}
                onSave={(name) => write(() => api.patch(`/money/groups/${group.id}`, { name }), `הקבוצה נקראת עכשיו ${name}`)}
                onArchive={() => write(() => api.patch(`/money/groups/${group.id}`, { archived: true }), `${group.name} הועברה לארכיון`)}
              />
            )}

            <div className="rows">
              {cats.map((c) => {
                const editing = open?.kind === 'category' && open.id === c.id;
                return (
                  // The rule goes on the wrapper: `.row:last-child` drops its own
                  // border, and every row here is the last child of its pair.
                  <div key={c.id} style={{ borderBottom: '1px solid var(--rule)' }}>
                    <div className="row" style={{ minHeight: 56 }}>
                      <button
                        type="button"
                        className="grow"
                        style={{ textAlign: 'start', background: 'none', border: 0, color: 'inherit', font: 'inherit', minHeight: 48, padding: 0 }}
                        onClick={() => setOpen(editing ? null : { kind: 'category', id: c.id })}
                        aria-expanded={editing}
                      >
                        <span className="title" style={{ display: 'block' }}>{c.name}</span>
                        {KIND_NOTES[c.kind] && <span className="meta">{KIND_NOTES[c.kind]}</span>}
                      </button>
                      <MoveButtons
                        name={c.name}
                        first={ids[0] === c.id}
                        last={ids[ids.length - 1] === c.id}
                        onMove={(dir) => {
                          const next = moveInList(ids, c.id, dir);
                          void reorder('categories', next, movedAnnouncement(c.name, next, c.id, where));
                        }}
                      />
                    </div>
                    {editing && (
                      <CategoryEditor
                        category={c}
                        groups={openGroups}
                        onSave={(changes) => write(
                          () => api.patch(`/money/categories/${c.id}`, changes),
                          `${String(changes['name'] ?? c.name)} נשמר`,
                        )}
                        onArchive={() => write(
                          () => api.patch(`/money/categories/${c.id}`, { archived: true }),
                          `${c.name} הועבר לארכיון`,
                        )}
                      />
                    )}
                  </div>
                );
              })}

              {open?.kind === 'new-category' && open.groupId === (group?.id ?? null) ? (
                <NewCategoryForm
                  groupId={group?.id ?? null}
                  onCancel={() => setOpen(null)}
                  onAdded={(name) => { setOpen(null); setSaid(`${name} נוסף`); data.reload(); }}
                />
              ) : (
                <button
                  type="button"
                  className="row"
                  style={{ minHeight: 48, color: 'var(--ink-2)' }}
                  onClick={() => setOpen({ kind: 'new-category', groupId: group?.id ?? null })}
                >
                  <span className="margin-col"><Icon name="plus" size={16} /></span>
                  <span className="grow" style={{ textAlign: 'start', fontSize: 15 }}>סעיף חדש בקבוצה</span>
                </button>
              )}
            </div>
          </section>
        );
      })}

      {data.data && (open?.kind === 'new-group' ? (
        <NameForm
          label="שם הקבוצה"
          submitLabel="הוספת הקבוצה"
          onCancel={() => setOpen(null)}
          onSubmit={(name) => write(() => api.post('/money/groups', { name }), `הקבוצה ${name} נוספה`)}
        />
      ) : (
        <button type="button" className="btn btn-block" onClick={() => setOpen({ kind: 'new-group' })}>
          קבוצה חדשה
        </button>
      ))}

      {(layout.archivedCategories.length > 0 || layout.archivedGroups.length > 0) && (
        <section style={{ marginTop: 'var(--s7)' }}>
          <h3 className="label" style={{ borderBottom: '1px solid var(--rule)', paddingBottom: 'var(--s2)' }}>
            בארכיון <span className="n" style={{ color: 'var(--ink-3)', fontWeight: 400 }}>· {layout.archivedCategories.length + layout.archivedGroups.length}</span>
          </h3>
          <div className="rows">
            {layout.archivedGroups.map((g) => (
              <div className="row" key={`g${g.id}`} style={{ minHeight: 52, color: 'var(--ink-2)' }}>
                <span className="grow">{g.name} <span className="meta">· קבוצה</span></span>
                <button type="button" className="btn btn-sm" onClick={() => void write(() => api.patch(`/money/groups/${g.id}`, { archived: false }), `${g.name} חזרה`)}>
                  להחזיר
                </button>
              </div>
            ))}
            {layout.archivedCategories.map((c) => (
              <div className="row" key={c.id} style={{ minHeight: 52, color: 'var(--ink-2)' }}>
                <span className="grow">
                  {c.name}
                  {c.group_name && <span className="meta"> · {c.group_name}</span>}
                </span>
                <button type="button" className="btn btn-sm" onClick={() => void write(() => api.patch(`/money/categories/${c.id}`, { archived: false }), `${c.name} חזר`)}>
                  להחזיר
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      <button type="button" className="btn btn-primary btn-block" style={{ marginTop: 'var(--s5)' }} onClick={onClose}>
        סיום
      </button>
    </Sheet>
  );
}

/** Up and down, in the margin. Each says which row it moves, since the arrow alone does not. */
function MoveButtons({ name, first, last, onMove }: {
  name: string;
  first: boolean;
  last: boolean;
  onMove: (direction: -1 | 1) => void;
}) {
  return (
    <span style={{ display: 'flex', flex: '0 0 auto' }}>
      <button type="button" className="btn btn-quiet" style={{ minWidth: 48, minHeight: 48 }} disabled={first} onClick={() => onMove(-1)} aria-label={`להזיז את ${name} למעלה`}>
        <Icon name="up" size={18} />
      </button>
      <button type="button" className="btn btn-quiet" style={{ minWidth: 48, minHeight: 48 }} disabled={last} onClick={() => onMove(1)} aria-label={`להזיז את ${name} למטה`}>
        <Icon name="down" size={18} />
      </button>
    </span>
  );
}

const editorStyle = { padding: 'var(--s3) 0 var(--s4)', borderBottom: '1px solid var(--rule)' } as const;

function CategoryEditor({ category, groups, onSave, onArchive }: {
  category: Category;
  groups: CategoryGroup[];
  onSave: (changes: Record<string, unknown>) => Promise<void>;
  onArchive: () => Promise<void>;
}) {
  const [name, setName] = useState(category.name);
  const [groupId, setGroupId] = useState(category.group_id);
  return (
    <div style={editorStyle}>
      <AsyncForm
        submitLabel="שמירה"
        onSubmit={() => {
          const changes: Record<string, unknown> = {};
          if (name.trim() && name.trim() !== category.name) changes['name'] = name.trim();
          if (groupId != null && groupId !== category.group_id) changes['group_id'] = groupId;
          return onSave(changes);
        }}
      >
        <Field label="שם הסעיף">
          <input className="input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <Field label="בקבוצה">
          <select className="select" value={groupId ?? ''} onChange={(e) => setGroupId(e.target.value ? Number(e.target.value) : null)}>
            {groupId == null && <option value="">ללא קבוצה</option>}
            {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </Field>
      </AsyncForm>
      <button type="button" className="btn btn-red btn-block" style={{ marginTop: 'var(--s3)' }} onClick={() => void onArchive()}>
        להעביר לארכיון
      </button>
      <p className="meta" style={{ marginTop: 'var(--s2)' }}>התנועות שכבר נרשמו נשארות, ואפשר להחזיר מכאן.</p>
    </div>
  );
}

function GroupEditor({ group, openCategories, onSave, onArchive }: {
  group: CategoryGroup;
  openCategories: number;
  onSave: (name: string) => Promise<void>;
  onArchive: () => Promise<void>;
}) {
  const [name, setName] = useState(group.name);
  const block = groupArchiveBlock(openCategories);
  return (
    <div style={editorStyle}>
      <AsyncForm submitLabel="שמירה" onSubmit={() => onSave(name.trim() || group.name)}>
        <Field label="שם הקבוצה">
          <input className="input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
      </AsyncForm>
      <button type="button" className="btn btn-red btn-block" style={{ marginTop: 'var(--s3)' }} disabled={block != null} onClick={() => void onArchive()}>
        להעביר לארכיון
      </button>
      {block && <p className="meta" style={{ marginTop: 'var(--s2)' }}>{block}</p>}
    </div>
  );
}

function NameForm({ label, submitLabel, onSubmit, onCancel }: {
  label: string;
  submitLabel: string;
  onSubmit: (name: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  return (
    <div style={editorStyle}>
      <AsyncForm submitLabel={submitLabel} disabled={!name.trim()} onSubmit={() => onSubmit(name.trim())}>
        <Field label={label}>
          <input className="input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
      </AsyncForm>
      <button type="button" className="btn btn-quiet btn-block" onClick={onCancel}>ביטול</button>
    </div>
  );
}

/** The fields a new category needs, and nothing it can be given later. */
function NewCategoryFields({ name, setName, kind, setKind, commitment, setCommitment, allowIncome = true }: {
  allowIncome?: boolean;
  name: string; setName: (v: string) => void;
  kind: CategoryKind; setKind: (v: CategoryKind) => void;
  commitment: Commitment; setCommitment: (v: Commitment) => void;
}) {
  return (
    <>
      <Field label="שם הסעיף">
        <input className="input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} autoFocus />
      </Field>
      <Field label="סוג">
        <select className="select" value={kind} onChange={(e) => setKind(e.target.value as CategoryKind)}>
          <option value="spending">הוצאה</option>
          <option value="saving">חיסכון</option>
          {allowIncome && <option value="income">הכנסה</option>}
        </select>
      </Field>
      {kind !== 'income' && (
        <Field label="מה אפשר לעשות עם זה">
          <select className="select" value={commitment} onChange={(e) => setCommitment(e.target.value as Commitment)}>
            {COMMITMENTS.map((c) => <option key={c} value={c}>{COMMITMENT_LABELS[c]}</option>)}
          </select>
        </Field>
      )}
    </>
  );
}

function useNewCategory(groupId: number | null) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<CategoryKind>('spending');
  const [commitment, setCommitment] = useState<Commitment>('flexible');
  const submit = () => api.post<Category>('/money/categories', { group_id: groupId, name: name.trim(), kind, commitment });
  return { fields: { name, setName, kind, setKind, commitment, setCommitment }, submit, ready: name.trim() !== '' };
}

function NewCategoryForm({ groupId, onAdded, onCancel }: {
  groupId: number | null;
  onAdded: (name: string) => void;
  onCancel: () => void;
}) {
  const form = useNewCategory(groupId);
  return (
    <div style={editorStyle}>
      <AsyncForm submitLabel="הוספת הסעיף" disabled={!form.ready} onSubmit={async () => { const c = await form.submit(); onAdded(c.name); }}>
        <NewCategoryFields {...form.fields} />
      </AsyncForm>
      <button type="button" className="btn btn-quiet btn-block" onClick={onCancel}>ביטול</button>
    </div>
  );
}

/** Adding a category from the foot of its group on the budget screen. */
export function NewCategorySheet({ groupId, groupName, onClose, onAdded }: {
  groupId: number | null;
  groupName: string;
  onClose: () => void;
  onAdded: () => void;
}) {
  const form = useNewCategory(groupId);
  return (
    <Sheet title={`סעיף חדש · ${groupName}`} onClose={onClose}>
      <AsyncForm submitLabel="הוספת הסעיף" disabled={!form.ready} onSubmit={async () => { await form.submit(); onAdded(); }}>
        {/* No income here: an income category has no envelope, so it would
            be added from the budget screen and never appear on it. */}
        <NewCategoryFields {...form.fields} allowIncome={false} />
      </AsyncForm>
    </Sheet>
  );
}
