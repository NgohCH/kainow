/**
 * The one helper that makes file and folder names safe for SharePoint and OneDrive (spec 5.4): every output file
 * name, output folder, department, project, year and report type folder goes through `safeName`.
 */

/** Characters SharePoint does not allow in a name; each becomes one `-`. */
const ILLEGAL = /["*:<>?/\\|]/g;
/** Control characters count as whitespace (they are never kept in a name). */
const SPACE_RUN = /[\s\p{Cc}]+/gu;
const EDGES = /^[ .]+|[ .]+$/g;

export const MAX_NAME = 100;
export const MAX_PATH = 400;
/** The shortest a title or folder is cut to before anything else is shortened further. */
const MIN_PART = 10;

const codePoints = (s: string): string[] => [...s];
const length = (s: string): number => codePoints(s).length;

/**
 * A name safe as one file or folder name: the characters `" * : < > ? / \ |` each replaced with `-`, whitespace runs
 * made one space, leading and trailing spaces and dots removed, cut at `max` code points (never inside a surrogate
 * pair), and "Untitled" when nothing is left.
 */
export function safeName(name: string, max = MAX_NAME): string {
  let s = name.normalize('NFC').replace(ILLEGAL, '-').replace(SPACE_RUN, ' ').replace(EDGES, '');
  if (length(s) > max) s = codePoints(s).slice(0, Math.max(0, max)).join('').replace(EDGES, '');
  return s === '' ? 'Untitled' : s;
}

const tailOf = (versionNo: number, ext: string, suffix?: number): string =>
  ` v${versionNo}${suffix && suffix > 1 ? ` (${suffix})` : ''}.${ext.toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin'}`;

/** `<Title> v<n>.<ext>`, or `<Title> v<n> (2).<ext>` when another file has the name; the title is cut so the whole name fits 100. */
export function outputFileName(title: string, versionNo: number, ext: string, suffix?: number): string {
  const tail = tailOf(versionNo, ext, suffix);
  return `${safeName(title, Math.max(1, MAX_NAME - length(tail)))}${tail}`;
}

const FILE_TAIL = /^(.*?)( v\d+(?: \(\d+\))?\.[a-z0-9]+)$/su;

/** Splits a file name into the part that may be shortened and the part that is kept. */
function splitFile(fileName: string): { head: string; tail: string } {
  const m = FILE_TAIL.exec(fileName);
  if (m) return { head: m[1], tail: m[2] };
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? { head: fileName.slice(0, dot), tail: fileName.slice(dot) } : { head: fileName, tail: '' };
}

const total = (parts: string[], fileName: string): number => length([...parts, fileName].join('/'));

/**
 * The folders and the file name, shortened so the whole path (joined with `/`) stays under `limit` code points. The
 * title in the file name is shortened first; then the folders from the last one up (for a restricted output the last
 * folder is its own, named for its title); each first down to 10 characters, then further only if still needed.
 * Returns the folders followed by the file name.
 */
export function fitPath(parts: string[], fileName: string, limit = MAX_PATH): string[] {
  const folders = [...parts];
  const file = splitFile(fileName);
  let head = file.head;
  const over = () => total(folders, `${head}${file.tail}`) - (limit - 1);
  const shorten = (s: string, floor: number): string => {
    const excess = over();
    if (excess <= 0 || length(s) <= floor) return s;
    return safeName(s, Math.max(floor, length(s) - excess));
  };
  for (const floor of [MIN_PART, 1]) {
    head = shorten(head, floor);
    for (let i = folders.length - 1; i >= 0 && over() > 0; i--) folders[i] = shorten(folders[i], floor);
  }
  return [...folders, `${head}${file.tail}`];
}
