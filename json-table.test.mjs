import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// A small DOM stand-in checks import and filter interactions without a browser dependency.
function page(html) {
  const makeElement = () => ({
    get value() { return this._value ?? ''; }, set value(value) { this._value = String(value); },
    textContent: '', hidden: false, children: [], events: {}, attributes: {}, style: {},
    addEventListener(type, handler) { this.events[type] = handler; },
    append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } },
    replaceChildren(...children) { this.children = []; this.append(...children); },
    replaceWith(child) { const index = this.parent.children.indexOf(this); child.parent = this.parent; this.parent.children[index] = child; },
    get tBodies() { return this.children.slice(1); },
    get tHead() { return this.children[0]; },
    get rows() { return this.children; },
    setAttribute(key, value) { this.attributes[key] = value; },
    click() { this.clicked = true; },
    focus() {}, showPopover() { this.open = true; }, hidePopover() { this.open = false; }, close() { this.open = false; }, showModal() { this.open = true; },
    getBoundingClientRect() { return { left: 100, bottom: 120 }; },
    offsetWidth: 300, offsetHeight: 400,
    classList: {
      values: new Set(),
      add(value) { this.values.add(value); }, remove(value) { this.values.delete(value); },
      toggle(value, active) { if (active) this.values.add(value); else this.values.delete(value); },
      contains(value) { return this.values.has(value); }
    }
  });
  const elements = new Map();
  for (const [, id] of html.matchAll(/id="([^"]+)"/g)) {
    assert.ok(!elements.has(id), `duplicate id: ${id}`);
    elements.set(id, makeElement());
  }
  const get = id => { assert.ok(elements.has(id), id); return elements.get(id); };
  get('table').hidden = true;
  const document = {
    ...makeElement(), body: makeElement(), getElementById: get, createElement: makeElement, createElementNS: makeElement
  };
  const context = vm.createContext({ document, innerWidth: 1024, innerHeight: 768 });
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context);
  return { get, document, context };
}

test('standalone JSON table file import behavior', async t => {
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  const data = { columns: ['名称', '数值'], rows: [{ 名称: '<img src=x onerror=alert(1)>', 数值: false }] };
  const { get, document, context } = page(html);
  const settle = async () => {
    for (let i = 0; i < 100 && vm.runInContext('loading', context); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(vm.runInContext('loading', context), false);
  };
  await t.test('file picker and drag/drop both import immediately', async () => {
    get('import').events.click();
    assert.equal(get('file').clicked, true);
    get('file').files = [new File([JSON.stringify(data)], 'chosen.json')];
    await get('file').events.change();
    assert.equal(get('filename').textContent, 'chosen.json');
    assert.equal(get('error').hidden, true);
    const file = new File([JSON.stringify(data)], 'dropped.json');
    document.events.drop({ dataTransfer: { types: ['Files'], files: [file] }, preventDefault() {} });
    await settle();
    assert.equal(get('filename').textContent, 'dropped.json');
    document.events.drop({ dataTransfer: { types: ['Files'], files: [file, file] }, preventDefault() {} });
    assert.match(get('error').textContent, /每次拖入一个/);
  });
  await t.test('invalid JSON and schema preserve data; zero rows render correctly', async () => {
    const previous = get('table').children;
    for (const text of ['{invalid', '{"columns":["x","x"],"rows":[]}', '{"columns":["x"],"rows":[{"y":1}]}']) {
      context.file = new File([text], 'invalid.json');
      await vm.runInContext('importFile(file)', context);
      assert.equal(get('table').children, previous);
      assert.equal(get('error').hidden, false);
    }
    context.file = new File(['{"columns":["x"],"rows":[]}'], 'empty.json');
    await vm.runInContext('importFile(file)', context);
    assert.equal(get('table').children[1].children[0].children[0].textContent, '暂无数据');
  });
  await t.test('BOM, oversized files and read failures preserve import behavior', async () => {
    context.file = new File(['\uFEFF' + JSON.stringify(data)], '中文 表格.json');
    await vm.runInContext('importFile(file)', context);
    assert.equal(get('filename').textContent, '中文 表格.json');
    assert.equal(get('count').textContent, '1 行 · 2 列');
    assert.equal(get('table').tBodies[0].children[0].children[0].children[0].textContent, data.rows[0].名称);
    const previous = get('table').children;
    for (const file of [
      { name: 'large.json', size: 20 * 1024 * 1024 + 1, text() { assert.fail('must reject before reading'); } },
      { name: 'unreadable.json', size: 1, async text() { throw new Error('读取失败'); } }
    ]) {
      context.file = file;
      await vm.runInContext('importFile(file)', context);
      assert.equal(get('table').children, previous);
      assert.equal(get('filename').textContent, '中文 表格.json');
      assert.equal(get('count').textContent, '1 行 · 2 列');
      assert.match(get('error').textContent, /仍保留/);
      assert.equal(get('import').disabled, false);
      assert.equal(get('table').inert, false);
    }
  });
  await t.test('loading prevents simultaneous imports and permits retry', async () => {
    let finishRead;
    context.file = { name: 'slow.json', size: 1, text: () => new Promise(resolve => { finishRead = resolve; }) };
    const pending = vm.runInContext('importFile(file)', context);
    assert.equal(get('import').disabled, true);
    assert.equal(get('table').inert, true);
    context.file = { name: 'ignored.json', size: 1, text() { assert.fail('must ignore overlapping imports'); } };
    await vm.runInContext('importFile(file)', context);
    finishRead(JSON.stringify(data));
    await pending;
    assert.equal(get('filename').textContent, 'slow.json');
    assert.equal(get('import').disabled, false);
    assert.equal(get('table').attributes['aria-busy'], 'false');
  });
  await t.test('drag hints only appear for files and clear after leaving or dropping', async () => {
    const event = types => ({ dataTransfer: { types }, preventDefault() {} });
    const dragging = () => document.body.classList.contains('dragging');
    document.events.dragenter(event(['text/plain']));
    assert.equal(dragging(), false);
    document.events.dragenter(event(['Files']));
    document.events.dragenter(event(['Files']));
    assert.equal(dragging(), true);
    document.events.dragleave(event(['text/plain']));
    document.events.dragleave(event(['Files']));
    assert.equal(dragging(), true);
    document.events.dragleave(event(['Files']));
    assert.equal(dragging(), false);
    document.events.dragenter(event(['Files']));
    document.events.drop({ dataTransfer: { types: ['Files'], files: [] }, preventDefault() {} });
    assert.equal(dragging(), false);
  });
});

test('column sorting, combined filters and resetting the view', async () => {
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  const { get, context } = page(html);
  const data = {
    columns: ['名称', '金额', '完成'],
    rows: [
      { 名称: '任务10', 金额: 10, 完成: true },
      { 名称: '任务2', 金额: 2, 完成: false },
      { 名称: '任务1', 金额: null, 完成: false },
      { 名称: 'TASK A', 金额: 2, 完成: true },
      { 名称: '', 金额: '', 完成: false }
    ]
  };
  context.data = data;
  vm.runInContext('render(data)', context);
  const rows = () => JSON.parse(vm.runInContext('JSON.stringify(visibleRows())', context));
  const select = (column, values) => {
    context.column = column;
    context.values = values;
    vm.runInContext('openFilter(column, headings.get(column).filterButton); draftValues = new Set(values.map(valueKey))', context);
    get('column-filter').events.submit({ preventDefault() {} });
  };
  vm.runInContext("cycleSort('金额')", context);
  assert.deepEqual(rows().map(row => row.名称), ['任务2', 'TASK A', '任务10', '任务1', '']);
  assert.equal(get('table').children[0].children[0].children[1].attributes['aria-sort'], 'ascending');
  vm.runInContext("cycleSort('金额')", context);
  assert.deepEqual(rows().map(row => row.金额), [10, 2, 2, null, '']);
  vm.runInContext("cycleSort('金额')", context);
  assert.deepEqual(rows(), data.rows);
  vm.runInContext("cycleSort('名称')", context);
  assert.deepEqual(rows().map(row => row.名称), ['任务1', '任务2', '任务10', 'TASK A', '']);
  select('名称', ['任务10', '任务2', '任务1']);
  vm.runInContext('openFilter("完成", headings.get("完成").filterButton); draftValues = new Set([valueKey(false)])', context);
  get('column-filter').events.submit({ preventDefault() {} });
  assert.deepEqual(rows().map(row => row.名称), ['任务1', '任务2']);
  assert.equal(get('count').textContent, '2 / 5 行 · 3 列');
  assert.equal(get('reset-view').hidden, false);
  get('clear-filter').events.click();
  assert.equal(rows().length, 3);
  select('名称', ['TASK A']);
  assert.equal(rows()[0].名称, 'TASK A');
  select('名称', ['']);
  assert.equal(rows()[0].名称, '');
  select('名称', ['任务10', '任务2', '任务1', 'TASK A']);
  assert.equal(rows().length, 4);
  select('名称', []);
  assert.equal(rows().length, 0);
  assert.match(get('table').tBodies[0].children[0].children[0].textContent, /没有符合筛选条件/);
  get('reset-view').events.click();
  assert.equal(rows().length, 0, 'resetting sorting keeps filters');
  get('clear-all-filters').events.click();
  assert.deepEqual(rows(), data.rows);
  assert.equal(get('reset-view').hidden, true);
  assert.equal(get('count').textContent, '5 行 · 3 列');
  assert.deepEqual(data.rows.map(row => row.金额), [10, 2, null, 2, '']);
  vm.runInContext('openFilter("完成", headings.get("完成").filterButton); draftValues = new Set([valueKey(true)])', context);
  get('column-filter').events.submit({ preventDefault() {} });
  vm.runInContext('render(data)', context);
  assert.equal(rows().length, 5);
  assert.equal(get('reset-view').hidden, true);
});

test('column widths and full cell content survive sorting and filtering', async () => {
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  const { get, context } = page(html);
  const columns = Array.from({ length: 24 }, (_, index) => `field_${index}`);
  const text = '较长的原始内容，包含中文、English 和换行。\n'.repeat(30);
  const rows = Array.from({ length: 20 }, (_, index) => Object.fromEntries(columns.map((column, i) => [column, i === 3 ? text : i === 5 && index === 19 ? text : index])));
  context.data = { columns, rows };
  vm.runInContext('render(data)', context);
  const run = code => vm.runInContext(code, context);
  assert.equal(get('table').tHead.rows[0].children.length, 24);
  const initialWidth = run('columnState.get("field_3").width');
  assert.ok(initialWidth >= 240 && initialWidth <= 360);
  assert.ok(run('columnState.get("field_5").width') < 360, 'one outlier does not determine initial width');
  assert.ok(parseInt(get('table').style.width) > 2000, 'many columns keep widths rather than compressing to the viewport');
  run('setColumnWidth("field_3", 470); cycleSort("field_0"); filters.set("field_0", {mode:"equals",value:2}); updateView()');
  assert.equal(run('columnState.get("field_3").width'), 470, 'sorting/filtering keep the chosen width');
  assert.equal(get('count').textContent, '1 / 20 行 · 24 列');
  const longCell = get('table').tBodies[0].children[0].children[3];
  assert.equal(longCell.children[0].textContent, text, 'the full value is displayed directly');
  assert.equal(longCell.children.length, 1);
  run('render(data)');
  assert.equal(run('columnState.get("field_3").width'), initialWidth);
  assert.equal(get('table').tHead.rows[0].children.length, 24);
  assert.equal(run('filters.size'), 0);
});

test('value selection keeps JSON types, drafts, searched selections and facet counts', async () => {
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  const { get, context } = page(html);
  context.data = {
    columns: ['值', '地区'],
    rows: [1, '1', true, 'true', null, '', '张三', '李四', '张三'].map((value, i) => ({ 值: value, 地区: i % 2 ? '上海' : '北京' }))
  };
  const run = code => vm.runInContext(code, context);
  const open = column => { context.column = column; run('openFilter(column, headings.get(column).filterButton)'); };
  const submit = () => get('column-filter').events.submit({ preventDefault() {} });
  const search = value => { get('filter-search').value = value; get('filter-search').events.input(); };
  const option = text => get('filter-options').children.find(label => label.children[1].textContent === text);
  const toggle = (text, checked) => { const checkbox = option(text).children[0]; checkbox.checked = checked; checkbox.events.change(); };
  run('render(data)');
  open('值');
  assert.equal(get('number-filter').hidden, true, 'value columns do not expose a mode selector');
  assert.equal(get('number-mode').disabled, true);
  assert.equal(get('filter-values').hidden, false);
  assert.equal(get('filter-value').disabled, true);
  assert.equal(option('张三').children[2].textContent, '2');
  search('张');
  get('select-filter-values').events.click(); // Only deselect the searched value.
  search('李');
  toggle('李四', false);
  assert.equal(run('visibleRows().length'), 9, 'drafts and candidate search do not filter the table');
  get('close-filter').events.click();
  open('值');
  assert.equal(run('draftValues.size'), 8, 'closing without applying discards the draft');
  get('select-filter-values').events.click(); // Deselect all.
  toggle('1', true);
  toggle('李四', true);
  submit();
  assert.equal(run('visibleRows().length'), 2, 'same-column selected values use OR');
  assert.equal(run('typeof visibleRows()[0].值'), 'string', 'text 1 does not also select numeric 1');
  assert.equal(get('filter-chips').children.length, 1);
  assert.equal(get('active-filters').hidden, false);
  open('值');
  assert.equal(option('1 · 数字').children[2].textContent, '1', 'facet counts ignore this column’s applied filter');
  search('true');
  get('select-filter-values').events.click();
  submit();
  assert.equal(run('visibleRows().length'), 4, 'selecting search results preserves earlier selections');
  open('地区');
  get('select-filter-values').events.click();
  toggle('北京', true);
  submit();
  assert.equal(run('visibleRows().length'), 1, 'different columns use AND');
  assert.equal(run('visibleRows()[0].值'), true);
  open('值');
  assert.equal(option('true').children[2].textContent, '0', 'counts reflect other columns');
  assert.equal(option('是 · true').children[2].textContent, '1');
  get('clear-all-filters').events.click();
  open('值');
  get('select-filter-values').events.click();
  toggle('（空值 · null）', true);
  submit();
  assert.equal(run('visibleRows().length'), 1);
  assert.equal(run('visibleRows()[0].值'), null, 'null and an empty string are distinct options');
  get('filter-chips').children[0].events.click();
  assert.equal(run('visibleRows().length'), 9);
  assert.equal(get('active-filters').hidden, true);
  open('值');
  search('不存在');
  assert.equal(get('select-filter-values').disabled, true);
  assert.match(get('filter-options').textContent, /没有匹配/);
});

test('numeric comparisons, ranges, invalid input, empty selections and independent resets', async () => {
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  const { get, context } = page(html);
  context.data = { columns: ['金额', '完成'], rows: [-2.5, 0, 2, 10, null].map((value, i) => ({ 金额: value, 完成: i % 2 === 0 })) };
  const run = code => vm.runInContext(code, context);
  const open = column => { context.column = column; run('openFilter(column, headings.get(column).filterButton)'); };
  const submit = () => get('column-filter').events.submit({ preventDefault() {} });
  const apply = (mode, value, upper = '') => {
    open('金额'); get('number-mode').value = mode; get('number-mode').events.change();
    get('filter-value').value = value; get('filter-upper').value = upper; submit();
  };
  run('render(data)');
  open('金额');
  assert.equal(get('number-filter').hidden, false);
  assert.equal(get('number-mode').disabled, false);
  assert.equal(get('number-mode').value, 'gte');
  assert.equal(get('filter-values').hidden, true, 'numeric columns only expose comparisons');
  assert.equal(get('filter-value').type, 'number');
  assert.equal(get('filter-upper').disabled, true);
  apply('gte', '0');
  assert.equal(run('visibleRows().length'), 3, 'null does not compare as zero');
  apply('gt', '2'); assert.equal(run('visibleRows()[0].金额'), 10);
  apply('lte', '0'); assert.equal(run('visibleRows().length'), 2);
  apply('lt', '0'); assert.equal(run('visibleRows()[0].金额'), -2.5);
  apply('equals', '0'); assert.equal(run('visibleRows().length'), 1);
  open('金额'); submit();
  assert.equal(run('visibleRows()[0].金额'), 0, 'reopening and applying preserves a zero-valued condition');
  apply('between', '-2.5', '2'); assert.equal(run('visibleRows().length'), 3);
  assert.equal(get('filter-upper').disabled, false);
  for (const [value, upper] of [['5', '2'], ['', '2'], ['0', ''], ['Infinity', '2']]) {
    apply('between', value, upper);
    assert.equal(get('filter-error').hidden, false);
    assert.equal(get('column-filter').open, true);
    assert.equal(run('visibleRows().length'), 3, 'invalid input preserves the applied condition');
  }
  get('clear-filter').events.click();
  open('完成');
  assert.equal(get('number-filter').hidden, true);
  assert.equal(get('filter-values').hidden, false);
  assert.equal(get('filter-value').hidden, true);
  assert.equal(get('filter-upper').disabled, true, 'switching away from numeric ranges disables the upper bound');
  get('select-filter-values').events.click();
  submit();
  assert.equal(run('visibleRows().length'), 0, 'selecting nothing means no matches');
  open('完成');
  get('select-filter-values').events.click();
  submit();
  assert.equal(run('filters.has("完成")'), false, 'selecting every value removes that condition');
  run('cycleSort("金额")');
  get('clear-all-filters').events.click();
  assert.equal(run('sort.direction'), 'ascending', 'clear filters preserves sorting');
  assert.equal(get('active-filters').hidden, true);
  apply('gte', '2');
  get('reset-view').events.click();
  assert.equal(run('sort'), null);
  assert.equal(run('visibleRows().length'), 2, 'reset sorting preserves filtering');
});

test('text columns expose only keyword input and restore applied keywords', async () => {
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  const { get, context } = page(html);
  context.data = {
    columns: ['编号', '备注', '对象', '字符串数字'],
    rows: Array.from({ length: 101 }, (_, i) => ({ 编号: `id-${i}`, 备注: '很长的备注'.repeat(30), 对象: { id: i }, 字符串数字: String(i % 2) }))
  };
  const run = code => vm.runInContext(code, context);
  run('render(data)');
  for (const column of ['编号', '备注', '对象']) {
    context.column = column; run('openFilter(column, headings.get(column).filterButton)');
    assert.equal(get('number-filter').hidden, true);
    assert.equal(get('number-mode').disabled, true);
    assert.equal(get('filter-values').hidden, true);
    assert.equal(get('filter-value').type, 'text');
    assert.equal(get('filter-value').hidden, false);
    assert.equal(get('filter-value-label').textContent, '包含关键词（不区分大小写）');
  }
  run('openFilter("编号", headings.get("编号").filterButton)');
  get('filter-value').value = 'ID-10';
  get('column-filter').events.submit({ preventDefault() {} });
  assert.equal(run('visibleRows().length'), 2, 'keyword matching is case-insensitive');
  run('openFilter("编号", headings.get("编号").filterButton)');
  assert.equal(get('filter-value').value, 'ID-10');
  get('filter-value').value = '';
  get('column-filter').events.submit({ preventDefault() {} });
  assert.equal(run('filters.size'), 0, 'an empty keyword clears the filter');
  run('openFilter("字符串数字", headings.get("字符串数字").filterButton)');
  assert.equal(get('filter-values').hidden, false, 'numeric-looking strings use value selection');
  assert.equal(run('columnState.get("字符串数字").numeric'), false);
  run('render({columns:["空列"],rows:[]}); openFilter("空列", headings.get("空列").filterButton)');
  assert.equal(get('number-filter').hidden, true);
  assert.equal(get('filter-value').hidden, false, 'empty columns still have a keyword input');
});
