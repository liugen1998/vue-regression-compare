import { escapeHtml } from './utils.js';

export interface TextDiffResult {
  equal: boolean;
  vue2DiffHtml: string;
  vue3DiffHtml: string;
  summary: string;
  diffCount: number;
}

type DiffOp<T> = { type: 'equal' | 'remove' | 'add'; value: T[] };

/**
 * Strict display-value diff.
 * - 不做格式归一化。
 * - 支持多处差异高亮。
 * - 短文本按字符 diff；超长文本按行 diff，避免 LCS 内存过大。
 */
export function buildTextDiff(vue2Value = '', vue3Value = ''): TextDiffResult {
  if (vue2Value === vue3Value) {
    return {
      equal: true,
      vue2DiffHtml: escapeHtml(vue2Value),
      vue3DiffHtml: escapeHtml(vue3Value),
      summary: '',
      diffCount: 0
    };
  }

  const useCharDiff = vue2Value.length * vue3Value.length <= 2_000_000;
  const vue2Tokens = useCharDiff ? Array.from(vue2Value) : splitKeepNewline(vue2Value);
  const vue3Tokens = useCharDiff ? Array.from(vue3Value) : splitKeepNewline(vue3Value);

  const ops = lcsDiff(vue2Tokens, vue3Tokens);
  const vue2DiffHtml = renderSide(ops, 'vue2');
  const vue3DiffHtml = renderSide(ops, 'vue3');
  const diffCount = countDiffGroups(ops);

  return {
    equal: false,
    vue2DiffHtml,
    vue3DiffHtml,
    summary: summarize(ops, diffCount, vue2Value.length, vue3Value.length, useCharDiff),
    diffCount
  };
}

function splitKeepNewline(input: string): string[] {
  const lines = input.split(/(\n)/);
  const tokens: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== '') tokens.push(lines[i]);
  }
  return tokens.length ? tokens : [''];
}

function lcsDiff<T>(a: T[], b: T[]): DiffOp<T>[] {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const dp = new Uint32Array((n + 1) * (m + 1));

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] = a[i] === b[j]
        ? dp[(i + 1) * width + (j + 1)] + 1
        : Math.max(dp[(i + 1) * width + j], dp[i * width + (j + 1)]);
    }
  }

  const ops: DiffOp<T>[] = [];
  const push = (type: DiffOp<T>['type'], value: T) => {
    const last = ops[ops.length - 1];
    if (last && last.type === type) last.value.push(value);
    else ops.push({ type, value: [value] });
  };

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push('equal', a[i]);
      i++;
      j++;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + (j + 1)]) {
      push('remove', a[i]);
      i++;
    } else {
      push('add', b[j]);
      j++;
    }
  }
  while (i < n) push('remove', a[i++]);
  while (j < m) push('add', b[j++]);

  return ops;
}

function renderSide<T>(ops: DiffOp<T>[], side: 'vue2' | 'vue3'): string {
  let html = '';
  for (const op of ops) {
    const text = op.value.join('');
    if (op.type === 'equal') html += escapeHtml(text);
    else if (op.type === 'remove' && side === 'vue2') html += `<span class="diff-old">${escapeHtml(text || '∅')}</span>`;
    else if (op.type === 'add' && side === 'vue3') html += `<span class="diff-new">${escapeHtml(text || '∅')}</span>`;
  }
  return html;
}

function countDiffGroups<T>(ops: DiffOp<T>[]): number {
  let count = 0;
  let inDiff = false;
  for (const op of ops) {
    if (op.type === 'equal') {
      inDiff = false;
    } else if (!inDiff) {
      count++;
      inDiff = true;
    }
  }
  return count;
}

function summarize<T>(ops: DiffOp<T>[], diffCount: number, vue2Length: number, vue3Length: number, charLevel: boolean): string {
  const snippets: string[] = [];
  let currentRemove = '';
  let currentAdd = '';

  const flush = () => {
    if (currentRemove || currentAdd) {
      snippets.push(`Vue2「${shorten(currentRemove || '∅')}」 vs Vue3「${shorten(currentAdd || '∅')}」`);
      currentRemove = '';
      currentAdd = '';
    }
  };

  for (const op of ops) {
    if (op.type === 'equal') flush();
    else if (op.type === 'remove') currentRemove += op.value.join('');
    else currentAdd += op.value.join('');
    if (snippets.length >= 3) break;
  }
  flush();

  const granularity = charLevel ? '字符级' : '行级';
  return `发现 ${diffCount} 处差异（${granularity}）；${snippets.slice(0, 3).join('；')}；Vue2长度=${vue2Length}，Vue3长度=${vue3Length}`;
}

function shorten(s: string, max = 80): string {
  const visible = s.replaceAll('\n', '\\n');
  return visible.length > max ? `${visible.slice(0, max)}...` : visible;
}
