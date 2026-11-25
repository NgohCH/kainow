import { useEffect, useState, type FormEvent } from 'react';
import { ApiError, api, type Department } from '../api.ts';
import { departmentOptions, departmentToSave, type PersonDepartment } from '../profile.ts';

/**
 * Choosing a person's department from the central list, or none (D134): on My profile and on the Administrators and
 * people page. An unchanged choice is not sent. `save` sends a change; `onDone` follows a save, or Save with no change.
 */
export function DepartmentForm({ held, label, save, onDone }: {
  held: PersonDepartment | null;
  label: string;
  save: (departmentId: string | null) => Promise<void>;
  onDone: () => void;
}) {
  const [active, setActive] = useState<Department[] | null>(null);
  const [chosen, setChosen] = useState(held?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.get<{ departments: Department[] }>('/departments').then(
      (r) => setActive(r.departments),
      (e) => setError(e instanceof ApiError ? e.message : 'Could not load the departments.'),
    );
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const departmentId = departmentToSave(held, chosen);
    if (departmentId === undefined) return onDone();
    setBusy(true);
    setError(null);
    try {
      await save(departmentId);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The department was not saved. Try again.');
    } finally {
      setBusy(false);
    }
  }

  const options = departmentOptions(active, held);
  return (
    <form className="stack" onSubmit={(e) => void submit(e)}>
      <label>
        {label}
        <select value={chosen} onChange={(e) => setChosen(e.target.value)}>
          {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
        <span className="hint">For information only. It gives no access to any project.</span>
      </label>
      {error && <p role="alert" className="error">{error}</p>}
      <button className="primary" disabled={busy || !active}>Save department</button>
    </form>
  );
}
