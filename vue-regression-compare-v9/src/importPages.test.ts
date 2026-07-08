import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdownPageTable, parseCsvPageTable } from './importPages.js';

test('parseMarkdownPageTable 解析三列表并跳过分隔行', () => {
  const md = [
    '| 页面 | VUE2链接 | VUE3链接 |',
    '| --- | --- | --- |',
    '| 首页 | https://v2/home | https://v3/home |',
    '| 报表 | https://v2/report | https://v3/report |'
  ].join('\n');
  const rows = parseMarkdownPageTable(md);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { pageName: '首页', vue2Url: 'https://v2/home', vue3Url: 'https://v3/home' });
  assert.equal(rows[1].pageName, '报表');
});

test('parseMarkdownPageTable 表头缺列抛错', () => {
  const md = ['| 页面 | 链接 |', '| --- | --- |', '| 首页 | x |'].join('\n');
  assert.throws(() => parseMarkdownPageTable(md), /表头必须包含/);
});

test('parseMarkdownPageTable 支持 vue2url 别名表头', () => {
  const md = [
    '| 页面 | VUE2URL | VUE3URL |',
    '| --- | --- | --- |',
    '| 首页 | https://v2 | https://v3 |'
  ].join('\n');
  const rows = parseMarkdownPageTable(md);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].vue2Url, 'https://v2');
});

test('parseCsvPageTable 处理引号与逗号', () => {
  const csv = [
    '页面,VUE2链接,VUE3链接',
    '"首页,含逗号",https://v2/home,https://v3/home'
  ].join('\n');
  const rows = parseCsvPageTable(csv);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pageName, '首页,含逗号');
  assert.equal(rows[0].vue3Url, 'https://v3/home');
});

test('parseCsvPageTable 空内容返回空数组', () => {
  assert.deepEqual(parseCsvPageTable(''), []);
});
