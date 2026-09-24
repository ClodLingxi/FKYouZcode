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
  `wss://host/<base>/ws`），无需为前缀改协议。WS 端点若在反代上豁免 basic auth，
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
