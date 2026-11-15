# 聊天室 Cloudflare Workers 版部署说明

## 应用
轻量聊天室：JavaScript + Cloudflare Workers + D1（SQLite）存消息。
- 进页面先起昵称（localStorage 记住，下次不用再输）
- 一个共用房间，所有访客消息互相可见，带昵称和时间
- 消息存在服务端 D1 数据库，刷新/重进、重新部署后记录都还在
- 前端每 3 秒拉取新消息（页面不可见时暂停，省请求）
- 界面全中文；消息最多 500 字，昵称最多 20 字；简单限流（同一 IP 每分钟最多 20 条）
- 和 Python 版接口完全一致，方便对照

## 文件
- `worker.js`：Worker 全部代码（API + 内嵌前端 HTML，可直接部署）
- `index.html`：前端页面源码（与 worker.js 里内嵌的是同一份内容；改前端请改这里，再重新嵌进 worker.js——见下方“改前端”）
- `wrangler.toml`：Wrangler 配置（含 D1 绑定，database_id 待填）
- `schema.sql`：D1 建表语句

## 接口
- `GET /` 聊天室页面
- `GET /api/messages?after=<id>` 拉取新消息
- `POST /api/messages` 发消息（JSON nickname/text）
- `GET /api/health` 健康检查

## 免费额度（2026-11-15 直接核对 Cloudflare 官方文档）
来源：developers.cloudflare.com/workers/platform/pricing/、
developers.cloudflare.com/d1/platform/pricing/、
developers.cloudflare.com/d1/platform/limits/、
developers.cloudflare.com/workers/configuration/routing/workers-dev/

- **注册不要卡**：Workers Free 是账号默认套餐，只需邮箱注册；Cloudflare 自己的 Workers 页面明确写着 Free plan 不需要信用卡。超了也不扣费，只会停服到午夜 UTC 重置。
- **Workers 免费档**：每天 10 万次请求（全账号共享，Pages Functions 也算在内），每天 00:00 UTC 重置；每次调用最多 10 毫秒 CPU；没有出站流量费；静态资源请求免费不限量。超限后请求返回 Error 1027，直到重置。
- **D1（SQLite）免费档**：每天读 500 万行、写 10 万行；总存储 5 GB；每个库最多 500 MB；账号最多 10 个库；每天 00:00 UTC 重置；超限后查询报错直到重置，不扣费。D1 官方 FAQ 说 Free plan 永远保留。
- **Workers KV 免费档**（本项目没用，备用）：读 10 万/天、写 1000/天、删 1000/天、存 1 GB。
- **公开域名**：每个 Worker 自动分配 `https://<Worker 名>.<账号子域名>.workers.dev`，公开访问、HTTPS（Cloudflare 托管证书）、免费。workers.dev 官方定位是个人/兴趣项目。
- **不休眠**：Workers 没有 Render 那种 15 分钟无流量休眠，也没有 Cloady 的 7 天无访问暂停；只要当天请求数没用完，一直在线。

## 额度够不够用（实算）
- 每个打开的页面每 3 秒拉一次 = 20 次/分钟 = 1200 次/小时 = 28800 次/天（24 小时一直开着）。
- Workers 每天 10 万次：约 3 个页面 24 小时不关会打满；正常几个人每天聊一两个小时远远不到。超限只停到午夜 UTC 重置，不扣费。
- D1 写：每发 1 条消息算 2 行写入（表 1 行 + IP 索引 1 行），每天 10 万行 ≈ 每天 5 万条消息，足够。
- D1 读：没新消息时轮询几乎不读行（主键索引只扫新增行），5 万行/天读额度很宽裕。
- 存储：每条消息约 200 字节，500 MB 单库上限 ≈ 250 万条消息，实际上用不完。

## 部署方法 A：Wrangler 命令行（推荐）
1. 注册 Cloudflare 账号：dash.cloudflare.com，邮箱注册即可，**不要绑卡**。账号没有 Cloudflare 账号的话新建一个（免费）。
2. 本机装 Wrangler：`npm install -g wrangler`（已验证 wrangler 4.162.0 可用）。
3. 登录二选一：
   - `wrangler login`（浏览器 OAuth 登录，最省事），或
   - 在控制台 My Profile → API Tokens → Create Token，用 “Edit Cloudflare Workers” 模板建一个 Token（包含 Workers + D1 权限），设环境变量 `CLOUDFLARE_API_TOKEN`。
4. 创建 D1 数据库并拿到 ID：
   `wrangler d1 create chatroom`
   把返回的 `database_id` 填进 `wrangler.toml`（替换掉那串 00000000 占位符）。
5. 建表：
   `wrangler d1 execute chatroom --remote --file=./schema.sql`
6. 部署：
   `wrangler deploy`
   成功后显示公开地址，形如 `https://chatroom.<你的账号子域名>.workers.dev`。
7. 验证：打开地址，起昵称发一条测试消息，刷新后还在；换个浏览器/无痕窗口打开，能看到刚才那条消息，即证明多用户共享。

## 部署方法 B：控制台全程点鼠标（不用命令行）
1. 注册 Cloudflare 账号（同上，邮箱即可，不要绑卡）。
2. 先建 D1 库：Workers & Pages → D1 → Create database，名字填 `chatroom` → 建好后点进这个库 → Console，把 `schema.sql` 全文粘贴进去 → Execute。
3. 再建 Worker：Workers & Pages → Create Worker → 名字填 `chatroom` → Deploy → 点进这个 Worker → 右上角 Edit code → 把 `worker.js` 全文粘贴进去 → Deploy。
4. 绑定 D1：进这个 Worker → Settings → Variables → D1 Database Bindings → Add binding，Variable name 填 `DB`，选刚才建的 `chatroom` 库 → Save/Deploy。
5. 公开地址在 Worker 页面上，形如 `https://chatroom.<你的账号子域名>.workers.dev`。按方法 A 第 7 步同样验证。

## 改前端
前端源码在 `index.html`。改完后要重新嵌进 `worker.js`（worker.js 里 `const HTML = \`...\`` 那一大段就是它）。生成命令（在 cloudflare-chatroom 目录里）：
```bash
python3 -c "
html = open('index.html', encoding='utf-8').read()
assert '\`' not in html and '\${' not in html
src = open('worker.js', encoding='utf-8').read()
import re
src = re.sub(r'const HTML = \`.*?\`;', 'const HTML = \`' + html + '\`;', src, flags=re.S)
open('worker.js', 'w', encoding='utf-8').write(src)
print('ok')
"
```
注意：index.html 里不能出现反引号或 `${`（目前没有，改的时候别加）。

## 本地测试（已实测通过）
环境：Node v24.22.1，wrangler 4.162.0。`wrangler dev --local` + 本地 D1：
- `GET /api/health` → `{"ok": true}`；`GET /` → 200、8179 字节
- 小李、阿华各发一条，两条都写入 D1；换一个“访客”拉取，两条都能看到——服务端共享，不是本地显示
- 增量拉取 `after=1` 只返回第 2 条；空消息/昵称超长/非法 JSON 均返回 400
- 限流：同一 IP 第 21 条返回 429 `{"error":"发得太快了，稍等一会儿再发"}`，数据库里仍是 20 条，没多写
- 测试用的本地 D1 数据已清理（.wrangler 目录已删），线上库是空的

## 限制（部署后也要跟用户说清楚）
- **每天 10 万次请求是全账号共享的**：如果账号里还有别的 Worker/Pages Functions，它们也算在这 10 万里。超了整个账号的 Worker 请求都停到午夜 UTC。
- **中国大陆访问 workers.dev 需实测**：workers.dev 是 Cloudflare 的共享域名，在国内的访问速度和稳定性没有在这台机器上验证过，部署后请用自己的网络打开链接实测。如果打不开或很慢，可以考虑给 Worker 绑一个自己的域名（需要域名托管在 Cloudflare，免费套餐也可绑）。
- **限流按 IP 算**：同一出口 IP 的多人（比如同一公司/学校 NAT 下）共享每分钟 20 条的额度；对小聊天室没影响。
- **消息存在 D1 里**：删库就丢；D1 免费档有 7 天 Time Travel（时间点恢复），误删可恢复。重新部署 Worker 不丢消息。
- **没有 WebSocket 实时推送**：现在是每 3 秒轮询，不是秒级推送；够用，且不消耗 Durable Objects（那是要付费的）。
- **workers.dev 域名是 Cloudflare 的**：官方建议正式项目用自己的域名；个人聊天室用 workers.dev 完全可以。
