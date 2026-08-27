require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.6-terra";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
// 換模型的話記得順便把價格改掉，不然後台估算的花費會不準（單位：美金／百萬 tokens）
const PRICE_INPUT_PER_1M = Number(process.env.PRICE_INPUT_PER_1M) || 2.0;
const PRICE_OUTPUT_PER_1M = Number(process.env.PRICE_OUTPUT_PER_1M) || 12.0;

// ---- 用量記錄（SQLite）----
// 只記錄「這次呼叫花了多少 token、成功或失敗」這種統計用的資訊，不會記錄對話或記憶庫的實際內容。
// 用的是 Node 內建的 node:sqlite（Node 22.5+ 就有，不需要另外 npm install 任何套件，
// 也不會遇到 better-sqlite3 那種需要裝 Visual Studio C++ 編譯器才能裝起來的 Windows 問題）。
// DB_PATH 沒特別設定的話預設放在專案資料夾裡的 data/usage.db；
// 部署到 Render 的話，這個路徑要指到一個有掛「Persistent Disk」的目錄，不然每次重新部署／重啟資料就會歸零。
let db = null;
let dbError = null;
try {
  const { DatabaseSync } = require("node:sqlite");
  const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data", "usage.db");
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      kind TEXT NOT NULL,
      model TEXT,
      prompt_tokens INTEGER DEFAULT 0,
      completion_tokens INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      status TEXT NOT NULL,
      error_message TEXT,
      duration_ms INTEGER,
      ip TEXT
    );
  `);
  // 存放「緊急維護模式」這種設定值，開關狀態可以立即生效（不用重新部署、不用重啟服務）。
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  // 每隔一分鐘記一筆「當下在線人數」的快照，用來畫在線人數的趨勢圖。
  db.exec(`
    CREATE TABLE IF NOT EXISTS online_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      online_count INTEGER NOT NULL
    );
  `);
  // 存放使用者上傳的原始聊天紀錄與整理後的記憶庫
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_uploads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      session_id TEXT,
      source_name TEXT,
      raw_content TEXT,
      memories_json TEXT,
      style_summary TEXT,
      persona_name TEXT,
      persona_relationship TEXT,
      is_public INTEGER DEFAULT 0,
      ip TEXT
    );
  `);
  // 存放使用者跟 AI 角色的即時對話內容
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      session_id TEXT,
      persona_name TEXT,
      persona_relationship TEXT,
      role TEXT,
      content TEXT,
      ip TEXT
    );
  `);
  console.log(`用量統計資料庫已就緒：${DB_PATH}`);
} catch (e) {
  dbError = e.message || String(e);
  console.warn("⚠️  用量統計資料庫初始化失敗，後台統計功能會停用（不影響主要功能）：", dbError);
}

function logUsage(entry) {
  if (!db) return;
  try {
    db.prepare(
      `INSERT INTO usage_log (created_at, kind, model, prompt_tokens, completion_tokens, total_tokens, status, error_message, duration_ms, ip)
       VALUES (@created_at, @kind, @model, @prompt_tokens, @completion_tokens, @total_tokens, @status, @error_message, @duration_ms, @ip)`
    ).run(entry);
  } catch (e) {
    console.warn("寫入用量記錄失敗：", e.message || e);
  }
}

// ---- 緊急維護模式（救火用的一鍵開關）----
// 存在資料庫裡，不是環境變數，所以在 /admin 按一下就能立刻生效／解除，完全不用重新部署或重啟伺服器。
// 出問題時（例如 OpenAI 帳單被打爆、金鑰被停用、發現有人在濫用）可以第一時間先把 AI 功能整個關掉，
// 網站本身（記憶庫、對話介面）還是能正常打開，只是 AI 功能會顯示維護中的訊息，爭取時間慢慢排查。
const DEFAULT_MAINTENANCE_MESSAGE = "系統暫時維護中，AI 功能先休息一下，請稍後再試。造成不便敬請見諒。";

function getSetting(key, fallback) {
  if (!db) return fallback;
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
    return row ? row.value : fallback;
  } catch (e) {
    return fallback;
  }
}
function setSetting(key, value) {
  if (!db) return false;
  try {
    db.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run(key, value);
    return true;
  } catch (e) {
    return false;
  }
}
function isMaintenanceMode() {
  return getSetting("maintenance_mode", "0") === "1";
}
function maintenanceMessage() {
  return getSetting("maintenance_message", DEFAULT_MAINTENANCE_MESSAGE);
}

// ---- 在線人數（心跳偵測）----
// 沒有帳號登入系統，沒辦法真正知道「誰」在線上，退而求其次的做法：前端每 30 秒回報一次
// 「我還開著這個頁面」，伺服器記住每個瀏覽分頁最後回報的時間，2 分鐘內有回報過的都算「在線」。
// 這份即時名單只存在記憶體裡（伺服器重啟就會歸零，這是合理的，因為「現在在線」本來就是即時資訊，
// 不需要長期保存），但每分鐘會把「當下在線人數」這個數字寫進資料庫留一筆快照，讓後台能畫趨勢圖。
const ONLINE_TIMEOUT_MS = 2 * 60 * 1000;
const onlineSessions = new Map(); // sessionId -> lastSeenAt (ms)

app.post("/api/heartbeat", (req, res) => {
  const { sessionId } = req.body || {};
  if (typeof sessionId === "string" && sessionId) {
    onlineSessions.set(sessionId, Date.now());
  }
  res.json({ ok: true });
});

function currentOnlineCount() {
  const now = Date.now();
  for (const [id, lastSeen] of onlineSessions) {
    if (now - lastSeen > ONLINE_TIMEOUT_MS) onlineSessions.delete(id);
  }
  return onlineSessions.size;
}

setInterval(() => {
  const count = currentOnlineCount();
  if (!db) return;
  try {
    db.prepare("INSERT INTO online_snapshots (created_at, online_count) VALUES (?, ?)").run(new Date().toISOString(), count);
    // 舊快照沒有長期保留的必要，順手清掉 7 天前的資料，資料庫不會無限長大。
    db.prepare("DELETE FROM online_snapshots WHERE created_at < ?").run(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());
  } catch (e) {
    console.warn("寫入在線人數快照失敗：", e.message || e);
  }
}, 60 * 1000);

// 簡單的健康檢查，前端用來確認伺服器有沒有設定好 API key，
// 避免 demo 現場才發現金鑰忘了設定。
app.get("/api/health", (req, res) => {
  res.json({ ok: true, keyConfigured: Boolean(OPENAI_API_KEY), maintenanceMode: isMaintenanceMode(), maintenanceMessage: isMaintenanceMode() ? maintenanceMessage() : null });
});

// 儲存使用者上傳的聊天紀錄（整理進記憶庫時同步呼叫）
app.post("/api/save-upload", (req, res) => {
  if (!db) return res.json({ ok: false });
  const { sessionId, sourceName, rawContent, memoriesJson, styleSummary, personaName, personaRelationship, isPublic } = req.body || {};
  const clientIp = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").toString().split(",")[0].trim();
  try {
    db.prepare(`
      INSERT INTO user_uploads (created_at, session_id, source_name, raw_content, memories_json, style_summary, persona_name, persona_relationship, is_public, ip)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      new Date().toISOString(),
      sessionId || "",
      sourceName || "",
      rawContent || "",
      typeof memoriesJson === "string" ? memoriesJson : JSON.stringify(memoriesJson || []),
      styleSummary || "",
      personaName || "",
      personaRelationship || "",
      isPublic ? 1 : 0,
      clientIp
    );
    res.json({ ok: true });
  } catch (e) {
    console.warn("儲存上傳記錄失敗：", e.message);
    res.json({ ok: false });
  }
});

// 更新公開同意狀態——由使用者自己透過前端呼叫，不是後台決定。
// 依 sessionId 批次更新這個瀏覽分頁（同一個人）上傳過的所有紀錄，
// 讓使用者事後改變心意時，之前上傳的內容也會跟著套用新的選擇。
app.post("/api/update-consent", (req, res) => {
  if (!db) return res.json({ ok: false });
  const { sessionId, isPublic } = req.body || {};
  if (!sessionId) return res.json({ ok: false, error: "缺少 sessionId" });
  try {
    const result = db.prepare("UPDATE user_uploads SET is_public = ? WHERE session_id = ?").run(isPublic ? 1 : 0, sessionId);
    res.json({ ok: true, updated: result.changes });
  } catch (e) {
    res.json({ ok: false });
  }
});

// 儲存使用者跟 AI 角色的即時對話內容（每次收到 AI 回覆後同步呼叫）
app.post("/api/save-message", (req, res) => {
  if (!db) return res.json({ ok: false });
  const { sessionId, personaName, personaRelationship, userMessage, assistantMessage } = req.body || {};
  const clientIp = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").toString().split(",")[0].trim();
  try {
    const insert = db.prepare(`
      INSERT INTO chat_logs (created_at, session_id, persona_name, persona_relationship, role, content, ip)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const now = new Date().toISOString();
    if (typeof userMessage === "string" && userMessage) {
      insert.run(now, sessionId || "", personaName || "", personaRelationship || "", "user", userMessage, clientIp);
    }
    if (typeof assistantMessage === "string" && assistantMessage) {
      insert.run(now, sessionId || "", personaName || "", personaRelationship || "", "assistant", assistantMessage, clientIp);
    }
    res.json({ ok: true });
  } catch (e) {
    console.warn("儲存對話紀錄失敗：", e.message);
    res.json({ ok: false });
  }
});

// 唯一對外的 AI 端點：前端只送 system / messages / max_tokens，
// 真正的 API key 只存在這台伺服器上，永遠不會送到瀏覽器。
app.post("/api/claude", async (req, res) => {
  if (isMaintenanceMode()) {
    return res.status(503).json({ error: maintenanceMessage() });
  }
  if (!OPENAI_API_KEY) {
    return res.status(500).json({ error: "伺服器尚未設定 OPENAI_API_KEY，請參考 README 設定環境變數。" });
  }

  const { system, messages, max_tokens, json, temperature, presence_penalty } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "messages 格式錯誤，需要至少一則訊息。" });
  }

  const startedAt = Date.now();
  const kind = json ? "classify" : "chat";
  const clientIp = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").toString().split(",")[0].trim();

  // OpenAI 走 Chat Completions 格式：沒有像 Anthropic 那樣獨立的 system 欄位，
  // system prompt 要放進 messages 陣列的第一則、role 是 "system"。
  const chatMessages = [
    ...(typeof system === "string" && system ? [{ role: "system", content: system }] : []),
    ...messages,
  ];

  try {
    const upstream = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        // 新一點的 OpenAI 模型已經棄用 max_tokens，改用 max_completion_tokens
        max_completion_tokens: Math.min(Number(max_tokens) || 1000, 16000),
        messages: chatMessages,
        // 對話功能會帶 temperature / presence_penalty 讓語氣更自然、減少用詞重複；
        // 整理記憶那一步沒有帶這兩個參數，維持預設值，讓 JSON 抽取結果盡量穩定精準。
                ...(OPENAI_MODEL.startsWith("gpt-5.6") ? {} : {
          ...(typeof temperature === "number" ? { temperature } : {}),
          ...(typeof presence_penalty === "number" ? { presence_penalty } : {}),
        }),
        // 整理記憶那一步需要拿到嚴格的 JSON，用 OpenAI 的 JSON 模式強制輸出格式，
        // 避免模型偶爾多講幾句廢話讓 JSON.parse 失敗。
        ...(json ? { response_format: { type: "json_object" } } : {}),
      }),
    });

    const data = await upstream.json();
    const duration_ms = Date.now() - startedAt;

    if (!upstream.ok) {
      console.error("OpenAI API error:", data);
      logUsage({
        created_at: new Date().toISOString(),
        kind,
        model: OPENAI_MODEL,
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        status: "error",
        error_message: (data && data.error && data.error.message) || `HTTP ${upstream.status}`,
        duration_ms,
        ip: clientIp,
      });
      if (upstream.status === 401) {
        return res.status(401).json({
          error: "API key 驗證失敗。請確認 .env 裡的 OPENAI_API_KEY 是從 platform.openai.com 申請的金鑰（sk- 開頭），不是其他服務（例如 Groq、Anthropic）的金鑰。",
        });
      }
      return res.status(upstream.status).json({ error: data?.error?.message || "呼叫 OpenAI API 失敗" });
    }

    const usage = data.usage || {};
    logUsage({
      created_at: new Date().toISOString(),
      kind,
      model: OPENAI_MODEL,
      prompt_tokens: usage.prompt_tokens || 0,
      completion_tokens: usage.completion_tokens || 0,
      total_tokens: usage.total_tokens || 0,
      status: "ok",
      error_message: null,
      duration_ms,
      ip: clientIp,
    });

    // 把回應格式轉成前端原本認得的格式，這樣前端程式碼完全不用跟著改。
    const text = data?.choices?.[0]?.message?.content || "";
    res.json({ content: [{ type: "text", text }] });
  } catch (err) {
    console.error("Proxy error:", err);
    logUsage({
      created_at: new Date().toISOString(),
      kind,
      model: OPENAI_MODEL,
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      status: "error",
      error_message: err.message || String(err),
      duration_ms: Date.now() - startedAt,
      ip: clientIp,
    });
    res.status(500).json({ error: "伺服器呼叫 OpenAI API 時發生錯誤，請稍後再試。" });
  }
});

// ---- 後台用量統計（/admin）----
// 用 HTTP Basic Auth 保護，帳號固定是 admin，密碼是環境變數 ADMIN_PASSWORD。
// 沒有設定 ADMIN_PASSWORD 的話，整個後台直接回 404，不會意外曝露一個沒密碼保護的後台。
function requireAdminAuth(req, res, next) {
  if (!ADMIN_PASSWORD) return res.status(404).send("Not found");
  const auth = req.headers.authorization || "";
  const [scheme, encoded] = auth.split(" ");
  const decoded = scheme === "Basic" && encoded ? Buffer.from(encoded, "base64").toString() : "";
  const [user, pass] = decoded.split(":");
  if (user === "admin" && pass === ADMIN_PASSWORD) return next();
  res.set("WWW-Authenticate", 'Basic realm="afterglow-admin"');
  return res.status(401).send("需要登入");
}

app.get("/api/admin/stats", requireAdminAuth, (req, res) => {
  if (!db) return res.status(503).json({ error: dbError || "用量統計資料庫尚未就緒" });
  try {
    const totals = db
      .prepare(
        `SELECT
           COUNT(*) AS calls,
           SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END) AS ok_calls,
           SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS error_calls,
           COALESCE(SUM(prompt_tokens),0) AS prompt_tokens,
           COALESCE(SUM(completion_tokens),0) AS completion_tokens,
           COALESCE(SUM(total_tokens),0) AS total_tokens
         FROM usage_log`
      )
      .get();

    const byKind = db
      .prepare(
        `SELECT kind, COUNT(*) AS calls, COALESCE(SUM(prompt_tokens),0) AS prompt_tokens, COALESCE(SUM(completion_tokens),0) AS completion_tokens
         FROM usage_log GROUP BY kind`
      )
      .all();

    const byDay = db
      .prepare(
        `SELECT substr(created_at, 1, 10) AS day,
                COUNT(*) AS calls,
                COALESCE(SUM(prompt_tokens),0) AS prompt_tokens,
                COALESCE(SUM(completion_tokens),0) AS completion_tokens
         FROM usage_log
         GROUP BY day
         ORDER BY day DESC
         LIMIT 30`
      )
      .all();

    const byHour = db
      .prepare(
        `SELECT substr(created_at, 1, 13) AS hour,
                COUNT(*) AS calls
         FROM usage_log
         GROUP BY hour
         ORDER BY hour DESC
         LIMIT 48`
      )
      .all();

    const byIp = db
      .prepare(
        `SELECT ip, COUNT(*) AS calls, COALESCE(SUM(total_tokens),0) AS total_tokens
         FROM usage_log
         WHERE ip IS NOT NULL AND ip != ''
         GROUP BY ip
         ORDER BY calls DESC
         LIMIT 20`
      )
      .all();

    const recentErrors = db
      .prepare(
        `SELECT created_at, kind, error_message, ip FROM usage_log
         WHERE status='error' ORDER BY id DESC LIMIT 20`
      )
      .all();

    const estCost = (totals.prompt_tokens / 1e6) * PRICE_INPUT_PER_1M + (totals.completion_tokens / 1e6) * PRICE_OUTPUT_PER_1M;

    res.json({
      model: OPENAI_MODEL,
      pricing: { inputPer1M: PRICE_INPUT_PER_1M, outputPer1M: PRICE_OUTPUT_PER_1M },
      totals: { ...totals, estimatedCostUsd: Math.round(estCost * 10000) / 10000 },
      byKind,
      byDay,
      byHour,
      byIp,
      recentErrors,
      uploadCount: db.prepare("SELECT COUNT(*) AS c FROM user_uploads").get().c,
      publicCount: db.prepare("SELECT COUNT(*) AS c FROM user_uploads WHERE is_public=1").get().c,
    });
  } catch (e) {
    res.status(500).json({ error: e.message || "讀取統計失敗" });
  }
});

app.get("/api/admin/online", requireAdminAuth, (req, res) => {
  const current = currentOnlineCount();
  let history = [];
  if (db) {
    try {
      history = db
        .prepare(
          `SELECT created_at, online_count FROM online_snapshots
           ORDER BY id DESC LIMIT 120`
        )
        .all()
        .reverse();
    } catch (e) {}
  }
  res.json({ current, history });
});

app.get("/api/admin/settings", requireAdminAuth, (req, res) => {
  res.json({
    dbAvailable: Boolean(db),
    maintenanceMode: isMaintenanceMode(),
    maintenanceMessage: maintenanceMessage(),
    defaultMaintenanceMessage: DEFAULT_MAINTENANCE_MESSAGE,
  });
});

app.post("/api/admin/settings", requireAdminAuth, (req, res) => {
  if (!db) return res.status(503).json({ error: dbError || "資料庫尚未就緒，無法儲存設定" });
  const { maintenanceMode: nextMode, maintenanceMessage: nextMessage } = req.body || {};
  if (typeof nextMode === "boolean") setSetting("maintenance_mode", nextMode ? "1" : "0");
  if (typeof nextMessage === "string" && nextMessage.trim()) setSetting("maintenance_message", nextMessage.trim().slice(0, 300));
  res.json({ ok: true, maintenanceMode: isMaintenanceMode(), maintenanceMessage: maintenanceMessage() });
});

app.get("/api/admin/uploads", requireAdminAuth, (req, res) => {
  if (!db) return res.status(503).json({ error: "資料庫未就緒" });
  const page = Math.max(1, Number(req.query.page) || 1);
  const perPage = 20;
  const offset = (page - 1) * perPage;
  const filter = req.query.filter || "all"; // all | public | private
  const where = filter === "public" ? "WHERE is_public=1" : filter === "private" ? "WHERE is_public=0" : "";
  const total = db.prepare(`SELECT COUNT(*) AS c FROM user_uploads ${where}`).get().c;
  const rows = db.prepare(
    `SELECT id, created_at, session_id, source_name, style_summary, persona_name, persona_relationship, is_public, ip,
            length(raw_content) AS raw_len,
            json_array_length(memories_json) AS memory_count
     FROM user_uploads ${where} ORDER BY id DESC LIMIT ? OFFSET ?`
  ).all(perPage, offset);
  res.json({ total, page, perPage, rows });
});

app.get("/api/admin/uploads/:id", requireAdminAuth, (req, res) => {
  if (!db) return res.status(503).json({ error: "資料庫未就緒" });
  const row = db.prepare("SELECT * FROM user_uploads WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "找不到" });
  res.json(row);
});

// 對話紀錄：先列出「每個分頁（session）」的摘要，再點進去看完整對話。
app.get("/api/admin/chats", requireAdminAuth, (req, res) => {
  if (!db) return res.status(503).json({ error: "資料庫未就緒" });
  const page = Math.max(1, Number(req.query.page) || 1);
  const perPage = 20;
  const offset = (page - 1) * perPage;
  const total = db.prepare("SELECT COUNT(DISTINCT session_id) AS c FROM chat_logs WHERE session_id IS NOT NULL AND session_id != ''").get().c;
  const rows = db.prepare(
    `SELECT session_id,
            MAX(persona_name) AS persona_name,
            MAX(persona_relationship) AS persona_relationship,
            COUNT(*) AS message_count,
            MIN(created_at) AS started_at,
            MAX(created_at) AS last_at,
            MAX(ip) AS ip
     FROM chat_logs
     WHERE session_id IS NOT NULL AND session_id != ''
     GROUP BY session_id
     ORDER BY last_at DESC
     LIMIT ? OFFSET ?`
  ).all(perPage, offset);
  res.json({ total, page, perPage, rows });
});

app.get("/api/admin/chats/:sessionId", requireAdminAuth, (req, res) => {
  if (!db) return res.status(503).json({ error: "資料庫未就緒" });
  const rows = db
    .prepare("SELECT role, content, created_at FROM chat_logs WHERE session_id = ? ORDER BY id ASC")
    .all(req.params.sessionId);
  if (!rows.length) return res.status(404).json({ error: "找不到這個對話" });
  res.json({ sessionId: req.params.sessionId, messages: rows });
});

// 快速自我檢測：不改任何資料，單純打一個最小的請求給 OpenAI，
// 出問題時可以馬上判斷「是我們自己的伺服器掛了」還是「OpenAI 那邊有問題／金鑰失效」。
app.post("/api/admin/test-connection", requireAdminAuth, async (req, res) => {
  if (!OPENAI_API_KEY) return res.json({ ok: false, message: "尚未設定 OPENAI_API_KEY" });
  const startedAt = Date.now();
  try {
    const upstream = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({ model: OPENAI_MODEL, max_completion_tokens: 5, messages: [{ role: "user", content: "ping" }] }),
    });
    const duration_ms = Date.now() - startedAt;
    if (!upstream.ok) {
      const data = await upstream.json().catch(() => ({}));
      return res.json({ ok: false, message: (data && data.error && data.error.message) || `HTTP ${upstream.status}`, duration_ms });
    }
    return res.json({ ok: true, message: "連線正常", duration_ms });
  } catch (e) {
    return res.json({ ok: false, message: e.message || "連線失敗", duration_ms: Date.now() - startedAt });
  }
});

app.get("/admin", requireAdminAuth, (req, res) => {
  res.set("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>餘溫 · 用量後台</title>
<style>
  body { font-family: -apple-system, "Noto Sans TC", sans-serif; background: #17111C; color: #F2E9E4; margin: 0; padding: 24px; }
  h1 { font-size: 18px; margin-bottom: 4px; }
  h2 { font-size: 15px; margin: 0 0 12px; }
  .muted { color: #9a8b93; font-size: 13px; }
  .cards { display: flex; flex-wrap: wrap; gap: 12px; margin: 20px 0; }
  .card { background: #241A2B; border: 1px solid #382b3f; border-radius: 12px; padding: 14px 18px; min-width: 140px; }
  .card .label { color: #9a8b93; font-size: 12px; margin-bottom: 6px; }
  .card .value { font-size: 22px; font-weight: 600; color: #E8A660; }
  table { border-collapse: collapse; width: 100%; margin-top: 10px; font-size: 13px; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #382b3f; }
  th { color: #9a8b93; font-weight: 500; }
  section { margin-bottom: 32px; }
  .err { color: #C97B84; }
  #status { color: #9a8b93; font-size: 13px; }
  .emergency { background: #241A2B; border: 1px solid #382b3f; border-radius: 12px; padding: 18px 20px; }
  .status-badge { display: inline-block; padding: 4px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; }
  .status-on { background: #4A3A1A; color: #F2DDA8; }
  .status-off { background: #1e3a2a; color: #9adfb8; }
  .row { margin: 12px 0; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  textarea#msgInput { width: 100%; min-height: 60px; background: #17111C; color: #F2E9E4; border: 1px solid #382b3f; border-radius: 8px; padding: 8px; font-family: inherit; font-size: 13px; box-sizing: border-box; }
  .btn { cursor: pointer; border: none; border-radius: 8px; padding: 8px 16px; font-size: 13px; font-weight: 600; }
  .btn-danger { background: #C97B84; color: #17111C; }
  .btn-safe { background: #6fae8a; color: #17111C; }
  .btn-neutral { background: #382b3f; color: #F2E9E4; }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .online-count { font-size: 32px; font-weight: 700; color: #6fae8a; }
  .chart-wrap { overflow-x: auto; }
  svg.chart { display: block; }
  svg.chart rect:hover, svg.chart circle:hover { opacity: 0.8; }
</style>
</head>
<body>
<h1>餘溫 · 用量後台</h1>

<section class="emergency">
  <h2>🚨 緊急控制</h2>
  <div id="modeStatus" class="muted">載入中...</div>
  <div class="row">
    <button id="toggleBtn" class="btn btn-neutral" disabled>載入中...</button>
  </div>
  <div class="row" style="flex-direction:column; align-items:stretch;">
    <label class="muted">維護模式開啟時，使用者會看到的訊息：</label>
    <textarea id="msgInput"></textarea>
    <div><button id="saveMsgBtn" class="btn btn-neutral">儲存訊息</button></div>
  </div>
  <div class="row">
    <button id="testBtn" class="btn btn-neutral">測試 OpenAI 連線</button>
    <span id="testResult" class="muted"></span>
  </div>
  <div class="muted" style="margin-top:6px;">
    「關閉 AI 功能」只會擋掉整理記憶／對話這兩個要花錢呼叫 AI 的功能，網站本身還是能正常打開，
    不會整個網站掛掉；解除的話再按一次按鈕就好，不用重新部署、不用重啟伺服器。
  </div>
</section>

<section style="margin-top:24px;">
  <h2>目前在線人數</h2>
  <div class="card" style="display:inline-block;">
    <div class="label">最近 2 分鐘內有回報的分頁數</div>
    <div class="online-count" id="onlineNow">-</div>
  </div>
  <div class="muted" style="margin-top:8px;">
    沒有帳號系統，這裡算的是「開著網頁的瀏覽分頁數」，不是真正登入的使用者人數；
    同一個人開兩個分頁會算 2。
  </div>
  <div class="chart-wrap" style="margin-top:12px;">
    <div id="onlineChart"></div>
  </div>
</section>

<section>
  <h2>使用時間趨勢（最近 48 小時，依小時統計呼叫次數）</h2>
  <div class="chart-wrap">
    <div id="hourChart"></div>
  </div>
</section>

<div class="muted" id="status" style="margin-top:24px;">載入中...</div>

<section style="margin-top:20px;">
  <h2>📂 用戶上傳紀錄</h2>
  <div class="muted" style="margin-bottom:10px;">
    是否公開由使用者自己在網頁上決定並可隨時修改，後台這裡只能查看目前的狀態，沒辦法直接更改。
  </div>
  <div id="uploadSummary" class="muted" style="margin-bottom:10px;">載入中...</div>
  <div style="margin-bottom:10px; display:flex; gap:8px; flex-wrap:wrap;">
    <button class="btn btn-neutral" onclick="loadUploads('all')" id="filterAll">全部</button>
    <button class="btn btn-neutral" onclick="loadUploads('public')" id="filterPublic">✅ 已公開</button>
    <button class="btn btn-neutral" onclick="loadUploads('private')" id="filterPrivate">🔒 未公開</button>
    <span id="uploadPageInfo" class="muted" style="align-self:center;"></span>
    <button class="btn btn-neutral" id="prevPage" onclick="changePage(-1)" style="display:none;">◀ 上一頁</button>
    <button class="btn btn-neutral" id="nextPage" onclick="changePage(1)" style="display:none;">下一頁 ▶</button>
  </div>
  <div id="uploadDetail" style="display:none; margin-bottom:12px; background:#241A2B; border:1px solid #382b3f; border-radius:10px; padding:14px;">
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
      <strong id="detailTitle" style="font-size:13px;"></strong>
      <button class="btn btn-neutral" onclick="closeDetail()" style="padding:4px 10px; font-size:12px;">關閉</button>
    </div>
    <div id="detailBody" style="font-size:12px; color:#9a8b93; white-space:pre-wrap; max-height:300px; overflow-y:auto;"></div>
  </div>
  <div id="uploadList"></div>
</section>

<section style="margin-top:20px;">
  <h2>💬 對話紀錄</h2>
  <div id="chatSummary" class="muted" style="margin-bottom:10px;">載入中...</div>
  <div style="margin-bottom:10px; display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
    <span id="chatPageInfo" class="muted"></span>
    <button class="btn btn-neutral" id="chatPrevPage" onclick="changeChatPage(-1)" style="display:none;">◀ 上一頁</button>
    <button class="btn btn-neutral" id="chatNextPage" onclick="changeChatPage(1)" style="display:none;">下一頁 ▶</button>
  </div>
  <div id="chatDetail" style="display:none; margin-bottom:12px; background:#241A2B; border:1px solid #382b3f; border-radius:10px; padding:14px;">
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
      <strong id="chatDetailTitle" style="font-size:13px;"></strong>
      <button class="btn btn-neutral" onclick="closeChatDetail()" style="padding:4px 10px; font-size:12px;">關閉</button>
    </div>
    <div id="chatDetailBody" style="font-size:12px; max-height:400px; overflow-y:auto;"></div>
  </div>
  <div id="chatList"></div>
</section>

<div id="app"></div>
<script>
let currentSettings = null;

function formatHourLabel(h) {
  const parts = h.split("T");
  return parts.length > 1 ? parts[1] + ":00" : h;
}

function barChart(containerId, data) {
  const el = document.getElementById(containerId);
  if (!data.length) { el.innerHTML = '<div class="muted">目前還沒有資料</div>'; return; }
  const width = Math.max(320, data.length * 16);
  const height = 140;
  const pad = 24;
  const max = Math.max(1, ...data.map(function (d) { return d.value; }));
  const barW = (width - pad * 2) / data.length;
  const bars = data.map(function (d, i) {
    const h = (d.value / max) * (height - pad * 2);
    const x = pad + i * barW;
    const y = height - pad - h;
    return '<rect x="' + x + '" y="' + y + '" width="' + Math.max(1, barW * 0.7) + '" height="' + Math.max(0, h) + '" fill="#E8A660" rx="2"><title>' + d.label + '：' + d.value + '</title></rect>';
  }).join("");
  const axisY = height - pad;
  el.innerHTML = '<svg class="chart" viewBox="0 0 ' + width + ' ' + height + '" width="' + width + '" height="' + height + '">' +
    '<line x1="' + pad + '" y1="' + axisY + '" x2="' + (width - pad) + '" y2="' + axisY + '" stroke="#382b3f" />' +
    bars + '</svg>';
}

function lineChart(containerId, data) {
  const el = document.getElementById(containerId);
  if (!data.length) { el.innerHTML = '<div class="muted">還沒有快照資料，大概一分鐘後再重新整理看看</div>'; return; }
  const width = Math.max(320, data.length * 6);
  const height = 100;
  const pad = 20;
  const max = Math.max(1, ...data.map(function (d) { return d.value; }));
  const stepX = data.length > 1 ? (width - pad * 2) / (data.length - 1) : 0;
  const points = data.map(function (d, i) {
    const x = pad + i * stepX;
    const y = height - pad - (d.value / max) * (height - pad * 2);
    return x + "," + y;
  });
  const circles = data.map(function (d, i) {
    const parts = points[i].split(",");
    return '<circle cx="' + parts[0] + '" cy="' + parts[1] + '" r="2.5" fill="#6fae8a"><title>' + d.label + '：' + d.value + '</title></circle>';
  }).join("");
  el.innerHTML = '<svg class="chart" viewBox="0 0 ' + width + ' ' + height + '" width="' + width + '" height="' + height + '">' +
    '<polyline points="' + points.join(" ") + '" fill="none" stroke="#6fae8a" stroke-width="2" />' +
    circles + '</svg>';
}

async function loadOnline() {
  const res = await fetch("/api/admin/online");
  if (!res.ok) return;
  const d = await res.json();
  document.getElementById("onlineNow").textContent = d.current;
  const chartData = d.history.map(function (r) {
    return { label: r.created_at.slice(11, 16), value: r.online_count };
  });
  lineChart("onlineChart", chartData);
}

function renderEmergency(d) {
  currentSettings = d;
  const statusEl = document.getElementById("modeStatus");
  const toggleBtn = document.getElementById("toggleBtn");
  statusEl.innerHTML = d.maintenanceMode
    ? '<span class="status-badge status-on">🔴 維護模式開啟中：AI 功能目前對所有人停用</span>'
    : '<span class="status-badge status-off">🟢 正常運作中</span>';
  toggleBtn.textContent = d.maintenanceMode ? "解除維護模式，恢復 AI 功能" : "立即關閉 AI 功能（維護模式）";
  toggleBtn.className = "btn " + (d.maintenanceMode ? "btn-safe" : "btn-danger");
  toggleBtn.disabled = !d.dbAvailable;
  document.getElementById("msgInput").value = d.maintenanceMessage || d.defaultMaintenanceMessage || "";
  if (!d.dbAvailable) {
    statusEl.innerHTML += '<div style="margin-top:6px;">資料庫未就緒，暫時無法儲存維護模式設定。</div>';
  }
}

async function loadSettings() {
  const res = await fetch("/api/admin/settings");
  const d = await res.json();
  renderEmergency(d);
}

async function toggleMaintenance() {
  const next = !currentSettings.maintenanceMode;
  if (next && !confirm("確定要立即關閉 AI 功能嗎？所有人都無法使用整理記憶／對話功能，直到你手動解除為止。")) return;
  const res = await fetch("/api/admin/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ maintenanceMode: next }),
  });
  const d = await res.json();
  renderEmergency({ ...currentSettings, ...d });
}

async function saveMessage() {
  const msg = document.getElementById("msgInput").value;
  const res = await fetch("/api/admin/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ maintenanceMessage: msg }),
  });
  const d = await res.json();
  renderEmergency({ ...currentSettings, ...d });
  alert("已儲存");
}

async function testConnection() {
  const btn = document.getElementById("testBtn");
  const resultEl = document.getElementById("testResult");
  btn.disabled = true;
  resultEl.textContent = "測試中...";
  resultEl.className = "muted";
  try {
    const res = await fetch("/api/admin/test-connection", { method: "POST" });
    const d = await res.json();
    resultEl.textContent = d.ok ? ("連線正常（" + d.duration_ms + "ms）") : ("失敗：" + d.message);
    resultEl.className = d.ok ? "muted" : "err";
  } catch (e) {
    resultEl.textContent = "測試失敗，請確認伺服器本身有沒有在跑";
    resultEl.className = "err";
  } finally {
    btn.disabled = false;
  }
}

async function load() {
  const res = await fetch("/api/admin/stats");
  if (!res.ok) {
    document.getElementById("status").textContent = "讀取失敗：" + res.status;
    return;
  }
  const d = await res.json();
  document.getElementById("status").textContent = "模型：" + d.model + "（估算單價 輸入 $" + d.pricing.inputPer1M + " / 輸出 $" + d.pricing.outputPer1M + " 每百萬 tokens，換模型記得改 .env 裡的價格設定才會準）";

  const cards = [
    ["總呼叫次數", d.totals.calls],
    ["成功", d.totals.ok_calls],
    ["失敗", d.totals.error_calls],
    ["總 tokens", d.totals.total_tokens.toLocaleString()],
    ["估算花費（美金）", "$" + d.totals.estimatedCostUsd],
  ];
  document.getElementById("app").innerHTML =
    '<div class="cards">' + cards.map(c => '<div class="card"><div class="label">'+c[0]+'</div><div class="value">'+c[1]+'</div></div>').join("") + '</div>' +
    section("依用途分類", ["用途","次數","輸入 tokens","輸出 tokens"], d.byKind.map(r => [r.kind, r.calls, r.prompt_tokens, r.completion_tokens])) +
    section("最近 30 天", ["日期","次數","輸入 tokens","輸出 tokens"], d.byDay.map(r => [r.day, r.calls, r.prompt_tokens, r.completion_tokens])) +
    section("依 IP 排行（找異常流量用）", ["IP","次數","總 tokens"], d.byIp.map(r => [r.ip, r.calls, r.total_tokens])) +
    section("最近的錯誤", ["時間","用途","IP","錯誤訊息"], d.recentErrors.map(r => [r.created_at, r.kind, r.ip, '<span class="err">'+(r.error_message||"")+'</span>']));

  const hourData = (d.byHour || []).slice().reverse().map(function (r) {
    return { label: formatHourLabel(r.hour), value: r.calls };
  });
  barChart("hourChart", hourData);
}
function section(title, headers, rows) {
  return '<section><h3>'+title+'</h3><table><thead><tr>' +
    headers.map(h => '<th>'+h+'</th>').join("") +
    '</tr></thead><tbody>' +
    (rows.length ? rows.map(r => '<tr>' + r.map(c => '<td>'+c+'</td>').join("") + '</tr>').join("") : '<tr><td colspan="'+headers.length+'" class="muted">目前沒有資料</td></tr>') +
    '</tbody></table></section>';
}

// ---- 用戶上傳紀錄 ----
let uploadCurrentFilter = "all";
let uploadCurrentPage = 1;
let uploadTotalPages = 1;

// ---- 對話紀錄 ----
let chatCurrentPage = 1;
let chatTotalPages = 1;

document.getElementById("toggleBtn").addEventListener("click", toggleMaintenance);
document.getElementById("saveMsgBtn").addEventListener("click", saveMessage);
document.getElementById("testBtn").addEventListener("click", testConnection);
loadSettings();
load();
loadOnline();
loadUploads("all");
loadChats();
setInterval(loadOnline, 30000);
setInterval(load, 60000);

async function loadUploads(filter) {
  if (filter) { uploadCurrentFilter = filter; uploadCurrentPage = 1; }
  ["filterAll","filterPublic","filterPrivate"].forEach(id => document.getElementById(id).style.opacity = "0.5");
  const activeId = uploadCurrentFilter === "public" ? "filterPublic" : uploadCurrentFilter === "private" ? "filterPrivate" : "filterAll";
  document.getElementById(activeId).style.opacity = "1";

  const res = await fetch("/api/admin/uploads?filter=" + uploadCurrentFilter + "&page=" + uploadCurrentPage);
  if (!res.ok) { document.getElementById("uploadList").innerHTML = '<div class="muted">讀取失敗</div>'; return; }
  const d = await res.json();
  uploadTotalPages = Math.max(1, Math.ceil(d.total / d.perPage));

  document.getElementById("uploadSummary").textContent = "共 " + d.total + " 筆上傳紀錄（已公開：透過此頁按鈕切換）";
  document.getElementById("uploadPageInfo").textContent = d.total > d.perPage ? "第 " + d.page + " / " + uploadTotalPages + " 頁" : "";
  document.getElementById("prevPage").style.display = uploadCurrentPage > 1 ? "inline-block" : "none";
  document.getElementById("nextPage").style.display = uploadCurrentPage < uploadTotalPages ? "inline-block" : "none";

  if (!d.rows.length) {
    document.getElementById("uploadList").innerHTML = '<div class="muted" style="padding:12px;">目前還沒有上傳紀錄，使用者整理記憶後才會出現。</div>';
    return;
  }
  document.getElementById("uploadList").innerHTML =
    '<table><thead><tr>' +
    '<th>時間</th><th>角色</th><th>來源</th><th>記憶則數</th><th>原文大小</th><th>IP</th><th>公開狀態</th><th>查看內容</th>' +
    '</tr></thead><tbody>' +
    d.rows.map(r => '<tr>' +
      '<td>' + r.created_at.slice(0,16).replace("T"," ") + '</td>' +
      '<td>' + (r.persona_name||"-") + (r.persona_relationship ? "（"+r.persona_relationship+"）" : "") + '</td>' +
      '<td style="max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + (r.source_name||"-") + '</td>' +
      '<td>' + (r.memory_count||0) + ' 則</td>' +
      '<td>' + (r.raw_len ? (Math.round(r.raw_len/100)/10)+"k 字" : "-") + '</td>' +
      '<td style="font-size:11px;color:#9a8b93;">' + (r.ip||"-") + '</td>' +
      '<td><span class="status-badge ' + (r.is_public ? "status-off" : "status-on") + '">' + (r.is_public ? "✅ 公開中" : "🔒 未公開") + '</span></td>' +
      '<td><button class="btn btn-neutral" style="padding:4px 10px; font-size:12px;" onclick="viewUpload(' + r.id + ')">查看</button></td>' +
    '</tr>').join("") +
    '</tbody></table>';
}

function changePage(delta) {
  uploadCurrentPage = Math.max(1, Math.min(uploadTotalPages, uploadCurrentPage + delta));
  loadUploads();
}

async function viewUpload(id) {
  const res = await fetch("/api/admin/uploads/" + id);
  if (!res.ok) return;
  const d = await res.json();
  document.getElementById("detailTitle").textContent =
    "[" + d.created_at.slice(0,16).replace("T"," ") + "] " + (d.persona_name||"") + "（" + (d.source_name||"未知來源") + "）";
  let body = "";
  if (d.style_summary) body += "【語氣摘要】\\n" + d.style_summary + "\\n\\n";
  try {
    const mems = JSON.parse(d.memories_json || "[]");
    if (mems.length) body += "【記憶庫項目】\\n" + mems.map((m,i) => (i+1)+". ["+m.category+"] "+m.content).join("\\n") + "\\n\\n";
  } catch(e) {}
  if (d.raw_content) body += "【原始上傳內容】\\n" + d.raw_content.slice(0, 3000) + (d.raw_content.length > 3000 ? "\\n…（內容過長，只顯示前 3000 字）" : "");
  document.getElementById("detailBody").textContent = body || "（無內容）";
  document.getElementById("uploadDetail").style.display = "block";
  document.getElementById("uploadDetail").scrollIntoView({ behavior: "smooth", block: "start" });
}

function closeDetail() {
  document.getElementById("uploadDetail").style.display = "none";
}

async function loadChats() {
  const res = await fetch("/api/admin/chats?page=" + chatCurrentPage);
  if (!res.ok) { document.getElementById("chatList").innerHTML = '<div class="muted">讀取失敗</div>'; return; }
  const d = await res.json();
  chatTotalPages = Math.max(1, Math.ceil(d.total / d.perPage));

  document.getElementById("chatSummary").textContent = "共 " + d.total + " 個對話分頁";
  document.getElementById("chatPageInfo").textContent = d.total > d.perPage ? "第 " + d.page + " / " + chatTotalPages + " 頁" : "";
  document.getElementById("chatPrevPage").style.display = chatCurrentPage > 1 ? "inline-block" : "none";
  document.getElementById("chatNextPage").style.display = chatCurrentPage < chatTotalPages ? "inline-block" : "none";

  if (!d.rows.length) {
    document.getElementById("chatList").innerHTML = '<div class="muted" style="padding:12px;">目前還沒有對話紀錄。</div>';
    return;
  }
  document.getElementById("chatList").innerHTML =
    '<table><thead><tr>' +
    '<th>角色</th><th>開始時間</th><th>最後訊息</th><th>訊息數</th><th>IP</th><th>查看</th>' +
    '</tr></thead><tbody>' +
    d.rows.map(r => '<tr>' +
      '<td>' + (r.persona_name||"-") + (r.persona_relationship ? "（"+r.persona_relationship+"）" : "") + '</td>' +
      '<td>' + r.started_at.slice(0,16).replace("T"," ") + '</td>' +
      '<td>' + r.last_at.slice(0,16).replace("T"," ") + '</td>' +
      '<td>' + r.message_count + ' 則</td>' +
      '<td style="font-size:11px;color:#9a8b93;">' + (r.ip||"-") + '</td>' +
      '<td><button class="btn btn-neutral" style="padding:4px 10px; font-size:12px;" onclick=\\'viewChat(&quot;' + escapeHtml(r.session_id) + '&quot;)\\'>查看</button></td>' +
    '</tr>').join("") +
    '</tbody></table>';
}

function changeChatPage(delta) {
  chatCurrentPage = Math.max(1, Math.min(chatTotalPages, chatCurrentPage + delta));
  loadChats();
}

async function viewChat(sessionId) {
  const res = await fetch("/api/admin/chats/" + encodeURIComponent(sessionId));
  if (!res.ok) return;
  const d = await res.json();
  document.getElementById("chatDetailTitle").textContent = "對話紀錄（" + d.messages.length + " 則訊息）";
  document.getElementById("chatDetailBody").innerHTML = d.messages.map(function (m) {
    const isUser = m.role === "user";
    const label = isUser ? "使用者" : "AI";
    const time = m.created_at.slice(11,16);
    return '<div style="margin-bottom:8px; text-align:' + (isUser ? "right" : "left") + ';">' +
      '<div style="font-size:10px; color:#9a8b93; margin-bottom:2px;">' + label + ' · ' + time + '</div>' +
      '<div style="display:inline-block; max-width:80%; padding:6px 10px; border-radius:8px; background:' + (isUser ? "#382b3f" : "#4A3A1A") + '; color:#F2E9E4; font-size:12px; white-space:pre-wrap; text-align:left;">' +
      escapeHtml(m.content) + '</div></div>';
  }).join("");
  document.getElementById("chatDetail").style.display = "block";
  document.getElementById("chatDetail").scrollIntoView({ behavior: "smooth", block: "start" });
}

function closeChatDetail() {
  document.getElementById("chatDetail").style.display = "none";
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}
</script>
</body>
</html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`餘溫 demo 伺服器已啟動：http://localhost:${PORT}`);
  if (!OPENAI_API_KEY) {
    console.warn("⚠️  尚未偵測到 OPENAI_API_KEY，AI 功能目前無法使用。請設定 .env 後重啟。");
  }
  if (!ADMIN_PASSWORD) {
    console.warn("ℹ️  尚未設定 ADMIN_PASSWORD，/admin 後台目前是關閉的（回 404），這是安全預設值。");
  }
});
