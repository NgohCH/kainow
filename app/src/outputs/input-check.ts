import { BadRequestException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { kindFromFilename, UploadRejected, type FileKind } from '../notes/readers';
import { loadStorageSettings } from '../storage/settings';
import { effectiveFormats, inputRefusal } from './formats';

/**
 * The notes import checks the project's effective input formats before reading a file (spec 6.4). Pasted text never
 * comes here. Earlier sources are untouched: this only decides whether a new file may be imported.
 */
export async function assertInputFormatAllowed(db: Pool | PoolClient, projectId: string, filename: string): Promise<void> {
  let kind: FileKind;
  try {
    kind = kindFromFilename(filename);
  } catch (err) {
    if (err instanceof UploadRejected) throw new BadRequestException(err.message);
    throw err;
  }
  const storage = await loadStorageSettings(db);
  const own = (await db.query<{ input_formats: string[] | null }>(`SELECT input_formats FROM project_output_settings WHERE project_id = $1`, [projectId])).rows[0];
  const allowed = effectiveFormats(storage, own ? { inputFormats: own.input_formats, outputFormats: null } : null).input;
  if (!allowed.some((a) => a.format === kind)) throw new BadRequestException(inputRefusal(kind));
}
