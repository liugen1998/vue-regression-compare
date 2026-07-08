import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import type { PageConfig, RunContext, RunMode } from './types.js';
import { pathExists } from './utils.js';

export function parseArgs(argv: string[]): RunContext {
  const ctx: RunContext = {
    mode: 'default',
    headed: false,
    configDir: 'workspace/pages',
    outputDir: 'reports',
    concurrency: 2,
    runs: 1
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--headed') ctx.headed = true;
    else if (arg === '--page' && next) { ctx.page = next; i++; }
    else if (arg === '--mode' && next) { ctx.mode = next as RunMode; i++; }
    else if (arg === '--config-dir' && next) { ctx.configDir = next; i++; }
    else if (arg === '--output-dir' && next) { ctx.outputDir = next; i++; }
    else if (arg === '--concurrency' && next) { ctx.concurrency = Number(next); i++; }
    else if (arg === '--runs' && next) { ctx.runs = Number(next); i++; }
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  if (!['default', 'single-filter', 'targeted', 'smoke', 'standard', 'strict'].includes(ctx.mode)) {
    throw new Error(`Unsupported --mode: ${ctx.mode}. Expected default | single-filter | targeted | smoke | standard | strict.`);
  }
  if (!Number.isFinite(ctx.concurrency) || ctx.concurrency < 1) {
    throw new Error(`Unsupported --concurrency: ${ctx.concurrency}. Expected positive integer.`);
  }
  ctx.concurrency = Math.floor(ctx.concurrency);
  if (ctx.runs !== undefined && (!Number.isFinite(ctx.runs) || ctx.runs < 1)) {
    throw new Error(`Unsupported --runs: ${ctx.runs}. Expected positive integer.`);
  }
  ctx.runs = Math.floor(ctx.runs ?? 1);
  return ctx;
}

function printHelp(): void {
  console.log(`\nVue2/Vue3 回归对比工具\n\n常用命令：\n  npm run setup\n  npm run compare -- --page <pageKey> --mode default --headed\n  npm run compare -- --page <pageKey> --mode single-filter --concurrency 2\n  npm run compare -- --page <pageKey> --mode standard --runs 3\n\n参数：\n  --page          页面 key，必须精确匹配文件名或配置中的 pageKey\n  --mode          default | single-filter | targeted | smoke | standard | strict\n  --headed        打开浏览器界面，便于调试\n  --config-dir    默认 workspace/pages\n  --output-dir    默认 reports\n  --concurrency   页面级并发数，默认 2\n  --runs          性能采样次数，N>1 时取 Vue2/Vue3 中位数，默认 1\n`);
}

export interface LoadedConfigFile {
  file: string;
  baseName: string;
  cfg: PageConfig;
}

export async function loadAllPageConfigFiles(configDir: string): Promise<LoadedConfigFile[]> {
  let actualDir = configDir;
  if (!await pathExists(actualDir)) {
    // 兼容旧版本目录，但不再作为首选，避免业务配置和代码混放。
    const legacy = 'configs/pages';
    if (configDir === 'workspace/pages' && await pathExists(legacy)) {
      console.warn(`[WARN] 未找到 workspace/pages，已兼容读取旧目录 configs/pages。建议执行 npm run setup 迁移到 workspace/pages。`);
      actualDir = legacy;
    } else {
      throw new Error(`配置目录不存在：${configDir}\n建议执行 npm run setup 生成业务配置目录，或使用 --config-dir 指定目录。`);
    }
  }

  const entries = await fs.readdir(actualDir, { withFileTypes: true });
  const files = entries
    .filter(e => e.isFile() && /\.(yaml|yml|json)$/i.test(e.name))
    .map(e => path.join(actualDir, e.name));

  const loaded: LoadedConfigFile[] = [];
  for (const file of files) {
    const raw = await fs.readFile(file, 'utf8');
    const cfg = file.endsWith('.json') ? JSON.parse(raw) : YAML.parse(raw);
    validatePageConfig(cfg, file);
    loaded.push({ file, baseName: path.basename(file).replace(/\.(yaml|yml|json)$/i, ''), cfg });
  }
  return loaded;
}

export async function loadPageConfigs(configDir: string, pageKey?: string): Promise<PageConfig[]> {
  const loaded = await loadAllPageConfigFiles(configDir);

  const duplicateKeys = findDuplicatePageKeys(loaded.map(x => x.cfg));
  if (duplicateKeys.length) {
    throw new Error(`发现重复 pageKey：${duplicateKeys.join(', ')}。请保证每个页面配置 pageKey 唯一。`);
  }

  if (!pageKey) return loaded.map(x => x.cfg);

  // 精确匹配：文件名去扩展名 === pageKey 或 cfg.pageKey === pageKey。禁止 startsWith。
  const matches = loaded.filter(x => x.cfg.pageKey === pageKey || x.baseName === pageKey);
  if (matches.length > 1) {
    throw new Error(
      `--page ${pageKey} 匹配到多个配置，已拒绝执行，避免误跑页面：\n` +
      matches.map(m => `- ${m.file} / pageKey=${m.cfg.pageKey}`).join('\n') +
      `\n请修正文件名或 pageKey，使其唯一精确匹配。`
    );
  }
  if (matches.length === 0) {
    const candidates = loaded
      .filter(x => x.cfg.pageKey.includes(pageKey) || x.baseName.includes(pageKey) || pageKey.includes(x.cfg.pageKey))
      .map(x => `${x.cfg.pageKey} (${x.file})`)
      .slice(0, 10);
    throw new Error(
      `No page config found for --page ${pageKey} in ${configDir}.\n` +
      `注意：v5 已改为精确匹配，不再使用 startsWith 前缀匹配。` +
      (candidates.length ? `\n相似配置：\n${candidates.map(c => `- ${c}`).join('\n')}` : '')
    );
  }
  return [matches[0].cfg];
}

function findDuplicatePageKeys(configs: PageConfig[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const cfg of configs) {
    if (seen.has(cfg.pageKey)) dup.add(cfg.pageKey);
    seen.add(cfg.pageKey);
  }
  return [...dup];
}

export interface ValidationIssue {
  file?: string;
  pageKey?: string;
  level: 'ERROR' | 'WARN';
  field: string;
  message: string;
  suggestion?: string;
}

export function validatePageConfig(cfg: unknown, file = ''): asserts cfg is PageConfig {
  const issues = collectConfigIssues(cfg, file).filter(i => i.level === 'ERROR');
  if (issues.length > 0) {
    throw new Error(issues.map(formatValidationIssue).join('\n'));
  }
}

export function formatValidationIssue(i: ValidationIssue): string {
  return `[${i.level}] ${i.file ?? ''} ${i.field}: ${i.message}${i.suggestion ? `；建议：${i.suggestion}` : ''}`;
}

export function collectConfigIssues(cfg: unknown, file = ''): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const push = (level: ValidationIssue['level'], field: string, message: string, pageKey?: string, suggestion?: string) => {
    issues.push({ file, pageKey, level, field, message, suggestion });
  };

  if (!cfg || typeof cfg !== 'object') {
    push('ERROR', 'root', '配置文件不是对象', undefined, '执行 npm run setup 重新生成配置模板');
    return issues;
  }
  const c = cfg as Partial<PageConfig>;
  for (const key of ['pageKey', 'pageName', 'vue2Url', 'vue3Url'] as const) {
    if (!c[key] || typeof c[key] !== 'string') push('ERROR', key, `缺少必填字段 ${key}`, c.pageKey, '通过 setup 向导补齐页面基本信息');
  }
  if (c.pageKey && !/^[a-zA-Z0-9_-]+$/.test(c.pageKey)) {
    push('WARN', 'pageKey', 'pageKey 建议只使用英文、数字、中划线或下划线', c.pageKey, '例如 service-satisfaction');
  }
  if (c.timeoutMs !== undefined && (typeof c.timeoutMs !== 'number' || c.timeoutMs <= 0)) {
    push('ERROR', 'timeoutMs', 'timeoutMs 必须是正数', c.pageKey);
  }
  if (c.waitAfterMs !== undefined && (typeof c.waitAfterMs !== 'number' || c.waitAfterMs < 0)) {
    push('ERROR', 'waitAfterMs', 'waitAfterMs 必须是非负数', c.pageKey);
  }
  if (c.waitForSelector === 'body') {
    push('WARN', 'waitForSelector', 'body 只能作为兜底等待区域，复杂页面建议配置主容器、核心卡片或表格容器', c.pageKey, '例如 [data-testid="main-content"]');
  }
  validateStringArray(c.waitForHiddenSelectors, 'waitForHiddenSelectors');
  if (c.readiness !== undefined) {
    if (!c.readiness || typeof c.readiness !== 'object' || Array.isArray(c.readiness)) {
      push('ERROR', 'readiness', 'readiness 必须是对象', c.pageKey);
    } else {
      const readiness = c.readiness as Record<string, unknown>;
      for (const key of [
        'waitForRequestIdle',
        'waitForDomStable',
        'waitForCommonLoading',
        'waitForCanvasStable',
        'autoScrollBeforeScreenshot',
        'disableAnimations'
      ]) {
        if (readiness[key] !== undefined && typeof readiness[key] !== 'boolean') {
          push('ERROR', `readiness.${key}`, '必须是 boolean', c.pageKey);
        }
      }
      for (const key of ['stableQuietMs', 'canvasSettleMs']) {
        if (readiness[key] !== undefined && (typeof readiness[key] !== 'number' || readiness[key] < 0)) {
          push('ERROR', `readiness.${key}`, '必须是非负数', c.pageKey);
        }
      }
      validateStringArray(readiness.loadingSelectors, 'readiness.loadingSelectors');
      validateStringArray(readiness.loadingText, 'readiness.loadingText');
    }
  }
  if (c.interactionExtraPolicy && !['manual', 'fail', 'ignore'].includes(c.interactionExtraPolicy)) {
    push('ERROR', 'interactionExtraPolicy', '必须是 manual/fail/ignore', c.pageKey);
  }
  if (c.interactionCheckMode && !['conservative', 'balanced'].includes(c.interactionCheckMode)) {
    push('ERROR', 'interactionCheckMode', '必须是 conservative/balanced', c.pageKey);
  }
  if (c.interactionScanLimit !== undefined && (typeof c.interactionScanLimit !== 'number' || c.interactionScanLimit <= 0)) {
    push('ERROR', 'interactionScanLimit', '必须是正数', c.pageKey);
  }

  const metricNames = new Set<string>();
  for (const [idx, metric] of (c.metrics ?? []).entries()) {
    const prefix = `metrics[${idx}]`;
    if (!metric.name) push('ERROR', `${prefix}.name`, '指标名称不能为空', c.pageKey);
    if (!metric.selector) push('ERROR', `${prefix}.selector`, '指标 selector 不能为空', c.pageKey, '先用 setup 跑通，再由前端补充 data-testid 或稳定 selector');
    if (metric.name && metricNames.has(metric.name)) push('WARN', `${prefix}.name`, `指标名称重复：${metric.name}`, c.pageKey);
    if (metric.name) metricNames.add(metric.name);
  }

  const filterNames = new Set<string>();
  if (c.enabled === false) {
    push('WARN', 'enabled', '当前页面 enabled=false，批量执行时仍会加载，但建议在导入或 UI 中确认是否要忽略', c.pageKey);
  }
  if (c.testStrategy && !['smoke', 'standard', 'strict', 'custom'].includes(c.testStrategy)) {
    push('ERROR', 'testStrategy', '必须是 smoke/standard/strict/custom', c.pageKey);
  }

  for (const [idx, filter] of (c.filters ?? []).entries()) {
    const prefix = `filters[${idx}]`;
    if (!filter.name) push('ERROR', `${prefix}.name`, '筛选器名称不能为空', c.pageKey);
    if (!filter.selector) push('ERROR', `${prefix}.selector`, '筛选器 selector 不能为空', c.pageKey);
    if (!['select', 'input', 'click-options'].includes(filter.type)) push('ERROR', `${prefix}.type`, '筛选器 type 必须是 select/input/click-options', c.pageKey);
    if (filter.strategy && !['all', 'sample', 'previous-and-current', 'region-representative', 'first-n', 'manual'].includes(filter.strategy)) push('ERROR', `${prefix}.strategy`, '筛选器 strategy 必须是 all/sample/previous-and-current/region-representative/first-n/manual', c.pageKey);
    if ((filter.type === 'input' || filter.type === 'click-options') && (!filter.values || filter.values.length === 0)) {
      push('WARN', `${prefix}.values`, `${filter.type} 类型建议显式配置 values`, c.pageKey, '否则 single-filter 模式可能无法遍历选项');
    }
    if (filter.type === 'click-options' && !filter.optionSelector) push('ERROR', `${prefix}.optionSelector`, 'click-options 必须配置 optionSelector', c.pageKey);
    if (filter.name && filterNames.has(filter.name)) push('WARN', `${prefix}.name`, `筛选器名称重复：${filter.name}`, c.pageKey);
    if (filter.name) filterNames.add(filter.name);
  }

  const tabItems = Array.isArray(c.tabs) ? c.tabs : c.tabs?.items ?? [];
  const tabNames = new Set<string>();
  for (const [idx, tab] of tabItems.entries()) {
    const prefix = `tabs[${idx}]`;
    if (!tab.name) push('ERROR', `${prefix}.name`, '页签名称不能为空', c.pageKey);
    if (!tab.selector) push('ERROR', `${prefix}.selector`, '页签 selector 不能为空', c.pageKey);
    if (tab.name && tabNames.has(tab.name)) push('WARN', `${prefix}.name`, `页签名称重复：${tab.name}`, c.pageKey);
    if (tab.name) tabNames.add(tab.name);
  }

  const interactionNames = new Set<string>();
  for (const [idx, interaction] of (c.interactions ?? []).entries()) {
    const prefix = `interactions[${idx}]`;
    if (!interaction.name) push('ERROR', `${prefix}.name`, '交互名称不能为空', c.pageKey);
    if (!interaction.selector) push('ERROR', `${prefix}.selector`, '交互入口 selector 不能为空', c.pageKey);
    if (!['click', 'hover'].includes(interaction.type)) push('ERROR', `${prefix}.type`, '交互 type 必须是 click/hover', c.pageKey);
    if (!interaction.compareUrl && (!interaction.compareSelectors || interaction.compareSelectors.length === 0)) {
      push('WARN', `${prefix}.compareSelectors`, '交互未配置 compareUrl 或 compareSelectors，只能校验能否操作', c.pageKey, '可先依赖自动交互扫描，再由前端补充弹窗/下钻对比区');
    }
    if (interaction.name && interactionNames.has(interaction.name)) push('WARN', `${prefix}.name`, `交互名称重复：${interaction.name}`, c.pageKey);
    if (interaction.name) interactionNames.add(interaction.name);
  }

  return issues;

  function validateStringArray(value: unknown, field: string): void {
    if (value === undefined) return;
    if (!Array.isArray(value)) {
      push('ERROR', field, '必须是字符串数组', c.pageKey);
      return;
    }
    for (const [idx, item] of value.entries()) {
      if (typeof item !== 'string' || !item.trim()) {
        push('ERROR', `${field}[${idx}]`, '必须是非空字符串', c.pageKey);
      }
    }
  }
}
