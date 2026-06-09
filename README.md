# wechat-bridge-node

微信公众号中转服务（Node.js 版），**部署到阿里云 1Panel**。

解决 Mavis 沙箱 IP 动态问题 —— 用阿里云服务器固定公网 IP 中转。

---

## 1Panel 部署步骤

### 第一步：1Panel 创建本地镜像

1. 登录 1Panel（你服务器的 `http://115.29.162.18:1panel-port`）
2. 左侧菜单 **「容器」→「本地镜像」**
3. 找 **「构建镜像」** 按钮
4. 选 **「本地构建」**
5. **上传项目代码**：
   - 在 1Panel 服务器上建个目录：`/opt/1panel/apps/wechat-bridge/`
   - 把本仓库的 `package.json` `Dockerfile` `docker-compose.yml` `src/` 传过去
6. 镜像名称：`wechat-bridge`
7. 标签：`v1.0`
8. 点击 **「构建」**（1-3 分钟）

### 第二步：创建容器

构建完成后，**容器 → 创建容器**：

| 字段 | 值 |
|------|-----|
| 镜像 | `wechat-bridge:v1.0` |
| 容器名称 | `wechat-bridge` |
| 端口映射 | `8080:8080` |
| 重启策略 | `always` |
| 环境变量 | （见下方） |
| 卷挂载 | `/opt/1panel/apps/wechat-bridge/data:/app/data` |

**环境变量**：

| 变量 | 值 |
|------|-----|
| `WX_APP_ID` | `wx357838b9bb8ad7ef` |
| `WX_APP_SECRET` | `63db4a61c06460df7ae44e81e02b499a` |
| `ADMIN_PASSWORD` | 你自己设一个强密码 |
| `PORT` | `8080` |
| `DATA_DIR` | `/app/data` |

### 第三步：开放防火墙 8080 端口

1. **阿里云控制台** → ECS → **安全组** → 配置规则
2. 添加入方向规则：
   - 端口：`8080/8080`
   - 协议：`TCP`
   - 来源：`0.0.0.0/0`（或限定 IP）
3. 1Panel 自身的**防火墙**也开放 8080

### 第四步：验证

浏览器打开 `http://115.29.162.18:8080/healthz`

期望返回：
```json
{"ok":true,"ts":...,"ip":"::ffff:127.0.0.1"}
```

### 第五步：获取本机公网 IP

`http://115.29.162.18:8080/api/outbound-ip`

期望返回：
```json
{"ip":"115.29.162.18",...}
```

### 第六步：加公众号白名单

1. https://mp.weixin.qq.com → **开发** → **基本配置** → **IP 白名单**
2. 添加 `115.29.162.18`
3. 保存（需要管理员微信扫码）

### 第七步：测试推送

```bash
curl -X POST "http://115.29.162.18:8080/api/publish" \
  -H "Content-Type: application/json" \
  -d '{"title":"测试早报","content":"<h1>测试</h1><p>来自 Mavis 的第一条测试推送</p>","digest":"测试"}'
```

返回 `{"ok":true,"media_id":"..."}` = 成功。

登录公众号后台 → **草稿箱** → 看到测试早报。

---

## 1Panel 快速构建（用 docker compose）

如果你 1Panel 安装了 Docker Compose 插件（默认有）：

```bash
# 1. SSH 到阿里云
ssh root@115.29.162.18

# 2. 进 1Panel 应用目录
mkdir -p /opt/1panel/apps/wechat-bridge
cd /opt/1panel/apps/wechat-bridge

# 3. 创建文件（你可以在 1Panel 终端里编辑，或者本地写好后 scp 上去）

# 4. 启动
docker compose up -d

# 5. 看日志
docker compose logs -f

# 6. 重启
docker compose restart
```

---

## 反向代理（可选，推荐）

用 1Panel 网站功能，反代到 `127.0.0.1:8080`，这样可以用 `https://wechat.yourdomain.com` 访问（带 HTTPS）。

---

## API 文档

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` | Dashboard |
| GET | `/healthz` | 健康检查 |
| GET | `/api/outbound-ip` | 本机公网 IP |
| POST | `/api/publish` | 推送草稿 |
| GET | `/api/drafts?password=xxx` | 草稿列表 |
| POST | `/api/send/:mediaId?password=xxx` | 群发 |

### POST /api/publish 请求体

```json
{
  "title": "AI 早报 | 2026-06-09",
  "content": "<h1>...</h1><p>...</p>",
  "digest": "摘要",
  "thumb_url": "https://...（封面）",
  "audio_base64": "base64 编码的 mp3",
  "audio_filename": "podcast.mp3"
}
```

---

## 数据持久化

`/app/data` 目录存：
- `wx_token.json` - access_token 缓存
- `history.json` - 历史推送记录（最多 50 条）

挂载到宿主机，**容器删除数据不丢**。

---

## 故障排查

### 容器起不来
```bash
docker logs wechat-bridge
```

### 公众号返回 40164
IP 白名单没加。看 `/api/outbound-ip` 拿真实 IP。

### 公众号返回其他 errcode
看容器日志 `docker logs wechat-bridge`。
