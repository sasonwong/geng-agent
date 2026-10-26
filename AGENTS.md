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
`pi` 装在容器镜像里，不算本仓库的依赖。记忆扩展不装：一轮一个会话。

## 测试

测试放 `test/`，不进 `internal/`——`internal/` 会被发布，测试不会。

只给"不平凡且有破坏性"的逻辑写断言，不追求覆盖率。已覆盖：session 尾部截断、
`waiting.json` 的解析。要加测试时按这个标准挑，别给 getter 写测试。
验收标准不是覆盖率，是"连跑一周不自燃"。

## 镜像

用 `deploy/build.sh` 构建，不要手写 `docker build`：代理只在那个脚本里配对了（构建容器在
桥接网络里看不见 `127.0.0.1` 上的代理，所以要 `--network=host` 加 build args）。

## 容器里的扩展

`image/extensions/*.ts` 在镜像里被拷进 `~/.pi/agent/extensions/`，不挂载 ——
它不该能改自己和人对谈用的工具。本地 runner 看不到这些扩展，这是已知差异。

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

## 文件格式与迁移

格式分两类（详见 `docs/design` 第 8.5 节）：接口（甲类，定死）和它的书（乙类，永不冻结）。

1. **改行为、改提示词、改唤醒纸 → 不重置。** 它的书继续用，下一轮醒来自然就是新的。
2. **加字段 → 随时**，不用迁移：读的一侧只用认识的字段。
3. **改名、删字段 → 必须带迁移 + doctor 检查**，迁移前拍一次快照。
4. **它的书（identity / journal / open-loops / work）永不迁移**，只通过系统提示词告知新约定。
5. **每加一个乙类路径，问一句：daemon 会不会解析它的内容？** 会，就改成数个数。
6. 迁移的测试对象是**真实数据的副本**（`rsync -a data/<inst>/ /tmp/copy/` 再跑 doctor），
   不是手写的 fixture——fixture 总会漏掉真实数据里恰好存在的那个前提。

## 收件箱的可见性

消息在送达之前一直算未读：`markSeen` 只标记**这一轮真正交给它的**（唤醒纸上的 + 运行中注入的）。
新消息如果在一轮跑到一半时到达而没被注入，必须留在盘上等下一轮——"标记读过但没给它看"就是
静默丢失，而且查不出来。

一轮里注入的每条消息，判据是 `turn_start`：`steer` 在下一次模型调用之前交付，所以注入之后
只要有一个 assistant 回合开始就算送到；没有就是没送到，`daemon.log` 记 `inj=N(unread=M)`，
文件不标已读。

## 文档

- `README.md` 只写项目简介和用法
- `docs/design/` 只写设计思路和下一步，不写"已完成"
- 本文件只写怎么开发，不写既成事实
- 全项目不写开发日志

## 提交

提交信息只描述相对于父提交的 diff，不叙述跨分支的对比。

## 提交

- **一个功能一个提交**：做完就提交，不用问。修 bug 单独一个提交，不把无关改动塞进同一个。
- 一条提交只描述它自己的 diff 相对父提交做了什么。
- 格式 `feat(scope): ...` / `fix(scope): ...` / `docs: ...`，英文，小写开头。
- 被要求整理历史时，再按功能 squash/rebase，保持线性。
