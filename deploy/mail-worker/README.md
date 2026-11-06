# 邮件入口

Cloudflare 收到信之后要有个东西把 MIME 解开，这件事只能在 Worker 里做。所以这里有一个
Worker，它只做一件事：解开、打包成 JSON、POST 给宿主上的收信端点。

**它不判断任何事。** 谁能写进信箱（白名单）、什么算已读、要不要叫醒它——全在宿主上，在仓库里。
Worker 手里的 token 只能投递，容器里那个 token 不存在。

## 部署发生在哪、设置存在哪

这个 Worker 是 Cloudflare 上的对象，不是宿主上的一份代码。**部署在有一份 `wrangler login` 的
机器上做，不在跑实例的宿主上做**——宿主只跑收信端点，凭据没有理由和实例住在一起。

于是每样东西都有唯一的位置：

| 东西 | 在哪 | 进 git 吗 |
|---|---|---|
| `worker.js`、`wrangler.jsonc` | 这个目录 | 是。`wrangler.jsonc` 只写脚本本身（名字、入口、兼容日期），**不写账号、不写地址、不写 token** |
| `postal-mime`、`wrangler` | `package.json`（前者 dependency，后者 devDependency）+ 提交的 `package-lock.json` | 是。`npm ci` 一条命令还原出跑的和用的 |
| `wrangler` 的登录凭据 | `~/.config/.wrangler/config/default.toml`，在仓库外 | 否 |
| `.wrangler/`、`.dev.vars` | 这个目录，本地临时 | 否（已 gitignore） |
| `GENG_MAIL_URL`、`GENG_MAIL_TOKEN` | **Cloudflare 的 Worker secret**，只有云端有一份 | 否 |

token 要和收信端点比的那一串**一模一样**。优先用环境变量 `GENG_MAIL_TOKEN`；没给时才去读
仓库根的 `secrets/mail.env`（在跑实例的宿主上它就是端点用的那份）——不让人再手打一遍，也允许
在别的机器上部署时用同一个值。两个都没有就报错退出，不会拿空 token 推上去：

```bash
cd deploy/mail-worker
npx wrangler login                      # 一次，凭据落在仓库外
./deploy.sh https://geng-mail.example.com
```

`deploy.sh` 依次做：`npm ci` → 确认 `wrangler whoami` 有凭据 → `wrangler deploy` → 把 URL
推成 secret → 取 token（先 `GENG_MAIL_TOKEN`，其次仓库根 `secrets/mail.env`）推成 secret →
`secret list` 给你看一眼。
两个 secret 都**不**放进 `wrangler.jsonc`：写进配置文件就得进 git，而 `--var` 传的普通变量
下一次不带参数部署就会丢；secret 在 Cloudflare 上跨部署保留。

## 公网入口（tunnel）

收信端点只听 `127.0.0.1:8788`，外面进不来，所以公网 hostname 要由 Cloudflare tunnel 接到它上面。
**机器上已经有 tunnel 的话不要新建**——面板 → Zero Trust → Networks → Tunnels → 选那条正在跑的 →
**Public Hostname**：

- Subdomain `geng-mail`、Domain `your-domain`
- Service `http://127.0.0.1:8788`（端点只绑 IPv4 的 loopback；写 `localhost` 时若先解析成 `::1`，隧道会连不上而报 502）

面板会顺手建好 DNS 记录，hostname 就是 `GENG_MAIL_URL`。

机器上还没有 tunnel 才需要新建，一次三行：

```
cloudflared tunnel create geng-mail
cloudflared tunnel route dns geng-mail geng-mail.your-domain
# 再把它跑成常驻服务（包自带的 unit 或自己写一个），ingress 就是上面那一条 hostname → 8788
```

顺序按脚本来：`wrangler deploy` 先跑（secret 在 Cloudflare 上跨部署保留，不会被这次部署抹掉），
紧接着把两个 secret 推上去，**最后**才到面板把 Email Routing 指到这个 Worker。真正不能颠倒的是
「有信进来之前，token 和 tunnel 都得就位」：否则 Worker 回 401、或者 URL 指向一个 502，两种都会
让 Cloudflare 退信。第一次部署时路由还没指过来，所以脚本里 deploy 与 secret 之间的那段窗口是空的；
重部署时若路由已经生效，先确认 secret 仍是当前值。验证：

```
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://geng-mail.your-domain/
```

`401` 是对的（没有 token）。`502` 说明隧道或端点没起来。

然后在 Cloudflare 面板：**Email Routing → Routes → 新规则**，

- 地址：`geng-alice-bot@your-domain`（想给它哪个地址就写哪个）
- 动作：**Send to a Worker** → `geng-mail`

（这条只能在面板或 REST API 做，`wrangler` 管不到 Email Routing。）

换域名、换 token 都要重新跑一次 `deploy.sh`：`wrangler deploy` 不会动 secret，但 secret 的值
变了就得重推，否则收信端点会以 `token 不对（没送）` 回 401，而信在 Cloudflare 那边是**退信**。

## 边界

- 白名单比的是信封发件人（`message.from`，SMTP MAIL FROM），不是 `From` 头。**两个都没被验证过**：
  没有 SPF 结论时，谁都能写 `MAIL FROM: <you@example.org>`。所以白名单是**减噪**，不是身份——
  别把「这封信来自名单里的人」当成授权。
- Cloudflare 的入站上限是 25 MiB，超过的它在 SMTP 阶段就退掉了，到不了这里。
- 单封附件超过 5 MB、总计超过 10 MB 的**不带内容**发过去：宿主只会记下"太大没取"和大小。
  附件仍然在原始邮件里，没有被删除。
- POST 失败就 `throw`，Cloudflare 会退信。**丢信比退信难查得多。**
