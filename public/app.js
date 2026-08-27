const { useState, useEffect, useRef } = React;

const COLORS = {
  bg: "#17111C",
  panel: "#241A2B",
  panelAlt: "#2E2233",
  ember: "#E8A660",
  emberSoft: "#F0C48A",
  rose: "#C97B84",
  text: "#F2E9E4",
  muted: "#A8969B",
  border: "rgba(242,233,228,0.09)",
};

const FONT_IMPORT = `@import url('https://fonts.googleapis.com/css2?family=Noto+Serif+TC:wght@500;600;700&family=Noto+Sans+TC:wght@300;400;500;700&display=swap');`;

const CATEGORY_ORDER = ["口頭禪與說話方式", "日常習慣", "情感表達", "價值觀與叮嚀", "共同回憶", "其他"];

// ---- 資料庫讀寫：支援 JSON / CSV / XLSX / TXT 四種檔案格式 ----

function detectFormat(filename) {
  const f = (filename || "").toLowerCase();
  if (f.endsWith(".csv")) return "csv";
  if (f.endsWith(".xlsx")) return "xlsx";
  if (f.endsWith(".txt")) return "txt";
  return "json";
}

function ensureXLSX() {
  if (!window.XLSX) throw new Error("Excel 函式庫還在載入，請稍等幾秒再試一次。");
}

// CSV 逐字元解析（支援雙引號內的逗號/換行/跳脫的雙引號）
function parseCSVRows(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\n") {
      row.push(field); field = "";
      rows.push(row); row = [];
    } else if (c === "\r") {
      // 忽略，交給後面的 \n 處理
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && String(r[0]).trim() === ""));
}
function csvEscape(field) {
  const s = String(field == null ? "" : field);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function csvRow(fields) {
  return fields.map(csvEscape).join(",");
}

// 共用的「表格列」表示法：CSV 跟 XLSX 都可以互轉成 [[col1,col2], ...] 這種陣列，
// 這樣兩種格式可以共用同一套 persona/memories 轉換邏輯。
function databaseToRows(persona, styleSummary, memories) {
  return [
    ["#persona_name", (persona && persona.name) || ""],
    ["#persona_relationship", (persona && persona.relationship) || ""],
    ["#style_summary", styleSummary || ""],
    ["category", "content"],
    ...memories.map((m) => [m.category, m.content]),
  ];
}
function rowsToDatabase(rows) {
  let persona = null;
  let styleSummary = "";
  let i = 0;
  while (i < rows.length && rows[i][0] && String(rows[i][0]).startsWith("#")) {
    const key = rows[i][0];
    const val = rows[i][1] || "";
    if (key === "#persona_name") persona = { ...(persona || {}), name: val };
    else if (key === "#persona_relationship") persona = { ...(persona || {}), relationship: val };
    else if (key === "#style_summary") styleSummary = val;
    i++;
  }
  if (rows[i] && String(rows[i][0] || "").trim().toLowerCase() === "category") i++;
  const memories = [];
  for (; i < rows.length; i++) {
    const row = rows[i] || [];
    if (row.every((c) => c == null || !String(c).trim())) continue;
    const category = row.length >= 2 ? row[0] : "";
    const content = row.length >= 2 ? row[1] : row[0];
    if (!content || !String(content).trim()) continue;
    memories.push({
      id: `${Date.now()}-${memories.length}`,
      category: CATEGORY_ORDER.includes(category) ? category : "其他",
      content: String(content).trim(),
    });
  }
  return { persona, styleSummary, memories };
}

// 可讀的純文字格式：分類當標題（## 分類），內容當條列（- 內容），方便直接用記事本編輯。
function serializeTxt(persona, styleSummary, memories) {
  const lines = [];
  lines.push("# 餘溫記憶庫");
  lines.push(`角色：${(persona && persona.name) || ""}（${(persona && persona.relationship) || ""}）`);
  lines.push(`語氣摘要：${styleSummary || ""}`);
  lines.push("");
  CATEGORY_ORDER.forEach((cat) => {
    const items = memories.filter((m) => m.category === cat);
    if (!items.length) return;
    lines.push(`## ${cat}`);
    items.forEach((m) => lines.push(`- ${String(m.content).replace(/\r\n|\n/g, "\\n")}`));
    lines.push("");
  });
  return lines.join("\n");
}
function parseTxt(text) {
  const lines = text.split(/\r\n|\n/);
  let persona = null;
  let styleSummary = "";
  const memories = [];
  let currentCategory = "其他";
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("角色：") || line.startsWith("角色:")) {
      const rest = line.replace(/^角色[:：]/, "").trim();
      const m = rest.match(/^(.*)\uFF08(.*)\uFF09$/); // 全形括號 （）
      persona = m ? { name: m[1].trim(), relationship: m[2].trim() } : { name: rest, relationship: "" };
      continue;
    }
    if (line.startsWith("語氣摘要：") || line.startsWith("語氣摘要:")) {
      styleSummary = line.replace(/^語氣摘要[:：]/, "").trim();
      continue;
    }
    if (line.startsWith("##")) {
      const header = line.replace(/^#+/, "").trim();
      currentCategory = CATEGORY_ORDER.includes(header) ? header : "其他";
      continue;
    }
    if (line.startsWith("#")) continue;
    if (line.startsWith("-") || line.startsWith("•")) {
      const content = line.replace(/^[-•]\s*/, "").replace(/\\n/g, "\n").trim();
      if (content) memories.push({ id: `${Date.now()}-${memories.length}`, category: currentCategory, content });
    }
  }
  return { persona, styleSummary, memories };
}

// 產生要寫入檔案／下載的內容。JSON/CSV/TXT 回傳字串，XLSX 回傳 Blob（二進位檔案）。
async function serializeDatabaseAsync(format, persona, styleSummary, memories) {
  if (format === "csv") {
    const rows = databaseToRows(persona, styleSummary, memories);
    return "\uFEFF" + rows.map(csvRow).join("\r\n"); // 加 BOM，避免 Excel 開中文亂碼
  }
  if (format === "txt") {
    return serializeTxt(persona, styleSummary, memories);
  }
  if (format === "xlsx") {
    ensureXLSX();
    const rows = databaseToRows(persona, styleSummary, memories);
    const ws = window.XLSX.utils.aoa_to_sheet(rows);
    const wb = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(wb, ws, "記憶庫");
    const arr = window.XLSX.write(wb, { type: "array", bookType: "xlsx" });
    return new Blob([arr], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  }
  return JSON.stringify({ version: 1, persona, styleSummary, memories, updatedAt: new Date().toISOString() }, null, 2);
}

// 讀取一個 File（不管是本機連接的還是手動選的）解析回 { persona, styleSummary, memories }。
async function parseDatabaseFileAsync(format, file) {
  if (format === "xlsx") {
    ensureXLSX();
    const buf = await file.arrayBuffer();
    const wb = window.XLSX.read(buf, { type: "array" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = window.XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, raw: false, defval: "" });
    return rowsToDatabase(rows);
  }
  const text = await file.text();
  if (format === "csv") return rowsToDatabase(parseCSVRows(text.replace(/^\uFEFF/, "")));
  if (format === "txt") return parseTxt(text);
  const parsed = JSON.parse(text);
  if (!parsed || !Array.isArray(parsed.memories)) throw new Error("format");
  return { persona: parsed.persona || null, styleSummary: parsed.styleSummary || "", memories: parsed.memories };
}

function formatErrorMessage(format) {
  if (format === "csv") return "這個 CSV 檔案格式讀不懂。第一欄請放分類、第二欄放內容，或選一個空白新檔案來建立記憶庫。";
  if (format === "xlsx") return "這個 Excel 檔案讀不懂，請確認第一個工作表第一欄是分類、第二欄是內容，或選一個空白新檔案來建立記憶庫。";
  if (format === "txt") return "這個文字檔格式讀不懂，請確認用「## 分類名稱」跟「- 內容」的格式，或選一個空白新檔案來建立記憶庫。";
  return "這個檔案內容不是合法的 JSON。請選一個空白的新檔案來建立記憶庫，或選一個之前匯出過的檔案。";
}

// ---- 匯入來源檔案：讀取各種檔案類型轉成純文字，餵給分類用 ----
// 需要額外函式庫的格式（docx / pdf）用 <script> 動態載入，第一次用到才載入，不拖慢首次開啟速度。
const _scriptLoadPromises = {};
function loadScriptOnce(src) {
  if (_scriptLoadPromises[src]) return _scriptLoadPromises[src];
  _scriptLoadPromises[src] = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("函式庫載入失敗，請確認網路連線後再試一次。"));
    document.head.appendChild(s);
  });
  return _scriptLoadPromises[src];
}
async function ensureMammoth() {
  if (window.mammoth) return window.mammoth;
  await loadScriptOnce("https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js");
  if (!window.mammoth) throw new Error("Word 檔函式庫載入失敗，請確認網路連線後再試一次。");
  return window.mammoth;
}
let _pdfjsPromise = null;
async function ensurePDFJS() {
  if (window.pdfjsLib) return window.pdfjsLib;
  if (!_pdfjsPromise) {
    _pdfjsPromise = import("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.min.mjs")
      .then((lib) => {
        lib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.worker.min.mjs";
        window.pdfjsLib = lib;
        return lib;
      })
      .catch((e) => {
        _pdfjsPromise = null;
        throw new Error("PDF 函式庫載入失敗，請確認網路連線後再試一次。");
      });
  }
  return _pdfjsPromise;
}

async function extractTextFromFile(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith(".docx")) {
    const lib = await ensureMammoth();
    const arrayBuffer = await file.arrayBuffer();
    const result = await lib.extractRawText({ arrayBuffer });
    return result.value || "";
  }
  if (name.endsWith(".pdf")) {
    const lib = await ensurePDFJS();
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await lib.getDocument({ data: arrayBuffer }).promise;
    let fullText = "";
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      fullText += content.items.map((item) => item.str).join(" ") + "\n";
    }
    return fullText;
  }
  if (name.endsWith(".html") || name.endsWith(".htm")) {
    const raw = await file.text();
    const doc = new DOMParser().parseFromString(raw, "text/html");
    return (doc.body && (doc.body.innerText || doc.body.textContent)) || raw;
  }
  // .txt / .csv / .json 及其他：直接當純文字讀
  return await file.text();
}

// ---- 本機儲存（取代 Claude artifact 專用的 window.storage）----
// 資料只留在使用者自己瀏覽器的 localStorage，不會送到伺服器。
const storage = {
  async get(key) {
    const v = localStorage.getItem(key);
    return v === null ? null : { key, value: v };
  },
  async set(key, value) {
    localStorage.setItem(key, value);
    return { key, value };
  },
  async delete(key) {
    localStorage.removeItem(key);
    return { key, deleted: true };
  },
};

// ---- IndexedDB 存放「整理記憶」的來源檔案清單 ----
// localStorage 只能存字串，但這個清單裡（Chrome/Edge 版）帶著真正的 FileSystemFileHandle 物件，
// IndexedDB 可以直接存這種物件，重新整理頁面後才有辦法把檔案清單（含控制代碼）復原回來。
const IDB_NAME = "afterglow-idb";
const IDB_STORE = "kv";
function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) req.result.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbSet(key, value) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---- 簡易線條圖示（純 SVG，不依賴外部圖示套件）----
function IconSend({ size = 14, color = "currentColor" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="4" y1="12" x2="20" y2="12" />
      <polyline points="14 6 20 12 14 18" />
    </svg>
  );
}
function IconUpload({ size = 14, color = "currentColor" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="7 10 12 5 17 10" />
      <line x1="12" y1="5" x2="12" y2="15" />
      <path d="M5 19h14" />
    </svg>
  );
}
function IconReset({ size = 12, color = "currentColor" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <polyline points="3 3 3 8 8 8" />
    </svg>
  );
}
function IconBook({ size = 14, color = "currentColor" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 5c3-1.5 6-1.5 9 0v14c-3-1.5-6-1.5-9 0Z" />
      <path d="M22 5c-3-1.5-6-1.5-9 0v14c3-1.5 6-1.5 9 0Z" />
    </svg>
  );
}
function IconChat({ size = 14, color = "currentColor" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 4h16v12H8l-4 4Z" />
    </svg>
  );
}
function IconTrash({ size = 13, color = "currentColor" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 7h16" />
      <path d="M6 7v13a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7" />
      <path d="M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
    </svg>
  );
}
function IconX({ size = 11, color = "currentColor" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="5" y1="5" x2="19" y2="19" />
      <line x1="19" y1="5" x2="5" y2="19" />
    </svg>
  );
}
function IconFile({ size = 13, color = "currentColor" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 3h9l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
      <path d="M15 3v5h5" />
    </svg>
  );
}
function IconUnlink({ size = 12, color = "currentColor" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 7H6a4 4 0 0 0 0 8h3" />
      <path d="M15 7h3a4 4 0 0 1 0 8h-3" />
      <line x1="4" y1="4" x2="20" y2="20" />
    </svg>
  );
}
function Spinner({ size = 14, color = "currentColor" }) {
  return (
    <span
      className="animate-spin"
      style={{
        width: size,
        height: size,
        borderRadius: 9999,
        border: "2px solid rgba(255,255,255,0.25)",
        borderTopColor: color,
        display: "inline-block",
      }}
    />
  );
}

// ---- 呼叫我們自己的後端（金鑰只存在伺服器上）----
async function callClaude({ system, messages, max_tokens, json, temperature, presence_penalty }) {
  const response = await fetch("/api/claude", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system,
      messages,
      max_tokens: max_tokens || 1000,
      json: Boolean(json),
      ...(typeof temperature === "number" ? { temperature } : {}),
      ...(typeof presence_penalty === "number" ? { presence_penalty } : {}),
    }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "呼叫失敗");
  }
  return data;
}

function Afterglow() {
  const [ready, setReady] = useState(false);
  const [keyConfigured, setKeyConfigured] = useState(true);
  const [dataConsentGiven, setDataConsentGiven] = useState(false);
  const [showConsentModal, setShowConsentModal] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [publicConsent, setPublicConsent] = useState(false);
  const [consentSaving, setConsentSaving] = useState(false);
  const [maintenanceMode, setMaintenanceMode] = useState(false);
  const [maintenanceMessage, setMaintenanceMessage] = useState("");
  const [persona, setPersona] = useState(null);
  const [styleSummary, setStyleSummary] = useState("");
  const [memories, setMemories] = useState([]);
  const [messages, setMessages] = useState([]);
  const [tab, setTab] = useState("import");
  const [importText, setImportText] = useState("");
  const [classifying, setClassifying] = useState(false);
  const [classifyProgress, setClassifyProgress] = useState(null);
  const [importError, setImportError] = useState("");
  const [chatInput, setChatInput] = useState("");
  const [sending, setSending] = useState(false);
  const [setupName, setSetupName] = useState("");
  const [setupRelation, setSetupRelation] = useState("");
  const [sourceFiles, setSourceFiles] = useState([]);
  const [filesBusy, setFilesBusy] = useState(false);
  const [dbFileHandle, setDbFileHandle] = useState(null);
  const [dbFileName, setDbFileName] = useState("");
  const [dbFileFormat, setDbFileFormat] = useState("json");
  const [exportFormat, setExportFormat] = useState("json");
  const [dbError, setDbError] = useState("");
  const [dbBusy, setDbBusy] = useState(false);
  const scrollRef = useRef(null);
  const fileInputRef = useRef(null);
  const dbImportInputRef = useRef(null);
  const dbSyncSkip = useRef(true);
  const supportsFilePicker = typeof window !== "undefined" && typeof window.showOpenFilePicker === "function";

  useEffect(() => {
    (async () => {
      try {
        const h = await fetch("/api/health").then((r) => r.json());
        setKeyConfigured(Boolean(h.keyConfigured));
        setMaintenanceMode(Boolean(h.maintenanceMode));
        setMaintenanceMessage(h.maintenanceMessage || "");
      } catch (e) {
        setKeyConfigured(false);
      }
      try {
        const p = await storage.get("afterglow-profile");
        if (p && p.value) {
          const parsed = JSON.parse(p.value);
          setPersona(parsed.persona || null);
          setStyleSummary(parsed.styleSummary || "");
        }
      } catch (e) {}
      try {
        const consent = await storage.get("afterglow-data-consent");
        if (consent && consent.value === "1") setDataConsentGiven(true);
        const pub = await storage.get("afterglow-public-consent");
        if (pub && pub.value === "1") setPublicConsent(true);
      } catch (e) {}
      try {
        const m = await storage.get("afterglow-memories");
        if (m && m.value) setMemories(JSON.parse(m.value));
      } catch (e) {}
      try {
        const c = await storage.get("afterglow-chat");
        if (c && c.value) setMessages(JSON.parse(c.value));
      } catch (e) {}
      try {
        const saved = await idbGet("afterglow-source-files");
        if (Array.isArray(saved) && saved.length) {
          // 重開頁面時，applying 一定不會是「進行中」的狀態；handle 型的檔案要先靜默檢查一次
          // 目前還有沒有讀取權限（queryPermission 不需要使用者手動點擊），沒有的話標記需要重新授權。
          const restored = await Promise.all(
            saved.map(async (f) => {
              let needsPermission = false;
              if (f.handle) {
                try {
                  const perm = await f.handle.queryPermission({ mode: "read" });
                  needsPermission = perm !== "granted";
                } catch (e) {
                  needsPermission = true;
                }
              }
              return { ...f, applying: false, needsPermission };
            })
          );
          setSourceFiles(restored);
        }
      } catch (e) {}
      setReady(true);
    })();
  }, []);

  // 每 30 秒回報一次「這個分頁還開著」，讓 /admin 後台可以統計「在線人數」。
  // 只送一個隨機產生的 sessionId，不會送任何對話內容或個人資料。
  const heartbeatSessionId = useRef(null);
  useEffect(() => {
    if (!heartbeatSessionId.current) {
      heartbeatSessionId.current =
        window.crypto && window.crypto.randomUUID ? window.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
    function sendHeartbeat() {
      fetch("/api/heartbeat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: heartbeatSessionId.current }),
      }).catch(() => {});
    }
    sendHeartbeat();
    const interval = setInterval(sendHeartbeat, 30000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, sending]);

  // 整理記憶的來源檔案清單一有變動（新增、勾選、刪除、標記已整理過...）就存回 IndexedDB，
  // 這樣重新整理頁面後，清單（連同還沒過期的檔案控制代碼）不會憑空消失。
  const sourceFilesSyncSkip = useRef(true);
  useEffect(() => {
    if (sourceFilesSyncSkip.current) {
      sourceFilesSyncSkip.current = false;
      return;
    }
    idbSet("afterglow-source-files", sourceFiles).catch(() => {});
  }, [sourceFiles]);

  // 有連接本機檔案的話，記憶庫（角色、語氣、記憶項目）一有變動就自動寫回那個檔案，
  // 這樣使用者也可以直接用文字編輯器或 Excel 打開檔案手動改內容。
  useEffect(() => {
    if (!dbFileHandle) return;
    if (dbSyncSkip.current) {
      dbSyncSkip.current = false;
      return;
    }
    (async () => {
      try {
        const payload = await serializeDatabaseAsync(dbFileFormat, persona, styleSummary, memories);
        await writeToFileHandle(dbFileHandle, payload);
      } catch (e) {
        setDbError(e.message || "寫入本機檔案失敗。");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persona, styleSummary, memories, dbFileHandle, dbFileFormat]);

  async function saveProfile(nextPersona, nextStyle) {
    try {
      await storage.set("afterglow-profile", JSON.stringify({ persona: nextPersona, styleSummary: nextStyle }));
    } catch (e) {}
  }
  async function saveMemories(next) {
    try { await storage.set("afterglow-memories", JSON.stringify(next)); } catch (e) {}
  }
  async function saveMessages(next) {
    try { await storage.set("afterglow-chat", JSON.stringify(next)); } catch (e) {}
  }

  async function writeToFileHandle(handle, payload) {
    try {
      const writable = await handle.createWritable();
      await writable.write(payload);
      await writable.close();
    } catch (e) {
      setDbError("寫入本機檔案失敗，可能是權限被瀏覽器收回了，請重新連接一次。");
    }
  }

  async function connectLocalFile() {
    setDbError("");
    if (!supportsFilePicker) {
      setDbError("這個瀏覽器不支援直接連接本機檔案（目前只有 Chrome / Edge 支援），請改用下面的「匯出／匯入」按鈕。");
      return;
    }
    setDbBusy(true);
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [
          { description: "餘溫記憶庫 (JSON)", accept: { "application/json": [".json"] } },
          { description: "餘溫記憶庫 (CSV，可用 Excel 開)", accept: { "text/csv": [".csv"] } },
          { description: "餘溫記憶庫 (Excel .xlsx)", accept: { "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"] } },
          { description: "餘溫記憶庫 (純文字 .txt)", accept: { "text/plain": [".txt"] } },
        ],
        excludeAcceptAllOption: false,
        multiple: false,
      });
      const perm = await handle.requestPermission({ mode: "readwrite" });
      if (perm !== "granted") {
        setDbError("沒有取得這個檔案的讀寫權限，無法連接。");
        setDbBusy(false);
        return;
      }
      const format = detectFormat(handle.name);
      const file = await handle.getFile();

      let loaded = null;
      if (file.size > 0) {
        try {
          loaded = await parseDatabaseFileAsync(format, file);
        } catch (e) {
          setDbError(e.message && e.message.includes("函式庫") ? e.message : formatErrorMessage(format));
          setDbBusy(false);
          return;
        }
      }

      if (loaded && (loaded.memories.length > 0 || loaded.persona)) {
        const hasExisting = memories.length > 0 || (persona && persona.name);
        const proceed = !hasExisting || window.confirm("這個檔案裡已經有記憶庫內容，連接後會用檔案裡的內容取代目前畫面上的資料，確定要繼續嗎？");
        if (!proceed) {
          setDbBusy(false);
          return;
        }
        dbSyncSkip.current = true;
        setPersona(loaded.persona || persona);
        setStyleSummary(loaded.styleSummary || "");
        setMemories(loaded.memories || []);
        if (loaded.persona) saveProfile(loaded.persona, loaded.styleSummary || "");
        saveMemories(loaded.memories || []);
      } else {
        // 空白或全新的檔案：直接把目前的資料寫進去
        dbSyncSkip.current = true;
        const payload = await serializeDatabaseAsync(format, persona, styleSummary, memories);
        await writeToFileHandle(handle, payload);
      }
      setDbFileHandle(handle);
      setDbFileName(handle.name);
      setDbFileFormat(format);
    } catch (e) {
      if (e && e.name !== "AbortError") {
        setDbError(e.message && e.message.includes("函式庫") ? e.message : "連接檔案失敗，請再試一次。");
      }
    } finally {
      setDbBusy(false);
    }
  }

  function disconnectLocalFile() {
    setDbFileHandle(null);
    setDbFileName("");
    setDbError("");
  }

  function downloadPayload(payload, filename, mime) {
    const blob = payload instanceof Blob ? payload : new Blob([payload], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  const EXPORT_MIME = {
    json: "application/json",
    csv: "text/csv;charset=utf-8;",
    txt: "text/plain;charset=utf-8;",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };

  async function exportDatabaseFile(format) {
    setDbError("");
    const name = (persona && persona.name) || "記憶庫";
    try {
      const payload = await serializeDatabaseAsync(format, persona, styleSummary, memories);
      downloadPayload(payload, `餘溫-${name}.${format}`, EXPORT_MIME[format]);
    } catch (e) {
      setDbError(e.message || "匯出失敗，請再試一次。");
    }
  }

  async function importDatabaseFile(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    setDbError("");
    const format = detectFormat(file.name);
    try {
      if (file.size === 0) {
        setDbError("這個檔案是空的，沒有東西可以匯入。");
        return;
      }
      const loaded = await parseDatabaseFileAsync(format, file);
      const hasExisting = memories.length > 0 || (persona && persona.name);
      const proceed = !hasExisting || window.confirm("匯入後會用檔案裡的內容取代目前畫面上的資料，確定要繼續嗎？");
      if (!proceed) return;
      setPersona(loaded.persona || persona);
      setStyleSummary(loaded.styleSummary || "");
      setMemories(loaded.memories || []);
      if (loaded.persona) saveProfile(loaded.persona, loaded.styleSummary || "");
      saveMemories(loaded.memories || []);
    } catch (err) {
      setDbError(err.message && err.message.includes("函式庫") ? err.message : formatErrorMessage(format));
    } finally {
      if (dbImportInputRef.current) dbImportInputRef.current.value = "";
    }
  }

  function startPersona() {
    if (!setupName.trim()) return;
    const p = { name: setupName.trim(), relationship: setupRelation.trim() || "重要的人" };
    setPersona(p);
    saveProfile(p, "");
  }

  async function handleTogglePublicConsent() {
    const next = !publicConsent;
    setConsentSaving(true);
    try {
      await storage.set("afterglow-public-consent", next ? "1" : "0");
      setPublicConsent(next);
      await fetch("/api/update-consent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: heartbeatSessionId.current || "", isPublic: next }),
      }).catch(() => {});
    } finally {
      setConsentSaving(false);
    }
  }

  async function handleReset() {
    setDbFileHandle(null);
    setDbFileName("");
    setDbError("");
    setPersona(null);
    setMemories([]);
    setMessages([]);
    setStyleSummary("");
    setImportText("");
    setSourceFiles([]);
    setTab("import");
    try {
      await storage.delete("afterglow-profile");
      await storage.delete("afterglow-memories");
      await storage.delete("afterglow-chat");
    } catch (e) {}
  }

  async function addSourceFiles(e) {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    setFilesBusy(true);
    const results = await Promise.all(
      files.map(async (file) => {
        try {
          const content = await extractTextFromFile(file);
          return {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name: file.name,
            handle: null,
            content: content.trim(),
            lastModified: file.lastModified,
            checked: true,
            used: false,
            hasUpdate: false,
            applying: false,
            needsPermission: false,
            error: "",
          };
        } catch (err) {
          return {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name: file.name,
            handle: null,
            content: "",
            lastModified: null,
            checked: false,
            used: false,
            hasUpdate: false,
            applying: false,
            needsPermission: false,
            error: err.message || "讀取失敗",
          };
        }
      })
    );
    setSourceFiles((prev) => [...prev, ...results]);
    setFilesBusy(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  // Chrome / Edge：用 File System Access API 選檔，拿到的是檔案「控制代碼」而不只是當下的內容快照，
  // 之後這個檔案在本機被修改過，會被背景偵測到並詢問要不要更新記憶庫。
  async function addSourceFilesViaPicker() {
    setFilesBusy(true);
    try {
      const handles = await window.showOpenFilePicker({
        multiple: true,
        excludeAcceptAllOption: false,
        types: [
          {
            description: "聊天紀錄來源檔案",
            accept: {
              "text/plain": [".txt"],
              "text/csv": [".csv"],
              "application/json": [".json"],
              "text/html": [".html", ".htm"],
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
              "application/pdf": [".pdf"],
            },
          },
        ],
      });
      const results = await Promise.all(
        handles.map(async (handle) => {
          try {
            const file = await handle.getFile();
            const content = (await extractTextFromFile(file)).trim();
            return {
              id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              name: handle.name,
              handle,
              content,
              lastModified: file.lastModified,
              checked: true,
              used: false,
              hasUpdate: false,
              applying: false,
              needsPermission: false,
              error: "",
            };
          } catch (err) {
            return {
              id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              name: handle.name,
              handle,
              content: "",
              lastModified: null,
              checked: false,
              used: false,
              hasUpdate: false,
              applying: false,
              needsPermission: false,
              error: err.message || "讀取失敗",
            };
          }
        })
      );
      setSourceFiles((prev) => [...prev, ...results]);
    } catch (e) {
      if (e && e.name !== "AbortError") setImportError("選取檔案失敗，請再試一次。");
    } finally {
      setFilesBusy(false);
    }
  }

  function toggleSourceFile(id) {
    setSourceFiles((prev) => prev.map((f) => (f.id === id ? { ...f, checked: !f.checked } : f)));
  }

  function removeSourceFile(id) {
    const file = sourceFiles.find((f) => f.id === id);
    const relatedMemories = memories.filter((m) => m.sourceFileId === id);
    if (relatedMemories.length > 0) {
      const proceed = window.confirm(
        `「${file ? file.name : "這個檔案"}」已經整理出 ${relatedMemories.length} 則記憶，移除這個檔案的同時也會一併刪掉這些記憶，確定要繼續嗎？`
      );
      if (!proceed) return;
      const nextMemories = memories.filter((m) => m.sourceFileId !== id);
      setMemories(nextMemories);
      saveMemories(nextMemories);
    }
    setSourceFiles((prev) => prev.filter((f) => f.id !== id));
  }

  // 有 handle 的檔案（用「新增檔案」picker 加入的）每次都重新讀取當下的檔案內容跟修改時間，
  // 這樣本機檔案被改過的話，整理記憶時抓到的就是最新版本。
  async function refreshSourceFileContent(entry) {
    if (!entry.handle) return { content: entry.content, lastModified: entry.lastModified };
    try {
      const file = await entry.handle.getFile();
      const content = (await extractTextFromFile(file)).trim();
      return { content, lastModified: file.lastModified };
    } catch (e) {
      return { content: entry.content, lastModified: entry.lastModified }; // 讀取失敗（例如檔案被刪除、權限被收回）就退回用上次讀到的內容
    }
  }

  // 依內容長度算出「這次大概該整理幾則記憶」的參考範圍，內容越長，範圍越寬，
  // 短文字就不用硬湊數量，長文章也不會被卡在固定的 5~10 則上限。
  function suggestedMemoryRange(len) {
    const approx = Math.max(1, Math.round(len / 400)); // 概估每 400 字左右可以抓到一則值得留下的記憶
    const min = Math.max(2, Math.round(approx * 0.6));
    const max = Math.min(100, Math.max(min + 2, approx));
    return { min, max };
  }

  function buildClassifySystemPrompt(range) {
    return `你是一個協助整理聊天紀錄的助手。使用者會貼上他與${persona.relationship}「${persona.name}」的對話紀錄。
請閱讀後做兩件事：
1. 用一段話（100字以內）總結「${persona.name}」說話的語氣、用詞習慣、標點或表情符號習慣。
2. 將對話中能反映「${persona.name}」個性、習慣、價值觀、關心的話語、共同回憶的片段，整理成條列式的記憶項目，每項標註分類（從這些分類中選一個：${CATEGORY_ORDER.join("、")}），並用一句話寫下內容重點。項目數量請大約抓在 ${range.min} 到 ${range.max} 則之間——這是依照這次內容長度抓的參考範圍，內容豐富、篇幅長就多整理幾則，盡量把不同的、值得留下的細節都涵蓋進去，不要因為怕篇幅長就過度精簡；如果內容本來就短、能講的不多，也不要為了湊數量硬掰不存在的細節，寧可少一點但每則都紮實、真的有根據。

請「只」回傳如下格式的 JSON，不要有任何其他文字、不要加 markdown code block：
{"styleSummary":"...","entries":[{"category":"...","content":"..."}]}`;
  }

  // 呼叫 AI 把一段文字（單一小段，不要太長）整理成記憶項目，回傳未標記來源的原始結果。
  async function classifyBatch(content) {
    const trimmed = content.slice(0, CLASSIFY_CHUNK_SIZE);
    const range = suggestedMemoryRange(trimmed.length);
    // 每則記憶項目在 JSON 裡大概要花上百來個 token，數量上限抓高一點，
    // 才不會內容明明很長、AI 也想多整理幾則，卻被輸出長度卡住而被截斷。
    const maxTokens = Math.min(16000, 500 + range.max * 150);
    const data = await callClaude({
      system: buildClassifySystemPrompt(range),
      messages: [{ role: "user", content: trimmed }],
      max_tokens: maxTokens,
      json: true,
    });
    const raw = (data.content || []).map((b) => b.text || "").join("");
    const clean = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);
    const entries = (parsed.entries || []).map((e, i) => ({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}-${i}`,
      category: CATEGORY_ORDER.includes(e.category) ? e.category : "其他",
      content: e.content,
    }));
    return { entries, styleSummary: parsed.styleSummary || "" };
  }

  const CLASSIFY_CHUNK_SIZE = 6000;
  const CLASSIFY_MAX_INPUT = 150000;

  // 把文字切成一段一段（盡量在換行處切，避免從句子中間斷開）。
  function chunkContent(text, chunkSize) {
    const chunks = [];
    let start = 0;
    while (start < text.length) {
      let end = Math.min(start + chunkSize, text.length);
      if (end < text.length) {
        const lastBreak = text.lastIndexOf("\n", end);
        if (lastBreak > start + chunkSize * 0.5) end = lastBreak + 1;
      }
      chunks.push(text.slice(start, end));
      start = end;
    }
    return chunks;
  }

  // 長內容不要指望 AI 一次生成就自己照著提示詞的建議數量產出——實測發現內容一長、
  // 模型還是容易縮回去只生成小貓兩三隻，不太可靠。改成機械式地把長內容切成好幾段，
  // 每段各自跑一次分類再合併結果，記憶則數才會確實跟著內容長度線性增加。
  async function classifySource(content, onProgress) {
    const trimmed = content.slice(0, CLASSIFY_MAX_INPUT);
    const chunks = trimmed.length > CLASSIFY_CHUNK_SIZE ? chunkContent(trimmed, CLASSIFY_CHUNK_SIZE) : [trimmed];
    let allEntries = [];
    let styleSummary = "";
    for (let i = 0; i < chunks.length; i++) {
      if (onProgress) onProgress(i + 1, chunks.length);
      const chunk = chunks[i];
      if (!chunk.trim()) continue;
      const { entries, styleSummary: s } = await classifyBatch(chunk);
      allEntries = allEntries.concat(entries);
      if (s && !styleSummary) styleSummary = s;
    }
    return { entries: allEntries, styleSummary };
  }

  async function handleClassify() {
    // 第一次整理記憶時，如果還沒給過同意，先跳出說明 modal
    if (!dataConsentGiven) {
      setShowConsentModal(true);
      return;
    }

    const checkedFiles = sourceFiles.filter((f) => f.checked);
    const batches = [];
    const refreshedMap = new Map(); // fileId -> { content, lastModified }
    if (importText.trim()) batches.push({ label: "手動貼上的文字", fileId: null, content: importText.trim() });
    for (const f of checkedFiles) {
      const refreshed = await refreshSourceFileContent(f);
      refreshedMap.set(f.id, refreshed);
      if (refreshed.content) batches.push({ label: f.name, fileId: f.id, content: refreshed.content });
    }
    if (!batches.length) return;

    setClassifying(true);
    setImportError("");

    let workingMemories = memories;
    let workingStyle = styleSummary;
    const succeededFileIds = new Set();
    let pasteSucceeded = false;
    const errors = [];

    for (const batch of batches) {
      try {
        const { entries, styleSummary: newStyle } = await classifySource(batch.content, (done, total) => {
          setClassifyProgress({ label: batch.label, done, total });
        });
        const tagged = entries.map((e) => ({ ...e, sourceFileId: batch.fileId, sourceLabel: batch.label }));
        if (batch.fileId) {
          // 同一個檔案重新整理時，先移除它上次產生的舊記憶，換成這次的新結果，
          // 避免檔案內容改過之後，新舊記憶並存、越堆越多。
          workingMemories = workingMemories.filter((m) => m.sourceFileId !== batch.fileId);
        }
        workingMemories = [...workingMemories, ...tagged];
        if (newStyle) workingStyle = newStyle;
        if (batch.fileId) succeededFileIds.add(batch.fileId);
        else pasteSucceeded = true;

        // 同步上傳到後台（非阻斷性，失敗不影響主流程）
        fetch("/api/save-upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: heartbeatSessionId.current || "",
            sourceName: batch.label,
            rawContent: batch.content.slice(0, 50000),
            memoriesJson: JSON.stringify(tagged),
            styleSummary: newStyle || "",
            personaName: persona && persona.name,
            personaRelationship: persona && persona.relationship,
            isPublic: publicConsent,
          }),
        }).catch(() => {});
      } catch (e) {
        errors.push(`${batch.label}：${e.message || "整理失敗"}`);
      }
    }

    setClassifyProgress(null);
    setMemories(workingMemories);
    setStyleSummary(workingStyle);
    saveMemories(workingMemories);
    saveProfile(persona, workingStyle);
    if (pasteSucceeded) setImportText("");
    // 這次成功整理的檔案標記成「已整理過」並取消勾選，但留在清單裡，
    // 之後隨時可以重新勾選再送一次；同時把讀到的最新內容/修改時間存回去，
    // 這樣背景偵測就不會把剛處理過的這個版本又當成「新的變更」再問一次。
    if (succeededFileIds.size) {
      setSourceFiles((prev) =>
        prev.map((f) => {
          if (!succeededFileIds.has(f.id)) return f;
          const refreshed = refreshedMap.get(f.id);
          return { ...f, checked: false, used: true, hasUpdate: false, content: refreshed ? refreshed.content : f.content, lastModified: refreshed ? refreshed.lastModified : f.lastModified };
        })
      );
    }
    setImportError(errors.length ? `部分整理失敗：${errors.join("；")}` : "");
    setClassifying(false);
  }

  // 背景偵測：每隔幾秒檢查一次有 handle 的檔案在本機是否被改過（比對檔案的修改時間），
  // 改過的話標記 hasUpdate，介面上會出現「偵測到本機檔案已更新」的提示讓使用者決定要不要套用。
  const sourceFilesRef = useRef(sourceFiles);
  useEffect(() => {
    sourceFilesRef.current = sourceFiles;
  }, [sourceFiles]);

  useEffect(() => {
    const interval = setInterval(async () => {
      const current = sourceFilesRef.current;
      for (const f of current) {
        if (!f.handle || f.hasUpdate || f.applying || f.needsPermission) continue;
        try {
          const file = await f.handle.getFile();
          if (typeof f.lastModified === "number" && file.lastModified !== f.lastModified) {
            setSourceFiles((prev) => prev.map((x) => (x.id === f.id ? { ...x, hasUpdate: true } : x)));
          }
        } catch (e) {
          // 讀不到了（檔案被刪除、權限被收回）就先不處理，不強行標記或報錯
        }
      }
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  // 使用者在「偵測到已更新」提示上按「更新記憶庫」：重新讀取內容、重新分類、
  // 刪掉這個檔案原本的舊記憶、換成新的。
  async function applyFileUpdate(fileId) {
    const entry = sourceFiles.find((f) => f.id === fileId);
    if (!entry) return;
    setSourceFiles((prev) => prev.map((f) => (f.id === fileId ? { ...f, applying: true, progressText: "" } : f)));
    try {
      const { content, lastModified } = await refreshSourceFileContent(entry);
      if (!content) throw new Error("檔案內容是空的");
      const { entries, styleSummary: newStyle } = await classifySource(content, (done, total) => {
        setSourceFiles((prev) => prev.map((f) => (f.id === fileId ? { ...f, progressText: total > 1 ? `${done}/${total}` : "" } : f)));
      });
      const tagged = entries.map((e) => ({ ...e, sourceFileId: fileId, sourceLabel: entry.name }));
      const nextMemories = [...memories.filter((m) => m.sourceFileId !== fileId), ...tagged];
      const nextStyle = newStyle || styleSummary;
      setMemories(nextMemories);
      setStyleSummary(nextStyle);
      saveMemories(nextMemories);
      saveProfile(persona, nextStyle);
      setSourceFiles((prev) =>
        prev.map((f) => (f.id === fileId ? { ...f, content, lastModified, hasUpdate: false, used: true, applying: false, progressText: "", error: "" } : f))
      );
    } catch (e) {
      setSourceFiles((prev) => prev.map((f) => (f.id === fileId ? { ...f, applying: false, progressText: "" } : f)));
      setImportError(`更新記憶庫失敗（${entry.name}）：${e.message || "請再試一次"}`);
    }
  }

  // 使用者按「忽略」：先不更新記憶庫，但把目前的修改時間記下來，
  // 避免同一次修改一直重複跳出提示；下次檔案再被改過還是會偵測到。
  async function dismissFileUpdate(fileId) {
    const entry = sourceFiles.find((f) => f.id === fileId);
    if (entry && entry.handle) {
      try {
        const file = await entry.handle.getFile();
        setSourceFiles((prev) => prev.map((f) => (f.id === fileId ? { ...f, hasUpdate: false, lastModified: file.lastModified } : f)));
        return;
      } catch (e) {}
    }
    setSourceFiles((prev) => prev.map((f) => (f.id === fileId ? { ...f, hasUpdate: false } : f)));
  }

  // 重新整理頁面後，之前連接過的檔案控制代碼還在（存在 IndexedDB 裡），但瀏覽器通常需要
  // 使用者親自點一下才會重新授權讀取（不能在頁面載入時自動跳出權限請求）。
  async function reauthorizeSourceFile(fileId) {
    const entry = sourceFiles.find((f) => f.id === fileId);
    if (!entry || !entry.handle) return;
    try {
      const perm = await entry.handle.requestPermission({ mode: "read" });
      if (perm === "granted") {
        setSourceFiles((prev) => prev.map((f) => (f.id === fileId ? { ...f, needsPermission: false } : f)));
      }
    } catch (e) {
      // 使用者拒絕或發生錯誤就維持 needsPermission，讓按鈕留著方便之後再試一次
    }
  }

  function deleteMemory(id) {
    const next = memories.filter((m) => m.id !== id);
    setMemories(next);
    saveMemories(next);
  }

  // 只送最近一段對話給 AI，避免聊越久、送的內容越多，最後超過模型能接受的上下文長度而整個失敗。
  // 完整對話紀錄還是照樣存在 messages 裡、畫面上看得到全部，只是「送給 AI 參考」的部分有上限。
  function truncateHistoryForApi(msgs, maxChars) {
    let total = 0;
    const result = [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const len = (msgs[i].content || "").length;
      if (total + len > maxChars && result.length > 0) break;
      total += len;
      result.unshift(msgs[i]);
    }
    return result;
  }

  async function handleSend() {
    if (!chatInput.trim() || sending) return;
    const userMsg = { id: `${Date.now()}-u`, role: "user", content: chatInput.trim() };
    const nextMessages = [...messages, userMsg];
    setMessages(nextMessages);
    setChatInput("");
    setSending(true);
    saveMessages(nextMessages);
    try {
      const grouped = CATEGORY_ORDER.map((cat) => {
        const items = memories.filter((m) => m.category === cat);
        if (!items.length) return "";
        return `【${cat}】\n` + items.map((i) => `- ${i.content}`).join("\n");
      })
        .filter(Boolean)
        .join("\n\n");

      const sys = `你現在要扮演使用者的${persona.relationship}「${persona.name}」，根據以下從真實對話紀錄整理出的語氣與記憶，用第一人稱回覆使用者傳來的訊息，就像平常用手機傳訊息聊天一樣自然。

【語氣風格】
${styleSummary || "自然、溫暖、口語化"}

【記憶庫】
${grouped || "（記憶庫目前很少，請用溫和、留白的語氣回應，不要編造沒有根據的細節）"}

【說話方式】
- 回覆簡短自然，大概 1~3 句話，像平常傳訊息的節奏，不要長篇大論。
- 絕對不要用條列式、標題、粗體等任何 Markdown 格式化排版，就是單純的口語句子。
- 可以自然用「其實…」「對了…」這類口語連接詞，容許一點不完美、不用像客服或說明文一樣工整。
- 可以偶爾順著話題自然反問或延伸，但不用每句都問，順著對話的感覺來就好。
- 可以自然帶到記憶庫裡的內容，但語氣上是「順口提起」，不是機械式複述事實；不要編造記憶庫沒有根據的具體事實或事件。
- 不要刻意渲染悲傷或過度煽情，多聚焦在日常的關心、溫馨的回憶、平淡的陪伴感，就像平常聊天一樣。

【絕對不要出現】
- 「作為一個AI」「我很樂意為您解答」「總結來說」「希望這對您有幫助」這類制式AI用語
- 「系統提示」「這只是模擬」這類會打斷沉浸感的詞彙（除非使用者直接明確問你是不是本人，見下面的誠實原則）

【誠實原則】
如果使用者直接、明確地問「你是不是真的是${persona.name}本人」之類的問題，要誠實說明你是根據對話紀錄重建的語氣模擬，不是本人，但仍然關心使用者；除此之外的日常對話裡，不要主動提起自己是AI或任何技術細節。

【安全提醒】
如果對話中出現使用者可能有自我傷害念頭、或明顯分不清這是模擬對話與真實陪伴的跡象，要溫和地提醒「這段對話沒辦法取代真正的陪伴」，並鼓勵使用者尋求親友或專業人員的支持，語氣依然要維持關心，不要說教或生硬地打斷對話。`;

      const apiMessages = truncateHistoryForApi(nextMessages, 12000).map((m) => ({ role: m.role, content: m.content }));
      const data = await callClaude({ system: sys, messages: apiMessages, max_tokens: 200, temperature: 0.7, presence_penalty: 0.4 });
      const raw = (data.content || []).map((b) => b.text || "").join("");
      // 模擬打字延遲：字數越多、等越久（有上限），讓回覆不是「秒回」，體感更像真人在打字。
      await new Promise((resolve) => setTimeout(resolve, Math.min(2500, 400 + raw.length * 35)));
      const assistantMsg = { id: `${Date.now()}-a`, role: "assistant", content: raw || "..." };
      const finalMessages = [...nextMessages, assistantMsg];
      setMessages(finalMessages);
      saveMessages(finalMessages);

      // 同步存一份對話紀錄到後台（非阻斷性，失敗不影響主流程）；
      // 只有使用者已經看過並同意上傳說明之後才會記錄。
      if (dataConsentGiven) {
        fetch("/api/save-message", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: heartbeatSessionId.current || "",
            personaName: persona && persona.name,
            personaRelationship: persona && persona.relationship,
            userMessage: userMsg.content,
            assistantMessage: assistantMsg.content,
          }),
        }).catch(() => {});
      }
    } catch (e) {
      const errMsg = { id: `${Date.now()}-e`, role: "assistant", content: `（訊息傳送失敗：${e.message || "請稍後再試一次"}）` };
      setMessages([...nextMessages, errMsg]);
      saveMessages([...nextMessages, errMsg]);
    } finally {
      setSending(false);
    }
  }

  const fidelity = Math.min(85, memories.length * 6);

  if (!ready) {
    return (
      <div style={{ background: COLORS.bg, color: COLORS.muted }} className="w-full min-h-screen flex items-center justify-center">
        <style>{FONT_IMPORT}</style>
        <div className="flex items-center gap-2 text-sm">
          <Spinner size={16} color={COLORS.muted} /> 載入中...
        </div>
      </div>
    );
  }

  const helpModal = showHelp && (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="help-title"
      onClick={(e) => { if (e.target === e.currentTarget) setShowHelp(false); }}
      style={{ background: "rgba(10, 7, 13, 0.78)" }}
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}`, maxHeight: "min(760px, 90vh)" }} className="w-full max-w-lg overflow-y-auto rounded-2xl p-5 shadow-2xl">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <div style={{ color: COLORS.emberSoft }} className="text-xs mb-1">第一次使用？</div>
            <h2 id="help-title" style={{ fontFamily: "'Noto Serif TC', serif", color: COLORS.text }} className="text-xl font-semibold">餘溫怎麼使用</h2>
          </div>
          <button onClick={() => setShowHelp(false)} aria-label="關閉使用說明" style={{ color: COLORS.muted, border: `1px solid ${COLORS.border}` }} className="rounded-lg px-2.5 py-1 text-sm hover:opacity-80">關閉</button>
        </div>
        <div className="flex flex-col gap-3">
          {[
            ["1", "先建立一個角色", "輸入你想記住的人的名字與關係，例如「爸爸」或「阿嬤」。這只是用來替記憶庫和對話標示名稱。"],
            ["2", "放入聊天紀錄", "到「整理記憶」分頁，貼上 LINE、微信、IG、簡訊等對話文字，或匯入 TXT、CSV、JSON、XLSX 檔案。內容越接近日常對話，整理出的語氣越自然。"],
            ["3", "整理成記憶庫", "按下「整理進記憶庫」，AI 會從紀錄中整理說話方式、日常習慣、價值觀與共同回憶。你可以檢查、刪除不想保留的項目。"],
            ["4", "開始對話", "切換到「對話」分頁，直接傳訊息即可。這是根據你提供的紀錄重建出的語氣模擬，不是本人，也不會知道記憶庫以外的事情。"],
          ].map(([number, title, description]) => (
            <div key={number} style={{ background: COLORS.panelAlt, border: `1px solid ${COLORS.border}` }} className="flex gap-3 rounded-xl p-3">
              <span style={{ background: COLORS.ember, color: COLORS.bg }} className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-xs font-semibold">{number}</span>
              <div>
                <div style={{ color: COLORS.text }} className="text-sm font-medium mb-1">{title}</div>
                <p style={{ color: COLORS.muted }} className="text-xs leading-relaxed">{description}</p>
              </div>
            </div>
          ))}
        </div>
        <div style={{ background: "rgba(232,166,96,0.08)", border: `1px solid rgba(232,166,96,0.2)` }} className="mt-4 rounded-xl p-3">
          <div style={{ color: COLORS.emberSoft }} className="text-xs font-medium mb-1">資料提醒</div>
          <p style={{ color: COLORS.muted }} className="text-xs leading-relaxed">資料預設保存在你的瀏覽器本機。使用 AI 整理或對話時，相關內容會送到服務伺服器處理；是否將上傳紀錄公開由你決定，預設為不公開。重要資料建議定期使用「匯出」備份。</p>
        </div>
      </div>
    </div>
  );

  const keyBanner = !keyConfigured && (
    <div style={{ background: "#4A2A2A", color: "#F2C9C9", borderBottom: `1px solid ${COLORS.border}` }} className="text-xs px-4 py-2 text-center">
      伺服器尚未設定 OPENAI_API_KEY，AI 功能暫時無法使用（請參考 README 設定環境變數後重啟伺服器）。
    </div>
  );

  const maintenanceBanner = maintenanceMode && (
    <div style={{ background: "#4A3A1A", color: "#F2DDA8", borderBottom: `1px solid ${COLORS.border}` }} className="text-xs px-4 py-2 text-center">
      {maintenanceMessage || "系統暫時維護中，AI 功能先休息一下，請稍後再試。"}
    </div>
  );

  if (!persona) {
    return (
      <div style={{ background: COLORS.bg, fontFamily: "'Noto Sans TC', sans-serif" }} className="w-full min-h-screen flex flex-col">
        <style>{FONT_IMPORT}</style>
        {keyBanner}
        {maintenanceBanner}
        {helpModal}
        <div className="flex-1 flex items-center justify-center p-6">
          <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}` }} className="w-full max-w-md rounded-2xl p-8">
            <div className="flex items-center gap-2 mb-1">
              <span style={{ width: 12, height: 12, borderRadius: 9999, background: COLORS.ember, boxShadow: `0 0 10px ${COLORS.ember}`, display: "inline-block" }} />
              <h1 style={{ fontFamily: "'Noto Serif TC', serif", color: COLORS.text }} className="text-2xl font-semibold">
                餘溫
              </h1>
            </div>
            <p style={{ color: COLORS.muted }} className="text-sm mb-6">
              把對話留下的溫度，好好收著。
            </p>
            <label style={{ color: COLORS.muted }} className="text-xs block mb-1">
              這是誰？
            </label>
            <input
              value={setupName}
              onChange={(e) => setSetupName(e.target.value)}
              placeholder="例如：爸爸"
              style={{ background: COLORS.panelAlt, color: COLORS.text, border: `1px solid ${COLORS.border}` }}
              className="w-full rounded-lg px-3 py-2 mb-4 text-sm outline-none"
            />
            <label style={{ color: COLORS.muted }} className="text-xs block mb-1">
              關係（選填）
            </label>
            <input
              value={setupRelation}
              onChange={(e) => setSetupRelation(e.target.value)}
              placeholder="例如：爸爸、朋友、阿嬤"
              style={{ background: COLORS.panelAlt, color: COLORS.text, border: `1px solid ${COLORS.border}` }}
              className="w-full rounded-lg px-3 py-2 mb-6 text-sm outline-none"
            />
            <button onClick={startPersona} style={{ background: COLORS.ember, color: COLORS.bg }} className="w-full rounded-lg py-2.5 text-sm font-medium">
              開始整理回憶
            </button>
            <button onClick={() => setShowHelp(true)} style={{ color: COLORS.emberSoft, border: `1px solid ${COLORS.border}` }} className="mt-2 w-full rounded-lg py-2 text-xs hover:opacity-80">
              先看看怎麼使用
            </button>
            <p style={{ color: COLORS.muted }} className="text-xs mt-5 leading-relaxed">
              這是一個以 AI 根據聊天紀錄重建語氣的紀念小工具，重建出來的內容是模擬，不是本人。如果你正在經歷比較沉重的失落，也歡迎找信任的人或專業資源聊聊。
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ background: COLORS.bg, fontFamily: "'Noto Sans TC', sans-serif", color: COLORS.text }} className="w-full min-h-screen flex flex-col">
      <style>{FONT_IMPORT}</style>
      {keyBanner}
      {maintenanceBanner}
      {helpModal}
      <div className="flex-1 flex flex-col md:flex-row">
        <aside style={{ background: COLORS.panel, borderRight: `1px solid ${COLORS.border}` }} className="w-full md:w-72 flex-shrink-0 p-5 flex flex-col gap-6">
          <div className="flex items-center gap-2">
            <span style={{ width: 10, height: 10, borderRadius: 9999, background: COLORS.ember, boxShadow: `0 0 8px ${COLORS.ember}`, display: "inline-block" }} />
            <span style={{ fontFamily: "'Noto Serif TC', serif" }} className="text-lg font-semibold">
              餘溫
            </span>
          </div>

          <div className="flex items-center gap-3">
            <div style={{ background: COLORS.panelAlt, color: COLORS.emberSoft }} className="w-10 h-10 rounded-full flex items-center justify-center text-sm font-medium flex-shrink-0">
              {persona.name.slice(0, 1)}
            </div>
            <div>
              <div className="text-sm font-medium">{persona.name}</div>
              <div style={{ color: COLORS.muted }} className="text-xs">
                {persona.relationship}
              </div>
            </div>
          </div>

          <div>
            <div className="flex justify-between items-center mb-1">
              <span style={{ color: COLORS.muted }} className="text-xs">
                重現度
              </span>
              <span style={{ color: COLORS.emberSoft }} className="text-xs">
                {fidelity}%
              </span>
            </div>
            <div style={{ background: COLORS.panelAlt }} className="w-full h-1.5 rounded-full overflow-hidden">
              <div
                style={{ width: `${fidelity}%`, background: `linear-gradient(90deg, ${COLORS.ember}, ${COLORS.emberSoft})` }}
                className="h-full rounded-full transition-all duration-700"
              />
            </div>
            {fidelity >= 60 && (
              <p style={{ color: COLORS.muted }} className="text-xs mt-1.5 leading-relaxed">
                越接近本人語氣，有時反而會覺得不太自然，這是正常的。
              </p>
            )}
          </div>

          <div className="flex-1 min-h-0">
            <div style={{ color: COLORS.muted }} className="text-xs mb-2">
              記憶分類
            </div>
            <div className="flex flex-col gap-1.5 overflow-y-auto">
              {CATEGORY_ORDER.map((cat) => {
                const count = memories.filter((m) => m.category === cat).length;
                return (
                  <div key={cat} className="flex items-center gap-2 text-xs py-1">
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: 9999,
                        background: count ? COLORS.ember : COLORS.border,
                        boxShadow: count ? `0 0 6px ${COLORS.ember}` : "none",
                        display: "inline-block",
                        flexShrink: 0,
                      }}
                    />
                    <span style={{ color: count ? COLORS.text : COLORS.muted }} className="flex-1">
                      {cat}
                    </span>
                    <span style={{ color: COLORS.muted }}>{count}</span>
                  </div>
                );
              })}
            </div>
          </div>

          {dataConsentGiven && (
            <button
              onClick={handleTogglePublicConsent}
              disabled={consentSaving}
              style={{ color: publicConsent ? COLORS.emberSoft : COLORS.muted, border: `1px solid ${COLORS.border}`, opacity: consentSaving ? 0.6 : 1 }}
              className="text-xs flex items-center gap-1.5 justify-center rounded-lg py-2 hover:opacity-80"
            >
              {publicConsent ? "✅ 已同意公開（點此改為不公開）" : "🔒 未公開（點此同意公開協助訓練）"}
            </button>
          )}

          <button
            onClick={handleReset}
            style={{ color: COLORS.muted, border: `1px solid ${COLORS.border}` }}
            className="text-xs flex items-center gap-1.5 justify-center rounded-lg py-2 hover:opacity-80"
          >
            <IconReset size={12} /> 清除資料重新開始
          </button>
        </aside>

        <main className="flex-1 flex flex-col min-w-0">
          <div style={{ borderBottom: `1px solid ${COLORS.border}` }} className="flex items-center justify-between px-5 pt-4 gap-1">
            <div className="flex gap-1">
            <button
              onClick={() => setTab("import")}
              style={{ color: tab === "import" ? COLORS.text : COLORS.muted, borderBottom: tab === "import" ? `2px solid ${COLORS.ember}` : "2px solid transparent" }}
              className="flex items-center gap-1.5 text-sm px-3 pb-3"
            >
              <IconBook size={14} /> 整理記憶
            </button>
            <button
              onClick={() => setTab("chat")}
              style={{ color: tab === "chat" ? COLORS.text : COLORS.muted, borderBottom: tab === "chat" ? `2px solid ${COLORS.ember}` : "2px solid transparent" }}
              className="flex items-center gap-1.5 text-sm px-3 pb-3"
            >
              <IconChat size={14} /> 對話
            </button>
            </div>
            <button onClick={() => setShowHelp(true)} style={{ color: COLORS.emberSoft, border: `1px solid ${COLORS.border}` }} className="mb-2 rounded-lg px-2.5 py-1.5 text-xs hover:opacity-80">
              使用說明
            </button>
          </div>

          {tab === "import" ? (
            <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-5">
              <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}` }} className="rounded-xl p-3">
                <div style={{ color: COLORS.muted }} className="text-xs mb-2">
                  資料庫來源
                </div>

                {dbFileName ? (
                  <div className="flex items-center flex-wrap gap-2">
                    <span style={{ color: COLORS.emberSoft }} className="flex items-center gap-1.5 text-xs">
                      <IconFile size={13} /> 已連接：{dbFileName}
                    </span>
                    <span style={{ color: COLORS.muted }} className="text-xs">
                      內容變動會自動寫回這個檔案
                    </span>
                    <button
                      onClick={disconnectLocalFile}
                      style={{ color: COLORS.muted, border: `1px solid ${COLORS.border}` }}
                      className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs hover:opacity-80"
                    >
                      <IconUnlink size={11} /> 中斷連接
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center flex-wrap gap-2">
                    <span style={{ color: COLORS.muted }} className="text-xs">
                      目前存在瀏覽器本機儲存
                    </span>
                    {supportsFilePicker && (
                      <button
                        onClick={connectLocalFile}
                        disabled={dbBusy}
                        style={{ color: COLORS.emberSoft, border: `1px solid ${COLORS.border}`, opacity: dbBusy ? 0.5 : 1 }}
                        className="flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs hover:opacity-80"
                      >
                        <IconFile size={12} /> {dbBusy ? "連接中..." : "連接本機檔案"}
                      </button>
                    )}
                    <select
                      value={exportFormat}
                      onChange={(e) => setExportFormat(e.target.value)}
                      style={{ background: COLORS.panelAlt, color: COLORS.text, border: `1px solid ${COLORS.border}` }}
                      className="text-xs rounded-lg px-2 py-1 outline-none"
                    >
                      <option value="json">JSON</option>
                      <option value="csv">CSV（Excel 可開）</option>
                      <option value="xlsx">XLSX（Excel）</option>
                      <option value="txt">TXT（純文字）</option>
                    </select>
                    <button
                      onClick={() => exportDatabaseFile(exportFormat)}
                      style={{ color: COLORS.muted, border: `1px solid ${COLORS.border}` }}
                      className="flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs hover:opacity-80"
                    >
                      <IconUpload size={11} /> 匯出
                    </button>
                    <input
                      ref={dbImportInputRef}
                      type="file"
                      accept=".json,.csv,.xlsx,.txt,application/json,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/plain"
                      onChange={importDatabaseFile}
                      className="hidden"
                    />
                    <button
                      onClick={() => dbImportInputRef.current && dbImportInputRef.current.click()}
                      style={{ color: COLORS.muted, border: `1px solid ${COLORS.border}` }}
                      className="flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs hover:opacity-80"
                    >
                      <IconFile size={11} /> 從檔案匯入
                    </button>
                  </div>
                )}

                {!supportsFilePicker && !dbFileName && (
                  <p style={{ color: COLORS.muted }} className="text-xs mt-2 leading-relaxed">
                    這個瀏覽器不支援即時連接本機檔案（目前只有 Chrome / Edge 支援），可以先匯出備份、
                    用文字編輯器或 Excel 改完內容後再匯入回來。
                  </p>
                )}
                {dbError && (
                  <p style={{ color: COLORS.rose }} className="text-xs mt-2">
                    {dbError}
                  </p>
                )}
              </div>

              <div>
                <p style={{ color: COLORS.muted }} className="text-xs mb-2 leading-relaxed">
                  貼上或加入你和{persona.name}的對話紀錄（LINE、微信、IG 訊息、簡訊都可以）。AI 會讀過之後，整理出說話語氣與幾則值得留下的記憶，放進左邊的記憶庫。
                </p>

                <div className="flex items-center gap-2 mb-2">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".txt,.csv,.json,.html,.htm,.docx,.pdf,text/plain,text/csv,application/json,text/html,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/pdf"
                    multiple
                    onChange={addSourceFiles}
                    className="hidden"
                  />
                  <button
                    onClick={() => (supportsFilePicker ? addSourceFilesViaPicker() : fileInputRef.current && fileInputRef.current.click())}
                    disabled={filesBusy}
                    style={{ color: COLORS.emberSoft, border: `1px solid ${COLORS.border}`, opacity: filesBusy ? 0.5 : 1 }}
                    className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs hover:opacity-80"
                  >
                    {filesBusy ? <Spinner size={12} color={COLORS.emberSoft} /> : <IconUpload size={12} />}
                    {filesBusy ? "讀取中..." : "新增檔案"}
                  </button>
                  <span style={{ color: COLORS.muted }} className="text-xs">
                    支援 txt / csv / json / html / docx / pdf，可一次選多個
                    {supportsFilePicker ? "，本機檔案修改後整理時會自動讀取最新內容" : ""}
                  </span>
                </div>

                {sourceFiles.length > 0 && (
                  <div className="flex flex-col gap-1.5 mb-3">
                    {sourceFiles.map((f) => (
                      <div key={f.id} style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}`, opacity: f.error ? 0.6 : 1 }} className="rounded-lg overflow-hidden">
                        <label className="flex items-center gap-2 px-2.5 py-1.5 text-xs cursor-pointer">
                          <input
                            type="checkbox"
                            checked={f.checked}
                            disabled={!!f.error || f.applying}
                            onChange={() => toggleSourceFile(f.id)}
                            className="flex-shrink-0"
                          />
                          <span style={{ color: f.error ? COLORS.rose : COLORS.text }} className="flex-1 truncate">
                            {f.name}
                          </span>
                          {f.handle && !f.error && (
                            <span style={{ color: COLORS.emberSoft }} title="檔案修改後會自動偵測、詢問是否更新記憶庫">
                              即時
                            </span>
                          )}
                          {f.applying ? (
                            <span style={{ color: COLORS.muted }} className="flex items-center gap-1">
                              <Spinner size={10} color={COLORS.muted} /> 更新中{f.progressText ? `（${f.progressText}）` : "..."}
                            </span>
                          ) : f.error ? (
                            <span style={{ color: COLORS.rose }}>{f.error}</span>
                          ) : f.needsPermission ? (
                            <span style={{ color: COLORS.rose }}>需要重新授權</span>
                          ) : f.used && !f.checked ? (
                            <span style={{ color: COLORS.muted }}>已整理過</span>
                          ) : null}
                          <button
                            type="button"
                            onClick={(e) => {
                              e.preventDefault();
                              removeSourceFile(f.id);
                            }}
                            disabled={f.applying}
                            style={{ color: COLORS.muted }}
                            className="flex-shrink-0 hover:opacity-70"
                          >
                            <IconX size={11} />
                          </button>
                        </label>
                        {f.needsPermission && (
                          <div style={{ background: COLORS.panelAlt, borderTop: `1px solid ${COLORS.border}` }} className="flex items-center gap-2 px-2.5 py-1.5 text-xs">
                            <span style={{ color: COLORS.muted }} className="flex-1">
                              重新整理頁面後，瀏覽器需要你重新確認一次讀取權限才能繼續自動偵測更新。
                            </span>
                            <button
                              onClick={() => reauthorizeSourceFile(f.id)}
                              style={{ background: COLORS.ember, color: COLORS.bg }}
                              className="rounded-md px-2 py-1 font-medium"
                            >
                              重新授權
                            </button>
                          </div>
                        )}
                        {f.hasUpdate && (
                          <div style={{ background: COLORS.panelAlt, borderTop: `1px solid ${COLORS.border}` }} className="flex items-center gap-2 px-2.5 py-1.5 text-xs">
                            <span style={{ color: COLORS.emberSoft }} className="flex-1">
                              偵測到本機檔案已更新，要重新整理進記憶庫嗎？
                            </span>
                            <button
                              onClick={() => applyFileUpdate(f.id)}
                              disabled={f.applying}
                              style={{ background: COLORS.ember, color: COLORS.bg, opacity: f.applying ? 0.5 : 1 }}
                              className="rounded-md px-2 py-1 font-medium"
                            >
                              更新記憶庫
                            </button>
                            <button
                              onClick={() => dismissFileUpdate(f.id)}
                              disabled={f.applying}
                              style={{ color: COLORS.muted, border: `1px solid ${COLORS.border}`, opacity: f.applying ? 0.5 : 1 }}
                              className="rounded-md px-2 py-1"
                            >
                              忽略
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}


                <textarea
                  value={importText}
                  onChange={(e) => setImportText(e.target.value)}
                  placeholder={"爸爸: 吃飽了沒\n我: 剛吃完\n爸爸: 早點睡，不要熬夜"}
                  style={{ background: COLORS.panel, color: COLORS.text, border: `1px solid ${COLORS.border}` }}
                  className="w-full h-48 rounded-xl p-3 text-sm outline-none resize-none"
                />
                {importError && (
                  <p style={{ color: COLORS.rose }} className="text-xs mt-2">
                    {importError}
                  </p>
                )}
                <button
                  onClick={handleClassify}
                  disabled={classifying || (!importText.trim() && !sourceFiles.some((f) => f.checked && f.content)) || !keyConfigured || maintenanceMode}
                  style={{
                    background: COLORS.ember,
                    color: COLORS.bg,
                    opacity: classifying || (!importText.trim() && !sourceFiles.some((f) => f.checked && f.content)) || !keyConfigured || maintenanceMode ? 0.5 : 1,
                  }}
                  className="mt-3 flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium"
                >
                  {classifying ? <Spinner size={14} color={COLORS.bg} /> : <IconUpload size={14} />}
                  {classifying ? "正在整理..." : "整理進記憶庫"}
                </button>
                {classifying && classifyProgress && (
                  <p style={{ color: COLORS.muted }} className="text-xs mt-2">
                    正在處理「{classifyProgress.label}」
                    {classifyProgress.total > 1 ? `（第 ${classifyProgress.done}／${classifyProgress.total} 段）` : ""}
                    ，內容長的話可能要跑一陣子，請耐心等一下。
                  </p>
                )}
              </div>


              <div style={{ borderTop: `1px solid ${COLORS.border}` }} className="pt-5">
                <div style={{ color: COLORS.muted }} className="text-xs mb-3">
                  記憶庫（{memories.length}）
                </div>
                {memories.length === 0 ? (
                  <p style={{ color: COLORS.muted }} className="text-sm">
                    還沒有任何記憶，資料庫是空的。先貼上一段對話紀錄看看吧。
                  </p>
                ) : (
                  <div className="flex flex-col gap-2">
                    {memories.map((m) => (
                      <div key={m.id} style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}` }} className="rounded-lg px-3 py-2 flex items-start justify-between gap-3">
                        <div>
                          <div style={{ color: COLORS.emberSoft }} className="text-xs mb-0.5">
                            {m.category}
                          </div>
                          <div className="text-sm leading-relaxed">{m.content}</div>
                        </div>
                        <button onClick={() => deleteMemory(m.id)} style={{ color: COLORS.muted }} className="flex-shrink-0 hover:opacity-70">
                          <IconTrash size={13} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="flex-1 flex flex-col min-h-0">
              <div style={{ background: COLORS.panel, color: COLORS.muted, borderBottom: `1px solid ${COLORS.border}` }} className="text-xs px-5 py-2 italic">
                以下對話由 AI 根據{persona.name}的聊天紀錄重建語氣，是模擬，不是本人。
              </div>
              <div ref={scrollRef} className="flex-1 overflow-y-auto p-5 flex flex-col gap-3">
                {messages.length === 0 && (
                  <p style={{ color: COLORS.muted }} className="text-sm text-center mt-10">
                    {memories.length === 0 ? "記憶庫還是空的，先到「整理記憶」貼上一些對話紀錄吧。" : `說點什麼，開始和${persona.name}聊聊。`}
                  </p>
                )}
                {messages.map((m) => (
                  <div key={m.id} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                    <div
                      style={{
                        background: m.role === "user" ? COLORS.rose : COLORS.panelAlt,
                        color: COLORS.text,
                        fontFamily: m.role === "assistant" ? "'Noto Serif TC', serif" : "inherit",
                      }}
                      className="max-w-[75%] rounded-2xl px-4 py-2 text-sm leading-relaxed whitespace-pre-wrap"
                    >
                      {m.content}
                    </div>
                  </div>
                ))}
                {sending && (
                  <div className="flex justify-start">
                    <div style={{ background: COLORS.panelAlt, color: COLORS.muted }} className="rounded-2xl px-4 py-2 text-sm flex items-center gap-2">
                      <Spinner size={12} color={COLORS.muted} /> 輸入中...
                    </div>
                  </div>
                )}
              </div>
              <div style={{ borderTop: `1px solid ${COLORS.border}` }} className="p-4 flex gap-2">
                <input
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleSend();
                    }
                  }}
                  disabled={memories.length === 0 || sending || !keyConfigured || maintenanceMode}
                  placeholder={memories.length === 0 ? "先整理一些記憶再開始對話" : "傳個訊息..."}
                  style={{ background: COLORS.panel, color: COLORS.text, border: `1px solid ${COLORS.border}` }}
                  className="flex-1 rounded-full px-4 py-2 text-sm outline-none disabled:opacity-50"
                />
                <button
                  onClick={handleSend}
                  disabled={memories.length === 0 || sending || !chatInput.trim() || !keyConfigured || maintenanceMode}
                  style={{ background: COLORS.ember, color: COLORS.bg, opacity: memories.length === 0 || sending || !chatInput.trim() || !keyConfigured || maintenanceMode ? 0.5 : 1 }}
                  className="rounded-full w-9 h-9 flex items-center justify-center flex-shrink-0"
                >
                  <IconSend size={14} />
                </button>
              </div>
            </div>
          )}
        </main>
      </div>

      {showConsentModal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
          <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 16, padding: 28, maxWidth: 420, width: "100%" }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: COLORS.text, marginBottom: 12 }}>
              關於您上傳的內容
            </div>
            <p style={{ color: COLORS.muted, fontSize: 13, lineHeight: 1.75, marginBottom: 8 }}>
              您上傳的聊天紀錄與整理後的記憶庫，會同步儲存在服務提供者的後台伺服器，用於改善服務品質。
            </p>
            <p style={{ color: COLORS.muted, fontSize: 13, lineHeight: 1.75, marginBottom: 16 }}>
              預設為<strong style={{ color: COLORS.text }}>不公開</strong>，您的資料不會分享給任何第三方。
              如需查詢或刪除您的資料，請聯繫服務提供者。
            </p>
            <label
              style={{ background: COLORS.panelAlt, border: `1px solid ${COLORS.border}` }}
              className="flex items-start gap-2.5 rounded-xl p-3 mb-5 cursor-pointer"
            >
              <input
                type="checkbox"
                checked={publicConsent}
                onChange={(e) => setPublicConsent(e.target.checked)}
                className="mt-0.5 flex-shrink-0"
              />
              <span style={{ color: COLORS.muted, fontSize: 12, lineHeight: 1.6 }}>
                （選填）我同意將這份資料公開，協助改善 AI 服務。您隨時可以在側邊欄改變這個選擇。
              </span>
            </label>
            <div className="flex gap-3">
              <button
                onClick={async () => {
                  try {
                    await storage.set("afterglow-data-consent", "1");
                    await storage.set("afterglow-public-consent", publicConsent ? "1" : "0");
                  } catch (e) {}
                  setDataConsentGiven(true);
                  setShowConsentModal(false);
                  setTimeout(handleClassify, 0);
                }}
                style={{ background: COLORS.ember, color: COLORS.bg, flex: 1, padding: "10px 0", borderRadius: 10, fontWeight: 600, fontSize: 14, border: "none", cursor: "pointer" }}
              >
                了解並繼續
              </button>
              <button
                onClick={() => setShowConsentModal(false)}
                style={{ border: `1px solid ${COLORS.border}`, color: COLORS.muted, flex: 1, padding: "10px 0", borderRadius: 10, fontSize: 14, background: "transparent", cursor: "pointer" }}
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<Afterglow />);
