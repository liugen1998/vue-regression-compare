import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDir } from './misc.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const COLOR: Record<LogLevel, string> = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' };

export class Logger {
  constructor(
    private prefix = '',
    private level: LogLevel = (process.env.VMR_LOG as LogLevel) || 'info',
    private files: string[] = [],
  ) {}

  child(prefix: string, extraFile?: string) {
    const files = extraFile ? [...this.files, extraFile] : this.files;
    return new Logger(this.prefix ? `${this.prefix}|${prefix}` : prefix, this.level, files);
  }

  private write(lv: LogLevel, msg: string) {
    const line = `${new Date().toISOString()} [${lv.toUpperCase()}]${this.prefix ? ' [' + this.prefix + ']' : ''} ${msg}`;
    if (ORDER[lv] >= ORDER[this.level]) {
      // eslint-disable-next-line no-console
      console.log(`${COLOR[lv]}${line}\x1b[0m`);
    }
    for (const f of this.files) { try { appendFileSync(f, line + '\n'); } catch { /* 忽略日志落盘失败 */ } }
  }
  debug(m: string) { this.write('debug', m); }
  info(m: string) { this.write('info', m); }
  warn(m: string) { this.write('warn', m); }
  error(m: string) { this.write('error', m); }
}

export function runLogger(runDir: string) {
  ensureDir(join(runDir, 'logs'));
  return new Logger('', (process.env.VMR_LOG as LogLevel) || 'info', [join(runDir, 'logs', 'run.log')]);
}
