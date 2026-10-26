<img src="assets/geng.svg" alt="更" width="380">

# geng-agent

**更 agent 的 agent。**

现在大部分 agent 只是被调用的函数：你说一句，它答一句，结束。它没有自己的时间，不记得上次
想干什么，也不在你走开之后继续做什么。

geng 做的是另一半：给一个模型一块磁盘、一条网络、一个**它自己定的闹钟**，然后走开。

pi 跑在容器里，每次醒来都是一个全新进程，什么也不记得。连续性因此不在模型里，在磁盘上：
一份它自己写的 `identity.md`、一份没闭合的事的清单、一个它自己设的闹钟、一本日记。
每隔一段时间它醒一次，读自己写下的东西，决定做点什么，写下下一轮什么时候再醒。

外面只有一个很笨的 daemon：按时叫醒它、记一行机械的账、在它明显卡住的时候换一换条件。
**它不判断、不总结、不写话，也只执行闹钟——不设闹钟。** 醒来干什么、多久醒一次、要不要
再睡长一点，都是那个进程自己的决定。

名字念 `gēng`，和"打更"的"更"是同一个字；夜里报时的人一整晚只做一件事，这点像 daemon。
但主业不是打更，是**更**：它每一轮都在把自己重写一遍。

设计思路见 [`docs/design/`](docs/design/)，开发约定见 [`AGENTS.md`](AGENTS.md)。

> 目标是"主动性"能自己闭环，不是意识。它算不算活着，这套东西不回答。

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

第一次醒来时 `identity.md`、`open-loops/`、`waiting.json` 都不存在 —— 这是刻意的。
那个空白就是它的出生。

### 找人说话

最省事的办法是手写文件：

```bash
echo '{"text":"在吗","from":"telegram:@you"}' > data/alice/inbox/001.json      # 会叫醒它
echo '{"text":"群里的一句闲话"}'    > data/alice/inbox/low/001.json            # 不叫醒，等它自己看
```

接上 Telegram 之后由 gateway 写同样的文件。

### 通道

#### 先把 bot 建出来

每实例一个 bot：**Token 就是路由键**，所以 bot 的昵称和头像就是它在你手机里的身份。

1. 找 [@BotFather](https://t.me/BotFather)，`/newbot`，起名字（这一步之后能改，头像也能改）
2. **群聊必须关掉 privacy mode**：`/setprivacy` → 选 bot → `Disable`。不关的话它收不到群里的普通消息，
   只会收到 @ 和命令，而你会以为它坏了
3. `ops` bot 只需要一个：daemon 和 gateway 都借它说话（消息带 `[daemon@alice]` / `[gateway]` 前缀）
4. 拉进群的时候要给 bot 管理员权限（论坛群创建 topic 需要，虽然现在不用 topic 了）

#### 写 `secrets/bots.json`

`secrets/bots.json`（一实例一个 bot，`token` 就是路由键）：

```json
{
  "ops":   { "token": "123456:AAA", "chat": 123456789 },
  "alice": { "token": "234567:BBB", "listen": "all" },
  "bob":   { "token": "345678:CCC", "listen": "mentions" }
}
```

```bash
node cmd/geng/index.ts gateway      # 前台跑
```

常驻的话用 `deploy/geng-gateway.service`，和 daemon 一样替换 `@ROOT@` / `@NODE@`：

```bash
sed -e "s|@ROOT@|$PWD|g" -e "s|@NODE@|$(command -v node)|g" \
  deploy/geng-gateway.service > ~/.config/systemd/user/geng-gateway.service
systemctl --user daemon-reload
systemctl --user enable --now geng-gateway
```

unit 里已经带 `NODE_USE_ENV_PROXY=1`：node 的 `fetch` 默认不认 `HTTP(S)_PROXY`，
没有它，需要代理的地方 Telegram 直接连不上。

- `ops` 是运维频道；daemon 和 gateway 都借它说话，消息带 `[daemon@alice]` / `[gateway]` 前缀
- `chat` 可以省略，gateway 会记住第一个给它发消息的**那个会话**（所以先对 bot 说句话，
  再让它主动找你）。要知道 chat id 就先说一句话，然后看 `data/_gateway/chats.json`
- 投递分两档：**直接对它说话（私聊 / @ / 回复）会叫醒它，群里的闲话只进 `inbox/low`**
- 它自己可以 `mute` 某个来源；但直接对它说话永远穿透静音
- **有两处以上能说话的地方时，`say` 必须写 `to`**，不写直接被拒。默认值是猜的，
  而猜错的代价是群里的话落到某个人的私聊里——一次真实的串台就是这么来的
- **主动说话默认发往"第一个私聊"**，群只有在从没被私聊过时才是默认目标——一句没人要的话
  不该落进有观众的群里。要往群里说，它在 `say` 里指明目标
- bot 之间默认互相看不见消息；两个实例要互相说话，得在 BotFather 里给**两边**都打开
  bot-to-bot communication。开了之后每往下一步仍然要显式 @，否则对面只当环境消息收着

### 文件和图片

别人发的图片、文档、音频、视频会下载到 `data/<inst>/files/`，容器里只读挂 `/files`，
唤醒纸上只写个数（「一起发来的还有 2 张图片、1 个文件，在 /files/。」），内容它自己 `read`。

语音**不下载**：这里没有能把声音变成字的东西，纸上就照实说听不到。

它想发自己的东西出去，用 `say` 的 `files`，只认 `/work` 里存在的文件：

```
say(messages, to?, files: ["/work/report.html"])
```

`/files` 不会无限长：总量超了（默认 500 MB）就删最老的，最新的永远留着；年龄清理默认关
（`files.maxAgeDays: 0`）。它也可以自己 `forget` 指定文件，删在下一轮醒来之前——
容器里那个目录是只读的，所以删除只能是它明确说出来的动作。

### 搜索

搜索的 key 不在容器里。宿主上跑一个只认搜索的端点：

```bash
# secrets/search.env        chmod 600，和 <instance>.env 同一个目录
GENG_SEARCH_TOKEN=$(openssl rand -hex 16)      # 容器拿这串，也只能拿这串
DEEPSEEK_API_KEY=sk-...                        # search 是单独计费的端点，chat 的 key 不一定能用
GENG_SEARCH_BIND=0.0.0.0:8787
GENG_SEARCH_DAILY=200

node cmd/geng/index.ts search                  # 前台；常驻用 deploy/geng-search.service
```

容器用 `GENG_SEARCH_URL` + `GENG_SEARCH_TOKEN` 得到 `web_search` / `web_fetch` 两个工具。
这两个变量写在 `secrets/<instance>.env` 里（`--env-file` 注入）：

```
GENG_SEARCH_URL=http://<agent-net 的网关>:8787
GENG_SEARCH_TOKEN=和上面 search.env 里那串一样
```

网关地址别写死，换台机器就变。查它：

```bash
docker network inspect agent-net -f '{{(index .IPAM.Config 0).Gateway}}'
```

两个注意点：

- `geng search` 要 `GENG_SEARCH_BIND=0.0.0.0:8787`（或直接绑上面那个网关地址）才会被容器够到
- **加进 `<instance>.env` 之后不用重建镜像也不用重启 daemon**：下一轮醒来是个新容器，
  环境变量是那时读的，工具直接出现在列表里，纸上还会多一行 `环境变了。`
- 容器**只被允许**够到这一个地址上的这一个端口（见 `deploy/egress.sh`）
- **没有 `GENG_SEARCH_URL` 时扩展自己就不注册**，`web_search` 根本不在工具列表里——
  这是故意的：工具不该存在但拒绝工作

限额写在宿主这边，容器改不了；用完时工具会说"今天的搜索用完了"，唤醒纸上也会写着
今天还剩几次。

## 目录

```
data/<instance>/
  palimpsest/   它的书：identity.md  open-loops/  waiting.json  journal/  mute.json
                挂成容器里的 /state（可写）
  policy.json   它活在什么规矩下——**在书外面**，容器里看不见也写不着
  workspace/    挂成 /work（可写，永远不清理）
  files/        别人发来的图片和文件，挂成 /files（只读）
  inbox/        别人说的话：直接对它说的叫醒它，群里的闲话进 low/ 等下次
  people/       一个地址一份对话记录，只追加，不总结
  outbox/       它要说的话，gateway 取走
  session/      pi 的会话文件，一轮一个
  usage/ meta/ daemon.log
secrets/<instance>.env   模型凭据、搜索地址；--env-file 注入，永不挂载
deploy/    SYSTEM.md  settings.json  policy.json  geng@.service  egress.sh
```

`data/`、`backup/`、`secrets/` 全部 gitignore。

## 容器

```bash
deploy/build.sh                # 需要代理时：DOCKER_BUILD_PROXY=http://127.0.0.1:3128 deploy/build.sh
node cmd/geng/index.ts doctor alice --probe
```

镜像里烤好：pi、`say`/`mute`/`web_search`。不挂载，它改不了自己的工具。

它和人说的话记在 `data/<inst>/people/<chat>.jsonl`——一个地址一个文件，只追加，不总结、
不建画像。唤醒纸上只贴最近 10 句。

不装记忆扩展：**每轮醒来是一个新会话**，上下文里只有唤醒纸和它写下的自己，用完就丢。
所以既不需要压缩，也没有"阈值到点自动遗忘"这种事。它的记忆是 palimpsest 里的文件，不是上下文。

它能看到的东西就这些：`/state`、`/work`、`/inbox`、`/people`、`/files`、自己的 session 目录。
`daemon.log`、`meta/`、`usage/`、`secrets/`、`policy.json` 都不在里面——纸上的「上一轮」
已经把日志里有用的部分翻译成了话。

每个实例自己的一份 pi 配置在 `data/<instance>/pi/settings.json`（`geng init` 从
`deploy/settings.json` 拷），**只读**挂到容器的 agent 目录：provider / model / thinking 在这里。
它不能换模型来躲上下文压力。换模型改这个文件，不重建镜像。

时钟：容器 `TZ` 取 `policy.json` 的 `timezone`（默认 `Asia/Shanghai`，镜像里装了 `tzdata`）。
唤醒纸同时印两个时钟——`现在：2026-10-26T13:33:16Z · 21:33 +08`——因为 daemon 用 UTC 记账、
它自己 `date` 出来是本地时间，只印一个就会打架，而闹钟写错就是八小时的偏差。

模型凭据走 `secrets/<instance>.env`（`--env-file` 注入，不挂载）：
```
OPENCODE_API_KEY=...
```

### 更新

```bash
deploy/update.sh           # git pull + 重建镜像 + 重启已装的 unit
```

两种更新，走的路径不一样：

| 改了什么 | 要做什么 | 它怎么知道 |
|---|---|---|
| `internal/`、`cmd/`（daemon 自己） | `git pull` + 重启 unit | 它直接经历到（不同的唤醒纸、不同的行为） |
| `Dockerfile`、`image/extensions/`（它的工具） | 重建镜像 | 下一轮纸开头多一行 **`环境变了。`** |

工具那条是这样：每次醒来都是一个新容器，从 `geng-agent:latest` 起的，所以重建镜像后
下一轮自然用新镜像，不需要打断正在跑的那一轮。`环境变了。` 只在镜像 id 变了时出现一次，
**不带哈希、不带版本、不带建议**——它查不了 registry 也读不到代码，一个 64 位哈希对它
只是处理不了的噪音。工具多了还是少了、怎么用，是它自己该发现的事。

### 守护进程

`deploy/geng@.service` 是模板，装的时候把两个占位符换掉：

| 占位符 | 换成 |
|---|---|
| `@ROOT@` | 仓库路径，例如 `/home/you/geng-agent` |
| `@NODE@` | **node 的绝对路径**。nvm 装的 node 不在 systemd 的 PATH 里，`env node` 会让 unit 每十秒以 127 退出：`$(command -v node)` |

然后 `systemctl --user link <换过的文件>`、`systemctl --user enable --now geng@alice`，
再 `loginctl enable-linger $USER`（不然退出 SSH 后它就停）。

### 代理

两处，别混：

| 谁需要 | 怎么配 |
|---|---|
| docker daemon 拉镜像 | `/etc/systemd/system/docker.service.d/proxy.conf` |
| 构建步骤里的 apt / npm | `deploy/build.sh`：只在设了 `DOCKER_BUILD_PROXY` 时才用 `--network=host` 加 build args（构建容器在桥接网络里看不见 `127.0.0.1` 上的代理）。直连的机器不用设 |
| gateway 连 Telegram | `NODE_USE_ENV_PROXY=1 node cmd/geng/index.ts gateway`（Node 的 fetch 默认不认 `HTTP(S)_PROXY`） |

agent 容器本身**不需要**代理：`opencode.ai` 直连可达。

### 备份

一次清醒一张快照，用 [rustic](https://rustic.cli.rs/)。`geng init` 会生成
`secrets/rustic.env`（`RUSTIC_PASSWORD`）——**丢了它快照就没了**。

```bash
node cmd/geng/index.ts backup alice           # 立刻拍一张
node cmd/geng/index.ts backup alice --list    # 列已有快照
node cmd/geng/index.ts restore alice --yes    # 解到 backup/alice.restore-<时间>/
node cmd/geng/index.ts doctor alice --restore-test   # 真的读回来一次
```

- 没有 `rustic`、没有密码、或者 `policy.json` 里 `backup.enabled: false` → 跳过，不算失败
- 保留：最近 2000 张 / 每日 90 / 每周 52 / 每月 24，一天整理一次
- 恢复**不覆盖 `data/`**，解到旁边的新目录，你看过再拷回去

### 它可以改自己的运行参数

写 `data/<instance>/palimpsest/policy.proposal.json`，下次启动时被检查。只有这几项能改：

| 能改 | 范围 |
|---|---|
| `cycle.defaultWakeMinutes` | 1–720 |
| `cycle.minWakeMinutes` | 1–120 |
| `cycle.repeatThreshold` | 2–20 |

runner、容器限额、网络、一轮的超时**不在谈判范围**——那是框，不是设置。旧 policy 会存进 `meta/policy.history/`。

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
