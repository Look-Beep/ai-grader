/**
 * 智慧判 - 后端服务
 * 纯 Node.js 内置模块实现，零第三方依赖，需 Node.js 18+（用到全局 fetch）。
 *
 * 数据存储：data/db.json
 * 服务配置：data/settings.json（可在网页「设置」页修改，无需改代码）
 *
 * AI 服务（任意 OpenAI 兼容接口）按以下顺序自动选择：
 *   1. 网页「设置」页保存的配置（data/settings.json）
 *   2. 环境变量 AI_BASE_URL / AI_API_KEY / AI_MODEL（或 OPENAI_BASE_URL / OPENAI_API_KEY / OPENAI_MODEL）
 *   3. 本机 WorkBuddy 模型网关（WORKBUDDY_VLM_* 环境变量，仅在本机可用）
 *
 * 启动参数：PORT（默认 3210）、HOST（默认 0.0.0.0，局域网内其他电脑/手机可直接访问；
 *          设为 127.0.0.1 则仅本机可访问）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

const START_PORT = Number(process.env.PORT) || 3210;
const HOST = process.env.HOST || '0.0.0.0';
let activePort = START_PORT;

// ---------------- 账号与归属 ----------------
// 默认规则：教师 00000-00005，学生 26006-26200，密码=账号；管理员 99999/99999。
// 管理员在「账号设置」里改过账号或密码后，改动存在 accounts 表（云）/ data/accounts.json（本机），
// 覆盖默认规则；被改名后的旧账号会标记 disabled，不能再登录。
const AUTH = { teacher: { from: 0, to: 5 }, student: { from: 26006, to: 26200 } };
const ADMIN_ACCOUNT = '99999';
const ADMIN_PASSWORD = '99999';
const LEGACY_OWNER = '00000';   // 历史题目/提交的默认归属教师

/** 管理员改过的账号：account -> { account, password, role, disabled } */
const accountsCache = new Map();
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');

function defaultAccounts() {
  const out = [];
  for (let i = AUTH.teacher.from; i <= AUTH.teacher.to; i++) out.push(String(i).padStart(5, '0'));
  for (let i = AUTH.student.from; i <= AUTH.student.to; i++) out.push(String(i));
  return out;
}

function roleByRule(acc) {
  const s = String(acc || '').trim();
  if (s === ADMIN_ACCOUNT) return 'admin';
  if (!/^\d{5}$/.test(s)) return null;
  const n = Number(s);
  if (n >= AUTH.teacher.from && n <= AUTH.teacher.to) return 'teacher';
  if (n >= AUTH.student.from && n <= AUTH.student.to) return 'student';
  return null;
}

function roleOfAccount(acc) {
  const s = String(acc || '').trim();
  if (!s) return null;
  const custom = accountsCache.get(s);
  if (custom) return custom.disabled ? null : custom.role;
  return roleByRule(s);
}
/** 从 X-Account 请求头取当前登录账号（沿用前端登录体系，服务端只做权限校验） */
function accountOf(req) {
  const s = String(req.headers['x-account'] || '').trim();
  return roleOfAccount(s) ? s : null;
}
/** 题目的出题教师 */
function ownerOf(q) { return (q && q.ownerAccount) || LEGACY_OWNER; }

// ---------------- 数据存储 ----------------
let db = { questions: [], submissions: [], seq: 1 };

function loadDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    try {
      db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      if (!db.questions) db.questions = [];
      if (!db.submissions) db.submissions = [];
      if (!db.seq) db.seq = 1;
      // 历史数据没有出题人：统一归属到 00000，避免旧题目变成孤儿
      db.questions.forEach(q => { if (!q.ownerAccount) q.ownerAccount = LEGACY_OWNER; });
    } catch (e) {
      console.error('[db] 读取失败，使用空库:', e.message);
    }
  }
}
function saveDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}
function nextId(prefix) { return prefix + '_' + (db.seq++); }

// ---------------- 云端数据源（本机与线上共用同一份数据） ----------------
// data/cloud.json 存在时，所有读写都直接落到云数据库：
//   本机（localhost / 局域网）改动 → 立即写入云端 → 线上页面刷新即可看到，反之亦然。
// 删除 data/cloud.json 即可退回纯本机 data/db.json 存储。
const CLOUD_FILE = path.join(DATA_DIR, 'cloud.json');
let cloudCfg = null;
/**
 * 云服务配置来源（按优先级）：
 *   1. 环境变量 CLOUD_ENDPOINT / CLOUD_PUBLISHABLE_KEY（部署平台推荐，密钥不进仓库）
 *   2. data/cloud.json（本机开发用，已在 .gitignore 中，不入库）
 * 注意：这里的 publishableKey 是「公开标识键」，云端只按来源域名识别应用；
 * 真正需要保密的是大模型 API Key，它由教师在「设置」页填写，存服务端，永不写进代码。
 */
function loadCloudCfg() {
  cloudCfg = null;
  const envEndpoint = String(process.env.CLOUD_ENDPOINT || '').trim();
  const envKey = String(process.env.CLOUD_PUBLISHABLE_KEY || '').trim();
  if (envEndpoint && envKey) {
    cloudCfg = { endpoint: envEndpoint, publishableKey: envKey, source: 'env' };
    return;
  }
  try {
    if (!fs.existsSync(CLOUD_FILE)) return;
    const c = JSON.parse(fs.readFileSync(CLOUD_FILE, 'utf8'));
    if (c && c.endpoint && c.publishableKey) cloudCfg = c;
  } catch (e) {
    console.error('[cloud] 配置读取失败，退回本机存储:', e.message);
  }
}
const cloudOn = () => !!cloudCfg;

async function cloudFetch(pathAndQuery, opts) {
  opts = opts || {};
  const url = cloudCfg.endpoint.replace(/\/+$/, '') + '/.cloud/database/rest/' + pathAndQuery;
  const headers = Object.assign({
    'x-wb-webapp-access-key': cloudCfg.publishableKey,
    'Content-Type': 'application/json',
  }, opts.headers || {});
  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch (_) { data = text; } }
  if (!res.ok) {
    const msg = (data && (data.message || data.error_description || data.error)) || ('云端请求失败 HTTP ' + res.status);
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  return data;
}

function mapQFromCloud(r) {
  return {
    id: String(r.id), title: r.title, question: r.question, rubric: r.rubric,
    maxScore: Number(r.max_score), ownerAccount: r.owner_account || LEGACY_OWNER,
    createdAt: r.created_at,
  };
}
function mapSubFromCloud(r) {
  return {
    id: String(r.id), questionId: String(r.question_id), studentName: r.student_name,
    account: r.account || '', answer: r.answer, status: r.status, aiStatus: r.ai_status,
    aiScore: r.ai_score == null ? null : Number(r.ai_score),
    aiBreakdown: Array.isArray(r.ai_breakdown) ? r.ai_breakdown : [],
    aiSummary: r.ai_summary || '', aiDurationMs: r.ai_duration_ms,
    aiModel: r.ai_model, aiError: r.ai_error,
    teacherScore: r.teacher_score == null ? null : Number(r.teacher_score),
    teacherComment: r.teacher_comment || '',
    createdAt: r.created_at, confirmedAt: r.confirmed_at,
  };
}

const Store = {
  async questions() {
    if (!cloudOn()) return db.questions;
    const rows = await cloudFetch('questions?select=*&order=created_at.desc');
    return (rows || []).map(mapQFromCloud);
  },
  async submissions() {
    if (!cloudOn()) return db.submissions;
    const rows = await cloudFetch('submissions?select=*&order=created_at.desc');
    return (rows || []).map(mapSubFromCloud);
  },
  async createQuestion(q) {
    if (cloudOn()) {
      const rows = await cloudFetch('questions', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: { title: q.title, question: q.question, rubric: q.rubric, max_score: q.maxScore, owner_account: q.ownerAccount },
      });
      return mapQFromCloud(rows[0]);
    }
    q.id = nextId('q');
    q.createdAt = new Date().toISOString();
    db.questions.unshift(q);
    saveDb();
    return q;
  },
  async deleteQuestion(q) {
    if (cloudOn()) {
      await cloudFetch('questions?id=eq.' + encodeURIComponent(q.id), { method: 'DELETE' });
      return;
    }
    db.questions = db.questions.filter(x => x.id !== q.id);
    db.submissions = db.submissions.filter(s => s.questionId !== q.id);
    saveDb();
  },
  async createSubmission(sub) {
    if (cloudOn()) {
      const rows = await cloudFetch('submissions', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: {
          question_id: Number(sub.questionId), student_name: sub.studentName,
          account: sub.account || null, answer: sub.answer,
          status: 'pending', ai_status: 'grading',
        },
      });
      return mapSubFromCloud(rows[0]);
    }
    sub.id = nextId('s');
    sub.createdAt = new Date().toISOString();
    db.submissions.unshift(sub);
    saveDb();
    return sub;
  },
  async saveSubmission(sub) {
    if (!cloudOn()) { saveDb(); return sub; }
    await cloudFetch('submissions?id=eq.' + encodeURIComponent(sub.id), {
      method: 'PATCH',
      body: {
        status: sub.status,
        ai_status: sub.aiStatus,
        ai_score: sub.aiScore,
        ai_breakdown: sub.aiBreakdown || [],
        ai_summary: sub.aiSummary || '',
        ai_duration_ms: sub.aiDurationMs == null ? null : Math.round(sub.aiDurationMs),
        ai_model: sub.aiModel || null,
        ai_error: sub.aiError == null ? null : String(sub.aiError),
        teacher_score: sub.teacherScore == null ? null : sub.teacherScore,
        teacher_comment: sub.teacherComment || '',
        confirmed_at: sub.confirmedAt || null,
      },
    });
    return sub;
  },
  async resetOwner(acc) {
    if (!cloudOn()) {
      const mine = new Set(db.questions.filter(q => ownerOf(q) === acc).map(q => q.id));
      db.questions = db.questions.filter(q => !mine.has(q.id));
      db.submissions = db.submissions.filter(s => !mine.has(s.questionId));
      saveDb();
      return mine.size;
    }
    const rows = await cloudFetch('questions?select=id&owner_account=eq.' + encodeURIComponent(acc));
    for (const r of rows || []) {
      await cloudFetch('questions?id=eq.' + encodeURIComponent(r.id), { method: 'DELETE' });
    }
    return (rows || []).length;
  },
};

// ---------------- 账号表（管理员可改教师/学生账号与密码） ----------------
// 实时同步要点：账号数据以云数据库为唯一数据源。
//   · 本实例写入后立即更新缓存（写穿）
//   · 缓存带 TTL，过期后下次读取自动回源云端（感知其他实例/线上端的改动）
//   · 登录、改密等关键校验强制回源，保证密码修改立刻全端生效
const ACCOUNTS_TTL_MS = 3000;          // 缓存有效期 3 秒
let accountsLoadedAt = 0;
let accountsLoading = null;            // 并发去重：多个请求同时回源只发一次

async function loadAccounts(force) {
  if (!cloudOn()) {
    accountsCache.clear();
    try {
      const list = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
      (list || []).forEach(u => accountsCache.set(String(u.account), u));
    } catch (_) {}
    accountsLoadedAt = Date.now();
    return;
  }
  // 缓存仍新鲜且非强制刷新 → 直接用
  if (!force && accountsLoadedAt && Date.now() - accountsLoadedAt < ACCOUNTS_TTL_MS) return;
  if (accountsLoading) return accountsLoading;      // 已有请求在回源，复用它
  accountsLoading = (async () => {
    try {
      const rows = await cloudFetch('accounts?select=account,password,role,disabled');
      const next = new Map();
      (rows || []).forEach(r => next.set(String(r.account), {
        account: String(r.account), password: String(r.password || ''), role: String(r.role || 'student'),
        disabled: !!r.disabled,
      }));
      accountsCache.clear();
      next.forEach((v, k) => accountsCache.set(k, v));
      accountsLoadedAt = Date.now();
    } catch (e) {
      // 回源失败：保留旧缓存继续服务，不把用户挡在门外
      console.error('[accounts] 云端读取失败，沿用缓存:', e.message);
    } finally {
      accountsLoading = null;
    }
  })();
  return accountsLoading;
}

/** 缓存可能已过期时确保拿到最新账号表（读路径统一入口） */
async function ensureAccountsFresh() {
  await loadAccounts(false);
}

function persistAccountsLocal() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = ACCOUNTS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify([...accountsCache.values()], null, 2));
  fs.renameSync(tmp, ACCOUNTS_FILE);
}

/** 写入一行账号（存在则更新，不存在则新增） */
async function upsertAccountRow(rec) {
  const row = { account: rec.account, password: rec.password, role: rec.role, disabled: !!rec.disabled };
  if (cloudOn()) {
    const exists = accountsCache.has(rec.account);
    if (exists) {
      await cloudFetch('accounts?account=eq.' + encodeURIComponent(rec.account), { method: 'PATCH', body: row });
    } else {
      await cloudFetch('accounts', { method: 'POST', headers: { Prefer: 'return=representation' }, body: row });
    }
  }
  accountsCache.set(row.account, row);
  if (!cloudOn()) persistAccountsLocal();
}

/** 账号改名时把名下的题目/提交一起迁到新账号，避免数据丢失 */
async function migrateOwner(oldAccount, newAccount) {
  if (oldAccount === newAccount) return;
  if (cloudOn()) {
    await cloudFetch('questions?owner_account=eq.' + encodeURIComponent(oldAccount), {
      method: 'PATCH', body: { owner_account: newAccount },
    });
    await cloudFetch('submissions?account=eq.' + encodeURIComponent(oldAccount), {
      method: 'PATCH', body: { account: newAccount, student_name: newAccount },
    });
    return;
  }
  db.questions.forEach(q => { if (ownerOf(q) === oldAccount) q.ownerAccount = newAccount; });
  db.submissions.forEach(s => {
    if ((s.account || s.studentName) === oldAccount) { s.account = newAccount; s.studentName = newAccount; }
  });
  saveDb();
}

/** 登录校验：自定义账号优先，其余走默认规则（密码=账号）
 *  fresh=true 时强制回源云端，保证「线上改的密码，本机立刻生效」，反之亦然。 */
async function verifyLogin(acc, pwd, fresh) {
  const a = String(acc || '').trim();
  const p = String(pwd || '').trim();
  if (!a || !p) return { error: '请输入账号和密码' };
  if (fresh) await loadAccounts(true); else await ensureAccountsFresh();
  const custom = accountsCache.get(a);
  if (custom) {
    if (custom.disabled) return { error: '该账号已停用（可能被管理员改名），请联系管理员 99999' };
    if (custom.password !== p) return { error: '密码错误，请检查后重新输入' };
    return { account: a, role: custom.role };
  }
  const role = roleByRule(a);
  if (!role) return { error: '账号不存在，请检查账号是否正确' };
  if (role === 'admin') {
    return p === ADMIN_PASSWORD ? { account: a, role } : { error: '密码错误，请检查后重新输入' };
  }
  return p === a ? { account: a, role } : { error: '密码错误，请检查后重新输入' };
}

// ---------------- 密码重置申请（忘记密码） ----------------
// 流程：教师/学生提交申请 → 管理员在「账号设置」生成 6 位验证码（5 分钟有效）→
// 学生/老师用验证码 + 新密码自助重置；验证码过期则该申请作废，需重新提交申请。
const RESET_TTL_MS = 5 * 60 * 1000;
const REQUESTS_FILE = path.join(DATA_DIR, 'password-requests.json');
let localRequests = [];
let localRequestSeq = 0;

function loadLocalRequests() {
  try { localRequests = JSON.parse(fs.readFileSync(REQUESTS_FILE, 'utf8')) || []; } catch (_) { localRequests = []; }
  if (!Array.isArray(localRequests)) localRequests = [];
  localRequestSeq = localRequests.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0);
}
function saveLocalRequests() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = REQUESTS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(localRequests, null, 2));
  fs.renameSync(tmp, REQUESTS_FILE);
}

function mapRequest(r) {
  return {
    id: String(r.id),
    account: String(r.account || ''),
    role: String(r.role || 'student'),
    status: String(r.status || 'pending'),
    code: r.code || '',
    createdAt: r.created_at || r.createdAt || null,
    expiresAt: r.expires_at || r.expiresAt || null,
  };
}

async function listRequests() {
  if (cloudOn()) {
    const rows = await cloudFetch('password_requests?select=*&order=created_at.desc&limit=100');
    return (rows || []).map(mapRequest);
  }
  return localRequests.slice().sort((a, b) => (b.id > a.id ? 1 : -1)).map(mapRequest);
}

async function insertRequest(rec) {
  if (cloudOn()) {
    const rows = await cloudFetch('password_requests', {
      method: 'POST', headers: { Prefer: 'return=representation' },
      body: { account: rec.account, role: rec.role, status: rec.status, code: rec.code || null, expires_at: rec.expiresAt || null },
    });
    return mapRequest(rows[0]);
  }
  const row = Object.assign({ id: ++localRequestSeq, created_at: new Date().toISOString() }, rec);
  localRequests.push(row);
  saveLocalRequests();
  return mapRequest(row);
}

async function patchRequest(id, patch) {
  const body = {};
  if (patch.status !== undefined) body.status = patch.status;
  if (patch.code !== undefined) body.code = patch.code;
  if (patch.expiresAt !== undefined) body.expires_at = patch.expiresAt;
  body.updated_at = new Date().toISOString();
  if (cloudOn()) {
    await cloudFetch('password_requests?id=eq.' + encodeURIComponent(id), { method: 'PATCH', body });
    return;
  }
  const row = localRequests.find(r => String(r.id) === String(id));
  if (!row) return;
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.code !== undefined) row.code = patch.code;
  if (patch.expiresAt !== undefined) row.expires_at = patch.expiresAt;
  row.updated_at = body.updated_at;
  saveLocalRequests();
}

const isExpired = r => !!r.expiresAt && new Date(r.expiresAt).getTime() < Date.now();
const requestView = r => ({
  id: r.id, account: r.account, role: r.role, status: r.status, code: r.code,
  createdAt: r.createdAt, expiresAt: r.expiresAt,
  remainingSec: r.expiresAt ? Math.max(0, Math.round((new Date(r.expiresAt).getTime() - Date.now()) / 1000)) : 0,
});

/** 设置/修改密码（统一走 accounts 表，覆盖默认规则） */
async function setPassword(account, password) {
  const role = roleOfAccount(account);
  if (!role) throw new Error('账号不存在');
  await upsertAccountRow({ account, password, role, disabled: false });
}

// ---------------- 设置 ----------------
let settings = { llm: null }; // { baseUrl, endpoint, apiKey, model, stream, provider }

function loadSettings() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(SETTINGS_FILE)) {
    try { settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) || { llm: null }; }
    catch (e) { console.error('[settings] 读取失败:', e.message); }
  }
  if (!settings.llm) settings.llm = null;
}
function saveSettings() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = SETTINGS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
  fs.renameSync(tmp, SETTINGS_FILE);
}

// 常见 OpenAI 兼容服务预设，便于换电脑后一键填好
const PRESETS = [
  { id: 'deepseek', label: 'DeepSeek（深度求索）', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', note: '国内直连，性价比高，需在 platform.deepseek.com 申请 Key' },
  { id: 'dashscope', label: '通义千问（阿里云百炼）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', note: '阿里云控制台申请 Key' },
  { id: 'moonshot', label: 'Kimi（月之暗面）', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', note: 'platform.moonshot.cn 申请 Key' },
  { id: 'zhipu', label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus', note: 'open.bigmodel.cn 申请 Key' },
  { id: 'siliconflow', label: '硅基流动 SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct', note: '聚合多种开源模型' },
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', note: '需可访问外网' },
  { id: 'ollama', label: '本地 Ollama（无需联网/无需 Key）', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b', note: '需先在本机运行 ollama serve 并 pull 模型，API Key 随意填' },
  { id: 'custom', label: '自定义 / 其他兼容接口', baseUrl: '', model: '', note: '只要兼容 OpenAI 的 /chat/completions 协议即可' },
];

/** 把 Base URL 规范化成完整的 chat/completions 地址 */
function toChatEndpoint(base) {
  const b = String(base || '').trim().replace(/\/+$/, '');
  if (!b) return '';
  if (/\/chat\/completions$/.test(b)) return b;
  return b + '/chat/completions';
}
function hostOf(url) {
  try { const u = new URL(url); return u.host; } catch (_) { return url; }
}

/** 解析当前生效的 AI 服务配置；返回 null 表示未配置 */
function resolveLLM() {
  const s = settings.llm;
  if (s && s.baseUrl && s.model) {
    return {
      source: 'settings', label: s.provider || '自定义',
      endpoint: s.endpoint || toChatEndpoint(s.baseUrl),
      apiKey: s.apiKey || '', model: s.model, headers: {},
      stream: s.stream !== false,
    };
  }
  const base = process.env.AI_BASE_URL || process.env.OPENAI_BASE_URL;
  const key = process.env.AI_API_KEY || process.env.OPENAI_API_KEY;
  const model = process.env.AI_MODEL || process.env.OPENAI_MODEL;
  if (base && model) {
    return { source: 'env', label: '环境变量', endpoint: toChatEndpoint(base), apiKey: key || '', model, headers: {}, stream: true };
  }
  if (process.env.WORKBUDDY_VLM_CHAT_URL && process.env.WORKBUDDY_VLM_AUTH_TOKEN) {
    return {
      source: 'workbuddy', label: '本机 WorkBuddy 网关',
      endpoint: process.env.WORKBUDDY_VLM_CHAT_URL,
      apiKey: process.env.WORKBUDDY_VLM_AUTH_TOKEN,
      model: process.env.WORKBUDDY_VLM_MODEL || 'kinfra-office-agent',
      headers: { 'X-WorkBuddy-MCP-Context': process.env.WORKBUDDY_VLM_CONTEXT || '' },
      stream: true,
    };
  }
  return null;
}

// ---------------- LLM 调用 ----------------
function buildHeaders(cfg) {
  const h = { 'Content-Type': 'application/json' };
  Object.assign(h, cfg.headers || {});
  if (cfg.apiKey) h['Authorization'] = 'Bearer ' + cfg.apiKey;
  return h;
}

/** 单次请求（stream 或非 stream），返回聚合后的文本 */
async function requestOnce(cfg, messages, stream, timeoutMs) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('AI 请求超时（' + Math.round(timeoutMs / 1000) + ' 秒）')), timeoutMs);
  try {
    const res = await fetch(cfg.endpoint, {
      method: 'POST',
      headers: buildHeaders(cfg),
      body: JSON.stringify({ model: cfg.model, messages, stream }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error('AI 服务返回 HTTP ' + res.status + '：' + text.slice(0, 300));
    }
    const ctype = res.headers.get('content-type') || '';
    let content = '', usage = null, model = cfg.model;

    if (/text\/event-stream/.test(ctype)) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line.startsWith('data:')) continue;      // 跳过 ": heartbeat" 等
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const j = JSON.parse(payload);
            if (j.model) model = j.model;
            const d = j.choices && j.choices[0] && (j.choices[0].delta || {});
            if (typeof d.content === 'string') content += d.content;
            if (j.usage) usage = j.usage;
          } catch (_) { /* 忽略无法解析的行 */ }
        }
      }
    } else {
      const j = await res.json();
      model = j.model || model;
      usage = j.usage || null;
      const c = j.choices && j.choices[0];
      content = (c && ((c.message && c.message.content) || c.text)) || '';
      if (typeof content !== 'string') content = JSON.stringify(content);
    }

    if (!content.trim()) throw new Error('AI 返回内容为空');
    return { content, usage, elapsedMs: Date.now() - t0, model };
  } finally {
    clearTimeout(timer);
  }
}

/** 带智能重试的调用：
 *  - 服务商不支持当前流式模式 → 换另一种模式重试
 *  - 瞬时故障（空响应 / 超时 / 网络抖动 / 5xx）→ 同模式再试一次
 *  - 其他错误（如 401 鉴权失败、404 地址错误）→ 直接抛出，不做无意义重试
 */
async function callLLM(messages, timeoutMs = 180000, cfgOverride) {
  const cfg = cfgOverride || resolveLLM();
  if (!cfg) {
    throw new Error('尚未配置 AI 服务：请打开「设置」页填写服务地址、API Key 和模型，或设置环境变量 AI_BASE_URL / AI_API_KEY / AI_MODEL');
  }
  const primary = cfg.stream !== false;
  let firstErr = null;

  try {
    return await requestOnce(cfg, messages, primary, timeoutMs);
  } catch (e) {
    firstErr = e;
  }

  const msg = String(firstErr.message || '');
  const streamUnsupported = /non-?stream|stream[\s\S]{0,30}(not supported|不支持)|不支持[\s\S]{0,10}流式/i.test(msg);
  const transient = /为空|超时|aborted|fetch failed|network|ECONN|socket hang|HTTP 5\d\d/i.test(msg);

  let retryStream = null;
  if (streamUnsupported) retryStream = !primary;      // 换模式
  else if (transient) retryStream = primary;          // 同模式重试

  if (retryStream === null) throw firstErr;

  await new Promise(r => setTimeout(r, 400));
  try {
    return await requestOnce(cfg, messages, retryStream, timeoutMs);
  } catch (e2) {
    // 两次错误不同时，把首次错误一并带上，避免降级重试掩盖真实原因
    const m2 = String(e2.message || '');
    if (!streamUnsupported && m2 !== msg) {
      throw new Error(msg + '（重试后仍失败：' + m2 + '）');
    }
    throw e2;
  }
}

// ---------------- 判分 ----------------
function buildGradePrompt(q, answer) {
  const rubric = (q.rubric || '').trim();
  return [
    '你是一名严谨、公正的阅卷老师，正在批改学生提交的主观题答案。',
    '你必须严格依据给定的评分标准逐条评分：有则给分、无则扣分，理由要引用学生答案中的具体内容作为证据，不得凭印象打分。',
    '',
    '# 题目',
    q.question,
    '',
    '# 评分标准（满分 ' + q.maxScore + ' 分）',
    rubric,
    '',
    '# 学生答案',
    answer,
    '',
    '# 输出要求',
    '只输出一个 JSON 对象，不要输出任何解释文字，不要使用 markdown 代码块。格式：',
    '{"total": 总分数字, "breakdown": [{"criterion": "评分标准条目", "score": 该条得分, "max": 该条满分, "comment": "该条评分理由，须引用答案原文作为依据"}], "summary": "总体评价 2~3 句：先说优点，再说主要失分点"}',
    '要求：breakdown 必须覆盖评分标准的每一条；total 等于 breakdown 各条得分之和；总分不得超过 ' + q.maxScore + '，可以为小数（精确到 0.5）。',
  ].join('\n');
}

function extractJson(text) {
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const s = t.indexOf('{');
  const e = t.lastIndexOf('}');
  if (s >= 0 && e > s) t = t.slice(s, e + 1);
  return JSON.parse(t);
}

function round05(x) { return Math.round(x * 2) / 2; }

async function gradeSubmission(sub, q) {
  sub.aiStatus = 'grading';
  await Store.saveSubmission(sub);
  try {
    const { content, elapsedMs, usage, model } = await callLLM([
      { role: 'system', content: '你是一名严格依据评分标准阅卷的老师，只输出 JSON。' },
      { role: 'user', content: buildGradePrompt(q, sub.answer) },
    ]);
    let parsed;
    try {
      parsed = extractJson(content);
    } catch (e) {
      throw new Error('AI 返回内容无法解析为评分 JSON：' + content.slice(0, 200));
    }
    const max = Number(q.maxScore) || 100;
    let total = Number(parsed.total);
    if (!isFinite(total)) throw new Error('AI 返回的 total 不是数字');
    total = Math.min(max, Math.max(0, round05(total)));
    const breakdown = Array.isArray(parsed.breakdown) ? parsed.breakdown.map(b => ({
      criterion: String(b.criterion || ''),
      score: Number(b.score) || 0,
      max: Number(b.max) || 0,
      comment: String(b.comment || ''),
    })) : [];
    sub.aiScore = total;
    sub.aiBreakdown = breakdown;
    sub.aiSummary = String(parsed.summary || '');
    sub.aiDurationMs = elapsedMs;
    sub.aiModel = model;
    sub.aiTokens = usage ? { prompt: usage.prompt_tokens, completion: usage.completion_tokens, total: usage.total_tokens } : null;
    sub.aiError = null;
    sub.aiGradedAt = new Date().toISOString();
    sub.aiStatus = 'done';
    if (sub.status !== 'confirmed') sub.status = 'ai_graded';
  } catch (e) {
    sub.aiStatus = 'failed';
    sub.aiError = String(e.message || e);
  }
  await Store.saveSubmission(sub);
  return sub;
}

// ---------------- HTTP 基础 ----------------
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}

/** 供前端展示的 AI 服务状态（不泄露 API Key） */
function llmInfo() {
  const cfg = resolveLLM();
  if (!cfg) return { configured: false, presets: PRESETS };
  return {
    configured: true,
    presets: PRESETS,
    source: cfg.source,               // settings / env / workbuddy
    label: cfg.label,
    model: cfg.model,
    endpointHost: hostOf(cfg.endpoint),
    hasApiKey: !!cfg.apiKey,
    savedBaseUrl: (settings.llm && settings.llm.baseUrl) || '',
    savedModel: (settings.llm && settings.llm.model) || '',
    savedStream: settings.llm ? settings.llm.stream !== false : true,
    savedProvider: (settings.llm && settings.llm.provider) || '',
  };
}

// ---------------- API 路由 ----------------
async function handleApi(req, res, pathname) {
  // ---- 登录（服务端校验账号密码，支持管理员改过的账号） ----
  if (req.method === 'POST' && pathname === '/api/login') {
    const b = await readBody(req, 8 * 1024);
    const r = await verifyLogin(b.account, b.password, true);   // 登录强制回源：密码改动立即全端生效
    if (r.error) return sendJson(res, 401, { error: r.error });
    const label = r.role === 'admin' ? '管理员 ' : (r.role === 'teacher' ? '教师 ' : '学生 ');
    return sendJson(res, 200, { account: r.account, role: r.role, name: label + r.account });
  }

  // ---- 密码：自助修改 / 忘记密码（申请 → 验证码 → 重置） ----
  const pwdCheck = p => {
    const s = String(p || '');
    if (s.length < 4 || s.length > 32) return '新密码需为 4–32 个字符';
    return '';
  };

  if (req.method === 'POST' && pathname === '/api/password/change') {
    const acc = accountOf(req);
    if (!acc) return sendJson(res, 401, { error: '请先登录' });
    const b = await readBody(req, 8 * 1024);
    const oldPwd = String(b.oldPassword || '');
    const newPwd = String(b.newPassword || '');
    const v = await verifyLogin(acc, oldPwd, true);
    if (v.error) return sendJson(res, 403, { error: '原密码不正确' });
    const pe = pwdCheck(newPwd);
    if (pe) return sendJson(res, 400, { error: pe });
    if (newPwd === oldPwd) return sendJson(res, 400, { error: '新密码不能和原密码相同' });
    try { await setPassword(acc, newPwd); }
    catch (e) { return sendJson(res, 502, { error: '保存失败：' + e.message }); }
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'POST' && pathname === '/api/password/forgot') {
    const b = await readBody(req, 8 * 1024);
    const account = String(b.account || '').trim();
    const role = roleOfAccount(account);
    if (!role) return sendJson(res, 404, { error: '账号不存在，请核对后再试' });
    if (role === 'admin') return sendJson(res, 400, { error: '管理员请登录后在「账号设置」里修改密码' });
    let all;
    try { all = await listRequests(); }
    catch (e) { return sendJson(res, 502, { error: '申请提交失败：' + e.message }); }
    const active = all.find(r => r.account === account && (r.status === 'pending' || (r.status === 'issued' && !isExpired(r))));
    if (active) return sendJson(res, 200, { ok: true, reused: true, request: requestView(active) });
    let created;
    try { created = await insertRequest({ account, role, status: 'pending', code: '', expiresAt: null }); }
    catch (e) { return sendJson(res, 502, { error: '申请提交失败：' + e.message }); }
    return sendJson(res, 200, { ok: true, request: requestView(created) });
  }

  if (req.method === 'GET' && pathname === '/api/password/requests') {
    const acc = accountOf(req);
    if (!acc) return sendJson(res, 401, { error: '请先登录' });
    if (roleOfAccount(acc) !== 'admin') return sendJson(res, 403, { error: '只有管理员可以查看密码重置申请' });
    let all;
    try { all = await listRequests(); }
    catch (e) { return sendJson(res, 502, { error: '读取失败：' + e.message }); }
    for (const r of all) {
      if (r.status === 'issued' && isExpired(r)) { r.status = 'expired'; await patchRequest(r.id, { status: 'expired' }); }
    }
    return sendJson(res, 200, {
      active: all.filter(r => r.status === 'pending' || r.status === 'issued').map(requestView),
      recent: all.filter(r => r.status === 'used' || r.status === 'expired').slice(0, 10).map(requestView),
    });
  }

  if (req.method === 'POST' && pathname === '/api/password/issue') {
    const acc = accountOf(req);
    if (!acc) return sendJson(res, 401, { error: '请先登录' });
    if (roleOfAccount(acc) !== 'admin') return sendJson(res, 403, { error: '只有管理员可以生成验证码' });
    const b = await readBody(req, 8 * 1024);
    const id = String(b.id || '');
    const all = await listRequests();
    const r = all.find(x => String(x.id) === id);
    if (!r) return sendJson(res, 404, { error: '申请不存在' });
    if (r.status === 'used') return sendJson(res, 400, { error: '该申请已使用完成' });
    if (r.status === 'issued' && !isExpired(r)) {
      return sendJson(res, 200, { ok: true, reused: true, code: r.code, expiresAt: r.expiresAt, remainingSec: requestView(r).remainingSec });
    }
    if (r.status === 'issued' && isExpired(r)) {
      await patchRequest(r.id, { status: 'expired' });
      return sendJson(res, 400, { error: '验证码已过期，需要让对方重新提交申请' });
    }
    if (r.status !== 'pending') return sendJson(res, 400, { error: '该申请状态不可生成验证码' });
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = new Date(Date.now() + RESET_TTL_MS).toISOString();
    await patchRequest(r.id, { status: 'issued', code, expiresAt });
    return sendJson(res, 200, { ok: true, code, expiresAt, remainingSec: Math.round(RESET_TTL_MS / 1000), account: r.account });
  }

  if (req.method === 'POST' && pathname === '/api/password/reset') {
    const b = await readBody(req, 8 * 1024);
    const account = String(b.account || '').trim();
    const code = String(b.code || '').trim();
    const newPwd = String(b.password || '');
    if (!account || !code) return sendJson(res, 400, { error: '请填写账号和验证码' });
    const pe = pwdCheck(newPwd);
    if (pe) return sendJson(res, 400, { error: pe });
    let all;
    try { all = await listRequests(); }
    catch (e) { return sendJson(res, 502, { error: '重置失败：' + e.message }); }
    const mine = all.filter(r => r.account === account);
    const hit = mine.find(r => r.status === 'issued' && r.code === code && !isExpired(r));
    if (!hit) {
      const expiredSame = mine.find(r => r.code && r.code === code && isExpired(r));
      const hasIssued = mine.some(r => r.status === 'issued');
      return sendJson(res, 400, {
        error: expiredSame
          ? '验证码已过期（有效期 5 分钟），请重新提交申请'
          : (hasIssued ? '验证码不正确，请核对管理员发来的 6 位数字'
                       : '还没有生成验证码或申请已失效，请重新提交申请'),
      });
    }
    try { await setPassword(account, newPwd); }
    catch (e) { return sendJson(res, 502, { error: '保存失败：' + e.message }); }
    await patchRequest(hit.id, { status: 'used' });
    return sendJson(res, 200, { ok: true, account });
  }

  // ---- 账号管理（仅管理员 99999） ----
  if (req.method === 'GET' && pathname === '/api/accounts') {
    const acc = accountOf(req);
    if (!acc) return sendJson(res, 401, { error: '请先登录' });
    if (roleOfAccount(acc) !== 'admin') return sendJson(res, 403, { error: '只有管理员账号可以管理账号' });
    await loadAccounts(true);   // 管理页强制回源，看到的永远是最新账号与密码
    let qs, subs;
    try { qs = await Store.questions(); subs = await Store.submissions(); }
    catch (e) { return sendJson(res, 502, { error: '云端数据读取失败：' + e.message }); }
    const qCount = new Map();
    qs.forEach(q => qCount.set(ownerOf(q), (qCount.get(ownerOf(q)) || 0) + 1));
    const sCount = new Map();
    subs.forEach(s => { const k = s.account || s.studentName; sCount.set(k, (sCount.get(k) || 0) + 1); });

    const build = role => {
      const seen = new Set();
      const out = [];
      const push = a => {
        if (!a || seen.has(a)) return;
        seen.add(a);
        const c = accountsCache.get(a);
        if (c && c.disabled) return;
        out.push({
          account: a,
          password: c ? c.password : a,
          custom: !!c,
          questions: role === 'teacher' ? (qCount.get(a) || 0) : undefined,
          submissions: sCount.get(a) || 0,
        });
      };
      if (role === 'teacher') { for (let i = AUTH.teacher.from; i <= AUTH.teacher.to; i++) push(String(i).padStart(5, '0')); }
      else { for (let i = AUTH.student.from; i <= AUTH.student.to; i++) push(String(i)); }
      [...accountsCache.values()].forEach(c => { if (c.role === role) push(c.account); });
      return out.sort((a, b) => String(a.account).localeCompare(String(b.account)));
    };
    return sendJson(res, 200, { teachers: build('teacher'), students: build('student'), admin: ADMIN_ACCOUNT });
  }

  if (req.method === 'POST' && pathname === '/api/accounts/update') {
    const acc = accountOf(req);
    if (!acc) return sendJson(res, 401, { error: '请先登录' });
    if (roleOfAccount(acc) !== 'admin') return sendJson(res, 403, { error: '只有管理员账号可以修改账号' });
    const b = await readBody(req, 8 * 1024);
    const oldAccount = String(b.oldAccount || '').trim();
    const account = String(b.account || oldAccount).trim();
    const password = String(b.password == null ? '' : b.password).trim();
    const role = roleOfAccount(oldAccount);
    if (!role) return sendJson(res, 404, { error: '账号不存在：' + oldAccount });
    if (!/^[0-9A-Za-z]{3,12}$/.test(account)) return sendJson(res, 400, { error: '账号只能由 3–12 位字母或数字组成' });
    if (role === 'admin' && account !== ADMIN_ACCOUNT) return sendJson(res, 400, { error: '管理员账号固定为 ' + ADMIN_ACCOUNT + '，不能改名' });
    if (account !== oldAccount) {
      if (account === ADMIN_ACCOUNT) return sendJson(res, 400, { error: '该账号为管理员保留账号' });
      if (roleOfAccount(account)) return sendJson(res, 409, { error: '账号 ' + account + ' 已被占用' });
    }
    const pwd = password || (accountsCache.has(oldAccount) ? accountsCache.get(oldAccount).password : oldAccount);
    if (!pwd) return sendJson(res, 400, { error: '密码不能为空' });
    try {
      if (account !== oldAccount) {
        await upsertAccountRow({ account, password: pwd, role, disabled: false });
        await upsertAccountRow({ account: oldAccount, password: '', role, disabled: true });
        await migrateOwner(oldAccount, account);
      } else {
        await upsertAccountRow({ account, password: pwd, role, disabled: false });
      }
    } catch (e) {
      return sendJson(res, 502, { error: '保存失败：' + e.message });
    }
    return sendJson(res, 200, { ok: true, account, role });
  }

  if (req.method === 'GET' && pathname === '/api/state') {
    const acc = accountOf(req);
    if (!acc) return sendJson(res, 401, { error: '请先登录' });
    const cfg = resolveLLM();
    const role = roleOfAccount(acc);
    const isTeacher = role === 'teacher';
    // 教师：只返回自己出的题目和自己的判分记录；学生：可看到全部题目，只返回自己的提交
    let questions, submissions;
    try {
      questions = await Store.questions();
      submissions = await Store.submissions();
    } catch (e) {
      return sendJson(res, 502, { error: '云端数据读取失败：' + e.message + '（检查本机网络或 data/cloud.json）' });
    }
    if (role === 'admin') {
      // 管理员只做账号与 AI 设置，不参与出题判分
      questions = [];
      submissions = [];
    } else if (isTeacher) {
      questions = questions.filter(q => ownerOf(q) === acc);
      const ids = new Set(questions.map(q => q.id));
      submissions = submissions.filter(s => ids.has(s.questionId));
    } else {
      // 学生只看自己的提交：以登录账号为准，兼容历史数据（无 account 时比对姓名）
      submissions = submissions.filter(s => s.account ? s.account === acc : s.studentName === acc);
    }
    return sendJson(res, 200, {
      // owner 与云端 owner_account 对齐，前端统一读 owner
      questions: questions.map(q => Object.assign({}, q, { owner: ownerOf(q) })),
      submissions,
      viewer: { account: acc, role: role },
      storage: cloudOn() ? 'cloud' : 'local',
      llmConfigured: !!cfg,
      llmLabel: cfg ? cfg.label : '',
      llmModel: cfg ? cfg.model : '',
    });
  }

  // ---- 访问地址信息（给「设置」页展示，方便分发给其他电脑） ----
  if (req.method === 'GET' && pathname === '/api/info') {
    const lan = HOST === '0.0.0.0' ? lanAddresses() : [];
    const fwdHost = req.headers['x-forwarded-host'] || req.headers.host || ('127.0.0.1:' + activePort);
    const fwdProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0] || 'http';
    return sendJson(res, 200, {
      port: activePort,
      host: HOST,
      lanAllowed: HOST === '0.0.0.0',
      currentUrl: fwdProto + '://' + fwdHost,
      localUrl: 'http://127.0.0.1:' + activePort,
      lanUrls: lan.map(a => 'http://' + a + ':' + activePort),
      platform: process.platform,
      storage: cloudOn() ? 'cloud' : 'local',
      cloudEndpoint: cloudOn() ? cloudCfg.endpoint : '',
    });
  }

  // ---- 设置 ----
  if (req.method === 'GET' && pathname === '/api/settings') {
    return sendJson(res, 200, llmInfo());
  }

  if (req.method === 'POST' && pathname === '/api/settings') {
    const who = accountOf(req);
    if (!who) return sendJson(res, 401, { error: '请先登录' });
    if (roleOfAccount(who) !== 'admin') return sendJson(res, 403, { error: '只有管理员账号可以修改 AI 服务设置' });
    const b = await readBody(req, 64 * 1024);
    const baseUrl = String(b.baseUrl || '').trim();
    if (!baseUrl) {           // 清空 = 恢复自动检测
      settings.llm = null; saveSettings();
      return sendJson(res, 200, llmInfo());
    }
    const model = String(b.model || '').trim();
    if (!model) return sendJson(res, 400, { error: '请填写模型名称' });
    let apiKey = b.apiKey === undefined ? null : String(b.apiKey);
    if (apiKey === null || apiKey === '') apiKey = (settings.llm && settings.llm.apiKey) || ''; // 留空表示不修改
    settings.llm = {
      provider: String(b.provider || '').trim(),
      baseUrl,
      endpoint: toChatEndpoint(baseUrl),
      apiKey,
      model,
      stream: b.stream !== false,
    };
    saveSettings();
    return sendJson(res, 200, llmInfo());
  }

  if (req.method === 'POST' && pathname === '/api/settings/test') {
    const b = await readBody(req, 64 * 1024);
    let cfg;
    if (b.baseUrl && b.model) {           // 测试页面上尚未保存的配置
      const key = (b.apiKey && String(b.apiKey)) || (settings.llm && settings.llm.apiKey) || '';
      cfg = { source: 'test', label: '测试', endpoint: toChatEndpoint(b.baseUrl), apiKey: key, model: b.model, headers: {}, stream: b.stream !== false };
    } else {
      cfg = resolveLLM();
      if (!cfg) return sendJson(res, 400, { ok: false, error: '尚未配置 AI 服务' });
    }
    try {
      const r = await callLLM([{ role: 'user', content: '请只回复四个字：连接成功' }], 60000, cfg);
      return sendJson(res, 200, { ok: true, reply: r.content.trim().slice(0, 100), model: r.model, elapsedMs: r.elapsedMs });
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: String(e.message || e) });
    }
  }

  // ---- 题目 ----
  if (req.method === 'POST' && pathname === '/api/questions') {
    const acc = accountOf(req);
    if (!acc) return sendJson(res, 401, { error: '请先登录' });
    if (roleOfAccount(acc) !== 'teacher') return sendJson(res, 403, { error: '只有教师账号可以出题' });
    const b = await readBody(req, 1024 * 1024);
    const title = String(b.title || '').trim();
    const question = String(b.question || '').trim();
    const rubric = String(b.rubric || '').trim();
    const maxScore = Math.min(1000, Math.max(1, Number(b.maxScore) || 100));
    if (!title || !question || !rubric) return sendJson(res, 400, { error: '题目标题、题目内容和评分标准均不能为空' });
    const q = {
      title, question, rubric, maxScore,
      ownerAccount: acc,            // 出题教师：只有本人能看到和更改
    };
    try {
      const saved = await Store.createQuestion(q);
      return sendJson(res, 200, { question: saved });
    } catch (e) {
      return sendJson(res, 502, { error: '题目保存失败：' + e.message });
    }
  }

  let m = pathname.match(/^\/api\/questions\/([\w-]+)$/);
  if (req.method === 'DELETE' && m) {
    const acc = accountOf(req);
    if (!acc) return sendJson(res, 401, { error: '请先登录' });
    if (roleOfAccount(acc) !== 'teacher') return sendJson(res, 403, { error: '只有教师账号可以删除题目' });
    const id = m[1];
    let all;
    try { all = await Store.questions(); } catch (e) { return sendJson(res, 502, { error: '云端数据读取失败：' + e.message }); }
    const target = all.find(q => q.id === id);
    if (!target) return sendJson(res, 404, { error: '题目不存在' });
    if (ownerOf(target) !== acc) return sendJson(res, 403, { error: '这是其他教师发布的题目，你无权删除' });
    try {
      await Store.deleteQuestion(target);   // 云端外键为级联删除，提交记录一并清掉
      return sendJson(res, 200, { removed: 1 });
    } catch (e) {
      return sendJson(res, 502, { error: '删除失败：' + e.message });
    }
  }

  // ---- 提交与判分 ----
  if (req.method === 'POST' && pathname === '/api/submissions') {
    const acc = accountOf(req);
    if (!acc) return sendJson(res, 401, { error: '请先登录' });
    const b = await readBody(req, 1024 * 1024);
    let allQ;
    try { allQ = await Store.questions(); } catch (e) { return sendJson(res, 502, { error: '云端数据读取失败：' + e.message }); }
    const q = allQ.find(x => x.id === String(b.questionId));
    if (!q) return sendJson(res, 400, { error: '题目不存在' });
    // 提交记录归属出题教师；学生端姓名默认用登录账号
    const studentName = String(b.studentName || '').trim() || acc;
    const answer = String(b.answer || '').trim();
    if (!answer) return sendJson(res, 400, { error: '答案不能为空' });
    let sub;
    try {
      sub = await Store.createSubmission({
        questionId: q.id, studentName, account: acc, answer,
        ownerAccount: ownerOf(q),    // 判分记录归出题教师
        status: 'pending',           // pending -> ai_graded -> confirmed
        aiStatus: 'pending',         // pending / grading / done / failed
        aiScore: null, aiBreakdown: [], aiSummary: '', aiDurationMs: null,
        teacherScore: null, teacherComment: '', confirmedAt: null,
      });
    } catch (e) {
      return sendJson(res, 502, { error: '提交保存失败：' + e.message });
    }
    await gradeSubmission(sub, q);
    return sendJson(res, 200, { submission: sub });
  }

  m = pathname.match(/^\/api\/submissions\/([\w-]+)\/grade$/);
  if (req.method === 'POST' && m) {
    const acc = accountOf(req);
    if (!acc) return sendJson(res, 401, { error: '请先登录' });
    if (roleOfAccount(acc) !== 'teacher') return sendJson(res, 403, { error: '只有教师账号可以判分' });
    let subs, allQ;
    try { subs = await Store.submissions(); allQ = await Store.questions(); } catch (e) { return sendJson(res, 502, { error: '云端数据读取失败：' + e.message }); }
    const sub = subs.find(x => x.id === m[1]);
    if (!sub) return sendJson(res, 404, { error: '提交不存在' });
    const q = allQ.find(x => x.id === sub.questionId);
    if (!q) return sendJson(res, 400, { error: '对应题目已被删除' });
    if (ownerOf(q) !== acc) return sendJson(res, 403, { error: '这是其他教师题目下的提交，你无权判分' });
    await gradeSubmission(sub, q);
    return sendJson(res, 200, { submission: sub });
  }

  m = pathname.match(/^\/api\/submissions\/([\w-]+)\/confirm$/);
  if (req.method === 'POST' && m) {
    const acc = accountOf(req);
    if (!acc) return sendJson(res, 401, { error: '请先登录' });
    if (roleOfAccount(acc) !== 'teacher') return sendJson(res, 403, { error: '只有教师账号可以确认成绩' });
    let subs, allQ;
    try { subs = await Store.submissions(); allQ = await Store.questions(); } catch (e) { return sendJson(res, 502, { error: '云端数据读取失败：' + e.message }); }
    const sub = subs.find(x => x.id === m[1]);
    if (!sub) return sendJson(res, 404, { error: '提交不存在' });
    const q = allQ.find(x => x.id === sub.questionId);
    const owner = sub.ownerAccount || (q ? ownerOf(q) : LEGACY_OWNER);
    if (owner !== acc) return sendJson(res, 403, { error: '这是其他教师题目下的提交，你无权改分' });
    const b = await readBody(req, 64 * 1024);
    const max = q ? q.maxScore : 100;
    let score = Number(b.teacherScore);
    if (!isFinite(score)) return sendJson(res, 400, { error: '分数必须是数字' });
    score = Math.min(max, Math.max(0, round05(score)));
    sub.teacherScore = score;
    sub.teacherComment = String(b.teacherComment || '').trim();
    sub.status = 'confirmed';
    sub.confirmedAt = new Date().toISOString();
    try { await Store.saveSubmission(sub); } catch (e) { return sendJson(res, 502, { error: '成绩保存失败：' + e.message }); }
    return sendJson(res, 200, { submission: sub });
  }

  if (req.method === 'POST' && pathname === '/api/reset') {
    const acc = accountOf(req);
    if (!acc) return sendJson(res, 401, { error: '请先登录' });
    if (roleOfAccount(acc) !== 'teacher') return sendJson(res, 403, { error: '只有教师账号可以重置数据' });
    // 危险操作：启用云端存储后会真的删掉云端数据，必须显式确认
    const b = await readBody(req, 8 * 1024).catch(() => ({}));
    if (!b || b.confirm !== 'DELETE_MINE') {
      return sendJson(res, 400, {
        error: '危险操作：这会删除你名下的全部题目与判分记录，确认请传 {"confirm":"DELETE_MINE"}',
      });
    }
    // 只清空自己的题目与判分记录，不影响其他教师
    try {
      const removed = await Store.resetOwner(acc);
      return sendJson(res, 200, { ok: true, removed, storage: cloudOn() ? 'cloud' : 'local' });
    } catch (e) {
      return sendJson(res, 502, { error: '重置失败：' + e.message });
    }
  }

  return sendJson(res, 404, { error: '接口不存在' });
}

// ---------------- 静态文件 ----------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>页面不存在 · 智慧判</title></head>' +
    '<body style="font-family:system-ui,-apple-system,sans-serif;padding:56px 24px;text-align:center;color:#222">' +
    '<h1 style="font-size:20px;margin:0 0 10px">页面不存在</h1>' +
    '<p style="color:#666;font-size:14px;margin:0 0 18px">这个地址在系统里没有对应的页面。</p>' +
    '<p><a href="/" style="color:#2563eb;font-size:14px">返回 智慧判首页</a></p>' +
    '</body></html>');
}

/**
 * 前端运行时配置：/cloud-config.js 由服务端动态生成。
 * 这样 endpoint / publishableKey 只存在于运行环境的配置里（env 或 data/cloud.json），
 * 仓库里的代码没有任何密钥字面量；未配置时前端会退回本机 /api 存储。
 */
function serveCloudConfig(res) {
  const c = cloudCfg || {};
  const cfg = {
    endpoint: c.endpoint || '',
    oauthRelayBaseUrl: c.oauthRelayBaseUrl || 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
    publishableKey: c.publishableKey || '',
  };
  const body = '/* 由 server.js 运行时生成，内容取决于环境变量或 data/cloud.json，请勿写入密钥 */\n' +
    'window.CLOUD_PUBLIC_CONFIG = ' + JSON.stringify(cfg, null, 2) + ';\n' +
    'window.CLOUD_SDK_URL = ' + JSON.stringify(process.env.CLOUD_SDK_URL ||
      'https://cdn.jsdelivr.net/npm/@tencent-ai/workbuddy-cloud-sdk@dev/lib/index.global.js') + ';\n';
  res.writeHead(200, {
    'Content-Type': 'application/javascript; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function serveStatic(res, pathname) {
  let rel;
  try { rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1)); }
  catch (_) { return notFound(res); }
  if (rel === 'favicon.ico') { res.writeHead(204); return res.end(); }
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (!err) {
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      return res.end(data);
    }
    // 不带扩展名的路径（如 /teacher、/login）按单页应用处理，回退到首页，
    // 避免用户看到的是一行 Not Found
    if (!path.extname(rel)) {
      return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, html) => {
        if (e2) return notFound(res);
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(html);
      });
    }
    notFound(res);
  });
}

// ---------------- 启动 ----------------
function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const i of ifaces[name] || []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
  }
  return out;
}

function start(port, attempt) {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    // 访问不到时把真实路径打到控制台，方便排查「Not Found」是哪个地址引起的
    res.on('finish', () => {
      if (res.statusCode >= 400) {
        console.log('[访问异常] ' + res.statusCode + ' ' + req.method + ' ' + req.url);
      }
    });
    if (pathname.startsWith('/api/')) {
      handleApi(req, res, pathname).catch(e => {
        console.error('[api]', e);
        if (!res.headersSent) sendJson(res, 500, { error: e.message || '服务器内部错误' });
      });
      return;
    }
    if (pathname === '/cloud-config.js') { serveCloudConfig(res); return; }
    serveStatic(res, pathname);
  });

  server.on('error', e => {
    if (e.code === 'EADDRINUSE' && attempt < 10) {
      console.warn('[智慧判] 端口 ' + port + ' 被占用，尝试 ' + (port + 1) + ' …');
      start(port + 1, attempt + 1);
      return;
    }
    console.error('[智慧判] 启动失败：', e.message);
    process.exit(1);
  });

  server.listen(port, HOST, () => {
    activePort = port;
    const cfg = resolveLLM();
    const lan = lanAddresses();
    console.log('==================================================');
    console.log(' 智慧判 已启动');
    console.log(' 本机访问:     http://127.0.0.1:' + port);
    if (HOST === '0.0.0.0') {
      if (lan.length) {
        console.log(' 其他电脑访问: 用下面任意一个地址（同一局域网/WiFi 内即可）');
        lan.forEach(a => console.log('               http://' + a + ':' + port));
        console.log('               （把链接发给学生，他们用浏览器打开就能提交答案）');
      } else {
        console.log(' 其他电脑访问: 未检测到可用的局域网 IP，请检查网络连接');
      }
    } else {
      console.log(' 其他电脑访问: 已关闭（当前 HOST=' + HOST + '，仅本机可用）');
      console.log('               如需开放，用 HOST=0.0.0.0 启动');
    }
    console.log(' AI 服务:     ' + (cfg ? cfg.label + ' / ' + cfg.model + '（' + hostOf(cfg.endpoint) + '）' : '未配置 —— 请打开页面「设置」填写'));
    console.log(' 数据存储:     ' + (cloudOn()
      ? '云端数据库（题目/提交/账号/密码全部实时同步）' + cloudCfg.endpoint
      : '本机 data/db.json（未启用云端同步）'));
    console.log(' 按 Ctrl+C 停止服务');
    console.log('==================================================');
  });
}

loadDb();
loadSettings();
loadCloudCfg();
loadLocalRequests();
(async () => {
  try { await loadAccounts(); }
  catch (e) { console.error('[accounts] 加载失败，按默认账号规则运行:', e.message); }
  if (accountsCache.size) console.log('[账号] 已加载自定义账号 ' + accountsCache.size + ' 条');
  start(START_PORT, 0);
})();
