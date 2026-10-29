import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm, readFile, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { createJSONTableServer, normalizePath } from './server.mjs';

// A small DOM stand-in checks import state transitions without a browser dependency.
function page(html, fetch) {
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
    focus() {}, showPopover() {}, hidePopover() {}, close() { this.open = false; }, showModal() { this.open = true; },
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
    ...makeElement(), body: makeElement(), getElementById: get, createElement: makeElement, createElementNS: makeElement,
    querySelector: () => ({ content: html.match(/name="local-file-token" content="([^"]*)"/)[1] })
  };
  const context = vm.createContext({ document, fetch, AbortSignal });
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context);
  return { get, document, context };
}

test('JSON table: real path reads and unified import behavior', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'json-table-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, '中文 表格.json');
  const data = { columns: ['名称', '数值'], rows: [{ 名称: '<img src=x onerror=alert(1)>', 数值: false }] };
  await writeFile(path, '\uFEFF' + JSON.stringify(data));
  const server = createJSONTableServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const htmlResponse = await fetch(origin);
  const html = await htmlResponse.text();
  const token = html.match(/name="local-file-token" content="([^"]+)"/)[1];
  const request = (path, headers = {}) => fetch(`${origin}/api/read-file`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Local-Token': token, Origin: origin, ...headers },
    body: JSON.stringify({ path })
  });

  await t.test('absolute paths, quotes, spaces and file URLs read the actual file', async () => {
    for (const input of [path, `"${path}"`, `'${path}'`, pathToFileURL(path).href]) {
      const response = await request(input);
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.path, path);
      assert.deepEqual(JSON.parse(result.text.replace(/^\uFEFF/, '')), data);
    }
    assert.throws(() => normalizePath('relative.json'), /绝对路径/);
    assert.throws(() => normalizePath('/tmp/secrets.txt'), /\.json/);
  });

  await t.test('missing files, directories and oversized files have useful errors', async () => {
    assert.match((await (await request(join(directory, 'missing.json'))).json()).error, /找不到文件/);
    const folder = join(directory, 'folder.json');
    await mkdir(folder);
    assert.match((await (await request(folder)).json()).error, /不是普通文件/);
    const large = join(directory, 'large.json');
    await writeFile(large, '');
    await truncate(large, 20 * 1024 * 1024 + 1);
    assert.match((await (await request(large)).json()).error, /超过 20 MB/);
  });

  await t.test('foreign pages, invalid tokens and alternate hosts cannot read files', async () => {
    for (const headers of [{ Origin: 'https://example.com' }, { 'X-Local-Token': '' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
      assert.equal((await request(path, headers)).status, 403);
    }
    const { request: httpRequest } = await import('node:http');
    const status = await new Promise(resolve => {
      const req = httpRequest(origin, { headers: { Host: 'attacker.invalid' } }, response => { response.resume(); resolve(response.statusCode); });
      req.end();
    });
    assert.equal(status, 403);
    assert.equal(htmlResponse.headers.get('access-control-allow-origin'), null);
    assert.match(htmlResponse.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  });

  const { get, document, context } = page(html, (url, options) => fetch(new URL(url, origin), options));
  const settle = async () => {
    for (let i = 0; i < 100 && vm.runInContext('loading', context); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(vm.runInContext('loading', context), false);
  };
  await t.test('pasted path imports directly without opening the file picker', async () => {
    assert.equal(get('path-form').hidden, false);
    get('path').value = path;
    get('path-form').events.submit({ preventDefault() {} });
    await settle();
    assert.equal(get('file').clicked, undefined);
    assert.equal(get('table').hidden, false);
    assert.equal(get('filename').textContent, '中文 表格.json');
    assert.equal(get('filename').title, path);
    assert.equal(get('count').textContent, '1 行 · 2 列');
    assert.equal(get('table').children[1].children[0].children[0].children[0].textContent, data.rows[0].名称);
  });
  await t.test('failed path imports preserve the displayed table and allow retry', async () => {
    const previous = get('table').children;
    get('path').value = join(directory, 'missing.json');
    get('path-form').events.submit({ preventDefault() {} });
    await settle();
    assert.equal(get('table').children, previous);
    assert.match(get('error').textContent, /找不到文件/);
    assert.equal(get('count').textContent, '1 行 · 2 列');
    assert.equal(get('load-path').disabled, false);
  });
  await t.test('file picker and drag/drop both import immediately', async () => {
    get('import').events.click();
    assert.equal(get('file').clicked, true);
    get('file').files = [new File([JSON.stringify(data)], 'chosen.json')];
    await get('file').events.change();
    assert.equal(get('filename').textContent, 'chosen.json');
    assert.equal(get('path').value, '');
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
  await t.test('standalone HTML only offers working input methods', async () => {
    const standalone = page(await readFile(new URL('./index.html', import.meta.url), 'utf8'));
    assert.equal(standalone.get('path-form').hidden, true);
    standalone.get('import').events.click();
    assert.equal(standalone.get('file').clicked, true);
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
