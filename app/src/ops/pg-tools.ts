/**
 * Wrapper for the PostgreSQL 16 client tools. Connection details go in PG* environment variables, so a password is
 * never on a command line or in output. Binaries come from KAINOW_PG_BIN (a directory) or PATH.
 * Local tests only: KAINOW_TEST_PG_DOCKER=<container> runs them with `docker exec -i` and points them at the server
 * as seen from inside that container (127.0.0.1, port 5432).
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { join } from 'node:path';

type Tool = 'pg_dump' | 'pg_restore';

export class PgTools {
  constructor(
    private readonly connectionString: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  dump(args: string[]): ChildProcess {
    return this.run('pg_dump', args, true);
  }

  restore(args: string[]): ChildProcess {
    return this.run('pg_restore', args, true);
  }

  /** `pg_restore --list` reading the archive from stdin. */
  list(): ChildProcess {
    return this.run('pg_restore', ['--list'], false);
  }

  /** Major version of the client tools (16 expected). */
  async version(): Promise<number> {
    const child = this.run('pg_dump', ['--version'], false);
    const out = await new Promise<string>((resolve, reject) => {
      let text = '';
      child.stdout?.on('data', (d: Buffer) => (text += d.toString()));
      child.on('error', () => reject(new Error('The PostgreSQL client tools could not be started.')));
      child.on('close', (code) =>
        code === 0 ? resolve(text) : reject(new Error('The PostgreSQL client tools reported an error.')),
      );
    });
    const m = /(\d+)(?:\.\d+)*/.exec(out);
    if (!m) throw new Error('The PostgreSQL client tools gave an unreadable version.');
    return Number(m[1]);
  }

  private connection(): Record<string, string> {
    let u: URL;
    try {
      u = new URL(this.connectionString);
    } catch {
      // The input is not repeated: it can carry a password.
      throw new Error('The database connection setting is not a valid URL.');
    }
    const docker = this.env.KAINOW_TEST_PG_DOCKER;
    return {
      PGHOST: docker ? '127.0.0.1' : u.hostname,
      PGPORT: docker ? '5432' : u.port || '5432',
      PGUSER: decodeURIComponent(u.username),
      PGDATABASE: decodeURIComponent(u.pathname.replace(/^\//, '')),
      PGPASSWORD: decodeURIComponent(u.password),
    };
  }

  private run(tool: Tool, args: string[], connect: boolean): ChildProcess {
    const docker = this.env.KAINOW_TEST_PG_DOCKER;
    const conn = connect ? this.connection() : {};
    if (docker) {
      const flags: string[] = [];
      const childEnv: NodeJS.ProcessEnv = { ...this.env };
      for (const [k, v] of Object.entries(conn)) {
        if (k === 'PGPASSWORD') {
          flags.push('-e', 'PGPASSWORD'); // value is copied from this process's environment, not the command line
          childEnv.PGPASSWORD = v;
        } else flags.push('-e', `${k}=${v}`);
      }
      return spawn('docker', ['exec', '-i', ...flags, docker, tool, ...args], { env: childEnv, stdio: 'pipe' });
    }
    const dir = this.env.KAINOW_PG_BIN;
    const bin = dir ? join(dir, tool) : tool;
    return spawn(bin, args, { env: { ...this.env, ...conn }, stdio: 'pipe' });
  }
}
