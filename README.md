# wechat-bridge-node

微信公众号中转服务（Node.js 版），**通过 GitHub Actions 自动构建 Docker 镜像，部署到阿里云 1Panel**。

解决 Mavis 沙箱 IP 动态问题 —— 用阿里云服务器固定公网 IP 中转。

---

## 整体流程

```
GitHub 仓库 push
   ↓
GitHub Actions 自动 build Docker 镜像
   ↓
发布到 ghcr.io（GitHub Container Registry）
   ↓
阿里云 1Panel 拉取最新镜像
   ↓
docker compose up -d 启动
   ↓
服务运行在 http://115.29.162.18:8080
   ↓
Mavis 每天 8:00 cron → POST /api/publish
```

---

## 部署步骤

### 第一步：触发 GitHub Actions 自动构建

代码已经推到 `main` 分支，**GitHub Actions 会自动开始构建**。

查看构建进度：
- 打开 https://github.com/hkgood/wechat-bridge-node/actions
- 等 2-5 分钟，构建完成

构建成功后镜像会发布到：
```
ghcr.io/hkgood/wechat-bridge-node:latest
ghcr.io/hkgood/wechat-bridge-node:main
```

### 第二步：阿里云服务器拉取镜像

SSH 登录你的阿里云：
```bash
ssh root@115.29.162.18
```

登录 GitHub Container Registry（用 GitHub PAT）：
```bash
# 在 https://github.com/settings/tokens 生成一个 PAT，需要 read:packages 权限
echo "YOUR_GITHUB_PAT" | docker login ghcr.io -u hkgood --password-stdin
```

拉取镜像：
```bash
docker pull ghcr.io/hkgood/wechat-bridge-node:latest
```

### 第三步：1Panel 部署容器

#### 方式 A：1Panel 容器界面（图形化）

1. 登录 1Panel
2. 左侧 **「容器」→「容器」**
3. 点击 **「创建容器」**
4. 镜像：`ghcr.io/hkgood/wechat-bridge-node:latest`
5. 容器名称：`wechat-bridge`
6. 端口：`8080:8080`
7. 重启策略：`always`
8. 环境变量（**点击「添加环境变量」**）：

| 变量名 | 值 |
|--------|-----|
| `WX_APP_ID` | `wx357838b9bb8ad7ef` |
| `WX_APP_SECRET` | `63db4a61c06460df7ae44e81e02b499a` |
| `ADMIN_PASSWORD` | 你自己设的强密码 |
| `PORT` | `8080` |
| `DATA_DIR` | `/app/data` |

9. **卷**：挂载 `/opt/1panel/apps/wechat-bridge/data` → `/app/data`
10. 点击 **「创建」**

#### 方式 B：1Panel 终端（用 docker compose）

1. 1Panel → **主机 → 终端**
2. 创建目录：`mkdir -p /opt/1panel/apps/wechat-bridge/data && cd /opt/1panel/apps/wechat-bridge`
3. 创建 `docker-compose.yml`：

```yaml
version: "3.8"
services:
  wechat-bridge:
    image: ghcr.io/hkgood/wechat-bridge-node:latest
    container_name: wechat-bridge
    restart: always
    ports:
      - "8080:8080"
    environment:
      - WX_APP_ID=wx357838b9bb8ad7ef
      - WX_APP_SECRET=63db4a61c06460df7ae44e81e02b499a
      - ADMIN_PASSWORD=RockyReport2026
      - PORT=8080
      - DATA_DIR=/app/data
    volumes:
      - ./data:/app/data
```

4. 拉镜像 + 启动：
```bash
docker compose pull
docker compose up -d
docker compose logs -f
```

### 第四步：开放阿里云安全组 8080 端口

1. **阿里云控制台** → ECS → **安全组** → 配置规则
2. 添加入方向规则：
   - 端口：`8080/8080`
   - 协议：`TCP`
   - 来源：`0.0.0.0/0`（或限定 IP）
3. **1Panel 自身的防火墙** 也开放 8080

### 第五步：验证部署

浏览器打开：
- `http://115.29.162.18:8080/healthz` → 期望 `{"ok":true,...}`
- `http://115.29.162.18:8080/api/outbound-ip` → 期望 `{"ip":"115.29.162.18",...}`
- `http://115.29.162.18:8080/` → 看 Dashboard

### 第六步：公众号白名单

1. https://mp.weixin.qq.com → **开发** → **基本配置** → **IP 白名单**
2. 添加：`115.29.162.18`
3. 保存（管理员扫码）

### 第七步：测试推送

```bash
curl -X POST "http://115.29.162.18:8080/api/publish" \
  -H "Content-Type: application/json" \
  -d '{"title":"测试早报","content":"<h1>测试</h1><p>来自 Mavis</p>","digest":"测试"}'
```

返回 `media_id` = 成功，登录公众号后台看草稿箱。

---

## 镜像更新流程

以后改代码：

```bash
# 本地改完推 GitHub
git add .
git commit -m "feat: ..."
git push origin main
```

GitHub Actions 自动 build → 推送新镜像到 ghcr.io。

阿里云服务器更新：
```bash
cd /opt/1panel/apps/wechat-bridge
docker compose pull
docker compose up -d
```

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

### POST /api/publish

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

## 故障排查

### 拉镜像失败 401/403
- 重新跑 `docker login ghcr.io -u hkgood --password-stdin`
- 检查 PAT 是否有 `read:packages` 权限

### 容器起不来
```bash
docker logs wechat-bridge
```

### 公众号返回 40164
IP 白名单没加。看 `/api/outbound-ip` 确认 IP。

### 公众号返回其他 errcode
看容器日志。

---

## 数据持久化

容器内 `/app/data` 目录：
- `wx_token.json` - access_token 缓存
- `history.json` - 历史推送记录

挂载到宿主机，**容器删除数据不丢**。
