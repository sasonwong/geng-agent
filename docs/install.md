# 装一台

从零到它自己醒过来。按"改不回来的先做"排序：宿主前置 → 实例 → 单元 → 可选能力 → 升级 → 排错。

一共三类东西，别混：

| 类别 | 举例 | 特点 |
|---|---|---|
| **宿主前置** | docker、linger | 一次性，有的要 sudo |
| **每实例** | `geng init`、一个 user unit、一份凭据 | 加一个实例就重复一遍 |
| **可选能力** | 网关、搜索、邮件、备份 | 不装就等于没有，且**不会有任何报错** |

先读一遍这张表，再决定要不要全装。缺一件不会让系统坏掉，只会让某一件事安静地不发生。

---

## 1. 宿主前置（一次性，要 sudo）

| 要什么 | 为什么 | 怎么验 |
|---|---|---|
| Node ≥ 22.21.0 | 直接跑 TypeScript（22.18 起就行），但网关的 `NODE_USE_ENV_PROXY=1` 要 22.21.0 / 24 起才生效 | `node --version` |
| node 的**绝对路径** | systemd 的 PATH 里没有 nvm；`env node` 会让 unit 每十秒以 127 退出 | `command -v node` 记下来 |
| docker + 当前用户在 `docker` 组 | 每轮醒来是一个 `--rm` 容器 | `docker ps`（不是 `sudo docker ps`） |
| `rustic`、`flock` | 备份、单实例锁（`flock` 写在 unit 里） | `rustic --version`、`flock --help` |

**docker 组要重新登录一次才生效。** 刚 `usermod -aG docker` 完就 `docker ps` 会报 socket 权限，
那不是装错了。

### 代理（可选）

直连可达的机器不用配。需要代理时是三处，别混：

| 谁 | 怎么配 |
|---|---|
| docker 拉镜像 | `/etc/systemd/system/docker.service.d/proxy.conf`（`NO_PROXY` 要含 localhost 和私网段） |
| 构建里的 apt / npm | `DOCKER_BUILD_PROXY=http://…:PORT deploy/build.sh`——构建容器在桥接网络里看不见 `127.0.0.1`，所以脚本只在设了它时才切 `--network=host` |
| 网关连 Telegram | `geng-gateway.service` 里的 `NODE_USE_ENV_PROXY=1`（Node 的 `fetch` 默认不读 `HTTP(S)_PROXY`）+ `secrets/gateway.env` 里的 `HTTP_PROXY`/`HTTPS_PROXY`；不写这个文件就是直连。**这个开关要 Node ≥ 22.21.0 或 ≥ 24**：更旧的 Node 会忽略它、绕过代理直连，症状和「Telegram 不通」一样；网关启动时会直接报版本，不会悄悄直连 |

**agent 容器本身不需要配代理**：它没有网络，模型和搜索走 socket，其余 HTTPS 走容器里的 3128。

### 出口代理（容器怎么上网）

容器是 `--network none`：没有接口、没有路由、没有 DNS。出去的路只有两条，都在 book socket 上：

```
127.0.0.1:11434   模型请求   daemon 补上 provider 的 key，转发到上游
127.0.0.1:3128     HTTP 代理  CONNECT 到放行名单里的主机
```

```jsonc
"container": {
  // 不写 = auto：用 daemon 自己环境里的 HTTPS_PROXY/ALL_PROXY；没有就直连
  "proxyChain": "auto",
  // "proxyChain": "http://127.0.0.1:10808"    // 链式，忽略环境
  // "proxyChain": "socks5://user:pass@host:1080"  // SOCKS5（带认证也行）
  // "proxyChain": "off"                        // 直连，即使环境里有代理
  "proxyAllow": ["*"],                         // 放行哪些名字；"!name" 排除
  "proxyAllowCidrs": ["0.0.0.0/0", "::/0",     // 放行哪些地址；"!cidr" 排除
                      "!10.0.0.0/8", "!172.16.0.0/12", "!192.168.0.0/16",
                      "!127.0.0.0/8", "!169.254.0.0/16", "!100.64.0.0/10"]
}
```

`off` 是给"环境里残留了一行 `HTTPS_PROXY`"准备的：写 `auto` 会照它走，写 `off` 才是不走。

这份文件写坏了它**不启动**：`proxyChain` 的 URL 解析不了（没有主机、端口不是数字）、
`proxyAllowCidrs` 里有一项不是网段、整数字段写成小数，都在启动前被拒——一份"看起来配了、其实
一路按默认在跑"的 policy 比启动失败难查十倍。

**两个名单，两把钥匙。** 名字（`proxyAllow`）在解析之前查，地址（`proxyAllowCidrs`）在解析之后查；
两关都过才放行——**配了 `proxyChain` 也一样**，链就在这台机器上的时候，"让链去连"绕过的正是地址那一条。
代价是链式代理下域名也必须能在这台机器上解析：解析不出来就拒绝，而不是把地址检查交给链。`!` 是排除，**永远赢，与顺序无关**——`["*", "!evil.com"]` 和 `["!evil.com", "*"]` 是同一件事。

默认值是"所有名字 + 所有地址，除了内网"：

```jsonc
"proxyAllow": ["*"],
"proxyAllowCidrs": ["0.0.0.0/0", "::/0", "!10.0.0.0/8", "!172.16.0.0/12", "!192.168.0.0/16",
                    "!127.0.0.0/8", "!169.254.0.0/16", "!100.64.0.0/10", "!0.0.0.0/8",
                    "!::1/128", "!fc00::/7", "!fe80::/10"]
```

私网那几条是**写出来的，不是代码里的规则**：要让容器进内网，删掉对应那一行——于是它在 diff 里。
`doctor` 会在这些网段被放开时 `warn`，并把后果说出来（`127.0.0.0/8` = 宿主的所有 loopback 服务、
`169.254.0.0/16` = 云元数据、`172.17.0.0/16` = 同机的其他容器）。只放开其中一小段也算：它比的是
区间，所以 `127.0.1.0/24` 一样会响——那不是"只是另一个网段"，是同一种东西。

名字放行、地址拒绝时，`net.log` 会写明缺的是哪一半。每一次连接都记一行
`data/<inst>/net.log`，成功时括号里是**命中的那条网段**（不是解析出的地址），失败时是原因：

```
2026-11-05T01:39:31.000Z 出去 github.com:443（0.0.0.0/0）
2026-11-05T01:39:31.400Z 拒绝 pi.dev:443（pi.dev 不在放行名单里）
2026-11-05T01:39:32.000Z 拒绝 git.internal:443（git.internal 指向 10.20.0.5，不在 proxyAllowCidrs 里）
```

它自己一个文件，因为一次 `git clone` 就是十几行；轮次行里仍然只有 `net=N` 这个数。

只代理 https：客户端用 `CONNECT`，明文 `http://` 的绝对地址请求会直接回 501，并说明要用
https（`CONNECT`）——不转发，也不假装成功。501 而不是 405：这个 501 说的是「这条路我不实现」，
而 JSON 路由对非 POST 也回 405，两个码一样的话，正文没被读的那次会当成「代理坏了」。

```bash
node cmd/geng/index.ts doctor --instance alice --probe   # 「只有代理能出去」：直连必须失败、代理必须通
```

---

## 2. 仓库与镜像

```bash
git clone https://github.com/sasonwong/geng-agent ~/geng-agent && cd ~/geng-agent
npm ci                                   # 只有 @types/node 和 typescript，运行时零依赖
npx tsc --noEmit && npm test             # 十秒内应该全绿
deploy/build.sh                          # 镜像：pi 的独立二进制 + gh + git（不含 node，也不含扩展）
```

**什么时候需要重建镜像**：`Dockerfile` 或 `deploy/checksums.txt` 变了。只改 `internal/`、
`cmd/` 不用重建——daemon 在宿主上跑，容器只装 pi 和它的工具链。

镜像里 pi 的独立二进制和 gh 都按版本钉死，下载后还要过 `deploy/checksums.txt` 里的
SHA-256。`packages` 那一层装扩展包用的 npm 包钉在同一个 `PI_VERSION` 上——两边版本漂了，
装出来的包目录要让第一次醒来才报错。所以**升版本必须同时改三处**：`GH_VERSION` /
`PI_VERSION` 两处 ARG，以及校验和清单里对应的行；少改一处，构建会直接失败，这比悄悄
换掉一个二进制要好。

扩展在 `image/extensions/`，构建时**不进镜像**：`book.ts`（`journal`/`discard`/`loop_open`/`loop_close`/`wait`）、
`recall.ts`（`recall`/`open`）、`files.ts`（`download`）、`say-mute.ts`（`say`/`listen`/`forget`/`mute`/`propose`）、
`websearch.ts`（`web_search`/`web_fetch`）。运行时只读挂载到 `/opt/geng/extensions`，容器里加载的是
这个目录**顶层**的每一个 `.ts`（`lib/` 里的共用代码不是扩展，也不会被加载）。所以改一个工具、或者
新加一个工具，都只要存盘：下一轮醒来读到的就是新文件，不用重建镜像。

容器里改不了、删不了这些文件。为什么必须只读、以及实例想加工具时该走哪条路，见 `AGENTS.md`
的「容器里的扩展」。

---

## 3. 第一个实例

```bash
node cmd/geng/index.ts init alice \
  --chain opencode-go/deepseek-v4.1-flash,opencode-go/beam-free \
  --upstream https://opencode.ai/inference/go/v1
```

`init` 会建目录树、从 `deploy/policy.json` 拷一份 policy、生成 `secrets/alice.env` 模板（600）、
从 `deploy/settings.json` 拷一份 pi 配置、生成 `secrets/alice.model.env` 和备份口令。
**它出生时不带 `identity.md`、不带一行日记、不带一件没闭合的事** —— 那几个空白就是它的出生。

四个参数是**这个实例的**决定，其余全是模板的：

| 参数 | 写进哪 | 默认 |
|---|---|---|
| `--chain a/b,c/d` | `secrets/<inst>.model.json`；第一条同时写进 settings 的 `defaultProvider`/`defaultModel` | 不写：没有回退 |
| `--model <id>` | `data/<inst>/pi/settings.json` 的 `defaultModel` | 模板里的那个 |
| `--upstream <url>` | `secrets/<inst>.model.env` 的 `GENG_MODEL_UPSTREAM` | opencode 的 `/go/v1` |
| `--image <tag>` | `data/<inst>/policy.json` 的 `container.image` | `geng-agent:latest` |
| `--timeout-min <n>` | `data/<inst>/policy.json` 的 `cycle.timeoutSec` | 30 |

`--model` 和 `--chain` 都能定主力，所以只能给一个。模型 key 不用手改文件：环境里有它就直接写进去。

```bash
OPENCODE_API_KEY=sk-... node cmd/geng/index.ts init alice --model …
```

`init` 只写这个实例自己的值，模板里其余的键原样保留——它不是 policy 编辑器。

### 3.1 policy 里剩下的东西

**只有容器这一条路。** 每一轮醒来都是一个容器：policy 里没有 `runner` 字段，也没有本机直跑的
分支。第一次跑之前建镜像就行（见第 2 节）。网络不用配：容器没有网络，出口只有 book socket 上的代理。
看得见的地方没有"忘了配"这一档——镜像不在就是每轮 `start-failed`，`daemon.log` 当场说话。

同一个文件里值得先看一眼的还有 `cycle.timeoutSec`（默认 1800 = 30 分钟）、`timezone`、
`files.maxMb`。这些是**框**，只有时机和阈值是它自己能改的（见第 7 节）。

### 3.2 填凭据

**两个文件，区别是容器看不看得见。**

`secrets/<实例>.model.env`（600）——模型密钥，**容器永远读不到**。每个实例一份：两个实例
可以问两个 provider，用一个文件就没法这么干：

```
OPENCODE_API_KEY=...          # 变量名跟着 provider 换（OPENAI_API_KEY / ANTHROPIC_API_KEY …）
GENG_MODEL_UPSTREAM=https://opencode.ai/inference/go/v1
```

`deploy/providers.json`（共享，进 git）——每个 provider 的真实地址，链里只写名字：

```json
{
  "opencode":    "https://opencode.ai/inference/openai/v1",
  "opencode-go": "https://opencode.ai/inference/go/openai/v1"
}
```

值写成对象时可以单独指定 key 的变量名（只写名字，凭据仍在那份 `.model.env` 里）：
`{ "url": "https://api.deepseek.com/v1", "key": "DEEPSEEK_API_KEY" }`。

`secrets/<实例>.model.json`（600，可选）——模型链，**第一条就是主力**：

```json
[
  "opencode-go/beam-free",
  { "provider": "opencode", "model": "big-pickle", "reasoningEffort": "low" },
  "opencode-go/deepseek-v4.1-flash"
]
```

它只在请求的模型名等于第一条时生效（别人的模型原样直通，不替它挑）；一条失败就换下一条，判据是
`status >= 400`、连不上、或 60 秒没有响应头；body 里的 `model`（以及那一条写了的 `reasoning_effort`）
换成那一条的，其余字节不动；流已经开始之后不再换；全都不行时返回**第一条**的状态和 body。
`daemon.log` 里的 `fb=N` 是这一轮被第 N 跳救回来的次数（会话里记的仍是 pi 以为的那个模型名）。

字符串和对象可以混用。对象多一个可选的 `reasoningEffort`：它按字面写进请求的 `reasoning_effort`，
取值 `minimal` / `low` / `medium` / `high` / `xhigh` / `max`；不写就沿用这一轮 pi 为主力选的档。
值不经过 fallback 模型的档位表——daemon 不认识 pi 的目录，所以这里写的是**线上值**，不是 pi 的档名。
这里只挡拼写，挡不住上游：某家网关不认这一档会回 400，而 400 在这个 proxy 里是「换下一跳」的信号，
所以写错一个档看起来像上游故障——`fb=N` 涨了先回来看这张表。
`off` 不在这里：要关思考就改主力的 `defaultThinkingLevel`。给第一条写这项会覆盖 pi 发出来的档，
而会话里记的仍是 settings 的档——要两边一致，第一条就别写。

**每条都要跟主条目同一个 API 家族**：body 不翻译，openai ↔ anthropic 之间不做。所以表里一个名字
只服务一族——要跨族，就另起一个表项名（比如 `opencode-go-anthropic` 指向
`https://opencode.ai/inference/go/anthropic`），把它当另一个 provider 写进链。

`GENG_MODEL_UPSTREAM` 现在是**回退**：`deploy/providers.json` 认得链的第一条（没有链时是 settings
的 `defaultProvider`）就以表为准，表里没有才读它。新实例不必写这一行，老实例不改也照常跑——
`doctor` 的「模型密钥」会说清当前读的是哪一个。

`deploy/models.json` 把 provider 的地址指向容器里的 `http://127.0.0.1:11434/model`，`apiKey` 只是一个
占位符（`"local"`）：pi 发出去的请求里没有任何真凭据，daemon 在转发时补上 `Authorization`。所以密钥
只在两处存在：宿主上的那个文件，和宿主到 provider 的那一段。**容器里、`env` 里、socket 上都没有它。**

`secrets/alice.env`（600）——`--env-file` 注入，容器里 `env` 能读到。**现在它不需要放任何凭据**：
搜索走 socket（能不能连上就是授权），模型和 GitHub 的凭据都在宿主上。
真要放点什么都行，只是记住它会进容器。

```bash
echo '<值>' | node cmd/geng/index.ts secrets set alice SOME_NAME
```

值**从 stdin 读**（argv 会在 `ps` 里露出去），同名行原地替换、注释和别的行一个字不动。

**变量名由 provider 决定，不是靠猜。** `readModelKey` 按 `GENG_MODEL_KEY` / `OPENCODE_API_KEY` /
`DEEPSEEK_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` 的顺序找第一个非空的，写哪个都行。
名字写错的表现是每个请求都 503，而 pi 只说请求失败——看起来像网络坏了。验证的方式是拿它去打
一次真端点看状态码（401 = 能连上但没认出来，200 = 对了），不要靠打印它、看长度、看前缀。

`doctor` 的「模型密钥」会在三件事上说话：文件不存在（第一轮就没有模型可用）、
`OPENCODE_API_KEY` 之类还留在 `alice.env` 里（那个文件会进容器）、以及**最后到底用了哪个地址**
（`deploy/providers.json` 还是 `GENG_MODEL_UPSTREAM`）。「模型回退」那一项管链：第一条是不是
settings 里那个模型、每条 provider 在不在表里、没有链时只提醒不报错。

### 全部凭据一览

| 文件 | 谁写的 | 谁读它 | 缺了会怎样 |
|---|---|---|---|
| `secrets/<实例>.model.env` | `init`（key 从环境读，或你填） | daemon，转发模型请求时补上 | 每个请求都 503「没有模型密钥」，pi 只说请求失败 |
| `deploy/providers.json` | 项目（进 git） | daemon / `doctor` | 链里出现的 provider 全都解析不到地址（503），只有 `GENG_MODEL_UPSTREAM` 那一条路还活着 |
| `secrets/<实例>.model.json` | 你（或 `init --chain`） | daemon / `doctor` | 没有回退：模型报错就停下，其他照常 |
| `secrets/<inst>.env` | 你（`init` 只放空模板） | 每一轮的 `docker run --env-file` | 只该放代价有上限的值；模型密钥写在这儿会进容器，`doctor` 会说 |
| `secrets/search.env` | 你 | `geng search` | 端点起不来；容器里**根本没有** `web_search`（这个文件只要 `DEEPSEEK_API_KEY`、socket 路径、每日限额） |
| `secrets/bots.json` | 你 | `geng gateway` | 没 bot = gateway 不启动；有 bot 但 `allow` 漏人 = 那人说话它不醒，**不报错** |
| `secrets/mail.json` + `mail.env` | 你 | 收信端点 | 信不进 `data/<inst>/mail/`；纸上那行也不会出现 |
| `secrets/rustic.env` | `init` 生成 | `geng backup` | 备份跳过（不算失败）；**丢了它，已有快照永远打不开** |
| `secrets/gh-app.pem` + `<inst>.env` 里的两个 id | 你 | daemon 换 installation token | `git push` 要求密码；**别的都不受影响**（见 5.3） |
| `secrets/cnb.env` | 你 | daemon，`/cnb/token` 与 `git` 的 helper 都从这儿取 | 那台机器上的 cnb 读写 401；别的都不受影响（它没有 App，只有一个长期 token，所以比 GitHub 那条更容易被抄错） |

抄错率最高的是这两类：

1. **同一个值要在两个地方逐字相同**：`mail.env` 里的 `GENG_MAIL_TOKEN` = Cloudflare Worker 里的同名 secret
2. **只在 `bots.json` 里出现一次、但错一个字符就是 401**：每个 bot 的 token

抄错的后果都是**同一种**：那边看起来正常，这边安静地什么都不发生。

### 3.3 pi 的配置（模型、思考档）

`data/alice/pi/settings.json`，`init` 从 `deploy/settings.json` 拷来，每轮**只读**挂进容器：

```json
{
  "defaultProvider": "opencode-go",
  "defaultModel": "deepseek-v4.1-flash",
  "defaultThinkingLevel": "low",
  "packages": ["npm:@dietrichgebert/ponytail", "npm:@ff-labs/pi-fff"]
}
```

- 改这里不需要重建镜像、不需要重启 daemon：下一个容器起来时读的就是新文件
- **不要写 `enabledModels`**：这个过滤在模型目录刷新之前跑，写窄了会直接 "No models match pattern"
- 它改不了这个文件——换模型躲上下文压力这条路是关的

### 3.4 跑一轮看看（花钱之前）

```bash
node cmd/geng-dev/index.ts packet --instance alice   # 打印唤醒纸，不花钱、不动状态
node cmd/geng-dev/index.ts once   --instance alice   # 真的跑一轮（daemon 在跑时会拒绝）
```

`packet` 会把**系统提示词**和**唤醒纸**分开打印，这个分界值得看一次：常量（处境、路径、参数）
在系统提示词里，每轮变化的（上次说了什么、谁在等、几点了）在纸上。

---

## 4. 单元与开机

`deploy/geng@.service` 是模板，装的时候换掉两个占位符：

```bash
cd ~/geng-agent
sed -e "s|@ROOT@|$PWD|g" -e "s|@NODE@|$(command -v node)|g" \
  deploy/geng@.service > ~/.config/systemd/user/geng@.service
systemctl --user daemon-reload
systemctl --user enable --now geng@alice
loginctl enable-linger "$USER"
```

| 占位符 | 换成 |
|---|---|
| `@ROOT@` | 仓库路径 |
| `@NODE@` | node 的**绝对路径** |

`@NODE@` 写错的表现是 unit 每十秒以 127 退出、`Restart=always` 把它变成一个看不见的循环，
而 `systemctl status` 只写着 "Scheduled restart job"。`loginctl enable-linger` 忘了的表现是
**退出 SSH 之后它就停了**。

单实例锁在 unit 里（`/usr/bin/flock -w 5 <state>/daemon.lock`），所以别绕过 unit 直接跑 daemon。

验证：

```bash
systemctl --user is-active geng@alice        # active
node cmd/geng/index.ts status --all          # alice  上次=… 下次=…
tail -1 data/alice/daemon.log                # 最后一行：一轮一行
```

`daemon.log` 一行一轮：`#12 wake=timer sym=ok lvl=0 dur=18s tools=4 tokens=25283 cost=0.0014
timedout=no ctx=0.68% cache=19328/25283 inbox=0 llm=4 net=1 backup=ok(...)`。`fix=`（绕圈时
的 steer/compact、`clock`）、`inj=`（运行中插进去的消息）、`pruned=`、`forgot=` 只在那件事
发生时才出现。它同时是时间线、花费账和归属记录——**journald 永远不进备份**。

> 第一次醒来之前 `daemon.log` 是空的、`status` 说"从未"、`book/` 里有 `journal/` 和 `open-loops/`（都是空的）：
> 那是刚出生，不是坏了。它自己设的第一个闹钟到点才醒。

### 改配置不用重启

四份配置，各有各的读法；`restart` 只在换代码、换 `.env` 时才是必须的：

| 文件 | 谁读 | 什么时候重读 |
|---|---|---|
| `secrets/bots.json` | gateway | `systemctl --user reload geng-gateway` |
| `secrets/mail.json` | gateway | 同上 |
| `data/<inst>/policy.json` | daemon + book 端点 | **每一轮开头**（daemon），**每个请求**（代理名单、最短间隔、能说话的名单）；都不用重启 |
| `secrets/search.env` | search | **每一次请求**，什么也不用做；`bind` 除外，它只在 listen 时读 |

`reload` 不是重启：长轮询不断，只有 **token 变了的 bot** 才会重新登录（一个 token 只许一个
消费者，旧的不先停新的会被 409）；新加的 bot 起、删掉的停，只改 `allow` 的话一个 poller 都不动。
`bots.json` / `mail.json` 变空或读不出来都当成手滑，继续用旧的，日志里写一行。启动时没有信箱、
后来才写一个 `mail.json`，那要重启——监听器不是每轮都能起。

验证：`node cmd/geng/index.ts bots allow alice rm <某个 id>` 之后

```bash
systemctl --user reload geng-gateway
journalctl --user -u geng-gateway -n 5    # 应有「重载 alice：… allow=4 人」
```

出现 `Stopping`/`Started` 这一对就说明 HUP 变成了重启（handler 没装上）——只有「重载」行才是真
的没重启。再把 id 加回去 reload 一次，数字应该回到原样。

---

## 5. 可选能力

每一项都是**装了才有，没装就安静地什么都没有**——这正是"漏配"最难发现的地方，
所以每项都给了验证。

### 5.1 网关（Telegram）

一个实例一个 bot：**token 就是路由键**，昵称和头像就是它在你手机里的身份。

1. [@BotFather](https://t.me/BotFather) `/newbot`，名字和头像之后都能改
2. **两个开关，缺一个它就是个哑的**，都在 BotFather 里：
   - `/setprivacy` → 选 bot → `Disable`：不关就收不到群里的普通消息，只有 @ 和命令。**关完必须
     把它踢出群再拉回来**——Telegram 只在入群那一刻记 privacy，之后改对已经加入的群不生效
   - `/mybots` → 选 bot → `Bot Settings`（Mini App）→ `Mode Settings` → 打开
     `Bot to Bot Communication Mode`：不开的话**别的 bot 说的话一条都收不到**。这是 Bot API 10.0
     才有的开关，跟 privacy 是两件事，`getMe` 里也没有对应字段，只能在群里发一条验

   两个都漏的时候症状很像：人说的话照收，所以你不会起疑。区别是 privacy 没关时别的 bot 只在
   @ / 回复它的时候才到，bot-to-bot 没开时一条都不到。开了之后 Telegram 也不再替它拦 bot 之间的
   循环，刹车只剩 gateway 自己的 tripwire（一分钟 30 条、同一句 10 次 → 停 10 分钟）。
3. `ops` bot 只建一个：daemon 和 gateway 都借它说话，消息带 `[daemon@alice]` / `[gateway]` 前缀。
   **有了任何 bot 就得有它**：没有 `ops` 时，静音通知、gateway 断线、停车通知只会堆在
   `data/_ops/outbox` 里——gateway 只在这个键下排空那队列，`geng doctor` 的「bot 接线」会说

```bash
echo '<BotFather 给的 token>' | node cmd/geng/index.ts bots add alice \
  --token-stdin --listen all --allow 111111111,222222222
node cmd/geng/index.ts bots allow alice add 333333333     # 之后加人
node cmd/geng/index.ts bots allow alice rm 222222222
```

写出来的是 `secrets/bots.json`（600，原子替换），也可以照旧手写：

```json
{
  "ops":   { "token": "…", "chat": 111111111 },
  "alice": { "token": "…", "listen": "all", "allow": [111111111, 222222222] }
}
```

| 字段 | 意思 |
|---|---|
| `chat` | 主动说话默认发到哪个会话。不写就记第一个跟它说话的会话——**所以先对 bot 说一句话**。`ops` 没有「第一条消息」可等：daemon 和 gateway 的运维消息正是借它发出来的，所以必须写死一个，不写 `geng doctor` 就报「没有 chat，运维消息发不出去」 |
| `listen` | `all`（默认）群里的闲话进 `inbox/low`；`mentions` 表示群里的闲话直接丢掉 |
| `allow` | 只让名单上的人碰它。**不写 = 不限制**，`[]` = 谁都不能进来，只剩它自己的闹钟 |

`allow` 的三个坑：**漏了自己**（你说话它不醒，而且不报错）；**漏了另一个实例的 bot**
（两个实例的对话会安静地变哑）；加了群之后以为群是新入口（其实是按发件人过滤，群里没名单上的人
说话它就完全无感）。

怎么查 id：先让它收到那个人一句话，然后 `cat data/_gateway/chats.json`，或者看 gateway 日志里
`alice ← guest 123456789（没送）` 那个数字。

```bash
node cmd/geng/index.ts gateway --check    # 只验 token，不进轮询
systemctl --user enable --now geng-gateway
```

验证：`geng gateway --check` 每个 bot 打印 `ok @username`；启动行打印 `allow=N 人`（`0 人` 和
`不限` 要能一眼看出来）；然后给 bot 发一句话，看 `data/alice/inbox/` 出现文件、`people/` 出现一行。

最后一项只能拿**另一个 bot** 验：人说的话在 privacy 还生效时也会到，自己的账号测不出来。让群里
另一个 bot 发一条不带 @ 的普通消息，看目标实例的 `inbox/low/` 有没有多出文件：

```bash
# 群 id 抄 data/_gateway/chats.json；token 从文件读，不上命令行
node -e 'const b=require("./secrets/bots.json").alice;fetch("https://api.telegram.org/bot"+b.token+"/sendMessage",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:-1001234567890,text:"投递自检"})}).then(r=>r.json()).then(j=>console.log(j.ok))'
ls data/<inst>/inbox/low/     # 空 = 第 2 步还有开关没开（privacy 或 bot-to-bot）；有文件 = 通了
```

对照两个实例的 `message_id` 没有意义：basic group 的编号是按收件人各编一套的，同一条消息在
两个 bot 那儿是两个数。

投递分两档，这条决定了它会不会被吵：**私聊 / @ / 回复 → 立刻叫醒它**；
群里的闲话 → 只进 `inbox/low`，等它下次自己看。它可以用 `listen` 自己开四小时窗口，
也可以 `mute` 某个来源（但**直接对它说话永远穿透静音**）。点名只认 `@<它的 username>`
（`/cmd@<它的 username>` 和带 user id 的成员点名也算）：裸的 `/work`、`/inbox` 只是正文的一部分，
几个实例共用一个群时谁也不叫醒。

### 5.2 搜索

搜索的 key 不在容器里。宿主上跑一个只认搜索的端点，**它不需要 token**：socket 就是授权
（`secrets init` 生成的是邮件那一个，见 §5.4）。端点需要的东西手写：

```bash
# secrets/search.env   chmod 600
# 搜索是单独计费的端点，chat 的 key 不一定能用
DEEPSEEK_API_KEY=sk-...
# 改了不用重启，下一次请求就是新额度
GENG_SEARCH_DAILY=200

node cmd/geng/index.ts search                # 前台；它会自己建 socket 的父目录
```

**别忘了 `.env` 的注释要独占一行。** `readEnvFile()`、systemd 的 `EnvironmentFile=` 和
docker 的 `--env-file` 都把 `=` 后面直到行尾整段当成值：`DEEPSEEK_API_KEY=xx  # 说明`
里的说明会跟着进 `Authorization` 头。

**socket 路径别手写。** 不写 `GENG_SEARCH_SOCKET` 时，宿主端点和 daemon 都取
`$XDG_RUNTIME_DIR/geng/search.sock`（通常是 `/run/user/<uid>/geng/search.sock`）——正是 user
unit 的 `RuntimeDirectory=geng` 建出来的目录。写死 `/run/geng/search.sock` 是 system unit
的形状：普通用户的 user unit 既没权限在那儿建目录，daemon 找的也还是另一个路径。

**端点是 unix socket，不是端口。** 容器能连它是因为 daemon 把 socket 文件按同一个路径挂进去，
不是因为网络上有一个地址能打——所以出口规则里不再有私网例外，`ss -ltnp` 上也看不到任何东西。
`GENG_SEARCH_SOCKET` 由 daemon 在 `docker run` 时注入，**不要写进 `secrets/<实例>.env`**：
写进去的值和宿主上的不一致时，容器里会有一个连不上的路径。

验证三点：

```bash
node cmd/geng/index.ts doctor alice        # 「搜索接线」：没配是 warn，配了但 socket 不在是 FAIL
ss -lx | grep search.sock                  # 有（socket 在听）；ss -ltn 里一个端口都不该有
```

第三点要进容器看：纸上有没有「今天还能搜 N 次」。**没有这一行就说明扩展没注册**——宿主上的
socket 不存在时，daemon 干脆不挂它（docker 会把缺失的宿主路径建成一个目录，之后连接报的形状
没人认得出来）。所以"没配"和"配了但服务没起来"在纸上长得一样，区别在 doctor 里。

限额在宿主这边执行，容器改不了；用完时工具返回的是人话「今天的搜索用完了」，不是错误码。

### 5.3 GitHub App（让它能推代码）

审计发现原来的做法是把一个**永不过期**的 PAT 放进 `secrets/<inst>.env`，而那个文件是
`--env-file` 注入的——容器里 `env` 就能读到它，已经有一轮真的读过了。改成 App：

1. 建一个 GitHub App（Settings → Developer settings → GitHub Apps），权限只要
   `Contents: Read and write`，`Metadata: Read-only` 自带；
2. 在 App 页面生成一个 private key，存成 `secrets/gh-app.pem`（600）；
3. 把 App 装到那个仓库/组织上，记下 installation id（`.../installations/<id>`）；
4. 两个 id 写进 `secrets/alice.env`：

```
GENG_GH_APP_ID=123456
GENG_GH_INSTALLATION_ID=7890
```

容器里没有 token，也没有会过期的 token：`git` 要凭据时，`/usr/local/bin/geng-gh-credential`
去 `book.sock` 上问一次（`GET /gh/token`，明文，因为读它的是 `git` 不是模型），daemon 用私钥
签一个 JWT 换 installation token，缓存到过期前五分钟——**一小时一个，多轮共用**，谁都没有长期凭据。

```bash
node cmd/geng/index.ts doctor --instance alice     # 「GitHub App」那一行
git -C /work/geng remote -v                        # 在容器里：git pull 不再要密码
```

三态是分开的：没配 = `warn`（别的都正常）、配了但私钥签不动 = `FAIL`、签得动 = `ok`。
签不动是这里最常见的坏法（PEM 被编辑器重排过），而它之前的症状是 git 安静地说要密码。

### 5.4 邮件

给它一个真地址：Cloudflare Email Routing 收信 → 一个 Email Worker 解 MIME → POST 回宿主。

```bash
node cmd/geng/index.ts secrets init alice      # 生成 GENG_MAIL_TOKEN，写进 secrets/mail.env
                                              # （已有的不动；要换加 --rotate）
# secrets/mail.json   地址 → 实例；allow 留空 = 谁都进不来（这里默认是关的，
#                     一个没配好的信箱不该是开放的信箱）
{ "geng-alice-bot@example.com": { "instance": "alice", "allow": ["you@example.org"] } }

# secrets/mail.env
GENG_MAIL_TOKEN=...                          # 上面生成的；Worker 和宿主共用
GENG_MAIL_BIND=127.0.0.1:8788                # 只听 loopback，前面是 tunnel
```

Worker 那边要同一个值，**不要手抄**：

```bash
wrangler secret put GENG_MAIL_TOKEN < <(sed -n 's/^GENG_MAIL_TOKEN=//p' secrets/mail.env)
```

Cloudflare 那边三步在 `deploy/mail-worker/README.md`：`wrangler deploy` + 两个 secret、
tunnel 上加一个指向 `http://127.0.0.1:8788` 的 hostname（端点只绑 IPv4 loopback；写 `localhost` 时若先解析成 `::1`，隧道连不上而报 502）、Email Routing 加一条 "Send to a Worker"。
**机器上已经有 tunnel 就不要新建**，加一个 Public Hostname 就够。

行为上要知道的三件事：**只收不回**（`say` 只说到会话）；**收信是 pull**——邮件只进
`data/<inst>/mail/`，纸上报「邮件：2 封没打开」，不叫醒它；`From` 可伪造，所以邮件不叫醒它。

改白名单不用重启：`mail.json` 跟着 gateway 的 `reload` 一起换（见 §4）。

验证：给那个地址发一封，`ls data/alice/mail/` 多一个文件，下一张纸上出现那一行。
白名单外的人**在落盘之前**就被丢掉，日志一行 `mail ← guest …（没送）`。

### 5.5 备份

一次清醒一张快照，用 [rustic](https://rustic.cli.rs/)。`geng init` 已经生成了
`secrets/rustic.env`（`RUSTIC_PASSWORD`）——**丢了它，快照就永远打不开了**。

```bash
node cmd/geng/index.ts backup alice                 # 立刻拍一张
node cmd/geng/index.ts backup alice --list          # 列已有的
node cmd/geng/index.ts restore alice --yes          # 解到 backup/alice.restore-<时间>/
node cmd/geng/index.ts doctor alice --restore-test  # 真的读回来一次
```

保留：最近 2000 张 / 每日 90 / 每周 52 / 每月 24。恢复**不覆盖 `data/`**，解到旁边的新目录。

`--list` 读不出来（仓库不通、`RUSTIC_PASSWORD` 不对、rustic 换了输出形状）会直接说读不出来并以 1
退出：**"0 张"和"读不到"不是一件事**，后者说成前者等于告诉你去翻一份并不空的备份。

验证只有一条算数：`--restore-test`。`backup=ok(<id>)` 那行不足以证明——不同版本的 rustic 的
JSON 形状不一样，只有真的读回来一次才知道。

---

## 6. 第二个实例

```bash
OPENCODE_API_KEY=sk-… node cmd/geng/index.ts init bob --model deepseek-v4.1-flash
# 想改别的就改 data/bob/policy.json（下一轮生效，不用重启）；GitHub App 的 id 在 secrets/bob.env
sed -e "s|@ROOT@|$PWD|g" -e "s|@NODE@|$(command -v node)|g" \
  deploy/geng@.service > ~/.config/systemd/user/geng@bob.service
systemctl --user daemon-reload && systemctl --user enable --now geng@bob
# bots.json 加一个 bob 的 bot，然后重启 gateway
```

多一个实例，多的是三样：一份 `data/<inst>/`、一个 unit、一个 bot。宿主上的前置不用再做。
两个实例同时醒着就是两个容器，`--memory` 是**每个**容器的限额，总量没人管——注意 VPS 大小。

---

## 7. 它的运行参数

`data/<inst>/policy.json` 是**你**的（它在书外面，容器里看不见也写不着）。它自己只能通过
`propose` 提请求（落盘是 `book/policy.proposal.json`），每一轮开头被检查：

| 它能改 | 范围 |
|---|---|
| `cycle.defaultWakeMinutes` | 1–720 |
| `cycle.minWakeMinutes` | 1–120 |
| `cycle.repeatThreshold` | 2–20 |

容器限额、网络、一轮的超时、`backup.enabled`、`files.*`、`timezone` 都**不在谈判范围**——
那是框，不是设置。改过的旧版本存在 `meta/policy.history/`。

---

## 8. 升级

```bash
deploy/update.sh      # git pull --ff-only + 重装 unit + 重建镜像 + 重启已启用的 unit
```

脚本按顺序走，任何一步失败就停，不会打印「更新完成」：

1. 工作区必须干净、HEAD 必须在分支上，否则 `git pull --ff-only` 可能留下一个既不是新提交
   也不是旧提交的在跑版本。
2. `git pull --ff-only`。
3. 用 `deploy/` 里最新的模板**重装** `~/.config/systemd/user/` 下的 unit，再
   `daemon-reload`。只重启不重装的话，`KillMode`、`RuntimeDirectory`、`ExecStart` 的改动
   永远到不了 systemd。
4. 读 `data/*/policy.json` 里的 `container.image`，为每一个在用的 tag 重建镜像。用 `--image`
   建的实例不该因为只重建了 `geng-agent:latest` 就一直留在旧镜像上。
5. 只重启已启用的 unit。重启失败就是升级失败。

| 改了什么 | 要做什么 | 它会知道吗 |
|---|---|---|
| `internal/`、`cmd/` | `git pull` + 重启 unit | 直接经历到（不同的纸、不同的行为） |
| `image/extensions/` | 存盘（`build.sh` 对它没有作用） | 下一轮醒来工具就是新的；「环境变了」不会响 |
| `Dockerfile` | 重建镜像 | 下一张纸开头多一行 `环境变了。` |
| 搜索端点从有到无（或反过来）：`secrets/search.env` 没了，或那个 socket 不在 | 存盘 / 起服务 | 下一张纸开头多一行 `环境变了。` |
| `deploy/policy.json`（模板） | **没有用**，老实例的 policy 是生成时的副本；要手改 `data/<inst>/policy.json` | — |

最后一行是最容易漏的：模板只是 `init` 的输入。所以升级之后值得跑一次
`geng doctor <inst>`，看它有没有报 policy 与模板不一致。

历史被重写过（`git pull` 报 "no common history"）时不是坏了，是那份 clone 停在旧提交上：

```bash
git fetch origin && git reset --hard origin/main
```

---

## 9. 排错

先看**产物**，不要看服务状态。`systemctl is-active` 说 active 而 `daemon.log` 不动，是这套系统里
最常见的一种"看起来正常"。

| 现象 | 先查 | 常见原因 |
|---|---|---|
| unit active，`daemon.log` 不增长 | `tail daemon.log` 的时间 | 它睡的比你想的长（纸上有"下次醒来"）；或者循环卡在等一个不会来的条件 |
| unit 反复重启，`ExecMainStatus=0` | `systemctl --user show <u> -p NRestarts`、`journalctl --user -u <u>` | 干净退出而不是崩溃：某个子进程死了没人 settle、事件循环空了。锁被占也是这个形状 |
| 没有 `daemon.log` 这一行，但状态里有一轮 | `ls -l data/<inst>/daemon.log` | 它是**目录**：每次 append 都 EISDIR，所以症状是"日志不涨"而不是报错。删掉再跑一次 `init` |
| unit 127，每十秒一次 | unit 里的 `@NODE@` | node 绝对路径错（nvm 不在 systemd 的 PATH 里） |
| 容器压根没起来，日志里也没有一轮 | 手工跑一遍完整的 `docker run` | argv 里少了一个 `-e`（比如 `TZ=…` 没带 `-e`，docker 会把它当镜像名） |
| 工具不见了 | `geng doctor <inst> --probe` 的「工具挂载」 | 挂载源不在（checkout 不完整、`image/extensions/` 被删）；或者 socket 没挂进来：`GENG_SEARCH_SOCKET` 缺了，`web_search`/`web_fetch` 干脆不注册自己；`GENG_BOOK_SOCK` 缺了，`journal`/`say` 这类在调用时回一句话 |
| 它不回复，但进程正常 | `docker ps`、`daemon.log` 最后一行的用时 | 一轮还在跑（一轮可以跑 30 分钟）；或者它**选择了不说**——只有 `say` 会送出去，正文不会 |
| 它不知道收到过邮件 | `ls data/<inst>/mail/`、纸上的邮件行 | mail 是 pull，纸上只报数；读靠 `recall`/`open` |
| 搜不到东西 | `doctor` 的「搜索接线」+ 纸上有「今天还能搜 N 次」吗 | 没配是 warn；配了但 socket 不在是 FAIL——那一行都没有就说明扩展没注册 |
| unit active，`daemon.log` 不涨，`data/_ops/outbox` 里有一条 `policy.json 读不出来` | `cat data/<inst>/policy.json` | 它停在原地等修：配置读不出来时它不退出（退出会被 systemd 每十秒拉起来一次，而那条路什么都不写），最多一分钟重试一次，改好就接着跑。同一个错只说一次 |
| 备份说 ok 但 `--list` 是空的 | `geng backup <inst> --list` | rustic 版本不同，成功信息在 stderr、JSON 形状也不同。看落下来的快照，不看成功那行。读不出来时它以 1 退出并说原因，不会报成 0 张 |
| 某个 bot 突然不回消息，unit 还 active | `journalctl --user -u geng-gateway`（找「轮询断了」）、`ls data/_ops/outbox` | 401（token 被吊销）/ 409（有 webhook，或同一个 token 有第二个消费者）不会自愈：gateway 杀掉那个 poller，没有别的 bot 就退出、十秒后重试，还有别的 bot 就**要 `reload` 一次才回来**。429 / 5xx / 断网会原地重试。409 先 `deleteWebhook` |

深入一层的顺序固定：`geng doctor <inst>` → `journalctl --user -u geng@<inst>` →
`data/<inst>/daemon.log` → `data/<inst>/usage/symptoms.log` → 最后才是 session JSONL
（它是 pi 写的、只追加，任何一轮都能复原出它当时调了什么、说了什么）。

---

## 10. 它看得见什么

```
data/<instance>/
  book/   它的书：identity.md  open-loops/  journal/  journal/discarded/
                只有宿主读的 json：waiting（闹钟）/ waiting.consumed（用过的，改名留在这儿）/
                policy.proposal / mute / attention / intent / mail.read（打开过的邮件 id）/ files.forget（要删的附件）
                只有 identity.md 挂进容器，可写
  policy.json   它活在什么规矩下——在书外面，容器里看不见也写不着
  workspace/    挂成 /work（可写，永远不清理）——容器里除了它和 identity.md 只有 tmpfs
  files/        别人发来的图片和文件，每个附件一个 F<n>（不进容器，靠 id）
  inbox/        别人说的话：直接对它说的叫醒它，群里的闲话进 low/ 等下次；
                这一轮真正交给它的移进 seen/（跑完才算读过）
  mail/         收到的邮件，一封一个文件（不进容器，靠 recall 读）
  people/       一个地址一份对话记录，只追加，不总结
  outbox/       它要说的话，gateway 取走
  sessions/     pi 的会话文件，一轮一个（可写，但纸上不提它）
  pi/           这个实例的 pi 配置（settings.json），只读挂进容器
  usage/        症状日志 symptoms.log
  meta/         计数、stateSchema、快照版本，以及一两份跨轮的注记（cut / escalation）
  run/          socket 目录，整目录挂成容器里的 /run/geng
  daemon.log    一行一轮；轮转了就有 daemon.log.1
  net.log       一行一次出网；last-stderr.log 是某轮 stderr 的尾巴，有才写
data/_gateway/  gateway 自己的 chats.json / offsets.json（全机器一份，不是某个实例的）
data/_ops/      ops bot 的 outbox 和搜索额度；它的对话记录在 data/ops/people/
secrets/<instance>.env   GitHub App 的两个 id；--env-file 注入，永不挂载（模型 key 不在这个文件里）
secrets/<instance>.model.env  模型 key 与上游地址，只有宿主读；容器问，读不到
secrets/bots.json        每个实例一个 bot（token 就是路由键）
secrets/search.env       搜索的上游 key、绑定地址、每日限额（socket 就是授权，没有第二个 token）
secrets/mail.json/.env   信箱的地址映射和收信 token
secrets/rustic.env       备份口令——丢了快照就没了
deploy/    SYSTEM.md  settings.json  models.json  policy.json  checksums.txt  build.sh  update.sh
           geng@.service  geng-gateway.service  geng-search.service  mail-worker/
```

`data/`、`backup/`、`secrets/` 全部 gitignore，且**永不进 git**。

挂载是逐条论证过的，不是攒出来的：**六条无条件，两条看 socket 在不在**。正常一轮两个 socket
都由宿主端先起好，所以纸面上是八条；搜索的 socket 不在就不挂，容器里也就没有 `web_search`
（见 §5.2）。

| 宿主 | 容器 | 为什么 |
|---|---|---|
| `book/identity.md` | `/state/identity.md` | 唯一一个它直接写的文件 |
| `workspace/` | `/work` | 干活的地方，可写 |
| `pi/settings.json` | `~/.pi/agent/settings.json` | 只读：它不能换模型 |
| `deploy/models.json` | `~/.pi/agent/models.json` | 只读：provider 指向容器里的 socat（`opencode` 与 `opencode-go` 两条都指过去） |
| `sessions/` | `~/.pi/agent/sessions` | pi 写它自己的会话 |
| `image/extensions/` | `/opt/geng/extensions` | 只读：工具不可变 |
| `run/` | `/run/geng` | 只读：book socket（模型、代理、记忆都在这条路上） |
| `secrets/search.env` 里的 socket | `/run/search.sock` | 只读：搜索端点。文件不在就不挂——docker 会把缺失的宿主路径建成目录 |

书本身**不挂**：`book/` 里的东西、`inbox/`、`people/`、`mail/` 全都在容器外面，
读走 `recall`/`open`，写走 `journal`/`discard`/`loop_*`/`wait`/`mute`/`listen`/`forget`/`propose`/`say`，
两条路都是 unix socket 到 daemon，所以账本数得清每一次。`daemon.log`、`meta/`、`usage/`、
`secrets/`、`policy.json` 都不在里面。

---

## 附：一页验收

```bash
command -v node && node --version          # ≥ 22.21.0（网关走代理那条路的要求）
docker ps                                  # 不需要 sudo
node cmd/geng/index.ts doctor alice        # 全 ok 或只剩 warn
# 其中五条是"漏配"的唯一出口：搜索接线 / 邮件接线 / bot 接线 / GitHub App / 备份
#   配好且对 = ok，配了但不对 = FAIL，没配 = warn（模型密钥是 FAIL：没有它没有模型可用）
# 「policy 跟模板」两个方向都报：模板有而副本没有（正在用没人选过的默认值）、副本有而模板没有（没人再读）
node cmd/geng/index.ts doctor alice --probe   # 直连必须断开、代理必须通、容器里看不见 policy.json
#   （--probe 要有 daemon 在跑：代理是它答的，没有它只能测到"直连断了"）
node cmd/geng/index.ts status --all        # 上次=… 下次=…
tail -3 data/alice/daemon.log              # 有行就是跑过
node cmd/geng/index.ts backup alice --list # 有快照
node cmd/geng/index.ts doctor alice --restore-test
```

`doctor` 里任何一条 **warn** 都值得看完再算装好——它的 warn 通常是"这项能力没配"，
而没配的能力是不会自己报错的。
