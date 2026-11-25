import { useEffect, useState } from 'react';
import { ApiError, api } from '../api.ts';
import { todayUtc8 } from '../changes.ts';
import type { Prefs } from '../prefs.ts';
import { departmentName, endedText, sinceText, untilText, type PastRole, type PersonDepartment, type Profile, type ProfileRole } from '../profile.ts';
import { roleLabel } from '../projects.ts';
import { Box } from '../ui/Box.tsx';
import { DataTable, type Column } from '../ui/DataTable.tsx';
import { PageHeader } from '../ui/PageHeader.tsx';
import { SettingsPage } from '../ui/SettingsPage.tsx';
import { AppearanceChoice, useSaveStatus } from './Customise.tsx';
import { DepartmentForm } from './DepartmentForm.tsx';

/** Roles come without an id of their own, and the same role can be held twice: each row carries its place in the list. */
type Row<T> = T & { key: number };
const keyed = <T,>(rows: T[]): Row<T>[] => rows.map((r, key) => ({ ...r, key }));

/** My profile (D134): who the person is, their department, their projects and roles now and before, and how Kainow looks for them. */
export function MyProfile({ prefs, ready, failed, onPrefs, orgColour }: {
  prefs: Prefs;
  /** False until the saved preferences have loaded: saving then would overwrite them with defaults. */
  ready: boolean;
  /** True when loading the saved preferences failed. */
  failed: boolean;
  onPrefs: (next: Prefs) => Promise<void>;
  orgColour: string | null;
}) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { save, status, error: saveFailed } = useSaveStatus(onPrefs);

  useEffect(() => {
    api.get<Profile>('/me/profile').then(setProfile, (e) => setError(e instanceof ApiError ? e.message : 'Could not load your profile.'));
  }, []);

  const today = todayUtc8();
  const roleColumns: Column<Row<ProfileRole>>[] = [
    { key: 'project', header: 'Project', sortValue: (r) => r.projectName.toLowerCase(), cell: (r) => (r.canOpen ? <a href={`#/projects/${r.projectId}`}>{r.projectName}</a> : r.projectName) },
    { key: 'role', header: 'Role', sortValue: (r) => roleLabel(r.role), cell: (r) => roleLabel(r.role) },
    { key: 'since', header: 'Since', sortValue: (r) => r.since, cell: (r) => sinceText(r.since, today) },
    // No end date sorts after every date.
    { key: 'until', header: 'Until', sortValue: (r) => r.until ?? '9999-12-31', cell: (r) => untilText(r.until) },
  ];
  const pastColumns: Column<Row<PastRole>>[] = [
    { key: 'project', header: 'Project', sortValue: (r) => r.projectName.toLowerCase(), cell: (r) => r.projectName },
    { key: 'role', header: 'Role', sortValue: (r) => roleLabel(r.role), cell: (r) => roleLabel(r.role) },
    { key: 'ended', header: 'Ended', sortValue: (r) => r.endedOn, cell: (r) => endedText(r.since, r.endedOn) },
  ];

  return (
    <main className="page my-profile">
      <PageHeader title="My profile" intro="Who you are in Kainow, the projects you take part in, and how Kainow looks for you." />
      {error && <p role="alert" className="error">{error}</p>}
      {!profile && !error && <p role="status" className="loading">Loading…</p>}
      {profile && (
        <SettingsPage
          glance={
            <>
              <Box>
                <dl className="facts">
                  <dt>Name</dt><dd>{profile.name}</dd>
                  <dt>Email</dt><dd>{profile.email}</dd>
                  <dt>Department</dt><dd>{departmentName(profile.department)}</dd>
                </dl>
              </Box>
              <DataTable caption="Projects and roles" columns={roleColumns} rows={keyed(profile.roles)} rowKey={(r) => String(r.key)} empty="You have no role in any project now." />
              <DataTable caption="Past roles" columns={pastColumns} rows={keyed(profile.pastRoles)} rowKey={(r) => String(r.key)} empty="No past roles." />
            </>
          }
          settings={[
            {
              key: 'department',
              title: 'Department',
              current: <p className="meta">{departmentName(profile.department)}</p>,
              form: (close) => (
                <DepartmentForm
                  held={profile.department}
                  label="Your department"
                  save={async (departmentId) => {
                    const r = await api.put<{ department: PersonDepartment | null }>('/me/department', { departmentId });
                    setProfile({ ...profile, department: r.department });
                  }}
                  onDone={close}
                />
              ),
            },
          ]}
        />
      )}
      <section aria-labelledby="my-appearance" className="settings-area">
        <h2 id="my-appearance">Appearance</h2>
        <Box>
          <p className="hint">These choices change only how Kainow looks for you. They are saved as you make them.</p>
          {failed && !ready && <p role="alert" className="error">Your saved preferences have not loaded, so they cannot be changed now. Reload the page to try again.</p>}
          <fieldset className="plain-fieldset" disabled={!ready}>
            <div className="stack">
              <AppearanceChoice prefs={prefs} orgColour={orgColour} save={save} name="my-profile" />
            </div>
          </fieldset>
          <p role={saveFailed ? 'alert' : 'status'} className={saveFailed ? 'error' : 'meta'}>{status}</p>
        </Box>
      </section>
    </main>
  );
}
