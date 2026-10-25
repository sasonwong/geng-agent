# geng-agent

让一个大模型在没有人在旁边的时候，仍然自己有事可做，而且做出的事说得通。

pi 跑在容器里，每次醒来是一个全新进程，什么也不记得。于是它的连续性不放在模型里，
放在磁盘上：一份自己写的 `identity.md`、一张没闭合的事的清单、一个自己定的闹钟、
一本日记。

外面只有一个很笨的 daemon。它不判断、不总结、不写话，只负责按时叫醒它、记录发生了什么、
以及在它卡住的时候换一换条件。闹钟是它自己设的 —— daemon 只执行。

设计思路见 [`docs/design/`](docs/design/)，开发约定见 [`AGENTS.md`](AGENTS.md)。

> 目标是"主动性"的完整闭环，不是意识。

## 用法

需要 Node ≥ 22.18（直接运行 TypeScript，没有构建步骤）。

```bash
node cmd/geng/index.ts init alice          # 建目录、落 policy、生成 secrets 模板
node cmd/geng/index.ts doctor alice        # 检查不变量
node cmd/geng/index.ts status alice        # 一屏看状态
node cmd/geng/index.ts daemon --instance alice          # 一直跑
```

`--root <path>` 换仓库根目录，默认是本仓库。

### 第一次醒来

1. 把模型凭据填进 `secrets/<instance>.env`（`chmod 600`，注入容器，永不挂载）
2. `doctor` 应该全 ok 或只剩 warn
3. `node cmd/geng-dev/index.ts packet --instance alice` 看一眼唤醒纸对不对（不花钱）
4. `node cmd/geng-dev/index.ts once --instance alice` 跑一次，验证 runner

第一次醒来时 `identity.md`、`open-loops.json`、`waiting.json` 都不存在 —— 这是刻意的。
那个空白就是它的出生。

### 找人说话

把一个 JSON 丢进 `data/<instance>/inbox/`：

```bash
echo '{"text":"在吗","from":"telegram:@you"}' > data/alice/inbox/001.json
```

下一轮醒来（或者它正睡着时被轮询发现）就会看到。gateway 属于阶段 2，现在手写文件即可。

## 目录

```
data/<instance>/
  palimpsest/    identity.md  open-loops.json  waiting.json  journal/  policy.json
  workspace/     挂成容器里的 /work
  session/       挂成 /home/agent/.pi/agent/sessions
  inbox/ outbox/ usage/ meta/ daemon.log
secrets/<instance>.env
deploy/    SYSTEM.md  policy.json  geng@.service  egress.sh
```

`data/`、`backup/`、`secrets/` 全部 gitignore。

## 开发套件

`cmd/geng-dev/` 是开发用入口，不随 npm 包发布（见 `package.json` 的 `files`）。
它只做不花钱的事，或者在一些前提成立时才动手：

```bash
node cmd/geng-dev/index.ts packet --instance alice   # 打印这次醒来的唤醒纸
node cmd/geng-dev/index.ts fake   --instance alice   # 造一份有内容的假状态
node cmd/geng-dev/index.ts once   --instance alice   # 前台跑一轮（daemon 在跑时会拒绝）
```

## runner

`policy.json` 里的 `runner` 决定 pi 怎么被拉起来：

| | 什么时候用 | 差别 |
|---|---|---|
| `local` | 开发 | 直接调用本机 `pi`；会话写进 `data/<i>/session`，但 `SYSTEM.md` 用的是本机那份 |
| `docker` | 生产 | 每轮一个 `--rm` 容器；`--user` 对齐 uid；子目录挂载；`SYSTEM.md` 与 `policy.json` 单文件只读 |
