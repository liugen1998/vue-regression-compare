import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Browser } from 'playwright';
import type { RunContext } from './types.js';
import { pathExists } from './utils.js';

export async function loadLocalEnv(envFile = '.env'): Promise<void> {
  if (!await pathExists(envFile)) return;
  const raw = await fs.readFile(envFile, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const idx = trimmed.indexOf('=');
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

export async function launchManagedBrowser(ctx: Pick<RunContext, 'headed'>): Promise<Browser> {
  await loadLocalEnv();
  const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH;
  if (executablePath) {
    const exists = await pathExists(executablePath);
    if (!exists) {
      throw new Error(
        `CHROMIUM_EXECUTABLE_PATH 指向的文件不存在：${executablePath}\n` +
        `请改成真实存在的 chrome.exe/msedge.exe，或执行 npm run setup 重新检测浏览器。`
      );
    }
  }

  return await chromium.launch({
    headless: !ctx.headed,
    executablePath: executablePath || undefined
  });
}

export async function detectBrowserExecutable(): Promise<string | undefined> {
  await loadLocalEnv();
  const candidates = [
    process.env.CHROMIUM_EXECUTABLE_PATH,
    chromium.executablePath(),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium'
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (await pathExists(candidate)) return path.resolve(candidate);
  }
  return undefined;
}

export async function writeEnvValue(key: string, value: string, envFile = '.env'): Promise<void> {
  const existing = await pathExists(envFile) ? await fs.readFile(envFile, 'utf8') : '';
  const lines = existing.split(/\r?\n/).filter(line => line.trim() && !line.startsWith(`${key}=`));
  lines.push(`${key}=${value}`);
  await fs.writeFile(envFile, `${lines.join('\n')}\n`, 'utf8');
}
