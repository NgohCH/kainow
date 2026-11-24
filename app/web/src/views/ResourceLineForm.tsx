import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { ApiError, api } from '../api.ts';
import { type LineForm, type LineView, ONE_OFF_KINDS, UNITS, validateLineForm } from '../resources.ts';

interface CatalogueItem {
  id: string;
  kind: string;
  reference: string;
  name: string;
  categoryName: string | null;
}

const KIND_LABEL: Record<string, string> = { equipment: 'Equipment', facility: 'Facility', other: 'Other' };
const MAX_SHOWN = 50;

/**
 * Add or edit one resource line (spec 3.2, 4). A new line is a catalogue item (found by reference or name) or a one-off;
 * an existing line keeps its kind. The checks match the server's; the server's refusal is shown if it still refuses.
 */
export function ResourceLineForm({ projectId, line, onSaved, onCancel }: { projectId: string; line?: LineView; onSaved: (message: string) => void; onCancel: () => void }) {
  const editing = line !== undefined;
  const [mode, setMode] = useState<'item' | 'one_off'>(line ? (line.item ? 'item' : 'one_off') : 'item');
  const [items, setItems] = useState<CatalogueItem[]>([]);
  const [itemsFailed, setItemsFailed] = useState(false);
  const [search, setSearch] = useState('');
  const [itemId, setItemId] = useState(line?.item?.id ?? '');
  const [oneOffKind, setOneOffKind] = useState(line?.oneOffKind ?? '');
  const [description, setDescription] = useState(line?.oneOffKind ? line.description : '');
  const [quantity, setQuantity] = useState(line?.quantity ?? '');
  const [unit, setUnit] = useState(line?.unit ?? '');
  const [startsOn, setStartsOn] = useState(line?.startsOn ?? '');
  const [endsOn, setEndsOn] = useState(line?.endsOn ?? '');
  const [neededBy, setNeededBy] = useState(line?.neededBy ?? '');
  const [notes, setNotes] = useState(line?.notes ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (mode !== 'item' || editing) return;
    let stale = false;
    api.get<{ items: CatalogueItem[] }>('/resources/catalogue').then(
      (r) => !stale && setItems(r.items),
      () => !stale && setItemsFailed(true),
    );
    return () => {
      stale = true;
    };
  }, [mode, editing]);

  const matches = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((i) => q === '' || `${i.reference} ${i.name}`.toLowerCase().includes(q));
  }, [items, search]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const form: LineForm = {
      itemId: mode === 'item' ? itemId || null : null,
      oneOffKind: mode === 'one_off' ? oneOffKind || null : null,
      description,
      quantity,
      unit: unit || null,
      startsOn,
      endsOn,
      neededBy,
      notes,
    };
    const problem = validateLineForm(form);
    if (problem) return setError(problem);
    setError(null);
    setSaving(true);
    const body = {
      ...(form.itemId ? { itemId: form.itemId } : { oneOffKind: form.oneOffKind, description: description.trim() }),
      quantity: quantity.trim() || null,
      unit: unit || null,
      startsOn: startsOn.trim() || null,
      endsOn: endsOn.trim() || null,
      neededBy: neededBy.trim() || null,
      notes,
    };
    try {
      if (editing) await api.put(`/projects/${projectId}/resources/lines/${line.id}`, body);
      else await api.post(`/projects/${projectId}/resources/lines`, body);
      onSaved(editing ? 'Saved.' : 'Resource added.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That did not work. Try again.');
      setSaving(false);
    }
  }

  return (
    <form className="box stack change-form" aria-label={editing ? 'Edit resource line' : 'Add a resource'} onSubmit={(e) => void submit(e)}>
      <h3 className="form-box-title">{editing ? 'Edit resource' : 'Add a resource'}</h3>
      <p className="meta">{editing ? 'Saving records the change in the line’s history.' : 'This records that the project uses the resource. It does not book it.'}</p>
      {!editing && (
        <fieldset>
          <legend>Resource</legend>
          <label>
            <span>
              <input type="radio" name="line-mode" checked={mode === 'item'} onChange={() => setMode('item')} />
              Catalogue item
            </span>
          </label>
          <label>
            <span>
              <input type="radio" name="line-mode" checked={mode === 'one_off'} onChange={() => setMode('one_off')} />
              One-off resource
            </span>
          </label>
        </fieldset>
      )}
      {mode === 'item' && !editing && (
        <>
          <label>
            Search catalogue items
            <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Reference or name" />
          </label>
          {itemsFailed && <p role="alert" className="error">The catalogue could not be loaded. Try again.</p>}
          <label>
            Catalogue item
            <select value={itemId} onChange={(e) => setItemId(e.target.value)} required>
              <option value="">Choose an item</option>
              {matches.slice(0, MAX_SHOWN).map((i) => (
                <option key={i.id} value={i.id}>
                  {i.reference} · {i.name}
                  {i.categoryName ? ` (${i.categoryName})` : ''}
                </option>
              ))}
            </select>
            {matches.length > MAX_SHOWN && <span className="hint">Showing the first {MAX_SHOWN} of {matches.length}. Type more to narrow the list.</span>}
          </label>
        </>
      )}
      {mode === 'item' && editing && line?.item && (
        <p>
          <strong>{line.item.reference}</strong> · {line.item.name}
          {line.item.retired ? ' (retired)' : ''}
        </p>
      )}
      {mode === 'one_off' && (
        <>
          <label>
            Kind
            <select value={oneOffKind} onChange={(e) => setOneOffKind(e.target.value)} required disabled={editing}>
              <option value="">Choose a kind</option>
              {ONE_OFF_KINDS.map((k) => (
                <option key={k} value={k}>{KIND_LABEL[k]}</option>
              ))}
            </select>
          </label>
          <label>
            Description
            <input value={description} maxLength={200} onChange={(e) => setDescription(e.target.value)} required />
            <span className="hint">1 to 200 characters.</span>
          </label>
        </>
      )}
      <label>
        Quantity (optional)
        <input inputMode="decimal" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
      </label>
      <label>
        Unit (needed with a quantity)
        <select value={unit} onChange={(e) => setUnit(e.target.value)}>
          <option value="">No unit</option>
          {Object.entries(UNITS).map(([k, label]) => (
            <option key={k} value={k}>{label}</option>
          ))}
        </select>
      </label>
      <label>
        Starts on (optional)
        <input type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />
      </label>
      <label>
        Ends on (optional)
        <input type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />
      </label>
      <label>
        Needed by (optional)
        <input type="date" value={neededBy} onChange={(e) => setNeededBy(e.target.value)} />
      </label>
      <label>
        Notes (optional)
        <textarea rows={3} value={notes} maxLength={2000} onChange={(e) => setNotes(e.target.value)} />
      </label>
      <p role="status" aria-live="polite" className="meta">{saving ? 'Saving' : ''}</p>
      {error && <p role="alert" className="error">{error}</p>}
      <div className="decision">
        <button type="submit" className="primary" disabled={saving}>{editing ? 'Save changes' : 'Add resource'}</button>
        <button type="button" onClick={onCancel} disabled={saving}>Cancel</button>
      </div>
    </form>
  );
}
