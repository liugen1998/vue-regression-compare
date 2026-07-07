import fs from 'node:fs/promises';
import path from 'node:path';
import { collectConfigIssues, formatValidationIssue, loadAllPageConfigFiles, loadPageConfigs, parseArgs } from './config.js';
import type { ValidationIssue } from './config.js';
import { ensureDir, nowStamp } from './utils.js';

async function main(): Promise<void> {
  const ctx = parseArgs(process.argv.slice(2));
  const outputDir = path.join(ctx.outputDir, `config-validate-${nowStamp()}`);
  await ensureDir(outputDir);

  // 统一复用 loadPageConfigs，保证 validate 与 compare 的 --page 行为完全一致。
  const configs = await loadPageConfigs(ctx.configDir, ctx.page);
  const allFiles = await loadAllPageConfigFiles(ctx.configDir);
  const selectedKeys = new Set(configs.map(c => c.pageKey));
  const selectedFiles = allFiles.filter(f => selectedKeys.has(f.cfg.pageKey));

  const issues: ValidationIssue[] = [];
  for (const item of selectedFiles) {
    issues.push(...collectConfigIssues(item.cfg, item.file));
  }

  const errors = issues.filter(i => i.level === 'ERROR');
  const warnings = issues.filter(i => i.level === 'WARN');

  const lines = [
    `配置校验完成`,
    `配置目录：${ctx.configDir}`,
    `页面数量：${configs.length}`,
    `错误：${errors.length}`,
    `警告：${warnings.length}`,
    ``,
    ...issues.map(formatValidationIssue)
  ];

  await fs.writeFile(path.join(outputDir, 'config-validate.txt'), lines.join('\n'), 'utf8');
  await fs.writeFile(path.join(outputDir, 'config-validate.json'), JSON.stringify(issues, null, 2), 'utf8');

  console.log(lines.join('\n'));
  console.log(`\n报告目录：${outputDir}`);
  if (errors.length > 0) process.exitCode = 1;
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
