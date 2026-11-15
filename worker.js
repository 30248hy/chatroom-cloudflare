// 聊天室 Cloudflare Workers 版（JavaScript + D1 SQLite）
// 前端 HTML 内嵌在本文件底部（const HTML），与同目录 index.html 内容一致。
// 改前端请改 index.html，再重新把内容贴进 const HTML（或用 README 里的生成命令）。
//
// 接口与 Python 版一致：
//   GET  /                         聊天室页面
//   GET  /api/messages?after=<id>  拉取新消息（id 大于 after 的）
//   POST /api/messages             发消息，JSON {"nickname": "...", "text": "..."}
//   GET  /api/health               健康检查 {"ok": true}
//
// 需要绑定一个 D1 数据库，绑定名 DB（见 wrangler.toml）。

const MAX_NICKNAME_LEN = 20;
const MAX_TEXT_LEN = 500;
// 简单限流：同一 IP 每分钟最多发 20 条（与 Python 版一致）
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 20;
const POLL_LIMIT = 200;

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function clientIp(request) {
  return (
    request.headers.get("CF-Connecting-IP") ||
    (request.headers.get("X-Forwarded-For") || "").split(",")[0].trim() ||
    "unknown"
  );
}

async function listMessages(env, afterId) {
  // id 是主键，WHERE id > ? 只扫新增行，不产生多余的 D1 读行数
  const { results } = await env.DB.prepare(
    "SELECT id, nickname, text, created_at FROM messages WHERE id > ? ORDER BY id ASC LIMIT ?",
  )
    .bind(afterId, POLL_LIMIT)
    .all();
  return results || [];
}

async function countRecentByIp(env, ip) {
  // 限流：统计该 IP 最近 1 分钟已发的消息数。
  // 注意：Workers 是无状态的，内存限流不可靠，所以用 D1 查。
  // ip 列上有索引（见 schema.sql），只扫匹配行，不会全表扫描。
  const cutoff = new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString();
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM messages WHERE ip = ? AND created_at > ?",
  )
    .bind(ip, cutoff)
    .first();
  return row ? row.n : 0;
}

async function insertMessage(env, nickname, text, ip) {
  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    "INSERT INTO messages (nickname, text, created_at, ip) VALUES (?, ?, ?, ?)",
  )
    .bind(nickname, text, now, ip)
    .run();
  return {
    id: result.meta.last_row_id,
    nickname,
    text,
    created_at: now,
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "GET" && path === "/") {
      return new Response(HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (request.method === "GET" && path === "/api/health") {
      return json({ ok: true });
    }

    if (request.method === "GET" && path === "/api/messages") {
      const after = parseInt(url.searchParams.get("after") || "0", 10);
      const messages = await listMessages(
        env,
        Number.isFinite(after) ? after : 0,
      );
      return json({ messages });
    }

    if (request.method === "POST" && path === "/api/messages") {
      let data;
      try {
        data = await request.json();
      } catch {
        return json({ error: "请求体不是合法 JSON" }, 400);
      }
      const nickname = String(data?.nickname ?? "").trim();
      const text = String(data?.text ?? "").trim();
      if (!nickname || !text) {
        return json({ error: "昵称和消息内容都不能为空" }, 400);
      }
      if (nickname.length > MAX_NICKNAME_LEN) {
        return json({ error: "昵称最多 20 个字" }, 400);
      }
      if (text.length > MAX_TEXT_LEN) {
        return json({ error: "消息最多 500 个字" }, 400);
      }
      const ip = clientIp(request);
      const recent = await countRecentByIp(env, ip);
      if (recent >= RATE_LIMIT_MAX) {
        return json({ error: "发得太快了，稍等一会儿再发" }, 429);
      }
      const message = await insertMessage(env, nickname, text, ip);
      return json({ message }, 201);
    }

    return json({ error: "Not Found" }, 404);
  },
};

const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>聊天室</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; background: #f2f3f5; color: #222; height: 100vh; display: flex; flex-direction: column; }
  header { background: #fff; border-bottom: 1px solid #e5e6eb; padding: 12px 16px; display: flex; align-items: center; justify-content: space-between; }
  header h1 { font-size: 18px; }
  header .me { font-size: 13px; color: #666; display: flex; align-items: center; gap: 8px; }
  header .me button { font-size: 12px; padding: 4px 10px; border: 1px solid #ddd; background: #fff; border-radius: 12px; cursor: pointer; color: #555; }
  #chat { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
  .msg { max-width: 75%; padding: 8px 12px; border-radius: 12px; line-height: 1.5; word-break: break-word; }
  .msg .meta { font-size: 11px; color: #999; margin-bottom: 3px; }
  .msg.mine { align-self: flex-end; background: #ff8c1a; color: #fff; }
  .msg.mine .meta { color: rgba(255,255,255,.85); }
  .msg.other { align-self: flex-start; background: #fff; border: 1px solid #e5e6eb; }
  .msg.other .meta { color: #888; }
  .empty { text-align: center; color: #999; font-size: 13px; margin-top: 40px; }
  #inputbar { background: #fff; border-top: 1px solid #e5e6eb; padding: 10px 12px; display: flex; gap: 8px; }
  #inputbar input { flex: 1; border: 1px solid #ddd; border-radius: 20px; padding: 9px 14px; font-size: 15px; outline: none; }
  #inputbar input:focus { border-color: #ff8c1a; }
  #inputbar button { border: none; background: #ff8c1a; color: #fff; border-radius: 20px; padding: 0 20px; font-size: 15px; cursor: pointer; }
  #inputbar button:disabled { background: #ccc; cursor: default; }
  /* 起昵称遮罩 */
  #nickmask { position: fixed; inset: 0; background: rgba(0,0,0,.45); display: none; align-items: center; justify-content: center; z-index: 10; }
  #nickmask.show { display: flex; }
  .nickcard { background: #fff; border-radius: 16px; padding: 24px; width: min(88vw, 340px); text-align: center; }
  .nickcard h2 { font-size: 18px; margin-bottom: 6px; }
  .nickcard p { font-size: 13px; color: #888; margin-bottom: 16px; }
  .nickcard input { width: 100%; border: 1px solid #ddd; border-radius: 10px; padding: 10px 12px; font-size: 15px; outline: none; margin-bottom: 12px; }
  .nickcard input:focus { border-color: #ff8c1a; }
  .nickcard button { width: 100%; border: none; background: #ff8c1a; color: #fff; border-radius: 10px; padding: 11px; font-size: 15px; cursor: pointer; }
  #nickerr { color: #e64340; font-size: 12px; min-height: 16px; margin-bottom: 4px; }
  #status { text-align: center; font-size: 12px; color: #999; padding: 6px; }
</style>
</head>
<body>
<header>
  <h1>聊天室</h1>
  <div class="me"><span id="meLabel"></span><button id="changeNick">换昵称</button></div>
</header>
<div id="status"></div>
<div id="chat"></div>
<div id="inputbar">
  <input id="text" type="text" placeholder="输入消息…" maxlength="500" autocomplete="off">
  <button id="send">发送</button>
</div>

<div id="nickmask">
  <div class="nickcard">
    <h2>起个昵称进聊天室</h2>
    <p>大家会看到这个名字，之后不用再输</p>
    <input id="nick" type="text" placeholder="比如：小李" maxlength="20" autocomplete="off">
    <div id="nickerr"></div>
    <button id="enterBtn">进入聊天室</button>
  </div>
</div>

<script>
(function () {
  var chatEl = document.getElementById('chat');
  var textEl = document.getElementById('text');
  var sendBtn = document.getElementById('send');
  var meLabel = document.getElementById('meLabel');
  var statusEl = document.getElementById('status');
  var mask = document.getElementById('nickmask');
  var nickEl = document.getElementById('nick');
  var nickErr = document.getElementById('nickerr');
  var enterBtn = document.getElementById('enterBtn');
  var changeBtn = document.getElementById('changeNick');

  var nickname = localStorage.getItem('chat_nickname') || '';
  var lastId = 0;
  var pollTimer = null;
  var sending = false;

  function fmtTime(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var now = new Date();
    var sameDay = d.toDateString() === now.toDateString();
    var hh = String(d.getHours()).padStart(2, '0');
    var mm = String(d.getMinutes()).padStart(2, '0');
    if (sameDay) return hh + ':' + mm;
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hh + ':' + mm;
  }

  function addMessage(m) {
    var empty = chatEl.querySelector('.empty');
    if (empty) empty.remove();
    var div = document.createElement('div');
    div.className = 'msg ' + (m.nickname === nickname ? 'mine' : 'other');
    var meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = m.nickname + ' · ' + fmtTime(m.created_at);
    var body = document.createElement('div');
    body.textContent = m.text;
    div.appendChild(meta);
    div.appendChild(body);
    chatEl.appendChild(div);
    var nearBottom = chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 120;
    if (nearBottom || m.nickname === nickname) chatEl.scrollTop = chatEl.scrollHeight;
  }

  function fetchMessages() {
    if (!nickname) return;
    fetch('/api/messages?after=' + lastId)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var list = data.messages || [];
        list.forEach(function (m) {
          addMessage(m);
          if (m.id > lastId) lastId = m.id;
        });
        statusEl.textContent = '';
      })
      .catch(function () {
        statusEl.textContent = '连接断了，正在重试…';
      });
  }

  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    fetchMessages();
    pollTimer = setInterval(function () {
      if (document.visibilityState === 'visible') fetchMessages();
    }, 3000);
  }

  function showNickMask() {
    nickEl.value = nickname || '';
    nickErr.textContent = '';
    mask.classList.add('show');
    setTimeout(function () { nickEl.focus(); }, 50);
  }

  function hideNickMask() { mask.classList.remove('show'); }

  function enterRoom() {
    var name = nickEl.value.trim();
    if (!name) { nickErr.textContent = '请先起个昵称'; return; }
    if (name.length > 20) { nickErr.textContent = '昵称最多 20 个字'; return; }
    nickname = name;
    localStorage.setItem('chat_nickname', nickname);
    meLabel.textContent = '我是：' + nickname;
    hideNickMask();
    startPolling();
  }

  function send() {
    var text = textEl.value.trim();
    if (!text || sending || !nickname) return;
    sending = true;
    sendBtn.disabled = true;
    fetch('/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname: nickname, text: text })
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (!res.ok) { statusEl.textContent = res.d.error || '发送失败'; return; }
        textEl.value = '';
        fetchMessages();
      })
      .catch(function () { statusEl.textContent = '发送失败，请检查网络'; })
      .finally(function () { sending = false; sendBtn.disabled = false; textEl.focus(); });
  }

  sendBtn.addEventListener('click', send);
  textEl.addEventListener('keydown', function (e) { if (e.key === 'Enter') send(); });
  enterBtn.addEventListener('click', enterRoom);
  nickEl.addEventListener('keydown', function (e) { if (e.key === 'Enter') enterRoom(); });
  changeBtn.addEventListener('click', function () { showNickMask(); });

  if (nickname) {
    meLabel.textContent = '我是：' + nickname;
    var empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = '还没有消息，来发第一条吧';
    chatEl.appendChild(empty);
    startPolling();
  } else {
    showNickMask();
  }
})();
</script>
</body>
</html>
`;
