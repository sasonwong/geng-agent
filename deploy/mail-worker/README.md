# 邮件入口

Cloudflare 收到信之后要有个东西把 MIME 解开，这件事只能在 Worker 里做。所以这里有一个
Worker，它只做一件事：解开、打包成 JSON、POST 给宿主上的收信端点。

**它不判断任何事。** 谁能写进信箱（白名单）、什么算已读、要不要叫醒它——全在宿主上，在仓库里。
Worker 手里的 token 只能投递，容器里那个 token 不存在。

## 部署（一次）

```bash
cd deploy/mail-worker
npm install
npx wrangler login                    # 或用 CLOUDFLARE_API_TOKEN
npx wrangler deploy

# 两个变量：收信端点的公网地址，和 shared secret
npx wrangler secret put GENG_MAIL_TOKEN
npx wrangler secret put GENG_MAIL_URL   # https://mail.example.com
```

## 公网入口（tunnel）

收信端点只听 `127.0.0.1:8788`，外面进不来，所以公网 hostname 要由 Cloudflare tunnel 接到它上面。
**机器上已经有 tunnel 的话不要新建**——面板 → Zero Trust → Networks → Tunnels → 选那条正在跑的 →
**Public Hostname**：

- Subdomain `geng-mail`、Domain `your-domain`
- Service `http://localhost:8788`

面板会顺手建好 DNS 记录，hostname 就是 `GENG_MAIL_URL`。

机器上还没有 tunnel 才需要新建，一次三行：

```
cloudflared tunnel create geng-mail
cloudflared tunnel route dns geng-mail geng-mail.your-domain
# 再把它跑成常驻服务（包自带的 unit 或自己写一个），ingress 就是上面那一条 hostname → 8788
```

两处顺序不能颠倒：token 要在 Worker 部署**之前**存在（否则 Worker 拿到 401，Cloudflare 把信退回去），
tunnel 要在填 `GENG_MAIL_URL` 之前通（否则它指向一个 502）。验证：

```
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://geng-mail.your-domain/
```

`401` 是对的（没有 token）。`502` 说明隧道或端点没起来。

然后在 Cloudflare 面板：**Email Routing → Routes → 新规则**，

- 地址：`geng-alice-bot@your-domain`（想给它哪个地址就写哪个）
- 动作：**Send to a Worker** → `geng-mail`

`GENG_MAIL_TOKEN` 要和宿主上 `secrets/mail.env` 的 `GENG_MAIL_TOKEN` 一模一样。

## 边界

- 白名单比的是信封发件人（`message.from`，SMTP MAIL FROM），不是 `From` 头。**两个都没被验证过**：
  没有 SPF 结论时，谁都能写 `MAIL FROM: <you@example.org>`。所以白名单是**减噪**，不是身份——
  别把「这封信来自名单里的人」当成授权。
- Cloudflare 的入站上限是 25 MiB，超过的它在 SMTP 阶段就退掉了，到不了这里。
- 单封附件超过 5 MB、总计超过 10 MB 的**不带内容**发过去：宿主只会记下"太大没取"和大小。
  附件仍然在原始邮件里，没有被删除。
- POST 失败就 `throw`，Cloudflare 会退信。**丢信比退信难查得多。**
