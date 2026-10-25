# 开发方式

## 工具链

Node ≥ 22.18，直接跑 TypeScript（类型擦除），**没有构建步骤**。

```bash
npm run check     # tsc --noEmit
npm test          # node --test，测试在 test/ 下
node cmd/geng-dev/index.ts packet --instance <name>   # 不花钱地跑一遍唤醒纸
```

## TypeScript 约束

类型擦除只删类型，不转译语法，所以：

- **不用** `enum`、`namespace`、parameter properties、decorator
- import 一律带 `.ts` 后缀：`import { x } from "./policy.ts"`
- 类型导入写 `import type`
- 编辑器里 `tsconfig.json` 已开 `erasableSyntaxOnly`，写错会直接报错

## 依赖

**运行时依赖为零。** 想加一个包之前，先确认它不是三十行代码能解决的事
（`docker` 走 `spawn`，`telegram` 走 `fetch`，锁走 `flock`，测试走 `node:test`）。
`pi` 和 `pi-observational-memory` 装在容器镜像里，不算本仓库的依赖。

## 测试

测试放 `test/`，不进 `internal/`——`internal/` 会被发布，测试不会。

只给"不平凡且有破坏性"的逻辑写断言，不追求覆盖率。已覆盖：session 尾部截断、
`waiting.json` 的解析。要加测试时按这个标准挑，别给 getter 写测试。
验收标准不是覆盖率，是"连跑一周不自燃"。

## 边界

- **daemon 里不许出现需要读懂自然语言的分支。** 一旦发现自己在"如果日志里说它放弃了"，说明信号选错了，换个能 `wc -l` 出来的
- **daemon 不做判断、不总结、不写话，只填空**
- **不要为了多实例提前写协调逻辑**：路径从 `--instance` 派生就够了
- `data/`、`secrets/`、`backup/` 永不进 git；`secrets/` 永不挂载进容器

## 开发套件

`cmd/geng-dev/` 是开发入口，**不发布**（`package.json` 的 `files` 只列 `cmd/geng`）。
规矩：

- 生产命令（`cmd/geng`）只碰它该碰的；调试命令都在 `cmd/geng-dev`
- 调试命令要么不花钱，要么先确认前提成立（`once` 会先问锁）
- 新增调试命令时问一句：这个会不会在 daemon 跑着的时候动同一个 session

## 文档

- `README.md` 只写项目简介和用法
- `docs/design/` 只写设计思路和下一步，不写"已完成"
- 本文件只写怎么开发，不写既成事实
- 全项目不写开发日志

## 提交

提交信息只描述相对于父提交的 diff，不叙述跨分支的对比。
