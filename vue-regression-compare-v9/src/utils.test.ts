import test from 'node:test';
import assert from 'node:assert/strict';
import {
  median,
  performanceChangePercent,
  performanceChangeText,
  isPerformanceDegraded,
  sanitizeFileName,
  classifyError,
  isInvalidCollectedValue,
  escapeHtml,
  promisePool
} from './utils.js';

test('median 奇偶数组', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.ok(Number.isNaN(median([])));
});

test('performanceChangePercent 以 Vue2 为基线', () => {
  assert.equal(performanceChangePercent(100, 80), 20);
  assert.equal(performanceChangePercent(100, 120), -20);
  assert.equal(performanceChangePercent(0, 0), 0);
  assert.equal(performanceChangePercent(0, 5), undefined);
  assert.equal(performanceChangePercent(undefined, 5), undefined);
});

test('performanceChangeText 文案', () => {
  assert.equal(performanceChangeText(100, 80), '提升 20.00%');
  assert.equal(performanceChangeText(100, 120), '下降 20.00%');
  assert.equal(performanceChangeText(100, 100), '持平 0.00%');
  assert.equal(performanceChangeText(undefined, 100), '无法计算');
});

test('isPerformanceDegraded 只在 Vue3 更慢时为真', () => {
  assert.equal(isPerformanceDegraded(100, 120), true);
  assert.equal(isPerformanceDegraded(100, 100), false);
  assert.equal(isPerformanceDegraded(100, 80), false);
  assert.equal(isPerformanceDegraded(undefined, 80), false);
});

test('sanitizeFileName 归一非法字符', () => {
  assert.equal(sanitizeFileName('a/b:c *d'), 'a_b_c_d');
  assert.equal(sanitizeFileName('   '), 'unnamed');
  assert.equal(sanitizeFileName('__x__'), 'x');
});

test('classifyError 分类', () => {
  assert.equal(classifyError(new Error('net::ERR_CONNECTION')), '页面打不开或加载超时');
  assert.equal(classifyError(new Error('[NOT_FOUND]')), 'selector 找不到');
  assert.equal(classifyError(new Error('storageState missing ENOENT')), '登录态文件缺失');
  assert.equal(classifyError(new Error('something odd')), '未知异常');
});

test('isInvalidCollectedValue 识别占位', () => {
  assert.equal(isInvalidCollectedValue(undefined), true);
  assert.equal(isInvalidCollectedValue('[NOT_FOUND]'), true);
  assert.equal(isInvalidCollectedValue('正常值'), false);
});

test('escapeHtml 转义', () => {
  assert.equal(escapeHtml('<a>"&\'</a>'), '&lt;a&gt;&quot;&amp;&#039;&lt;/a&gt;');
});

test('promisePool 保持顺序且限制并发', async () => {
  let active = 0;
  let peak = 0;
  const out = await promisePool([1, 2, 3, 4, 5], 2, async (n) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(r => setTimeout(r, 5));
    active--;
    return n * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10]);
  assert.ok(peak <= 2);
});
