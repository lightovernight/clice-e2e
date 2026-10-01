# 回放样例

运行任意一个样例（先执行过一次 `npm run setup`）：

```powershell
npm run e2e -- examples/lambda.cpp
```

`npm run setup` 会生成 `examples/compile_commands.json`：`issue-701.cpp` 使用 `-std=c++17`，其余使用 `-std=c++20`。这个文件含本机绝对路径，不进版本库。

| 文件 | 用途 |
| --- | --- |
| `nesting.cpp` | 普通花括号嵌套 |
| `class-members.cpp` | 类成员先准备、后填充 |
| `lambda.cpp`、`sort-lambda.cpp` | lambda |
| `template-variants.cpp` | 类模板、函数模板及其特化 |
| `issue-701.cpp` | [clice issue #701](https://github.com/clice-io/clice/issues/701) 中的原样复现代码 |

`issue-701.cpp` 是真实崩溃样例，经同一个生成器和回放器运行，没有使用额外的定点编辑或故障注入代码。

- 2026-09-26，runtime `0.1.0+gfd95eb3`：第 870 / 876 步发生 stateless worker 崩溃。输入 `new(&remain) mini_variant_impl(` 的左括号后，等待 `textDocument/completion` 时收到 WorkerCrash。
- 2026-09-30，runtime `0.1.0+g2aa3b56`：876 步全部通过。

这些是对应 runtime 的观测结果，不把“必须崩溃”或“必须通过”写成自动化测试断言。
