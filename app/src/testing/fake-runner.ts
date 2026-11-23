/**
 * A scripted Runner for the updater's tests (10b Task 7). Responses are matched by
 * command and argument prefix, in the order they were added; an entry with `times`
 * is used up after that many calls. Calls nothing matches succeed with no output.
 * Every call is recorded in `calls`.
 */
import type { RunOptions, RunResult, Runner } from '../updater/runner';

type Response = RunResult | ((args: string[], opts?: RunOptions) => RunResult | Promise<RunResult>);
type Entry = { cmd: 'git' | 'docker'; prefix: string[]; response: Response; left: number };

export class FakeRunner implements Runner {
  readonly calls: { cmd: 'git' | 'docker'; args: string[]; opts?: RunOptions }[] = [];
  private readonly entries: Entry[] = [];

  on(cmd: 'git' | 'docker', prefix: string[], response: Response, opts: { times?: number } = {}): this {
    this.entries.push({ cmd, prefix, response, left: opts.times ?? Infinity });
    return this;
  }

  async run(cmd: 'git' | 'docker', args: string[], opts?: RunOptions): Promise<RunResult> {
    this.calls.push({ cmd, args: [...args], opts });
    const e = this.entries.find((x) => x.cmd === cmd && x.left > 0 && x.prefix.every((p, i) => args[i] === p));
    if (!e) return { code: 0, stdout: '', stderr: '' };
    e.left--;
    return typeof e.response === 'function' ? e.response(args, opts) : { ...e.response };
  }

  /** The calls of one command, each as one string, for compact assertions. */
  lines(cmd?: 'git' | 'docker'): string[] {
    return this.calls.filter((c) => !cmd || c.cmd === cmd).map((c) => `${c.cmd} ${c.args.join(' ')}`);
  }
}
