/**
 * Search terms from a question or report brief (spec 4.3). Pure: no database.
 * Lower-cased words of at least 2 characters, punctuation removed, common English and Malay stop words removed,
 * de-duplicated, first 12. Each term later goes into its own websearch_to_tsquery, so no operator survives here.
 */

export const MAX_TERMS = 12;

/** Common English and Malay words that carry no meaning for search. Lower case. */
export const STOP_WORDS: ReadonlySet<string> = new Set([
  // English
  'a', 'about', 'after', 'all', 'also', 'am', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'been', 'before', 'being',
  'but', 'by', 'can', 'could', 'did', 'do', 'does', 'doing', 'done', 'for', 'from', 'had', 'has', 'have', 'having',
  'he', 'her', 'here', 'him', 'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'just', 'me', 'my', 'no',
  'not', 'of', 'on', 'or', 'our', 'ours', 'please', 'she', 'should', 'so', 'some', 'tell', 'than', 'that', 'the',
  'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'to', 'us', 'was', 'we', 'were', 'what', 'when',
  'where', 'which', 'while', 'who', 'whom', 'why', 'will', 'with', 'would', 'you', 'your',
  // Malay
  'ada', 'adakah', 'akan', 'apa', 'atau', 'bagaimana', 'bahawa', 'bila', 'boleh', 'dan', 'dari', 'daripada', 'dengan',
  'di', 'dia', 'ia', 'ialah', 'ini', 'itu', 'juga', 'kami', 'kamu', 'kenapa', 'ke', 'kepada', 'kita', 'lagi', 'mana',
  'mereka', 'oleh', 'pada', 'sana', 'saya', 'sini', 'situ', 'sudah', 'telah', 'tentang', 'tidak', 'untuk', 'yang',
]);

export function buildTerms(text: string): string[] {
  const out: string[] = [];
  for (const word of text.normalize('NFC').toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if ([...word].length < 2 || STOP_WORDS.has(word) || out.includes(word)) continue;
    out.push(word);
    if (out.length === MAX_TERMS) break;
  }
  return out;
}
