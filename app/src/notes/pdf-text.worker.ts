import { parentPort, workerData } from 'node:worker_threads';
import { extractPdfText } from './pdf-text';
import { UploadRejected } from './readers';

/** One PDF per worker: read it, post the text or the plain-language refusal, and exit. */
export type PdfWorkerReply = { ok: true; text: string } | { ok: false; rejected: string | null };

const bytes = Buffer.from(workerData as Uint8Array);
extractPdfText(bytes).then(
  (text) => parentPort?.postMessage({ ok: true, text } satisfies PdfWorkerReply),
  (err: unknown) => parentPort?.postMessage({ ok: false, rejected: err instanceof UploadRejected ? err.message : null } satisfies PdfWorkerReply),
);
