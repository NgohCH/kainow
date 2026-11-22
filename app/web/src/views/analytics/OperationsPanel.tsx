import type { ReactNode } from 'react';
import { type OperationsPanelData, locationWords } from '../../operations.ts';
import { plural } from '../../format.ts';
import { GrowthChart, StatusStrip } from '../Operations.tsx';

/** Administrator analytics, Operations panel: the status strip, run counts for the period and growth over the period. Read-only. */
export function OperationsPanelView({ data, csv }: { data: OperationsPanelData; csv: ReactNode }) {
  const s = data.status;
  const locations = s.storage.locations.map((l) => l.location);
  return (
    <>
      <StatusStrip status={{ backups: s.backups, lastDrill: s.lastDrill, storage: s.storage, protective: s.protective }} />
      <div className="grid-2">
        <section aria-labelledby="opsp-backups">
          <h3 id="opsp-backups">Backup runs in the period</h3>
          <ul className="plain">
            <li>Started: {data.period.backups.total}</li>
            <li>Succeeded: {data.period.backups.succeeded}</li>
            <li>Failed: {data.period.backups.failed}</li>
          </ul>
        </section>
        <section aria-labelledby="opsp-drills">
          <h3 id="opsp-drills">Restore drills in the period</h3>
          <ul className="plain">
            <li>Started: {data.period.drills.total}</li>
            <li>Passed: {data.period.drills.passed}</li>
            <li>Failed: {data.period.drills.failed}</li>
          </ul>
        </section>
      </div>
      <p className="meta">
        Safe floor on the database disk: {s.storage.safeFloorGb} GB free. Growth covers {plural(new Set(s.growth.map((g) => g.day)).size, 'day')} with readings in the period ({locations.map(locationWords).join(', ')}).
      </p>
      {locations.map((l) => <GrowthChart key={l} rows={s.growth} location={l} id={`opsp-growth-${l}`} />)}
      <p><a href="#/admin/operations">Open the Operations page</a></p>
      {csv}
    </>
  );
}
