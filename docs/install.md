# 装一台

从零到它自己醒过来。按"改不回来的先做"排序：宿主前置 → 实例 → 单元 → 可选能力 → 升级 → 排错。

一共三类东西，别混：

| 类别 | 举例 | 特点 |
|---|---|---|
| **宿主前置** | docker、`agent-net`、egress 规则、linger | 一次性，有的要 sudo，**改回来麻烦** |
| **每实例** | `geng init`、一个 user unit、一份凭据 | 加一个实例就重复一遍 |
| **可选能力** | 网关、搜索、邮件、备份 | 不装就等于没有，且**不会有任何报错** |

先读一遍这张表，再决定要不要全装。缺一件不会让系统坏掉，只会让某一件事安静地不发生。

---

## 1. 宿主前置（一次性，要 sudo）

| 要什么 | 为什么 | 怎么验 |
|---|---|---|
| Node ≥ 22.18 | 直接跑 TypeScript，没有构建步骤 | `node --version` |
| node 的**绝对路径** | systemd 的 PATH 里没有 nvm；`env node` 会让 unit 每十秒以 127 退出 | `command -v node` 记下来 |
| docker + 当前用户在 `docker` 组 | 每轮醒来是一个 `--rm` 容器 | `docker ps`（不是 `sudo docker ps`） |
| `rustic`、`flock`、`rsync` | 备份、单实例锁、迁移 | `rustic --version`、`flock --help` |
| `deploy/egress.sh` | 建 `agent-net`，封掉元数据地址和私网段 | 见下 |

**docker 组要重新登录一次才生效。** 刚 `usermod -aG docker` 完就 `docker ps` 会报 socket 权限，
那不是装错了。

### egress 规则

```bash
sudo deploy/egress.sh          # 建 agent-net，写 DOCKER-USER 规则
docker network inspect agent-net -f '{{(index .IPAM.Config 0).Gateway}}'
```

它做三件事，顺序有意义：**先**封云元数据地址和私网段（`10/8`、`172.16/12`、`192.168/16`），
**再**放行 80/443/53，**最后**一条兜底 DROP。顺序反了（比如用 `-I` 逐条插到最前面），兜底会先命中，
容器就完全没有 TCP 了。

- 规则**只作用于 `-i br-<agent-net 的 id>`**，所以同机跑别的服务不受影响
- 重跑是安全的：它先删掉提到这个网桥的规则再按顺序重加，不会叠
- 想全部撤掉：`sudo iptables -F DOCKER-USER`
- 如果容器里的 agent 需要够到宿主机上的**一个**服务（比如搜索端点），那是脚本里单独一条
  按端口的例外，写在 DROP 之前。**不要**为了省事把整段私网放开

验证（两条都要，缺一条就说明规则位置错了）：

```bash
docker run --rm geng-agent:latest sh -lc 'curl -sS -m 5 -o /dev/null -w "%{http_code}\n" https://api.github.com'   # 应该出 200/301
docker run --rm geng-agent:latest sh -lc 'curl -sS -m 5 http://169.254.169.254/ ; echo exit=$?'                    # 应该超时
```

> 「连不上」和「被封住」在容器里长得一样。所以在 `geng doctor <inst> --probe` 里有一个
> **正向对照**（先证明它能上网），再证明私网不通——只测否定的探针在完全没网时也会全绿。

### 代理（可选）

直连可达的机器不用配。需要代理时是三处，别混：

| 谁 | 怎么配 |
|---|---|
| docker 拉镜像 | `/etc/systemd/system/docker.service.d/proxy.conf`（`NO_PROXY` 要含 localhost 和私网段） |
| 构建里的 apt / npm | `DOCKER_BUILD_PROXY=http://…:PORT deploy/build.sh`——构建容器在桥接网络里看不见 `127.0.0.1`，所以脚本只在设了它时才切 `--network=host` |
| 网关连 Telegram | unit 里的 `NODE_USE_ENV_PROXY=1`（Node 的 `fetch` 默认不读 `HTTP(S)_PROXY`） |

**agent 容器本身不需要代理**：它只连模型和网络搜索，出口由 egress 规则管。

---

## 2. 仓库与镜像

```bash
git clone https://github.com/sasonwong/geng-agent ~/geng-agent && cd ~/geng-agent
npm ci                                   # 只有 @types/node 和 typescript，运行时零依赖
npx tsc --noEmit && npm test             # 十秒内应该全绿
deploy/build.sh                          # 镜像：pi + 三个扩展，root 拥有、只读
```

**什么时候需要重建镜像**：`Dockerfile`、`image/` 变了。只改 `internal/`、`cmd/` 不用重建——
daemon 在宿主上跑，容器只装 pi 和它的工具。

镜像里的扩展（`say`/`mute`/`forget`/`listen`/`mail`/`web_search`）是 `chmod 0555`、root 拥有的，
容器里改不了、删不了——工具必须不可变，否则它就能改自己和人对谈的方式。

---

## 3. 第一个实例

```bash
node cmd/geng/index.ts init alice
```

`init` 会建目录树、从 `deploy/policy.json` 拷一份 policy、生成 `secrets/alice.env` 模板（600）、
从 `deploy/settings.json` 拷一份 pi 配置，并在 `secrets/rustic.env` 里生成备份口令。
**它不会写 `identity.md`、`open-loops/`、`waiting.json`** —— 那几个空白就是它的出生。

### 3.1 改 policy（这一步不能忘）

`init` 拷的是模板，所以它写出来的是 **`runner: "local"` + `container.network: null`**。
生产要改成：

```json
{ "runner": "docker", "container": { "network": "agent-net" } }
```

漏了会怎样：**每轮都会跑起来，只是跑在本机的 pi 上**——没有容器、没有只读挂载、没有 egress 规则。
它看起来完全正常，你看不出来。

同一个文件里值得先看一眼的还有 `cycle.timeoutSec`（默认 1800 = 30 分钟）、`timezone`、
`files.maxMb`。这些是**框**，只有时机和阈值是它自己能改的（见第 7 节）。

### 3.2 填凭据

```bash
echo '<你的 key>' | node cmd/geng/index.ts secrets set alice OPENCODE_API_KEY
```

值**从 stdin 读**（argv 会在 `ps` 里露出去），写进 `secrets/alice.env`（600），同名行原地替换、
注释和别的行一个字不动。也可以照旧手写这个文件：

```
OPENCODE_API_KEY=...          # 或者你用的 provider 对应的变量名
GENG_SEARCH_URL=...           # 可选：装上搜索端点之后再加（第 5 节）
GENG_SEARCH_TOKEN=...
```

**变量名由 provider 决定，不是靠猜。** 名字写错的表现是第一次醒来就报 "No API key found"，
看起来像 key 坏了。验证的方式是拿它去打一次真端点看状态码（401 = 能连上但没认出来，200 = 对了），
不要靠打印它、看长度、看前缀。

`--env-file` 注入，**永不挂载**。容器里 `env` 就能读到它，所以它必须是最小权限、只对一个用途。

### 全部凭据一览

| 文件 | 谁写的 | 谁读它 | 缺了会怎样 |
|---|---|---|---|
| `secrets/<inst>.env` | 你（`init` 只放空模板） | 每一轮的 `docker run --env-file` | 第一轮就 `No API key found`；变量名写错也是这个症状 |
| `secrets/search.env` | 你 | `geng search` | 端点起不来；容器里**根本没有** `web_search` |
| `<inst>.env` 的 `GENG_SEARCH_URL`/`_TOKEN` | 你 | 容器里的扩展 | 同上。纸上看不到「今天还能搜 N 次」就是它 |
| `secrets/bots.json` | 你 | `geng gateway` | 没 bot = gateway 不启动；有 bot 但 `allow` 漏人 = 那人说话它不醒，**不报错** |
| `secrets/mail.json` + `mail.env` | 你 | 收信端点 | 信不进 `/mail`；纸上那行也不会出现 |
| `secrets/rustic.env` | `init` 生成 | `geng backup` | 备份跳过（不算失败）；**丢了它，已有快照永远打不开** |
| `data/<inst>/palimpsest/.gh/hosts.yml` | 它自己 | 容器里的 `gh` | 推不了代码 |

三处是**同一个值要在两个地方逐字相同**，也是抄错率最高的三处：

1. `search.env` 里的 `GENG_SEARCH_TOKEN` = `<inst>.env` 里的 `GENG_SEARCH_TOKEN`
2. `mail.env` 里的 `GENG_MAIL_TOKEN` = Cloudflare Worker 里的同名 secret
3. 每个 bot 的 token = `bots.json` 里那串（它只出现在一个地方，但错一个字符就是 401）

抄错的后果都是**同一种**：那边看起来正常，这边安静地什么都不发生。所以拿不到可靠信号时，
判据永远是**拿它去打一次真端点看状态码**（401 = 能连上但没认出来，200 = 对了），
而不是打印它、数长度、看前缀。

### 3.3 pi 的配置（模型、思考档）

`data/alice/pi/settings.json`，`init` 从 `deploy/settings.json` 拷来，每轮**只读**挂进容器：

```json
{
  "defaultProvider": "opencode-go",
  "defaultModel": "deepseek-v4.1-flash",
  "defaultThinkingLevel": "low"
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
node cmd/geng/index.ts status --all          # alice  上次=… 下次=… runner=docker
tail -1 data/alice/daemon.log                # 第一行 key=value
```

`daemon.log` 一行一轮：`#12 wake=timer sym=ok lvl=0 dur=18s tools=4 tokens=25283 cost=0.0014
timedout=no ctx=0.68% cache=19328/25283 inbox=0 backup=ok(...)`。它同时是时间线、
花费账和归属记录——**journald 永远不进备份**。

> 第一次醒来之前 `daemon.log` 是空的、`status` 说"从未"、`palimpsest/` 里只有 `journal/`：
> 那是刚出生，不是坏了。它自己设的第一个闹钟到点才醒。

### 改配置不用重启

四份配置，各有各的读法；`restart` 只在换代码、换 `.env` 时才是必须的：

| 文件 | 谁读 | 什么时候重读 |
|---|---|---|
| `secrets/bots.json` | gateway | `systemctl --user reload geng-gateway` |
| `secrets/mail.json` | gateway | 同上 |
| `data/<inst>/policy.json` | daemon | **每一轮开头**，什么也不用做 |
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
2. **群聊必须关 privacy mode**：`/setprivacy` → 选 bot → `Disable`。不关的话它收不到群里的普通
   消息，只会收到 @ 和命令，而你会以为它坏了
3. `ops` bot 只建一个：daemon 和 gateway 都借它说话，消息带 `[daemon@alice]` / `[gateway]` 前缀

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
| `chat` | 主动说话默认发到哪个会话。不写就记第一个跟它说话的会话——**所以先对 bot 说一句话** |
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

投递分两档，这条决定了它会不会被吵：**私聊 / @ / 回复 → 立刻叫醒它**；
群里的闲话 → 只进 `inbox/low`，等它下次自己看。它可以用 `listen` 自己开四小时窗口，
也可以 `mute` 某个来源（但**直接对它说话永远穿透静音**）。

### 5.2 搜索

搜索的 key 不在容器里。宿主上跑一个只认搜索的端点：

```bash
node cmd/geng/index.ts secrets init alice     # 生成 search / mail 两对 token，写进该写的每一处
```

它做的事就是**同一个值不让你抄两遍**：`GENG_SEARCH_TOKEN` 一次生成，同时写进
`secrets/search.env`（端点那侧）和 `secrets/alice.env`（容器那侧）。已经有的不动，要换加
`--rotate`。

剩下两项它生成不出来，手写：

```bash
# secrets/search.env   chmod 600
DEEPSEEK_API_KEY=sk-...                      # 搜索是单独计费的端点，chat 的 key 不一定能用
GENG_SEARCH_BIND=0.0.0.0:8787                # 或直接绑 agent-net 的网关地址
GENG_SEARCH_DAILY=200                        # 改了不用重启，下一次请求就是新额度

node cmd/geng/index.ts search                # 前台；常驻用 deploy/geng-search.service
```

然后把它加进**实例的** env 文件（`--env-file` 注入，不用重建镜像、不用重启）：

```
GENG_SEARCH_URL=http://<agent-net 的网关>:8787
GENG_SEARCH_TOKEN=和上面那串一样
```

网关地址别写死，换台机器就变：

```bash
docker network inspect agent-net -f '{{(index .IPAM.Config 0).Gateway}}'
```

验证两点：不带 token 打 `/search` 应该 **401**，带上应该 **200** 且返回真结果；容器里能不能
够到，看它纸上有没有「今天还能搜 N 次」——**没有这一行就说明 `GENG_SEARCH_URL` 没进去**，
因为扩展在没有这个变量时**根本不注册**（工具不存在，而不是存在但拒绝工作）。

限额在宿主这边执行，容器改不了；用完时工具返回的是人话「今天的搜索用完了」，不是错误码。

### 5.3 邮件

给它一个真地址：Cloudflare Email Routing 收信 → 一个 Email Worker 解 MIME → POST 回宿主。

```bash
# secrets/mail.json   地址 → 实例；allow 留空 = 谁都进不来（这里默认是关的，
#                     一个没配好的信箱不该是开放的信箱）
{ "geng-alice-bot@example.com": { "instance": "alice", "allow": ["you@example.org"] } }

# secrets/mail.env
GENG_MAIL_TOKEN=...                          # geng secrets init 生成的；Worker 和宿主共用
GENG_MAIL_BIND=127.0.0.1:8788                # 只听 loopback，前面是 tunnel
```

Worker 那边要同一个值，**不要手抄**：

```bash
wrangler secret put GENG_MAIL_TOKEN < <(sed -n 's/^GENG_MAIL_TOKEN=//p' secrets/mail.env)
```

Cloudflare 那边三步在 `deploy/mail-worker/README.md`：`wrangler deploy` + 两个 secret、
tunnel 上加一个指向 `http://localhost:8788` 的 hostname、Email Routing 加一条 "Send to a Worker"。
**机器上已经有 tunnel 就不要新建**，加一个 Public Hostname 就够。

行为上要知道的三件事：**只收不回**（`say` 只说到会话）；**收信是 pull**——邮件只进
`data/<inst>/mail/`，纸上报「邮件：2 封没处理」，不叫醒它；`From` 可伪造，所以邮件不叫醒它。

改白名单不用重启：`mail.json` 跟着 gateway 的 `reload` 一起换（见 §4）。

验证：给那个地址发一封，`ls data/alice/mail/` 多一个文件，下一张纸上出现那一行。
白名单外的人**在落盘之前**就被丢掉，日志一行 `mail ← guest …（没送）`。

### 5.4 备份

一次清醒一张快照，用 [rustic](https://rustic.cli.rs/)。`geng init` 已经生成了
`secrets/rustic.env`（`RUSTIC_PASSWORD`）——**丢了它，快照就永远打不开了**。

```bash
node cmd/geng/index.ts backup alice                 # 立刻拍一张
node cmd/geng/index.ts backup alice --list          # 列已有的
node cmd/geng/index.ts restore alice --yes          # 解到 backup/alice.restore-<时间>/
node cmd/geng/index.ts doctor alice --restore-test  # 真的读回来一次
```

保留：最近 2000 张 / 每日 90 / 每周 52 / 每月 24。恢复**不覆盖 `data/`**，解到旁边的新目录。

验证只有一条算数：`--restore-test`。`backup=ok(<id>)` 那行不足以证明——不同版本的 rustic 的
JSON 形状不一样，只有真的读回来一次才知道。

---

## 6. 第二个实例

```bash
node cmd/geng/index.ts init bob
# 改 policy（runner=docker、network=agent-net）
# 填 secrets/bob.env
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
`palimpsest/policy.proposal.json` 提请求，每一轮开头被检查：

| 它能改 | 范围 |
|---|---|
| `cycle.defaultWakeMinutes` | 1–720 |
| `cycle.minWakeMinutes` | 1–120 |
| `cycle.repeatThreshold` | 2–20 |

runner、容器限额、网络、一轮的超时、`backup.enabled`、`files.*`、`timezone` 都**不在谈判范围**——
那是框，不是设置。改过的旧版本存在 `meta/policy.history/`。

---

## 8. 升级

```bash
deploy/update.sh      # git pull --ff-only + 重建镜像 + 重启已装的 unit
```

| 改了什么 | 要做什么 | 它会知道吗 |
|---|---|---|
| `internal/`、`cmd/` | `git pull` + 重启 unit | 直接经历到（不同的纸、不同的行为） |
| `Dockerfile`、`image/` | 重建镜像 | 下一张纸开头多一行 `环境变了。` |
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
| 没有 `daemon.log` 这一行，但状态里有一轮 | `ls -l data/<inst>/daemon.log` | 它是**目录**：容器挂载把不存在的路径建成了目录 |
| unit 127，每十秒一次 | unit 里的 `@NODE@` | node 绝对路径错（nvm 不在 systemd 的 PATH 里） |
| 容器压根没起来，日志里也没有一轮 | 手工跑一遍完整的 `docker run` | argv 里少了一个 `-e`（比如 `TZ=…` 没带 `-e`，docker 会把它当镜像名） |
| 工具不见了 | `docker run --rm <镜像> ls /opt/geng/extensions`、实例 env | 镜像没重建；或者扩展需要的环境变量没注入（缺变量时它**不注册**自己） |
| 它不回复，但进程正常 | `docker ps`、`daemon.log` 最后一行的用时 | 一轮还在跑（一轮可以跑 30 分钟）；或者它**选择了不说**——只有 `say` 会送出去，正文不会 |
| 它不知道收到过邮件 | `ls data/<inst>/mail/`、纸上的邮件行 | mail 是 pull，纸上只报数，不叫醒 |
| 搜不到东西 | 纸上有「今天还能搜 N 次」吗 | 没有那一行 = `GENG_SEARCH_URL` 没进容器 |
| 备份说 ok 但 `--list` 是空的 | `geng backup <inst> --list` | rustic 版本不同，成功信息在 stderr、JSON 形状也不同。看落下来的快照，不看成功那行 |

深入一层的顺序固定：`geng doctor <inst>` → `journalctl --user -u geng@<inst>` →
`data/<inst>/daemon.log` → `data/<inst>/usage/symptoms.log` → 最后才是 session JSONL
（它是 pi 写的、只追加，任何一轮都能复原出它当时调了什么、说了什么）。

---

## 10. 它看得见什么

```
data/<instance>/
  palimpsest/   它的书：identity.md  open-loops/  waiting.json  journal/  mute.json
                mail.read.json（它标过已读的邮件 id）· 挂成 /state（可写）
  policy.json   它活在什么规矩下——在书外面，容器里看不见也写不着
  workspace/    挂成 /work（可写，永远不清理）
  files/        别人发来的图片和文件，挂成 /files（只读）
  inbox/        别人说的话：直接对它说的叫醒它，群里的闲话进 low/ 等下次
  mail/         收到的邮件，一封一个文件，挂成 /mail（只读）
  people/       一个地址一份对话记录，只追加，不总结
  outbox/       它要说的话，gateway 取走
  session/      pi 的会话文件，一轮一个（可写，但纸上不提它）
  usage/ meta/ daemon.log
secrets/<instance>.env   模型凭据、搜索地址；--env-file 注入，永不挂载
secrets/bots.json        每个实例一个 bot（token 就是路由键）
secrets/search.env       搜索端点的 token、绑定地址、每日限额
secrets/mail.json/.env   信箱的地址映射和收信 token
secrets/rustic.env       备份口令——丢了快照就没了
deploy/    SYSTEM.md  settings.json  policy.json  geng@.service  egress.sh  mail-worker/
```

`data/`、`backup/`、`secrets/` 全部 gitignore，且**永不进 git**。

挂载是逐条论证过的，不是攒出来的：`/state`（记忆）、`/work`（干活）、`/inbox`（别人说了什么）、
`/people`（比纸上的摘录更早的对话）、`/outbox`（唯一的出口）、`/files`、`/mail`（都是只读，它改不了
别人给它的东西）、`data/<inst>/pi/settings.json`（只读，它不能换模型）。`daemon.log`、`meta/`、
`usage/`、`secrets/`、`policy.json` 都**不在**里面。

---

## 附：一页验收

```bash
command -v node && node --version          # ≥ 22.18
docker ps                                  # 不需要 sudo
docker run --rm geng-agent:latest sh -lc 'curl -sS -m 5 -o /dev/null -w "%{http_code}\n" https://api.github.com'
node cmd/geng/index.ts doctor alice        # 全 ok 或只剩 warn
# 其中四条是"漏配"的唯一出口：模型凭据 / 搜索接线 / 邮件接线 / bot 接线
#   配好且对 = ok，配了但不对 = FAIL，没配 = warn
node cmd/geng/index.ts doctor alice --probe   # 容器能上网、私网不通、policy 写不进去
node cmd/geng/index.ts status --all        # runner=docker，下次=…
tail -3 data/alice/daemon.log              # 有行就是跑过
node cmd/geng/index.ts backup alice --list # 有快照
node cmd/geng/index.ts doctor alice --restore-test
```

`doctor` 里任何一条 **warn** 都值得看完再算装好——它的 warn 通常是"这项能力没配"，
而没配的能力是不会自己报错的。
