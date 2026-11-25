import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from '../api.ts';
import { plural } from '../format.ts';
import { type ItemDraft, NEW_CATEGORY, type CatalogueCategory as Category, itemProblem, newItem, saveItem } from '../resourceScreens.ts';
import { useReturnFocus } from './useReturnFocus.ts';
import { DataTable, type Column } from '../ui/DataTable.tsx';
import { StatTile } from '../ui/StatTile.tsx';
import { StatusLabel } from '../ui/StatusLabel.tsx';

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
function ItemForm({ initial, categories, editing, onSubmit, onCancel, focusFirst = false }: {
  initial: ItemDraft;
  categories: Category[];
  editing: boolean;
  /** Saves the item, its new category first; returns the refusal, or null. `onCategory` selects the added category, which stays when the item is refused. */
  onSubmit: (d: ItemDraft, onCategory: (id: string) => void) => Promise<string | null>;
  onCancel: () => void;
  /** Moves focus to the first field when the form opens away from its button (Edit opens it above the table). */
  focusFirst?: boolean;
}) {
  const [d, setD] = useState(initial);
  const first = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    if (focusFirst) first.current?.focus();
  }, [focusFirst]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<ItemDraft>) => setD((x) => ({ ...x, ...patch }));
  async function submit(e: FormEvent) {
    e.preventDefault();
    const problem = itemProblem(d, categories);
    if (problem) return setError(problem);
    setBusy(true);
    const refused = await onSubmit(d, (id) => set({ categoryId: id, newCategory: '' }));
    setBusy(false);
    setError(refused);
  }
  return (
    <form className="box stack item-form" onSubmit={submit} aria-label={editing ? 'Edit item' : 'Add item'}>
      <div className="grid-2">
        <label>
          Kind
          <select ref={first} value={d.kind} onChange={(e) => set({ kind: e.target.value })}>
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
            <option value={NEW_CATEGORY}>New category</option>
          </select>
        </label>
        {d.categoryId === NEW_CATEGORY && (
          <label>
            New category name
            <input required maxLength={80} value={d.newCategory} onChange={(e) => set({ newCategory: e.target.value })} />
            <span className="hint">The category is added with the item.</span>
          </label>
        )}
      </div>
      <label>
        Description (optional)
        <textarea rows={2} maxLength={1000} value={d.description} onChange={(e) => set({ description: e.target.value })} />
      </label>
      {error && <p role="alert" className="error">{error}</p>}
      <div className="decision">
        <button className="primary" disabled={busy}>{editing ? 'Save item' : 'Add item'}</button>
        <button type="button" disabled={busy} onClick={onCancel}>Cancel</button>
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
  const Sub = bare ? 'h4' : embedded ? 'h3' : 'h2';
  /** While an item is being saved, the buttons that would close its form wait, so a refusal is never lost. */
  const saving = useRef(false);
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

  /** Saves an item, its new category first. Whatever was refused, the list is read again: the category may be there. */
  async function submitItem(d: ItemDraft, onCategory: (id: string) => void, sendItem: (body: object) => Promise<unknown>, done: string): Promise<string | null> {
    setNotice(null);
    saving.current = true;
    const { refused, added } = await saveItem(d, {
      addCategory: (name) => api.post('/resources/catalogue/categories', { name }),
      sendItem,
      onCategory: (c) => {
        setCategories((all) => [...all, c]);
        onCategory(c.id);
      },
      errText,
    });
    saving.current = false;
    const words = [added && `Category ${added} added.`, refused === null && done].filter(Boolean).join(' ');
    if (words) {
      setNotice(words);
      onChanged?.();
    }
    if (words || d.categoryId === NEW_CATEGORY) load();
    return refused;
  }

  const shown = (items ?? []).filter((i) => (kind === '' || i.kind === kind) && (category === '' || i.categoryId === category) && (status === '' || i.status === status));
  const draftOf = (i: Item): ItemDraft => ({ kind: i.kind, reference: i.reference, name: i.name, categoryId: i.categoryId ?? '', newCategory: '', description: i.description });

  const editingItem = editing ? (items ?? []).find((i) => i.id === editing) : undefined;
  // On its own page each part is a box; inside a settings box (bare) the parts are plain sections.
  const partClass = bare ? 'catalogue-part' : 'box catalogue-part';
  const subClass = bare ? undefined : 'box-title';

  const categoryColumns: Column<Category>[] = [
    { key: 'name', header: 'Category', sortValue: (c) => c.name.toLowerCase(), cell: (c) => c.name },
    { key: 'status', header: 'Status', sortValue: (c) => c.status, cell: (c) => <StatusLabel meaning={c.status === 'active' ? 'ok' : 'off'} word={c.status === 'active' ? 'In use' : 'Retired'} /> },
    {
      key: 'actions',
      header: 'Actions',
      wide: true,
      cell: (c) =>
        renaming?.id === c.id ? (
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
        ) : c.status === 'active' ? (
          <span className="actions">
            <button type="button" className="link-button" data-opener={`rename-${c.id}`} aria-label={`Rename ${c.name}`} onClick={() => setRenaming({ id: c.id, name: c.name })}>Rename</button>
            <button type="button" className="link-button" data-opener={`retire-category-${c.id}`} aria-label={`Retire ${c.name}`} onClick={() => setRetiringCategory(c.id)}>Retire</button>
          </span>
        ) : (
          <span className="meta">None: retired</span>
        ),
    },
  ];

  const itemColumns: Column<Item>[] = [
    { key: 'reference', header: 'Reference', sortValue: (i) => i.reference.toLowerCase(), cell: (i) => i.reference },
    { key: 'name', header: 'Name', sortValue: (i) => i.name.toLowerCase(), cell: (i) => <>{i.name}{i.description && <span className="row-note"><br />{i.description}</span>}</> },
    { key: 'kind', header: 'Kind', sortValue: (i) => kindLabel(i.kind), cell: (i) => kindLabel(i.kind) },
    { key: 'category', header: 'Category', sortValue: (i) => (i.categoryName ?? '').toLowerCase(), cell: (i) => i.categoryName ?? 'None' },
    { key: 'lines', header: 'Projects with current lines', sortValue: (i) => i.projectsWithLines ?? -1, cell: (i) => (typeof i.projectsWithLines === 'number' ? plural(i.projectsWithLines, 'project') : 'Not shown') },
    { key: 'status', header: 'Status', sortValue: (i) => i.status, cell: (i) => <StatusLabel meaning={i.status === 'active' ? 'ok' : 'off'} word={i.status === 'active' ? 'In use' : 'Retired'} /> },
    {
      key: 'actions',
      header: 'Actions',
      wide: true,
      cell: (i) =>
        retiring === i.id ? (
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
        ) : i.status === 'active' ? (
          <span className="actions">
            <button type="button" className="link-button" data-opener={`edit-${i.id}`} aria-label={`Edit ${i.reference}`} aria-expanded={editing === i.id} onClick={() => !saving.current && setEditing(editing === i.id ? null : i.id)}>Edit</button>
            <button type="button" className="link-button" data-opener={`retire-${i.id}`} aria-label={`Retire ${i.reference}`} onClick={() => setRetiring(retiring === i.id ? null : i.id)}>Retire</button>
          </span>
        ) : (
          <span className="meta">None: retired</span>
        ),
    },
  ];

  const intro = 'Shared equipment and facilities that projects choose from. A retired item stays on existing lines and cannot be chosen for new ones.';
  return (
    <Wrapper className={bare ? undefined : embedded ? 'panel' : 'page'} aria-labelledby="catalogue-heading">
      {bare ? (
        <>
          <h4 id="catalogue-heading" tabIndex={-1} className="visually-hidden">Resource catalogue</h4>
          <p className="meta">{intro}</p>
        </>
      ) : embedded ? (
        <>
          <Heading id="catalogue-heading" tabIndex={-1}>Resource catalogue</Heading>
          <p className="meta">{intro}</p>
        </>
      ) : (
        <header className="page-header">
          <div className="page-header-row">
            <div>
              <Heading id="catalogue-heading" tabIndex={-1}>Resource catalogue</Heading>
              <p className="page-intro">{intro}</p>
            </div>
          </div>
        </header>
      )}
      <p role="status" aria-live="polite" className="ok">{notice ?? ''}</p>
      {error && <p role="alert" className="error">{error}</p>}

      {items && !bare && (
        <div className="stat-grid">
          <StatTile label="Items in use" value={String(items.filter((i) => i.status === 'active').length)} />
          <StatTile label="Retired items" value={String(items.filter((i) => i.status === 'retired').length)} />
          <StatTile label="Categories in use" value={String(categories.filter((c) => c.status === 'active').length)} />
        </div>
      )}

      <section className={partClass} aria-labelledby="catalogue-categories">
        <Sub id="catalogue-categories" className={subClass}>Categories</Sub>
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
        <DataTable caption="Categories" columns={categoryColumns} rows={categories} rowKey={(c) => c.id} empty="No categories yet. Add one here, or with your first item." loading={items === null && !error} />
      </section>

      <section className={partClass} aria-labelledby="catalogue-items">
        <div className="settings-box-head">
          <Sub id="catalogue-items" className={subClass}>Items</Sub>
          <button type="button" className="primary" data-opener="add-item" aria-expanded={adding} onClick={() => {
            if (saving.current) return;
            if (!adding && items === null) load();
            setAdding(!adding);
          }}>
            + Add item
          </button>
        </div>
        {adding && !items && <p className="meta">{error ? 'The catalogue could not be loaded, so an item cannot be added yet. Reload the page to try again.' : 'Loading the catalogue…'}</p>}
        {adding && items && (
          <ItemForm
            initial={newItem(categories)}
            categories={categories}
            editing={false}
            onCancel={() => setAdding(false)}
            onSubmit={async (d, onCategory) => {
              const refused = await submitItem(d, onCategory, (body) => api.post('/resources/catalogue/items', body), 'Item added.');
              if (!refused) setAdding(false);
              return refused;
            }}
          />
        )}
        {editingItem && (
          <ItemForm
            key={editingItem.id}
            initial={draftOf(editingItem)}
            categories={categories}
            editing
            focusFirst
            onCancel={() => setEditing(null)}
            onSubmit={async (d, onCategory) => {
              const refused = await submitItem(d, onCategory, (body) => api.put(`/resources/catalogue/items/${editingItem.id}`, body), 'Item saved.');
              if (!refused) setEditing(null);
              return refused;
            }}
          />
        )}
        <form className="table-filters" aria-label="Filter items" onSubmit={(e) => e.preventDefault()}>
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
        <DataTable
          caption="Items"
          columns={itemColumns}
          rows={shown}
          rowKey={(i) => i.id}
          loading={items === null}
          empty={items && items.length === 0 ? 'No items yet.' : 'No items match these filters.'}
        />
      </section>
    </Wrapper>
  );
}
