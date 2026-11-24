import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '../api.ts';
import { plural } from '../format.ts';
import { EMPTY_ITEM as EMPTY, type ItemDraft, itemProblem } from '../resourceScreens.ts';
import { useReturnFocus } from './useReturnFocus.ts';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'That did not work. Try again.');
const KINDS: Array<[string, string]> = [['equipment', 'Equipment'], ['facility', 'Facility']];
const kindLabel = (k: string) => KINDS.find(([v]) => v === k)?.[1] ?? k;

interface Item {
  id: string;
  kind: string;
  reference: string;
  name: string;
  categoryId: string | null;
  categoryName: string | null;
  description: string;
  status: 'active' | 'retired';
  projectsWithLines?: number;
}
interface Category {
  id: string;
  name: string;
  status: 'active' | 'retired';
}

function ItemForm({ initial, categories, editing, onSubmit, onCancel }: {
  initial: ItemDraft;
  categories: Category[];
  editing: boolean;
  onSubmit: (d: ItemDraft) => Promise<string | null>;
  onCancel: () => void;
}) {
  const [d, setD] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<ItemDraft>) => setD((x) => ({ ...x, ...patch }));
  async function submit(e: FormEvent) {
    e.preventDefault();
    const problem = itemProblem(d);
    if (problem) return setError(problem);
    setBusy(true);
    const refused = await onSubmit(d);
    setBusy(false);
    setError(refused);
  }
  return (
    <form className="panel stack" onSubmit={submit} aria-label={editing ? 'Edit item' : 'Add item'}>
      <div className="grid-2">
        <label>
          Kind
          <select value={d.kind} onChange={(e) => set({ kind: e.target.value })}>
            {KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <label>
          Reference
          <input required maxLength={30} value={d.reference} onChange={(e) => set({ reference: e.target.value })} />
          <span className="hint">A short code, unique among current items, for example P-04.</span>
        </label>
        <label>
          Name
          <input required maxLength={120} value={d.name} onChange={(e) => set({ name: e.target.value })} />
        </label>
        <label>
          Category
          <select required value={d.categoryId} onChange={(e) => set({ categoryId: e.target.value })}>
            <option value="">Choose a category</option>
            {categories.filter((c) => c.status === 'active' || c.id === d.categoryId).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
      </div>
      <label>
        Description (optional)
        <textarea rows={2} maxLength={1000} value={d.description} onChange={(e) => set({ description: e.target.value })} />
      </label>
      {error && <p role="alert" className="error">{error}</p>}
      <div className="decision">
        <button className="primary" disabled={busy}>{editing ? 'Save item' : 'Add item'}</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

/** Retire needs a reason: the form asks for it and says what stays. */
function RetireForm({ label, onRetire, onCancel }: { label: string; onRetire: (reason: string) => Promise<string | null>; onCancel: () => void }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (reason.trim() === '') return setError('Give a reason for retiring.');
    setBusy(true);
    const refused = await onRetire(reason.trim());
    setBusy(false);
    setError(refused);
  }
  return (
    <form className="inline-form" onSubmit={submit} aria-label={`Retire ${label}`}>
      <label>
        Reason for retiring {label}
        <input required maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <button className="primary" disabled={busy}>Retire</button>
      <button type="button" onClick={onCancel}>Cancel</button>
      <span className="hint">Past lines keep showing it, marked (retired). It cannot be chosen for new lines.</span>
      {error && <span role="alert" className="error">{error}</span>}
    </form>
  );
}

/**
 * The resource catalogue (spec 3.1, 8.1): items and categories, add, edit, rename and retire. Open to the Administrator and
 * named catalogue maintainers; the server decides.
 */
/** `embedded` puts it on another page; `bare` also drops its own panel and heading, for use inside a settings box that names it. `onChanged` runs after each saved change. */
export function ResourceCatalogue({ embedded = false, bare = false, onChanged }: { embedded?: boolean; bare?: boolean; onChanged?: () => void } = {}) {
  const Wrapper = bare ? 'div' : embedded ? 'section' : 'main';
  const Heading = embedded ? 'h2' : 'h1';
  const Sub = bare ? 'h4' : 'h3';
  const [items, setItems] = useState<Item[] | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [kind, setKind] = useState('');
  const [category, setCategory] = useState('');
  const [status, setStatus] = useState('active');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [retiring, setRetiring] = useState<string | null>(null);
  const [newCategory, setNewCategory] = useState('');
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [retiringCategory, setRetiringCategory] = useState<string | null>(null);
  const focus = useReturnFocus(
    adding ? 'add-item'
      : editing ? `edit-${editing}`
      : retiring ? `retire-${retiring}`
      : renaming ? `rename-${renaming.id}`
      : retiringCategory ? `retire-category-${retiringCategory}`
      : null,
  );

  const load = useCallback(() => {
    api.get<{ items: Item[]; categories: Category[] }>('/resources/catalogue?all=1').then(
      (r) => {
        setItems(r.items);
        setCategories(r.categories);
        setError(null);
      },
      (e: unknown) => setError(errText(e)),
    );
  }, []);
  useEffect(load, [load]);

  /** Runs a change; returns the refusal text, or null after reloading. */
  async function run(work: () => Promise<unknown>, done: string): Promise<string | null> {
    setNotice(null);
    try {
      await work();
      setNotice(done);
      load();
      onChanged?.();
      return null;
    } catch (e) {
      return errText(e);
    }
  }

  const shown = (items ?? []).filter((i) => (kind === '' || i.kind === kind) && (category === '' || i.categoryId === category) && (status === '' || i.status === status));
  const draftOf = (i: Item): ItemDraft => ({ kind: i.kind, reference: i.reference, name: i.name, categoryId: i.categoryId ?? '', description: i.description });

  return (
    <Wrapper className={bare ? undefined : embedded ? 'panel' : 'page'} aria-labelledby="catalogue-heading">
      {bare ? <h4 id="catalogue-heading" tabIndex={-1} className="visually-hidden">Resource catalogue</h4> : <Heading id="catalogue-heading" tabIndex={-1}>Resource catalogue</Heading>}
      <p className="meta">Shared equipment and facilities that projects choose from. A retired item stays on existing lines and cannot be chosen for new ones.</p>
      <p role="status" aria-live="polite" className="ok">{notice ?? ''}</p>
      {error && <p role="alert" className="error">{error}</p>}

      <Sub>Categories</Sub>
      <form
        className="inline-form"
        onSubmit={async (e) => {
          e.preventDefault();
          const refused = await run(() => api.post('/resources/catalogue/categories', { name: newCategory }), 'Category added.');
          if (refused) setError(refused);
          else setNewCategory('');
        }}
      >
        <label>
          New category <input required maxLength={80} value={newCategory} onChange={(e) => setNewCategory(e.target.value)} />
        </label>
        <button className="primary">Add category</button>
      </form>
      {categories.length === 0 ? (
        <p className="empty">No categories yet. Add one before adding items.</p>
      ) : (
        <ul className="list">
          {categories.map((c) => (
            <li key={c.id} className="row">
              {renaming?.id === c.id ? (
                <form
                  className="inline-form"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const refused = await run(() => api.put(`/resources/catalogue/categories/${c.id}`, { name: renaming.name }), 'Category renamed.');
                    if (refused) setError(refused);
                    else setRenaming(null);
                  }}
                >
                  <label>
                    Name <input required maxLength={80} value={renaming.name} onChange={(e) => setRenaming({ id: c.id, name: e.target.value })} />
                  </label>
                  <button className="primary">Save</button>
                  <button type="button" onClick={() => setRenaming(null)}>Cancel</button>
                </form>
              ) : retiringCategory === c.id ? (
                <RetireForm
                  label={c.name}
                  onCancel={() => setRetiringCategory(null)}
                  onRetire={async (reason) => {
                    const refused = await run(() => api.post(`/resources/catalogue/categories/${c.id}/retire`, { reason }), 'Category retired.');
                    if (!refused) {
                      focus.leaving('catalogue-heading');
                      setRetiringCategory(null);
                    }
                    return refused;
                  }}
                />
              ) : (
                <>
                  <span>
                    {c.name}
                    {c.status === 'retired' && <span className="meta"> (retired)</span>}
                  </span>
                  {c.status === 'active' && (
                    <span>
                      <button type="button" className="link-button" data-opener={`rename-${c.id}`} onClick={() => setRenaming({ id: c.id, name: c.name })}>Rename</button>{' '}
                      <button type="button" className="link-button" data-opener={`retire-category-${c.id}`} onClick={() => setRetiringCategory(c.id)}>Retire</button>
                    </span>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="row">
        <Sub>Items</Sub>
        <button type="button" className="primary" data-opener="add-item" aria-expanded={adding} onClick={() => setAdding((a) => !a)} disabled={categories.every((c) => c.status !== 'active')}>
          + Add item
        </button>
      </div>
      {adding && (
        <ItemForm
          initial={EMPTY}
          categories={categories}
          editing={false}
          onCancel={() => setAdding(false)}
          onSubmit={async (d) => {
            const refused = await run(() => api.post('/resources/catalogue/items', { ...d, reference: d.reference.trim(), name: d.name.trim(), description: d.description.trim() }), 'Item added.');
            if (!refused) setAdding(false);
            return refused;
          }}
        />
      )}
      <form className="inline-form" aria-label="Filter items" onSubmit={(e) => e.preventDefault()}>
        <label>
          Kind
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">All kinds</option>
            {KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <label>
          Category
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">All categories</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}{c.status === 'retired' ? ' (retired)' : ''}</option>)}
          </select>
        </label>
        <label>
          Status
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="active">Active</option>
            <option value="retired">Retired</option>
            <option value="">Active and retired</option>
          </select>
        </label>
      </form>
      {!items ? (
        <p className="loading">Loading</p>
      ) : shown.length === 0 ? (
        <p className="empty">{items.length === 0 ? 'No items yet.' : 'No items match these filters.'}</p>
      ) : (
        <ul className="list">
          {shown.map((i) => (
            <li key={i.id}>
              {editing === i.id ? (
                <ItemForm
                  initial={draftOf(i)}
                  categories={categories}
                  editing
                  onCancel={() => setEditing(null)}
                  onSubmit={async (d) => {
                    const refused = await run(() => api.put(`/resources/catalogue/items/${i.id}`, { ...d, reference: d.reference.trim(), name: d.name.trim(), description: d.description.trim() }), 'Item saved.');
                    if (!refused) setEditing(null);
                    return refused;
                  }}
                />
              ) : (
                <div className="row">
                  <span>
                    <strong>{i.reference}</strong> · {i.name}
                    {i.status === 'retired' && <span className="meta"> (retired)</span>}
                    <span className="meta">
                      {' '}· {kindLabel(i.kind)}{i.categoryName ? ` · ${i.categoryName}` : ''}
                      {typeof i.projectsWithLines === 'number' ? ` · ${plural(i.projectsWithLines, 'project')} with current lines` : ''}
                    </span>
                    {i.description && <span className="meta"> · {i.description}</span>}
                  </span>
                  {i.status === 'active' && (
                    <span>
                      <button type="button" className="link-button" data-opener={`edit-${i.id}`} aria-label={`Edit ${i.reference}`} onClick={() => setEditing(i.id)}>Edit</button>{' '}
                      <button type="button" className="link-button" data-opener={`retire-${i.id}`} aria-label={`Retire ${i.reference}`} onClick={() => setRetiring(retiring === i.id ? null : i.id)}>Retire</button>
                    </span>
                  )}
                </div>
              )}
              {retiring === i.id && (
                <RetireForm
                  label={i.reference}
                  onCancel={() => setRetiring(null)}
                  onRetire={async (reason) => {
                    const refused = await run(() => api.post(`/resources/catalogue/items/${i.id}/retire`, { reason }), 'Item retired.');
                    if (!refused) {
                      focus.leaving('catalogue-heading');
                      setRetiring(null);
                    }
                    return refused;
                  }}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </Wrapper>
  );
}
