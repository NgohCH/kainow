import { useEffect, useState } from 'react';
import { aiTabPath, getConnections } from '../ai.ts';

/** Fetches only once mounted, so a screen mounts it just when something is blocked. */
function ManagerLink({ projectId }: { projectId: string }) {
  const [manager, setManager] = useState(false);
  useEffect(() => {
    let stale = false;
    getConnections(projectId).then(
      (l) => !stale && setManager(l.editable),
      () => !stale && setManager(false),
    );
    return () => {
      stale = true;
    };
  }, [projectId]);
  if (!manager) return null;
  return (
    <p className="meta">
      <a href={aiTabPath(projectId)}>Open Settings › AI</a> to set up connections and limits.
    </p>
  );
}

/** Under a blocked AI status: a person who may manage the project's AI connections gets a link to Settings › AI. */
export function AiSettingsLink({ projectId, show }: { projectId: string; show: boolean }) {
  return show ? <ManagerLink projectId={projectId} /> : null;
}
