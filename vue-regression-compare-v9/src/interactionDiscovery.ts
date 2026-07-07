import type { Page } from 'playwright';
import type { DiscoveredInteraction, PageConfig, ResultRow, ScenarioContext } from './types.js';

const DEFAULT_SAFE = ['查看', '详情', '明细', '下钻', '展开', '收起', '更多', '搜索', '查询', '重置', '关闭', '上一页', '下一页', 'tab'];
const DEFAULT_DANGEROUS = ['删除', '提交', '保存', '确认', '发布', '作废', '导出', '导入', '同步', '发送', '审批', '退回', '支付', '取消订单'];

/**
 * 保守确定性交互校验：
 * 1. 只匹配稳定标识：data-testid/data-test/data-cy、aria-label、title、href、表单 label/placeholder/name、两端唯一文本。
 * 2. 不使用 class、DOM 位置、相似文本或模糊匹配。
 * 3. 默认会去掉全/半角空格做匹配，避免“查 询”与“查询”被误判为不同入口。
 * 3. 不自动点击扫描出来的交互，只做入口存在性和状态一致性。
 * 4. 无确定性交互时输出“无法判断”，避免报告空白或误判通过。
 */
export async function compareAutoDiscoveredInteractions(
  vue2Page: Page,
  vue3Page: Page,
  cfg: PageConfig,
  scenario: ScenarioContext
): Promise<ResultRow[]> {
  const [vue2Items, vue3Items] = await Promise.all([
    discoverInteractions(vue2Page, cfg, 'vue2'),
    discoverInteractions(vue3Page, cfg, 'vue3')
  ]);

  const vue2Map = groupByKey(vue2Items);
  const vue3Map = groupByKey(vue3Items);
  const keys = Array.from(new Set([...vue2Map.keys(), ...vue3Map.keys()])).sort();
  const rows: ResultRow[] = [];
  const policy = cfg.interactionExtraPolicy ?? 'manual';
  const reportExtras = cfg.reportVue3ExtraInteractions ?? true;

  for (const key of keys) {
    const v2List = vue2Map.get(key) ?? [];
    const v3List = vue3Map.get(key) ?? [];

    // 保守模式下，重复 key 说明无法确定一一对应关系，不纳入一致性判断。
    if (v2List.length > 1 || v3List.length > 1) {
      rows.push({
        ...scenario,
        category: '页面交互功能一致',
        itemName: `${firstName(v2List, v3List, key)} / 交互入口唯一性`,
        vue2Value: v2List.length ? `发现 ${v2List.length} 个同名/同标识入口` : '未发现',
        vue3Value: v3List.length ? `发现 ${v3List.length} 个同名/同标识入口` : '未发现',
        status: '无法判断',
        attribution: '无法归因',
        severity: 'S2一般',
        message: '发现重复交互入口，无法确定 Vue2/Vue3 的一一对应关系，未判定通过或不通过。',
        suggestion: '建议前端补充唯一 data-testid；或在 interactions 中显式配置关键交互 selector。'
      });
      continue;
    }

    const v2 = v2List[0];
    const v3 = v3List[0];
    const itemName = v2?.name || v3?.name || key;

    if (v2 && !v3) {
      rows.push({
        ...scenario,
        category: '页面交互功能一致',
        itemName: `${itemName} / 交互入口存在性`,
        vue2Value: describe(v2),
        vue3Value: 'Vue3 未找到对应交互入口',
        status: '不通过',
        attribution: 'Vue3缺失',
        severity: 'S1严重',
        message: 'Vue2 存在确定性交互入口，但 Vue3 未找到相同稳定标识/唯一文本入口。',
        suggestion: '检查 Vue3 是否漏迁移该按钮/链接/Tab/筛选器；若文案或标识变更，请补充统一 data-testid 或显式 interactions 配置。'
      });
      continue;
    }

    if (!v2 && v3) {
      if (!reportExtras || policy === 'ignore') continue;
      rows.push({
        ...scenario,
        category: '页面交互功能一致',
        itemName: `${itemName} / Vue3 多出交互`,
        vue2Value: 'Vue2 未找到对应交互入口',
        vue3Value: describe(v3),
        status: policy === 'fail' ? '不通过' : '需人工确认',
        attribution: 'Vue3多出',
        severity: v3.dangerous ? 'S1严重' : 'S2一般',
        message: v3.dangerous ? 'Vue3 多出确定性高风险交互入口。' : 'Vue3 多出确定性交互入口，需要确认是否为允许新增。',
        suggestion: v3.dangerous ? '高风险新增入口需要业务和安全确认；不允许则前端移除。' : '确认是否为本次升级允许新增；如不允许则前端移除或隐藏。'
      });
      continue;
    }

    if (v2 && v3) {
      const sameEnabled = v2.enabled === v3.enabled;
      const sameVisible = v2.visible === v3.visible;
      const sameHref = (v2.href || '') === (v3.href || '');
      const ok = sameEnabled && sameVisible && sameHref;
      rows.push({
        ...scenario,
        category: '页面交互功能一致',
        itemName: `${itemName} / 交互入口存在性与状态`,
        vue2Value: describe(v2),
        vue3Value: describe(v3),
        status: ok ? '通过' : '不通过',
        attribution: ok ? '无法归因' : '交互状态不一致',
        severity: ok ? 'S3提示' : 'S1严重',
        message: ok
          ? `Vue2 与 Vue3 均存在确定性对应交互入口，基础状态一致。匹配依据：${v2.matchBy ?? v3.matchBy ?? 'stable-key'}`
          : 'Vue2 与 Vue3 交互入口的可见性、可用状态或 href 不一致。',
        suggestion: ok ? '-' : '检查权限控制、禁用条件、按钮状态、链接地址和组件迁移逻辑。'
      });
    }
  }

  if (rows.length === 0) {
    return [{
      ...scenario,
      category: '页面交互功能一致',
      itemName: '确定性交互扫描',
      vue2Value: vue2Items.length ? `发现 ${vue2Items.length} 个候选入口，但无可判定项` : '未发现确定性交互入口',
      vue3Value: vue3Items.length ? `发现 ${vue3Items.length} 个候选入口，但无可判定项` : '未发现确定性交互入口',
      status: '无法判断',
      attribution: '未配置交互',
      severity: 'S2一般',
      message: '未配置 interactions，且自动扫描未发现可唯一匹配的确定性交互入口。工具未做模糊猜测，避免误报。',
      suggestion: '建议前端补充唯一 data-testid/aria-label/title；或在页面配置中显式维护关键 interactions。'
    }];
  }

  return rows;
}

async function discoverInteractions(page: Page, cfg: PageConfig, side: 'vue2' | 'vue3'): Promise<DiscoveredInteraction[]> {
  const args = {
    limit: cfg.interactionScanLimit ?? 120,
    safeKeywords: cfg.safeActionKeywords ?? DEFAULT_SAFE,
    dangerousKeywords: cfg.dangerousActionKeywords ?? DEFAULT_DANGEROUS,
    uniqueTextMatch: cfg.interactionUniqueTextMatch ?? true,
    mode: cfg.interactionCheckMode ?? 'conservative',
    normalizeSpaces: cfg.interactionNormalizeSpaces !== false,
    fuzzyTextMatch: cfg.interactionFuzzyTextMatch === true
  };

  /**
   * 这里必须使用字符串 evaluate，而不是 page.evaluate(() => {...})。
   * 原因：tsx/esbuild 在某些环境下会给函数表达式注入 __name helper，Playwright 将函数序列化到浏览器上下文后，
   * 浏览器端没有 __name，导致交互发现全量失败。字符串脚本不会被 esbuild 改写，可避免该问题。
   */
  const script = String.raw`(() => {
    const args = ${JSON.stringify(args)};
    const limit = args.limit;
    const safeKeywords = args.safeKeywords;
    const dangerousKeywords = args.dangerousKeywords;
    const uniqueTextMatch = args.uniqueTextMatch;
    const mode = args.mode;
    const normalizeSpaces = args.normalizeSpaces;
    const fuzzyTextMatch = args.fuzzyTextMatch;

    const candidateSelector = [
      '[data-testid]', '[data-test]', '[data-cy]',
      'button', 'a[href]', 'input', 'select', 'textarea',
      '[role="button"]', '[role="link"]', '[role="tab"]', '[role="combobox"]', '[role="checkbox"]', '[role="radio"]'
    ].join(',');

    const normalize = (s) => (s || '').replace(/[\s\u00A0\u3000]+/g, ' ').trim();
    const normTextForKey = (s) => {
      const text = String(s || '').toLowerCase().trim();
      return normalizeSpaces ? text.replace(/[\s\u00A0\u3000]+/g, '') : text.replace(/[\s\u00A0\u3000]+/g, ' ');
    };
    const normKey = (s) => normTextForKey(s);
    const isVisible = (el) => {
      const r = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || 1) !== 0;
    };
    const typeOf = (el) => {
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute('role');
      const inputType = el.type;
      if (role) return role;
      if (tag === 'input') return inputType || 'input';
      return tag;
    };
    const visibleText = (el) => normalize(el.innerText || el.value || '');
    const containsAny = (name, keywords) => keywords.some((k) => String(name || '').includes(k));
    const enabled = (el) => {
      return !el.disabled && el.getAttribute('aria-disabled') !== 'true' && !String(el.className || '').includes('disabled');
    };
    const cssEscape = (value) => {
      const css = window.CSS;
      return css && css.escape ? css.escape(value) : String(value).replace(/["\\]/g, '\\$&');
    };
    const labelFor = (el) => {
      const id = el.getAttribute('id');
      if (id) {
        const label = document.querySelector('label[for="' + cssEscape(id) + '"]');
        const text = normalize(label && label.textContent ? label.textContent : '');
        if (text) return text;
      }
      const parentLabel = el.closest('label');
      const pText = normalize(parentLabel && parentLabel.textContent ? parentLabel.textContent : '');
      if (pText) return pText;
      return '';
    };

    const elements = Array.from(document.querySelectorAll(candidateSelector)).filter(isVisible);
    const textCount = new Map();
    for (const el of elements) {
      const role = typeOf(el);
      const tag = el.tagName.toLowerCase();
      const text = visibleText(el);
      if (!text) continue;
      if (!['button', 'a', 'link', 'tab'].includes(role) && !['button', 'a'].includes(tag)) continue;
      const key = role + '|' + normKey(text);
      textCount.set(key, (textCount.get(key) || 0) + 1);
    }

    const result = [];
    const seen = new Set();

    const push = (el, key, name, matchBy, confidence) => {
      if (!key || !name) return;
      if (mode === 'conservative' && confidence !== 'high') return;
      const role = typeOf(el);
      const href = normalize(el.getAttribute('href') || '');
      const finalKey = normKey(key);
      if (!finalKey || seen.has(finalKey)) return;
      seen.add(finalKey);
      const finalName = String(name || '').slice(0, 80);
      const dangerous = containsAny(finalName, dangerousKeywords);
      const safe = containsAny(finalName, safeKeywords) || ['tab', 'button', 'link', 'select', 'combobox', 'checkbox', 'radio'].includes(role);
      result.push({
        key: finalKey,
        type: role,
        name: finalName,
        role,
        href,
        visible: true,
        enabled: enabled(el),
        dangerous,
        safe,
        descriptor: role + '｜' + finalName + (href ? '｜' + href : ''),
        confidence,
        matchBy
      });
    };

    for (const el of elements) {
      const tag = el.tagName.toLowerCase();
      const role = typeOf(el);
      const text = visibleText(el);
      const testId = normalize(el.getAttribute('data-testid') || el.getAttribute('data-test') || el.getAttribute('data-cy'));
      const aria = normalize(el.getAttribute('aria-label'));
      const title = normalize(el.getAttribute('title'));
      const placeholder = normalize(el.getAttribute('placeholder'));
      const nameAttr = normalize(el.getAttribute('name'));
      const href = normalize(el.getAttribute('href'));
      const label = labelFor(el);
      const displayName = testId || aria || title || label || placeholder || text || nameAttr || href || role;

      if (testId) push(el, 'testid|' + testId, displayName, 'data-testid/data-test/data-cy', 'high');
      else if (aria) push(el, 'aria|' + role + '|' + aria, displayName, 'aria-label', 'high');
      else if (title) push(el, 'title|' + role + '|' + title, displayName, 'title', 'high');
      else if (tag === 'a' && href && !/^javascript:/i.test(href) && href !== '#') push(el, 'href|' + href + '|' + (text || aria || title), displayName, 'href', 'high');
      else if (['input', 'select', 'textarea', 'combobox', 'checkbox', 'radio'].includes(role) || ['input', 'select', 'textarea'].includes(tag)) {
        if (label) push(el, 'form-label|' + role + '|' + label, label, 'form-label', 'high');
        else if (placeholder) push(el, 'placeholder|' + role + '|' + placeholder, placeholder, 'placeholder', 'high');
        else if (nameAttr) push(el, 'name|' + role + '|' + nameAttr, nameAttr, 'name', 'high');
      } else if (uniqueTextMatch && text) {
        const textKey = role + '|' + normKey(text);
        if ((textCount.get(textKey) || 0) === 1) push(el, 'unique-text|' + role + '|' + text, text, 'unique-text', 'high');
      }
      if (result.length >= limit) break;
    }
    return result;
  })()`;

  const raw = await page.evaluate(script) as Omit<DiscoveredInteraction, 'side'>[];
  return raw.map(x => ({ ...x, side }));
}

function groupByKey(items: DiscoveredInteraction[]): Map<string, DiscoveredInteraction[]> {
  const map = new Map<string, DiscoveredInteraction[]>();
  for (const item of items) {
    const list = map.get(item.key) ?? [];
    list.push(item);
    map.set(item.key, list);
  }
  return map;
}

function firstName(v2: DiscoveredInteraction[], v3: DiscoveredInteraction[], fallback: string): string {
  return v2[0]?.name || v3[0]?.name || fallback;
}

function describe(item: DiscoveredInteraction): string {
  return `${item.descriptor}；状态=${item.enabled ? '可用' : '禁用'}；匹配=${item.matchBy ?? '-'}；风险=${item.dangerous ? '危险动作' : item.safe ? '安全/普通动作' : '未知动作'}`;
}
