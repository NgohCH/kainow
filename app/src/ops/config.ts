/** Settings the ops commands read from the environment. Error messages name the variable, never its value. */
export interface OpsConfig {
  databaseUrl: string;
  backupDir: string;
  backupKeyFile: string;
  dbDataDir: string;
  protectedKeyFile: string | null;
  /** What the administrator sees for the backup folder: the host-side path (KAINOW_BACKUP_DIR_LABEL), else /backups. */
  folderLabel: string;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (v === undefined || v.trim() === '') throw new Error(`${name} must be set.`);
  return v;
}

export function loadOpsConfig(env: NodeJS.ProcessEnv): OpsConfig {
  const label = env.KAINOW_BACKUP_DIR_LABEL?.trim();
  const protectedKey = env.KAINOW_PROTECTED_KEY_FILE?.trim();
  return {
    databaseUrl: required(env, 'DATABASE_URL'),
    backupDir: required(env, 'KAINOW_BACKUP_DIR'),
    backupKeyFile: env.KAINOW_BACKUP_KEY_FILE?.trim() || '/run/secrets/kainow-backup.key',
    dbDataDir: env.KAINOW_DB_DATA_DIR?.trim() || '/pgdata',
    protectedKeyFile: protectedKey ? protectedKey : null,
    folderLabel: label ? label : '/backups',
  };
}
