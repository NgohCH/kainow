import { Logger } from '@nestjs/common';

/** Everything written through the Nest logger, console and the process streams while a test runs. */
export function captureLogs() {
  const lines: string[] = [];
  const push = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? `${a.name}: ${a.message}\n${a.stack}` : JSON.stringify(a))).join(' '));
  };
  const sink = { log: push, error: push, warn: push, debug: push, verbose: push, fatal: push };
  Logger.overrideLogger(sink);
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  const wrap = (orig: typeof out) =>
    ((chunk: unknown, ...rest: unknown[]) => {
      push(String(chunk));
      return (orig as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof out;
  process.stdout.write = wrap(out);
  process.stderr.write = wrap(err);
  const consoleKeys = ['log', 'info', 'warn', 'error', 'debug'] as const;
  const saved = consoleKeys.map((k) => console[k]);
  for (const k of consoleKeys) console[k] = (...a: unknown[]) => push(...a);
  return {
    lines,
    stop() {
      process.stdout.write = out;
      process.stderr.write = err;
      consoleKeys.forEach((k, i) => (console[k] = saved[i]));
      Logger.overrideLogger(false);
    },
  };
}
