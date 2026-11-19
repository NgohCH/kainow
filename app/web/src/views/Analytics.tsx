import { type FormEvent, useEffect, useState } from 'react';
import { ApiError, api } from '../api.ts';
import {
  COLUMN_LABELS,
  type ChartMode,
  type ColumnPanel,
  OWNERSHIPS,
  OWNERSHIP_LABELS,
  PANEL_LABELS,
  PERIODS,
  PERIOD_LABELS,
  type ProblemsPanel,
  type ProgressPanel,
  STATUSES,
  type SavedView,
  type SystemPanel,
  type TrendsPanel,
  type ViewConfig,
  type ViewPanel,
  defaultViewConfig,
  filtersToQuery,
  moveItem,
} from '../analytics.ts';
import { updatedLabel } from '../dashboard.ts';
import { STATUS_LABEL } from '../projects.ts';
import { CsvLink, Drill, type DrillTarget, ProblemsView, ProgressView, SystemView, TrendsView } from './analytics/Panels.tsx';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'That did not work. Try again.');

type Served = 'progress' | 'problems' | 'system' | 'trends';
type Loaded<T> = { query: string; data: T | null; error: string | null };

/** One panel's figures for the filters in force; not fetched while the panel is hidden. Late answers are dropped. */
function usePanel<T>(panel: Served, query: string, shown: boolean): Loaded<T> | null {
  const [state, setState] = useState<Loaded<T> | null>(null);
  useEffect(() => {
    if (!shown) return setState(null);
    let stale = false;
    setState({ query, data: null, error: null });
    api.get<{ data: T }>(`/admin/analytics?panel=${panel}&${query}`).then(
      (r) => !stale && setState({ query, data: r.data, error: null }),
      (e) => !stale && setState({ query, data: null, error: errText(e) }),
    );
    return () => {
      stale = true;
    };
  }, [panel, query, shown]);
  return state;
}

/** Show boxes with Move up and Move down. No dragging: every control is a button or a box. */
function OrderList({ legend, order, hidden, labels, fixed, onChange }: {
  legend: string;
  order: string[];
  hidden: string[];
  labels: Record<string, string>;
  fixed?: string;
  onChange: (order: string[], hidden: string[]) => void;
}) {
  return (
    <fieldset>
      <legend>{legend}</legend>
      <ol className="plain customise-order">
        {order.map((k, i) => (
          <li key={k} className="inline-form">
            <label className="check">
              <input
                type="checkbox"
                checked={!hidden.includes(k)}
                disabled={k === fixed}
                onChange={(e) => onChange(order, e.target.checked ? hidden.filter((h) => h !== k) : [...hidden, k])}
              />
              <span>{labels[k]}</span>
            </label>
            <button type="button" disabled={i === 0} aria-label={`Move up: ${labels[k]}`} onClick={() => onChange(moveItem(order, k, -1), hidden)}>Move up</button>
            <button type="button" disabled={i === order.length - 1} aria-label={`Move down: ${labels[k]}`} onClick={() => onChange(moveItem(order, k, 1), hidden)}>Move down</button>
          </li>
        ))}
      </ol>
    </fieldset>
  );
}

/** Administration → Analytics (dashboards spec 7): filters, the five panels, drill-down, saved views and export. */
export function Analytics() {
  const [config, setConfig] = useState<ViewConfig>(defaultViewConfig);
  const [departments, setDepartments] = useState<Array<{ id: string; name: string }>>([]);
  const [exportAllowed, setExportAllowed] = useState<boolean | null>(null);
  const [views, setViews] = useState<SavedView[]>([]);
  const [viewId, setViewId] = useState('');
  const [viewName, setViewName] = useState('');
  const [viewError, setViewError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [layoutOpen, setLayoutOpen] = useState(false);
  const [drill, setDrill] = useState<{ panel: Served; stack: DrillTarget[] } | null>(null);

  const f = config.filters;
  const query = filtersToQuery(f);
  const shown = (p: ViewPanel) => !config.panels.hidden.includes(p);

  useEffect(() => {
    let stale = false;
    api.get<{ departments: Array<{ id: string; name: string }> }>('/departments').then((r) => !stale && setDepartments(r.departments), () => !stale && setDepartments([]));
    // Only to leave out "Download CSV" when export is off; the server refuses the export itself either way.
    api.get<{ settings: { analyticsExportAllowed: boolean } }>('/admin/access-settings').then(
      (r) => !stale && setExportAllowed(r.settings.analyticsExportAllowed),
      () => !stale && setExportAllowed(null),
    );
    api.get<{ views: SavedView[] }>('/admin/analytics/views').then((r) => !stale && setViews(r.views), (e) => !stale && setViewError(errText(e)));
    return () => {
      stale = true;
    };
  }, []);

  // A drill-down belongs to the filters it was opened with.
  useEffect(() => setDrill(null), [query]);

  const progress = usePanel<ProgressPanel>('progress', query, shown('progress'));
  const problems = usePanel<ProblemsPanel>('problems', query, shown('problems'));
  const system = usePanel<SystemPanel>('system', query, shown('system'));
  const trends = usePanel<TrendsPanel>('trends', query, shown('trends'));

  const setFilters = (patch: Partial<ViewConfig['filters']>) => setConfig((c) => ({ ...c, filters: { ...c.filters, ...patch } }));
  const setColumns = (panel: ColumnPanel, order: string[], hidden: string[]) => setConfig((c) => ({ ...c, columns: { ...c.columns, [panel]: { order, hidden } } }));
  const setChart = (key: string, mode: ChartMode) => setConfig((c) => ({ ...c, charts: { ...c.charts, [key]: mode } }));
  const visibleColumns = (panel: ColumnPanel) => config.columns[panel].order.filter((k) => !config.columns[panel].hidden.includes(k));
  // A figure in a panel starts a new drill-down; a figure inside the drill-down goes one level further.
  const openDrill = (panel: Served) => (t: DrillTarget) => setDrill({ panel, stack: [t] });
  const drillFurther = (t: DrillTarget) => setDrill((d) => (d ? { ...d, stack: [...d.stack, t] } : d));

  function choose(id: string) {
    setNotice(null);
    setViewError(null);
    setViewId(id);
    const v = views.find((x) => x.id === id);
    if (v) {
      setConfig(v.config);
      setViewName(v.name);
    } else setViewName('');
  }

  function reset() {
    setConfig(defaultViewConfig());
    setViewId('');
    setViewName('');
    setNotice('Back to the default filters and layout.');
    setViewError(null);
  }

  async function saveView(asNew: boolean) {
    setNotice(null);
    setViewError(null);
    const name = viewName.trim();
    if (name.length < 1 || name.length > 100) return setViewError('Give the view a name (up to 100 characters).');
    setBusy(true);
    try {
      const r = asNew || !viewId
        ? await api.post<{ view: SavedView }>('/admin/analytics/views', { name, config })
        : await api.put<{ view: SavedView }>(`/admin/analytics/views/${viewId}`, { name, config });
      setViews((list) => [...list.filter((v) => v.id !== r.view.id), r.view].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)));
      setViewId(r.view.id);
      setConfig(r.view.config);
      setNotice(`Saved the view “${r.view.name}”.`);
    } catch (err) {
      setViewError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  async function removeView() {
    const v = views.find((x) => x.id === viewId);
    if (!v || !window.confirm(`Delete the saved view “${v.name}”? This cannot be undone.`)) return;
    setNotice(null);
    setViewError(null);
    setBusy(true);
    try {
      await api.delete(`/admin/analytics/views/${v.id}`);
      setViews((list) => list.filter((x) => x.id !== v.id));
      setViewId('');
      setViewName('');
      setNotice(`Deleted the view “${v.name}”. The page keeps its current filters and layout.`);
    } catch (err) {
      setViewError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  const csv = (panel: Served) => <CsvLink panel={panel} query={query} allowed={exportAllowed} />;
  const drillFor = (panel: Served) =>
    drill && drill.panel === panel ? (
      <Drill
        stack={drill.stack}
        query={query}
        onDrill={drillFurther}
        onBack={() => setDrill((d) => (d && d.stack.length > 1 ? { ...d, stack: d.stack.slice(0, -1) } : d))}
        onClose={() => setDrill(null)}
      />
    ) : null;

  function body(p: ViewPanel) {
    if (p === 'aiUsage') {
      return (
        <p>
          <a href="#/ai/usage">Open the organisation AI usage</a> <span className="meta">(Administration → AI → Usage). Its figures are not repeated here.</span>
        </p>
      );
    }
    const state = p === 'progress' ? progress : p === 'problems' ? problems : p === 'system' ? system : trends;
    if (!state || (!state.data && !state.error)) return <p className="loading">Loading</p>;
    if (state.error) return <p role="alert" className="error">{state.error}</p>;
    const updated = <p className="meta">{updatedLabel((state.data as { computedAt: string }).computedAt)}</p>;
    if (p === 'progress' && progress?.data)
      return <>{updated}<ProgressView data={progress.data} columns={visibleColumns('progress')} mode={config.charts['progress.onTime'] ?? 'chart'} onMode={(m) => setChart('progress.onTime', m)} onDrill={openDrill('progress')} csv={csv('progress')} />{drillFor('progress')}</>;
    if (p === 'problems' && problems?.data)
      return <>{updated}<ProblemsView data={problems.data} columns={visibleColumns('problems')} onDrill={openDrill('problems')} csv={csv('problems')} />{drillFor('problems')}</>;
    if (p === 'system' && system?.data) return <>{updated}<SystemView data={system.data} csv={csv('system')} /></>;
    if (p === 'trends' && trends?.data) return <>{updated}<TrendsView data={trends.data} modes={config.charts} onMode={setChart} csv={csv('trends')} /></>;
    return null;
  }

  const panels = config.panels.order.filter(shown);
  const ownershipApplies = f.department !== null;

  return (
    <main className="page">
      <div className="row">
        <h1>Analytics</h1>
        <a href="#/admin/analytics/definitions">Definitions</a>
      </div>
      <p className="meta">Counts and project names only. Records are listed in a drill-down only in projects where you are a participant.</p>

      <form className="panel stack" aria-label="Filters" onSubmit={(e) => e.preventDefault()}>
        <div className="grid-2">
          <label>
            Period
            <select value={f.period} onChange={(e) => setFilters({ period: e.target.value as ViewConfig['filters']['period'] })}>
              {PERIODS.map((p) => <option key={p} value={p}>{PERIOD_LABELS[p]}</option>)}
            </select>
          </label>
          <label>
            Department
            <select value={f.department ?? ''} onChange={(e) => setFilters({ department: e.target.value || null })}>
              <option value="">All departments</option>
              {f.department && !departments.some((d) => d.id === f.department) && <option value={f.department}>A department no longer listed</option>}
              {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </label>
          <label>
            Owned or contributed
            <select value={ownershipApplies ? f.ownership : 'both'} disabled={!ownershipApplies} aria-describedby="ownership-hint" onChange={(e) => setFilters({ ownership: e.target.value as ViewConfig['filters']['ownership'] })}>
              {OWNERSHIPS.map((o) => <option key={o} value={o}>{OWNERSHIP_LABELS[o]}</option>)}
            </select>
            <span id="ownership-hint" className="hint">Applies when a department is chosen.</span>
          </label>
        </div>
        <fieldset>
          <legend>Project status</legend>
          {STATUSES.map((s) => (
            <label key={s} className="choice">
              <input
                type="checkbox"
                checked={f.status.includes(s)}
                // At least one status stays chosen: with none, the server would show the defaults.
                disabled={f.status.length === 1 && f.status.includes(s)}
                onChange={(e) => setFilters({ status: e.target.checked ? STATUSES.filter((x) => x === s || f.status.includes(x)) : f.status.filter((x) => x !== s) })}
              />
              {STATUS_LABEL[s]}
            </label>
          ))}
        </fieldset>
        <label className="check">
          <input type="checkbox" checked={f.includeArchived} onChange={(e) => setFilters({ includeArchived: e.target.checked })} />
          Include archived
        </label>
        <p className="hint">The period changes trends and "in the period" counts. Progress and problems always show the projects as they stand now.</p>
      </form>

      <section className="panel stack" aria-labelledby="views-heading">
        <h2 id="views-heading">Saved views</h2>
        {viewError && <p role="alert" className="error">{viewError}</p>}
        {notice && <p role="status" className="ok">{notice}</p>}
        <label>
          Saved view
          <select value={viewId} onChange={(e) => choose(e.target.value)}>
            <option value="">None chosen</option>
            {views.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </label>
        <form className="inline-form" onSubmit={(e: FormEvent) => { e.preventDefault(); void saveView(!viewId); }}>
          <label>
            View name
            <input value={viewName} maxLength={100} onChange={(e) => setViewName(e.target.value)} />
          </label>
          {viewId && <button className="primary" disabled={busy}>Save changes to this view</button>}
          {viewId ? (
            <button type="button" disabled={busy} onClick={() => void saveView(true)}>Save as a new view</button>
          ) : (
            <button className="primary" disabled={busy}>Save as a new view</button>
          )}
          {viewId && <button type="button" disabled={busy} onClick={() => void removeView()}>Delete this view</button>}
          <button type="button" className="quiet" onClick={reset}>Reset</button>
        </form>
        <p className="hint">A view keeps your filters and layout. It never shows more than you can see without it.</p>
        <button type="button" className="quiet" aria-expanded={layoutOpen} onClick={() => setLayoutOpen((o) => !o)}>Arrange panels and columns</button>
        {layoutOpen && (
          <div className="grid-2">
            <OrderList
              legend="Panels"
              order={config.panels.order}
              hidden={config.panels.hidden}
              labels={PANEL_LABELS}
              onChange={(order, hidden) => setConfig((c) => ({ ...c, panels: { order: order as ViewPanel[], hidden: hidden as ViewPanel[] } }))}
            />
            <OrderList legend="Project progress columns" order={config.columns.progress.order} hidden={config.columns.progress.hidden} labels={COLUMN_LABELS} fixed="name" onChange={(o, h) => setColumns('progress', o, h)} />
            <OrderList legend="Project problems columns" order={config.columns.problems.order} hidden={config.columns.problems.hidden} labels={COLUMN_LABELS} fixed="name" onChange={(o, h) => setColumns('problems', o, h)} />
          </div>
        )}
      </section>

      {panels.length === 0 && <p className="empty">Every panel is hidden. Show one under Arrange panels and columns, or choose Reset.</p>}
      {panels.map((p) => (
        <section key={p} className="panel" aria-labelledby={`panel-${p}`}>
          <h2 id={`panel-${p}`}>{PANEL_LABELS[p]}</h2>
          {body(p)}
        </section>
      ))}
    </main>
  );
}
