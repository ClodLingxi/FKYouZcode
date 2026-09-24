# @zcode/web-remote-relay（自建 relay 服务器）

ZCode Web Remote Control 的**自托管中继**：认证 + 按 device_sid 配对 + `data` 信封透传。
rpc-frame 可靠传输（分片/CRC/重放/流控）是手机↔桌面端到端的，本服务不解析、不缓存、不排序。

协议规格：`packages/shared/src/web-remote-control/`（schema 与认证纯函数双端共用）。

## 部署

```bash
cd apps/web-remote-relay
npm install
PORT=8787 node server.mjs   # 纯 Node，无构建；无状态（重启后桌面侧重新配对即可）
```

- 默认只绑 `127.0.0.1`（`HOST` env 覆盖）：relay 总是置于 TLS 反代或 ssh 反向隧道之后，
  由它们连回环地址；要直连监听需显式 `HOST=0.0.0.0`。
- 支持路径前缀发布（如 nginx `location /remote/ { proxy_pass http://127.0.0.1:8787/; }`
  剥前缀转发）：手机客户端会从页面地址自动推导 WS 端点（`https://host/<base>/` →
  `wss://host/<base>/ws`），无需为前缀改协议。

行为验收：

```bash
node protocol-test.mjs ws://127.0.0.1:8787/ws          # 本机
node protocol-test.mjs wss://host/prefix/ws            # 反代/隧道全链路（静态用例按前缀解析）
```

## 官方前端接入（zcode.z.ai/remote/v4 反代模式）

官方现行手机前端可直接用作本 relay 的 UI：nginx 把 `/remote/v4`（HTML + `/remote/v4/latest/*`
资产）实时反代到 zcode.z.ai，同时用 `sub_filter` 把它烘焙的 relay 端点
`wss://zcode.z.ai/ws`（全 app 唯一常量 `Yd`，`Mae/B4t` 由此派生，`endpointOrigin`
对非 chatglm 域不生效）改写为本域 `/ws`；sub_filter 不能处理压缩响应，需向源站要
identity 再由 nginx 自行 gzip。桌面侧 QR 的 `ZCODE_WEB_REMOTE_CONTROL_URL` 指向本域
`/remote/v4/`，控制链路（认证 + data 信封）即全程走自建 relay。

配套的 relay 兼容层（本文件已实现）：

- 官方前端以 `role:"terminal"` 接入（映射到 remote 槽位），proof 按原始角色串
  `${nonce}|terminal|${sid}` 校验；
- terminal 应答 `auth_ack{pair_status:"matched"|"waiting"}`（自家客户端仍收 `auth_ok`）；
- `pair_status_ack` 双字段并写：`paired`（布尔，自家客户端）+ `pair_status`（枚举，官方前端）。

注意：官方前端与官方 3.14.3 桌面端的控制面为 `zcode_type`/`requestId` + 驼峰
result 结构；本仓库 `webRemoteControlControlPlane.ts` 目前仍是 `type`/`request_id`
旧方言，故 `/remote/` 兜底前端只与「按本仓库构建的桌面端」配套，官方前端要配
官方/同步版桌面端（桌面端原生新方言，relay 透明透传 data 信封，无需翻译）。WS 端点若在反代上豁免 basic auth，
  安全由 relay 自身的 HMAC passHash 挑战应答兜底。

生产建议置于 TLS 反代之后（客户端 relay 端点为 `wss://<host>/ws`）。

## 桌面侧指向自建 relay

启动 ZCode 桌面端前设置：

```bash
export ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL=wss://your-relay.example.com/ws
export ZCODE_WEB_REMOTE_CONTROL_URL=https://your-web-client.example.com/remote/v4
```

（不设置时默认连官方 relay；两个 env 只在未配对前切换才完全生效，切换后建议
在设置页执行一次"重置配对"。）

## 行为清单（验收标准）

1. WS `/ws`，单条 JSON 消息 ≤1MB；
2. `{type:"device_register_init"}` → 分配 `device_sid` → `device_register_ack`；
3. `auth_init(role: device|remote)` → `auth_challenge{nonce}` → `auth_response{proof}`，
   `proof = base64url(HMAC-SHA256(passHash, nonce|role|deviceSid))`；
4. 配对互斥：同 device_sid 同角色新连接上线 → 旧连接收 `{type:"kicked"}` 并以 4010 关闭；
5. `pair_status_query` → `pair_status_ack{paired}`（对端在线与否）；
6. `{type:"data", payload}` 原样透传到对端；
7. 关闭码：4004 认证失败 / 4009 心跳超时 / 4010 被接管 / 4011 未知 sid / 4012 注册非法 / 4013 停机；
8. 不实现 rpc-frame 层。
