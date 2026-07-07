#!/usr/bin/env node
import { Command } from 'commander';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config/load.js';
import { estimateAll, type ComboStrategy } from './core/combos.js';
import { runAll, recordAll, type RunOptions } from './core/runner.js';
import { generateHtmlReport } from './report/html.js';
import { Logger } from './util/log.js';
import type { RunResults } from './types.js';

const program = new Command();
program.name('vmr').description('Vue2/Vue3 升级回归比对工具').version('0.1.0');
program.option('-c, --config <path>', '配置文件路径', 'config/pages.yaml');

const comboOpt = ['default', 'single', 'pairwise', 'full', 'sample'] as const;
const parseCombo = (v: string): ComboStrategy => {
  if (!(comboOpt as readonly string[]).includes(v)) { console.error(`--combo 只能是 ${comboOpt.join('|')}`); process.exit(2); }
  return v as ComboStrategy;
};

program.command('estimate')
  .description('按各组合策略预估用例数（dry-run）')
  .option('--max-cases <n>', '抽样/熔断上限', '300')
  .option('--seed <n>', '随机种子', '42')
  .action(opts => {
    const cfg = loadConfig(program.opts().config);
    const rows = estimateAll(cfg.pages, Number(opts.maxCases), Number(opts.seed));
    console.log('各页面在不同组合策略下的用例数（每用例约含 页面级比对 + 全部交互比对）：');
    console.table(rows);
    const totalFull = rows.reduce((s, r) => s + Number(r.full), 0);
    console.log(`full 策略总用例数：${totalFull}，按均值 40s/用例 预估约 ${(totalFull * 40 / 60).toFixed(0)} 分钟（不含性能采样）。`);
  });

program.command('record')
  .description('以 Vue2 侧为源录制 API 响应（replay 模式的前置步骤）')
  .option('--combo <s>', '组合策略 default|single|pairwise|full|sample', 'default')
  .option('--max-cases <n>', '上限', '300')
  .option('--seed <n>', '随机种子', '42')
  .option('--pages <ids>', '仅录制指定页面（逗号分隔）')
  .action(async opts => {
    await recordAll(program.opts().config, parseCombo(opts.combo), Number(opts.maxCases), Number(opts.seed),
      opts.pages ? String(opts.pages).split(',') : undefined);
  });

program.command('run')
  .description('执行双端比对')
  .option('--mode <m>', 'replay（默认，数据冻结权威判定）| live（双端同刻，漂移归因）', 'replay')
  .option('--combo <s>', '组合策略 default|single|pairwise|full|sample', 'default')
  .option('--max-cases <n>', '抽样/熔断上限', '300')
  .option('--seed <n>', '随机种子', '42')
  .option('--pages <ids>', '仅运行指定页面（逗号分隔）')
  .option('--perf', '附带性能采样（仅默认组合上执行）', false)
  .option('--perf-only', '只做性能，不做一致性比对', false)
  .option('--workers <n>', '页面级并行数', '2')
  .option('--resume <runId>', '断点续跑指定运行')
  .option('--auto-record', 'replay 模式缺少录制时自动先录制', false)
  .option('--no-confirm', '关闭缺陷二次确认复跑')
  .option('--junit', '额外输出 junit.xml', false)
  .action(async opts => {
    if (!['replay', 'live'].includes(opts.mode)) { console.error('--mode 只能是 replay|live'); process.exit(2); }
    const ro: RunOptions = {
      configPath: program.opts().config,
      mode: opts.mode, combo: parseCombo(opts.combo), maxCases: Number(opts.maxCases), seed: Number(opts.seed),
      pages: opts.pages ? String(opts.pages).split(',') : undefined,
      perf: !!opts.perf, perfOnly: !!opts.perfOnly, workers: Number(opts.workers),
      resume: opts.resume, autoRecord: !!opts.autoRecord, junit: !!opts.junit, confirm: opts.confirm !== false,
    };
    const r = await runAll(ro);
    process.exit(r.exitCode);
  });

program.command('report <runId>')
  .description('由 results.json 重新生成 HTML 报告')
  .action(runId => {
    const dir = join(process.cwd(), 'runs', runId);
    const p = join(dir, 'results.json');
    if (!existsSync(p)) { console.error(`未找到 ${p}`); process.exit(2); }
    const out = generateHtmlReport(JSON.parse(readFileSync(p, 'utf8')) as RunResults, dir);
    console.log(`已生成：${out}`);
  });

program.command('login')
  .description('获取登录态：scripted=按配置脚本化登录并保存 storageState；storage=打印手工导出说明')
  .option('--strategy <s>', 'scripted | storage', 'scripted')
  .action(async opts => {
    const cfg = loadConfig(program.opts().config);
    const log = new Logger();
    if (opts.strategy === 'storage') {
      console.log(`手工导出登录态步骤：
  1) 在任意有图形界面的机器上：npx playwright codegen --save-storage=state.json ${cfg.global.baseUrl.vue2}
  2) 在打开的浏览器中完成登录后关闭窗口；
  3) 将 state.json 拷贝到本机 ${cfg.global.auth.storageState.vue2 ?? '.auth/state-v2.json'}（v3 同理或共用）。`);
      return;
    }
    const sc = cfg.global.auth.scripted;
    if (!sc) { console.error('配置 global.auth.scripted 未填写，无法脚本化登录。'); process.exit(2); }
    const user = process.env[sc.usernameEnv], pass = process.env[sc.passwordEnv];
    if (!user || !pass) { console.error(`请先设置环境变量 ${sc.usernameEnv} / ${sc.passwordEnv}`); process.exit(2); }
    const { launchBrowser } = await import('./core/session.js');
    const browser = await launchBrowser(cfg, log);
    try {
      for (const side of ['vue2', 'vue3'] as const) {
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        await page.goto(cfg.global.baseUrl[side].replace(/\/$/, '') + sc.loginPath);
        await page.fill(sc.usernameSelector, user);
        await page.fill(sc.passwordSelector, pass);
        await page.click(sc.submitSelector);
        await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => undefined);
        const target = cfg.global.auth.storageState[side === 'vue2' ? 'vue2' : 'vue3'] ?? `.auth/state-${side}.json`;
        await ctx.storageState({ path: target });
        writeFileSync(target, readFileSync(target)); // 确保落盘
        console.log(`已保存 ${side} 登录态 → ${target}`);
        await ctx.close();
      }
    } finally { await browser.close(); }
  });

program.parseAsync().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(2); });
