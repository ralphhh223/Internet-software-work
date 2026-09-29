# tests/ — 第 4 课回归测试

一条命令跑全部：

```bash
node tests/run.js
```

或单独跑：

```bash
node tests/split.test.js                              # 切分策略，32 条断言
node tests/embed-vecstore.test.js                     # 嵌入 + 向量库，29 条断言
node --experimental-sqlite --no-warnings tests/retrieval.e2e.js   # 后端端到端，103 条断言
```

## 套件说明

| 文件 | 覆盖 |
|---|---|
| `split.test.js` | `auto` / `custom` / `hierarchy` 三种策略；参数边界（100–2000、重叠 0–50%）；预处理不改写原文；**偏移可回溯**（`original.slice(start,end).trimEnd() === chunk_text`）；hierarchy 二次切分不跨章 |
| `embed-vecstore.test.js` | 本地嵌入确定性、L2 归一化、同主题可分；向量库 payload 恰为 5 项且不含正文；**主键三相等**；班级过滤；`minScore` 丢弃；掉线降级；JSON 落盘往返 |
| `retrieval.e2e.js` | 真起服务、从**空库**首启，13 节覆盖：切分与索引 → 存储二分 → 三模式检索 → 可回溯 → 班级隔离 → 角色权限 → 问答 → 错误与降级 → 上传自动切分 → 重建索引 → 元信息 |

## 设计要点

- **e2e 刻意从空库跑起**（`CAMPUSCLAW_DATA_DIR` 指向 `tests/_tmp_smoke`），
  走的是用户真实首次运行路径：自动建表、建账号、写种子材料、逐份建索引全部真跑一遍。
  带上真实库会污染语料，让断言变成「依赖上一轮遗留数据」。
- **降级用测试钩子**：`CAMPUSCLAW_TEST_HOOKS=1` 时挂载
  `POST /api/retrieval/__test__/outage`（**仍需登录**，不是公开接口）来模拟向量库掉线。
  生产默认关闭。
- 结果写在 `last-run-*.txt`，便于在 IDE 里直接看断言明细（工具里 console 输出可能不显示）。

## 注意

- e2e 会占用端口 **8137**，跑之前先确认没有别的实例在跑。
- 临时库在 `tests/_tmp_smoke`，跑完自动删除；异常退出时可能残留，手动删掉即可。
