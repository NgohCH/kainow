import { useState, type FormEvent } from 'react';
import { ApiError, api } from '../api.ts';

interface Props {
  /** New notes need a title; a new version of existing notes does not. */
  withTitle: boolean;
  /** Upload and paste go to a different address for a new version. */
  pasteUrl: string;
  uploadUrl: string;
  submitLabel: string;
  onDone: (response: any) => void;
}

/** Paste text or choose a .txt, .md, .docx or text-PDF file. */
export function Intake({ withTitle, pasteUrl, uploadUrl, submitLabel, onDone }: Props) {
  const [mode, setMode] = useState<'paste' | 'upload'>('paste');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'paste') {
        onDone(await api.post(pasteUrl, withTitle ? { title, text } : { text }));
      } else {
        if (!file) throw new ApiError('Choose a file first.', 0);
        const form = new FormData();
        if (withTitle && title.trim()) form.set('title', title);
        form.set('file', file);
        onDone(await api.post(uploadUrl, form));
      }
      setText('');
      setFile(null);
      setTitle('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stack intake" onSubmit={submit}>
      <div role="tablist" aria-label="How to add notes" className="tabs">
        <button type="button" role="tab" aria-selected={mode === 'paste'} onClick={() => setMode('paste')}>Paste text</button>
        <button type="button" role="tab" aria-selected={mode === 'upload'} onClick={() => setMode('upload')}>Upload a file</button>
      </div>
      {withTitle && (
        <label>
          Title {mode === 'upload' && <span className="hint">(optional, the file name is used if empty)</span>}
          <input value={title} onChange={(e) => setTitle(e.target.value)} required={mode === 'paste'} maxLength={200} />
        </label>
      )}
      {mode === 'paste' ? (
        <label>
          Meeting notes
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={10} required />
        </label>
      ) : (
        <label>
          File
          <input type="file" accept=".txt,.md,.markdown,.docx,.pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <span className="hint">Text, Markdown, Word or a PDF with selectable text, up to 10 MB. Scanned PDFs are not supported yet.</span>
        </label>
      )}
      {error && <p role="alert" className="error">{error}</p>}
      <button className="primary" disabled={busy}>{busy ? 'Adding' : submitLabel}</button>
    </form>
  );
}
