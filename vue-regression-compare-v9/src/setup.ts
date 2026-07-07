import fs from 'node:fs/promises';
import path from 'node:path';
import readline, { type Interface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import YAML from 'yaml';
import { spawn } from 'node:child_process';
import { detectBrowserExecutable, launchManagedBrowser, writeEnvValue } from './browser.js';
import type { PageConfig } from './types.js';
import { ensureDir, pathExists, sanitizeFileName } from './utils.js';

async function main(): Promise<void> {
  const rl = readline.createInterface({ input, output });
  try {
    console.log('\nVue2/Vue3 升级验收工具 setup 向导');
    console.log('目标：自动检测浏览器、生成业务配置、保存登录态，并给出下一步命令。\n');

    await ensureDir('workspace/pages');
    await ensureDir('workspace/auth');
    await ensureDir('reports');

    const browserPath = await detectBrowserExecutable();
    if (browserPath) {
      console.log(`已检测到浏览器：${browserPath}`);
      const useDetected = await ask(rl, '是否写入 .env 并使用该浏览器？Y/n：', 'Y');
      if (!/^n/i.test(useDetected)) await writeEnvValue('CHROMIUM_EXECUTABLE_PATH', browserPath);
    } else {
      console.log('未自动检测到可用浏览器。');
      const manual = await ask(rl, '请输入 chrome.exe/msedge.exe 路径，或留空稍后处理：', '');
      if (manual.trim()) await writeEnvValue('CHROMIUM_EXECUTABLE_PATH', manual.trim());
    }

    const pageKey = sanitizeFileName(await ask(rl, '页面 key（英文，如 service-satisfaction）：', 'sample-page'));
    const pageName = await ask(rl, '页面名称（中文，如 服务满意度）：', pageKey);
    const vue2Url = await askRequired(rl, 'Vue2 页面 URL：');
    const vue3Url = await askRequired(rl, 'Vue3 页面 URL：');
    const needLogin = await ask(rl, '是否需要登录并保存登录态？Y/n：', 'Y');
    const authPath = `workspace/auth/${pageKey}.json`;

    if (!/^n/i.test(needLogin)) {
      await loginAndSaveStorage(vue2Url, authPath, rl);
    }

    const cfg: PageConfig = {
      pageKey,
      pageName,
      vue2Url,
      vue3Url,
      waitForSelector: 'body',
      waitForNetworkIdle: true,
      waitAfterMs: 300,
      timeoutMs: 60000,
      storageState: await pathExists(authPath) ? authPath : undefined,
      autoDiscoverInteractions: true,
      interactionCheckMode: 'conservative',
      interactionUniqueTextMatch: true,
      reportVue3ExtraInteractions: true,
      interactionExtraPolicy: 'manual',
      interactionScanLimit: 120,
      metrics: [],
      filters: [],
      interactions: []
    };

    const file = `workspace/pages/${pageKey}.yaml`;
    await fs.writeFile(file, renderYamlWithBusinessComments(cfg), 'utf8');
    console.log(`\n已生成页面配置：${file}`);

    const runChecks = await ask(rl, '是否自动执行配置校验与选择器健康检查？Y/n：', 'Y');
    if (!/^n/i.test(runChecks)) {
      await runCommand('npm', ['run', 'validate-config', '--', '--page', pageKey]);
      await runCommand('npm', ['run', 'check-selectors', '--', '--page', pageKey, '--headed']);
    }

    console.log('\nsetup 完成。下一步建议执行：');
    console.log(`npm run compare -- --page ${pageKey} --mode default --headed --concurrency 1`);
    console.log(`npm run compare -- --page ${pageKey} --mode single-filter --headed --concurrency 1`);
    console.log('\n说明：初始配置会以保守模式自动扫描确定性交互入口；指标、筛选器、弹窗/下钻内容对比仍建议由前端补充稳定 selector。');
  } finally {
    rl.close();
  }
}

async function loginAndSaveStorage(url: string, authPath: string, rl: Interface): Promise<void> {
  console.log('\n即将打开浏览器，请完成登录。登录完成后回到命令行按 Enter。');
  const browser = await launchManagedBrowser({ headed: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ignoreHTTPSErrors: true });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(err => {
    console.warn(`打开页面失败，但仍保留浏览器供手工处理：${(err as Error).message}`);
  });
  await rl.question('登录完成后按 Enter 保存登录态：');
  await ensureDir(path.dirname(authPath));
  await context.storageState({ path: authPath });
  await browser.close();
  console.log(`登录态已保存：${authPath}`);
}

async function ask(rl: Interface, question: string, defaultValue: string): Promise<string> {
  const ans = await rl.question(question);
  return ans.trim() || defaultValue;
}

async function askRequired(rl: Interface, question: string): Promise<string> {
  while (true) {
    const ans = (await rl.question(question)).trim();
    if (ans) return ans;
    console.log('该项必填。');
  }
}

function renderYamlWithBusinessComments(cfg: PageConfig): string {
  const yaml = YAML.stringify(cfg);
  return `# Vue2/Vue3 页面升级验收配置\n#\n# 非前端人员建议不要手写 selector：\n# 1. 先执行 npm run setup 生成本文件；\n# 2. 先依赖 autoDiscoverInteractions 自动扫描交互入口；\n# 3. 如果要做指标/弹窗/下钻内容精确对比，请让前端补充稳定 data-testid 后再配置 selector。\n#\n# 业务配置放在 workspace/pages，与代码 src/ 隔离，避免误改代码。\n\n${yaml}`;
}

async function runCommand(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve) => {
    console.log(`\n$ ${command} ${args.join(' ')}`);
    const child = spawn(command, args, { stdio: 'inherit', shell: process.platform === 'win32' });
    child.on('exit', () => resolve());
    child.on('error', err => { console.warn(`命令执行失败：${err.message}`); resolve(); });
  });
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
