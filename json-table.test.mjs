import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// A small DOM stand-in checks import state transitions without a browser dependency.
function page(html) {
  const makeElement = () => ({
    value: '', textContent: '', hidden: false, children: [], events: {}, attributes: {}, style: {},
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
  const context = vm.createContext({ document });
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
  const apply = (column, mode, value = '') => {
    context.column = column;
    vm.runInContext('filterColumn = column; filterTrigger = { focus() {} }', context);
    get('filter-mode').value = mode;
    get('filter-value').value = value;
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
  apply('名称', 'contains', '任务');
  apply('完成', 'equals', 'false');
  assert.deepEqual(rows().map(row => row.名称), ['任务1', '任务2']);
  assert.equal(get('count').textContent, '2 / 5 行 · 3 列');
  assert.equal(get('reset-view').hidden, false);
  get('clear-filter').events.click();
  assert.equal(rows().length, 3);
  apply('名称', 'contains', 'task');
  assert.equal(rows()[0].名称, 'TASK A');
  apply('名称', 'empty');
  assert.equal(rows()[0].名称, '');
  apply('名称', 'not-empty');
  assert.equal(rows().length, 4);
  apply('名称', 'equals', '<script>');
  assert.equal(rows().length, 0);
  assert.match(get('table').tBodies[0].children[0].children[0].textContent, /没有符合筛选条件/);
  get('reset-view').events.click();
  assert.deepEqual(rows(), data.rows);
  assert.equal(get('reset-view').hidden, true);
  assert.equal(get('count').textContent, '5 行 · 3 列');
  assert.deepEqual(data.rows.map(row => row.金额), [10, 2, null, 2, '']);
  apply('完成', 'equals', 'true');
  vm.runInContext('render(data)', context);
  assert.equal(rows().length, 5);
  assert.equal(get('reset-view').hidden, true);
});

test('generic column widths, visibility, pinning and full text', async () => {
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  const { get, context } = page(html);
  const columns = Array.from({ length: 24 }, (_, index) => `field_${index}`);
  const text = '较长的原始内容，包含中文、English 和换行。\n'.repeat(30);
  const rows = Array.from({ length: 20 }, (_, index) => Object.fromEntries(columns.map((column, i) => [column, i === 3 ? text : i === 5 && index === 19 ? text : index])));
  context.data = { columns, rows };
  vm.runInContext('render(data)', context);
  const run = code => vm.runInContext(code, context);
  assert.equal(run('displayColumns().length'), 24);
  const initialWidth = run('columnState.get("field_3").width');
  assert.ok(initialWidth >= 240 && initialWidth <= 360);
  assert.ok(run('columnState.get("field_5").width') < 360, 'one outlier does not determine initial width');
  assert.ok(parseInt(get('table').style.width) > 2000, 'many columns keep widths rather than compressing to the viewport');
  run('setColumnWidth("field_3", 470); cycleSort("field_0"); filters.set("field_0", {mode:"equals",value:"2"}); updateView()');
  assert.equal(run('columnState.get("field_3").width'), 470, 'sorting/filtering keep the chosen width');
  run('columnState.get("field_7").pinned = true; refreshColumns()');
  assert.equal(run('displayColumns()[0]'), 'field_7');
  assert.equal(get('table').tHead.rows[0].children[0].classList.contains('pinned'), true);
  run('setColumnVisible("field_0", false)');
  assert.equal(run('displayColumns().length'), 23);
  assert.equal(run('visibleRows().length'), 1, 'hidden columns continue to filter');
  assert.equal(get('count').textContent, '1 / 20 行 · 23 / 24 列');
  get('show-all-columns').events.click();
  assert.equal(run('displayColumns().length'), 24);
  run('for (const column of loadedData.columns.slice(1)) setColumnVisible(column, false); setColumnVisible("field_0", false)');
  assert.equal(run('displayColumns().length'), 1, 'at least one column stays visible');
  get('show-all-columns').events.click();
  const longCell = get('table').tBodies[0].children[0].children[4];
  assert.equal(longCell.children[0].textContent, text, 'compact mode preserves the full value');
  assert.equal(longCell.children[1].textContent, '查看全文');
  longCell.children[1].events.click();
  assert.equal(get('detail-text').textContent, text);
  assert.equal(get('cell-detail').open, true);
  get('close-detail').events.click();
  assert.equal(get('cell-detail').open, false);
  get('display-mode').value = 'full';
  get('display-mode').events.change();
  assert.equal(get('table').classList.contains('compact'), false);
  assert.equal(get('table').tBodies[0].children[0].children[4].children.length, 1);
  get('reset-widths').events.click();
  assert.equal(run('columnState.get("field_3").width'), initialWidth);
  run('render(data)');
  assert.equal(run('displayColumns()[0]'), 'field_0');
  assert.equal(run('displayColumns().length'), 24);
  assert.equal(run('filters.size'), 0);
});
