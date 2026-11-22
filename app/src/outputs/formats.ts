import { INPUT_FORMATS, OUTPUT_FORMATS, type InputFormat, type OutputFormat, type StorageSettings } from '../storage/settings';

export type FormatSource = 'organisation' | 'project';

/** The project's own format lists: null means "all approved" (D105). */
export interface ProjectFormats {
  inputFormats: string[] | null;
  outputFormats: string[] | null;
}

export interface EffectiveFormats {
  input: Array<{ format: InputFormat; source: FormatSource }>;
  output: Array<{ format: OutputFormat; source: FormatSource }>;
}

function intersect<T extends string>(catalogue: readonly T[], approved: readonly T[], own: string[] | null | undefined): Array<{ format: T; source: FormatSource }> {
  const source: FormatSource = own ? 'project' : 'organisation';
  return catalogue.filter((f) => approved.includes(f) && (!own || own.includes(f))).map((format) => ({ format, source }));
}

/**
 * The formats a project may use: what the Administrator approved, narrowed by the project's own list when it has one
 * (spec 6.4). Each carries where it comes from: "organisation" when the project takes all approved, "project" when the
 * project's own list applies.
 */
export function effectiveFormats(storage: Pick<StorageSettings, 'approvedInputFormats' | 'approvedOutputFormats'>, project: ProjectFormats | null): EffectiveFormats {
  return {
    input: intersect(INPUT_FORMATS, storage.approvedInputFormats, project?.inputFormats),
    output: intersect(OUTPUT_FORMATS, storage.approvedOutputFormats, project?.outputFormats),
  };
}

export const FORMAT_LABEL: Readonly<Record<InputFormat | OutputFormat, string>> = { txt: 'TXT', md: 'Markdown', docx: 'DOCX', pdf: 'PDF', csv: 'CSV' };

export const inputRefusal = (format: InputFormat): string =>
  `This project does not accept ${FORMAT_LABEL[format]} files. A PM, Owner or Sponsor can change this in Project settings › Outputs.`;

export const outputRefusal = (format: OutputFormat): string =>
  `This project does not make ${FORMAT_LABEL[format]} outputs. A PM, Owner or Sponsor can change this in Project settings › Outputs.`;
