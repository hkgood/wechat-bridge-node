/**
 * 微信公众号中转服务（Node.js Express 版）
 *
 * 部署到阿里云 1Panel：
 *   docker compose up -d
 * 监听端口：8080
 *
 * 接口：
 *   GET  /                - Web Dashboard（带密码登录）
 *   GET  /healthz         - 健康检查
 *   GET  /api/outbound-ip - 查询本机公网 IP
 *   POST /api/publish     - 推送早报到草稿箱
 *   GET  /api/drafts?password=xxx   - 草稿列表
 *   POST /api/send/:id?password=xxx - 群发某条草稿
 *   GET  /api/history?password=xxx  - 历史记录
 *
 * 环境变量（1Panel 在 docker-compose.yml 里配）：
 *   WX_APP_ID
 *   WX_APP_SECRET
 *   ADMIN_PASSWORD
 *   PORT (默认 8080)
 */

const express = require("express");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(express.json({ limit: "50mb" }));

const PORT = process.env.PORT || 8080;
const WX_APP_ID = process.env.WX_APP_ID || "";
const WX_APP_SECRET = process.env.WX_APP_SECRET || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";

// 简单文件 KV 存储（替代 Cloudflare KV）
const DATA_DIR = process.env.DATA_DIR || "/app/data";
const TOKEN_FILE = path.join(DATA_DIR, "wx_token.json");
const HISTORY_FILE = path.join(DATA_DIR, "history.json");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(HISTORY_FILE)) {
  fs.writeFileSync(HISTORY_FILE, "[]", "utf-8");
}

// ============== 微信 API ==============
const WX_API = "https://api.weixin.qq.com/cgi-bin";

async function getAccessToken() {
  // 缓存
  if (fs.existsSync(TOKEN_FILE)) {
    try {
      const cache = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf-8"));
      if (cache.expire_at > Date.now() / 1000) return cache.access_token;
    } catch (e) {}
  }
  // 使用新的 stable_token 接口（旧版 /cgi-bin/token 已被微信弃用）
  const url = `${WX_API}/stable_token`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      appid: WX_APP_ID,
      secret: WX_APP_SECRET,
      grant_type: "client_credential",
      force_refresh: false,
    }),
  });
  const data = await r.json();
  if (data.errcode) throw new Error(`获取 access_token 失败: ${JSON.stringify(data)}`);
  fs.writeFileSync(TOKEN_FILE, JSON.stringify({
    access_token: data.access_token,
    expire_at: Math.floor(Date.now() / 1000) + (data.expires_in || 7200) - 200,
  }));
  return data.access_token;
}

async function wxApi(path, method = "GET", body) {
  const token = await getAccessToken();
  const url = `${WX_API}${path}${path.includes("?") ? "&" : "?"}access_token=${token}`;
  const opts = { method };
  if (body) {
    opts.headers = { "Content-Type": "application/json" };
    opts.body = JSON.stringify(body);
  }
  let r = await fetch(url, opts);
  let data = await r.json();
  // 如果 token 过期，强制刷新再试一次
  if (data.errcode === 40001 || data.errcode === 42001 || data.errcode === 40014) {
    console.log("⚠️ token 过期，强制刷新");
    if (fs.existsSync(TOKEN_FILE)) fs.unlinkSync(TOKEN_FILE);
    const newToken = await getAccessToken();
    const newUrl = `${WX_API}${path}${path.includes("?") ? "&" : "?"}access_token=${newToken}`;
    r = await fetch(newUrl, opts);
    data = await r.json();
  }
  return data;
}

async function uploadNewsImage(imageUrl) {
  const token = await getAccessToken();
  const r = await fetch(imageUrl);
  const buffer = Buffer.from(await r.arrayBuffer());
  const form = new FormData();
  form.append("media", new Blob([buffer], { type: "image/jpeg" }), "cover.jpg");
  const url = `${WX_API}/material/add_material?access_token=${token}&type=image`;
  const res = await fetch(url, { method: "POST", body: form });
  const data = await res.json();
  if (data.errcode) throw new Error(`上传封面失败: ${JSON.stringify(data)}`);
  return data.media_id;
}

async function addDraft(article) {
  const data = await wxApi("/draft/add", "POST", { articles: [article] });
  if (data.errcode) throw new Error(`写入草稿失败: ${JSON.stringify(data)}`);
  return data.media_id;
}

async function uploadAudio(audioBase64, filename = "podcast.mp3") {
  const token = await getAccessToken();
  const binary = Buffer.from(audioBase64, "base64");
  const form = new FormData();
  form.append("media", new Blob([binary], { type: "audio/mpeg" }), filename);
  const url = `${WX_API}/material/add_material?access_token=${token}&type=voice`;
  const r = await fetch(url, { method: "POST", body: form });
  const data = await r.json();
  if (data.errcode) throw new Error(`上传音频失败: ${JSON.stringify(data)}`);
  return data.media_id;
}

async function sendAll(mediaId) {
  return wxApi("/message/mass/sendall", "POST", {
    filter: { is_to_all: true },
    mpnews: { media_id: mediaId },
    msgtype: "mpnews",
    send_ignore_reprint: 0,
  });
}

// ============== 历史记录 ==============
function saveHistory(entry) {
  const list = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8"));
  const key = `entry_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const fullEntry = { key, timestamp: Date.now(), ...entry };
  list.unshift(fullEntry);
  // 限 50 条
  if (list.length > 50) list.length = 50;
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(list, null, 2));
  return key;
}

function listHistory() {
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8"));
  } catch {
    return [];
  }
}

// ============== 路由 ==============

// 1. 健康检查
app.get("/healthz", (req, res) => {
  res.json({ ok: true, ts: Date.now(), ip: req.ip });
});

// 1.5 诊断接口（查看 access_token 是否有效）
app.get("/api/debug", async (req, res) => {
  try {
    const r = await fetch(`${WX_API}/token?grant_type=client_credential&appid=${WX_APP_ID}&secret=${WX_APP_SECRET}`);
    const data = await r.json();
    res.json({
      configured: { app_id: WX_APP_ID, has_secret: !!WX_APP_SECRET, secret_length: WX_APP_SECRET.length },
      token_response: data,
      hint: data.errcode ? "AppID 或 AppSecret 不对" : "AppID/Secret 有效",
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// 2. 查询本机公网 IP
app.get("/api/outbound-ip", async (req, res) => {
  try {
    // 信任 nginx 反向代理的 X-Forwarded-For 或 X-Real-IP
    const xff = req.headers["x-forwarded-for"];
    const realIp = req.headers["x-real-ip"] || req.ip || req.socket.remoteAddress;
    const publicIp = (xff ? xff.toString().split(",")[0].trim() : null) || realIp;
    res.json({
      ip: publicIp,
      hint: "把这个 IP 加到公众号后台的 IP 白名单（开发→基本配置）",
      server: {
        public_ip: publicIp,
        real_ip: realIp,
        xff: xff,
      },
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// 3. 推送早报到草稿箱
app.post("/api/publish", async (req, res) => {
  try {
    const { title, content, audio_base64, audio_filename, thumb_url, digest } = req.body || {};
    if (!title || !content) {
      return res.status(400).json({ error: "title 和 content 必填" });
    }
    if (!WX_APP_ID || !WX_APP_SECRET) {
      return res.status(500).json({ error: "请先在环境变量里配置 WX_APP_ID 和 WX_APP_SECRET" });
    }

    let thumb_media_id, audio_media_id;

    if (thumb_url) {
      try { thumb_media_id = await uploadNewsImage(thumb_url); } catch (e) { console.log("封面跳过:", e.message); }
    }

    // 如果没传封面，上传一个默认封面（解决 40007 问题）
    if (!thumb_media_id) {
      try {
        console.log("🔼 开始上传默认封面...");
        // 1x1 透明 PNG（最小合法图片）
        const png1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
        const token = await getAccessToken();
        const form = new FormData();
        form.append("media", new Blob([png1x1], { type: "image/png" }), "cover.png");
        const r = await fetch(`${WX_API}/material/add_material?access_token=${token}&type=image`, { method: "POST", body: form });
        const data = await r.json();
        console.log("🔼 素材上传返回:", JSON.stringify(data));
        if (data.media_id) {
          thumb_media_id = data.media_id;
          console.log("✅ 默认封面上传成功:", thumb_media_id);
        } else {
          console.log("⚠️ 默认封面上传失败:", JSON.stringify(data));
        }
      } catch (e) {
        console.log("默认封面上传异常:", e.message);
      }
    }

    if (audio_base64) {
      try { audio_media_id = await uploadAudio(audio_base64, audio_filename || "podcast.mp3"); } catch (e) { console.log("音频跳过:", e.message); }
    }

    let fullContent = content;
    if (audio_media_id) {
      fullContent += `\n\n<p style="background:#f0f9ff;padding:12px;border-radius:6px;">🎙️ <strong>Podcast 音频</strong>：公众号后台素材库已上传（素材 ID: ${audio_media_id}）</p>`;
    }

    const article = {
      title: title.slice(0, 64),
      author: "Mavis AI 早报",
      digest: (digest || content.replace(/<[^>]+>/g, "").slice(0, 100)).slice(0, 120),
      content: fullContent,
      content_source_url: "",
      thumb_media_id: thumb_media_id || "",
    };
    if (!thumb_media_id) {
      console.log("⚠️ 警告: thumb_media_id 为空，可能导致 40007");
    }
    console.log("📰 草稿 article:", JSON.stringify({ ...article, content: article.content.slice(0, 80) + "..." }, null, 2));
    const media_id = await addDraft(article);

    saveHistory({
      title,
      digest: article.digest,
      media_id,
      has_audio: !!audio_media_id,
      audio_media_id,
      thumb_media_id,
    });

    res.json({
      ok: true,
      media_id,
      has_audio: !!audio_media_id,
      message: "已存入公众号草稿箱，请登录 https://mp.weixin.qq.com 群发",
    });
  } catch (e) {
    console.error("publish 错误:", e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// 4. 草稿列表
app.get("/api/drafts", (req, res) => {
  if (req.query.password !== ADMIN_PASSWORD) return res.status(401).json({ error: "密码错误" });
  const history = listHistory();
  res.json({ ok: true, count: history.length, history });
});

// 5. 群发
app.post("/api/send/:id", async (req, res) => {
  if (req.query.password !== ADMIN_PASSWORD) return res.status(401).json({ error: "密码错误" });
  try {
    const result = await sendAll(req.params.id);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// 6. Dashboard HTML
app.get("/", (req, res) => {
  res.type("html").send(DASHBOARD_HTML);
});

app.get("/dashboard", (req, res) => {
  res.type("html").send(DASHBOARD_HTML);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ 微信公众号中转服务已启动`);
  console.log(`📡 端口: ${PORT}`);
  console.log(`🔑 WX_APP_ID: ${WX_APP_ID ? "已配置 ✓" : "⚠️ 未配置"}`);
  console.log(`🔐 ADMIN_PASSWORD: ${ADMIN_PASSWORD ? "已配置 ✓" : "⚠️ 使用默认 admin123"}`);
  console.log(`📂 数据目录: ${DATA_DIR}`);
});

// ============== Dashboard HTML ==============
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AI 早报 Dashboard</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f9fafb; color: #1f2937; padding: 20px; }
.container { max-width: 1200px; margin: 0 auto; }
h1 { font-size: 24px; margin-bottom: 8px; color: #111827; }
.subtitle { color: #6b7280; margin-bottom: 24px; font-size: 14px; }
.card { background: white; border-radius: 8px; padding: 20px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
input[type=password] { padding: 10px 12px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; width: 240px; }
button { padding: 10px 16px; background: #2563eb; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; }
button:hover { background: #1d4ed8; }
button:disabled { background: #9ca3af; cursor: not-allowed; }
.entry { border-left: 3px solid #2563eb; padding: 12px 16px; margin-bottom: 12px; background: #f9fafb; border-radius: 4px; }
.entry h3 { font-size: 15px; margin-bottom: 4px; color: #111827; }
.entry .meta { font-size: 12px; color: #6b7280; margin-bottom: 6px; }
.entry .digest { font-size: 13px; color: #374151; line-height: 1.5; }
.entry .actions { margin-top: 8px; display: flex; gap: 8px; }
.entry .actions button { padding: 4px 10px; font-size: 12px; }
.badge { display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 11px; margin-left: 6px; }
.badge.audio { background: #d1fae5; color: #065f46; }
.badge.thumb { background: #dbeafe; color: #1e40af; }
.empty { text-align: center; color: #9ca3af; padding: 40px; }
#login { text-align: center; padding: 60px 20px; }
#login h2 { margin-bottom: 12px; }
#login p { color: #6b7280; margin-bottom: 20px; font-size: 13px; }
.api-info { background: #f3f4f6; padding: 12px; border-radius: 4px; font-family: monospace; font-size: 12px; margin-top: 12px; white-space: pre-wrap; }
</style>
</head>
<body>
<div class="container">
<h1>📰 AI 早报 Dashboard</h1>
<p class="subtitle">Node.js 版 · 部署在阿里云 · 微信公众号草稿箱</p>

<div id="login" class="card">
<h2>🔐 管理员登录</h2>
<p>输入环境变量 ADMIN_PASSWORD</p>
<input type="password" id="password" placeholder="管理员密码" />
<button onclick="loadHistory()">登录</button>
</div>

<div id="content" style="display:none;">
<div class="card">
<h2 style="font-size:16px; margin-bottom:12px;">📊 最近推送</h2>
<div id="history"></div>
</div>

<div class="card">
<h2 style="font-size:16px; margin-bottom:12px;">🔌 API 接口</h2>
<p style="font-size:13px; color:#6b7280; margin-bottom:8px;">从 Mavis / curl 调用：</p>
<div class="api-info">POST /api/publish
Content-Type: application/json
{ "title": "...", "content": "<p>...</p>", "audio_base64": "...", "thumb_url": "..." }</div>
<p style="font-size:13px; color:#6b7280; margin-top:12px;">查询本机公网 IP：</p>
<div class="api-info">GET /api/outbound-ip</div>
</div>
</div>
</div>

<script>
let adminPwd = '';
async function loadHistory() {
  adminPwd = document.getElementById('password').value;
  if (!adminPwd) { alert('请输入密码'); return; }
  const r = await fetch('/api/drafts?password=' + encodeURIComponent(adminPwd));
  if (r.status === 401) { alert('密码错误'); return; }
  const data = await r.json();
  document.getElementById('login').style.display = 'none';
  document.getElementById('content').style.display = 'block';
  const container = document.getElementById('history');
  if (data.history.length === 0) {
    container.innerHTML = '<div class="empty">还没有推送记录</div>';
    return;
  }
  container.innerHTML = data.history.map(e => \`
    <div class="entry">
      <h3>\${e.title}\${e.has_audio ? '<span class="badge audio">🎙️ 含音频</span>' : ''}\${e.thumb_media_id ? '<span class="badge thumb">🖼️ 含封面</span>' : ''}</h3>
      <div class="meta">\${new Date(e.timestamp).toLocaleString('zh-CN')} · 草稿 ID: \${e.media_id}</div>
      <div class="digest">\${e.digest || '(无摘要)'}</div>
      <div class="actions">
        <button onclick="sendDraft('\${e.media_id}')">📤 群发</button>
        <button onclick="copyId('\${e.media_id}')">📋 复制 ID</button>
      </div>
    </div>
  \`).join('');
}
async function sendDraft(mediaId) {
  if (!confirm('确定群发这条草稿吗？订阅号每天只能群发 1 次！')) return;
  const r = await fetch('/api/send/' + mediaId + '?password=' + encodeURIComponent(adminPwd), { method: 'POST' });
  const data = await r.json();
  alert('群发结果：' + JSON.stringify(data));
}
function copyId(id) {
  navigator.clipboard.writeText(id);
  alert('已复制：' + id);
}
</script>
</body>
</html>`;
