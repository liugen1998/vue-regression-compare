import path from 'node:path';
import { loadPageConfigs, parseArgs } from './config.js';
import { writeReports } from './report.js';
import { runAll } from './runner.js';
import { ensureDir, nowStamp } from './utils.js';

async function main(): Promise<void> {
  const ctx = parseArgs(process.argv.slice(2));
  ctx.outputDir = path.join(ctx.outputDir, nowStamp());
  await ensureDir(ctx.outputDir);

  const configs = await loadPageConfigs(ctx.configDir, ctx.page);
  if (configs.length === 0) {
    throw new Error(`No page configs found in ${ctx.configDir}`);
  }

  console.log('Vue2/Vue3 页面回归对比开始');
  console.log(`模式：${ctx.mode}`);
  console.log(`页面数：${configs.length}`);
  console.log(`页面并发数：${ctx.concurrency}`);
  console.log(`性能采样次数：${ctx.runs ?? 1}`);
  console.log(`报告目录：${ctx.outputDir}`);

  const rows = await runAll(configs, ctx);
  await writeReports(rows, ctx.outputDir, configs, ctx);

  const pass = rows.filter(r => r.status === '通过').length;
  const fail = rows.filter(r => r.status === '不通过').length;
  const perf = rows.filter(r => r.status === '性能下降').length;
  const error = rows.filter(r => r.status === '执行异常').length;
  const manual = rows.filter(r => r.status === '需人工确认').length;

  console.log('\nVue2/Vue3 页面回归对比完成');
  console.log(`总项数：${rows.length}`);
  console.log(`通过：${pass}`);
  console.log(`不通过：${fail}`);
  console.log(`性能下降：${perf}`);
  console.log(`执行异常：${error}`);
  console.log(`需人工确认：${manual}`);
  console.log(`HTML报告：${path.join(ctx.outputDir, 'report.html')}`);
  console.log(`Excel报告：${path.join(ctx.outputDir, 'report.xlsx')}`);
  console.log(`JSON结果：${path.join(ctx.outputDir, 'result.json')}`);
  console.log(`页面覆盖数据：${path.join(ctx.outputDir, 'coverage.json')}`);
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
