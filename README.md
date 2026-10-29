# json-table

让 Agent 用 JSON 文件交付表格，用浏览器阅读。Agent 可直接读写文件，也可用 jq 处理数据，无需调用表格平台。

## 使用

1. 将 [SYSTEM_PROMPT.md](./SYSTEM_PROMPT.md) 复制到 Agent 的系统提示词中。
2. 让 Agent 生成表格 JSON 文件。
3. 用浏览器直接打开 [index.html](./index.html)。

点击顶部「选择文件…」，或直接将一个 JSON 文件拖到页面任意位置打开。无需启动服务。

页面无需安装依赖，文件仅在本机处理，最大 20 MB。支持排序、多列筛选、调整列宽、隐藏和冻结列，以及查看单元格全文。

## 数据格式

```json
{
  "columns": ["事项", "数量", "已完成"],
  "rows": [
    {"事项": "接口验证", "数量": 3, "已完成": true},
    {"事项": "异常排查", "数量": 1, "已完成": false}
  ]
}
```

`columns` 决定列顺序，列名非空且唯一；每行字段与列名一致。保留数值、布尔值等 JSON 类型，缺失值用 `null`，订单号等标识用字符串。

## 开发

运行测试需要 Node.js 24+，无第三方依赖。页面本身不需要 Node.js。

```sh
npm test   # 运行测试
```

所有文件放在根目录：`index.html` 是独立页面，`json-table.test.mjs` 是测试，`SYSTEM_PROMPT.md` 是用户提示词，`package.json` 定义测试命令。
