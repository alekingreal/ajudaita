'use strict';
require('dotenv').config();

let OpenAI;
try { OpenAI = require('openai'); } catch {}

const OPENAI_API_KEY      = process.env.OPENAI_API_KEY || '';
const DEFAULT_MODEL       = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const DEFAULT_TIMEOUT_MS  = Number(process.env.OPENAI_TIMEOUT_MS || 55_000);
const OPENAI_RPM_LIMIT    = Number(process.env.OPENAI_RPM_LIMIT || 3);
const OPENAI_TPM_LIMIT    = Number(process.env.OPENAI_TPM_LIMIT || 12_000); // conservador

// -----------------------------
// Utils / infra
// -----------------------------
function newClient() {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY ausente no .env');
  if (!OpenAI) throw new Error("Pacote 'openai' não instalado. Rode: npm i openai");
  return new OpenAI({ apiKey: OPENAI_API_KEY, timeout: DEFAULT_TIMEOUT_MS });
}

/** Retry só para erros de rede/5xx (NÃO 429). */
async function withRetry(a, b) {
  let fn, retries = 4, baseDelay = 800;
  if (typeof a === 'function') {
    fn = a;
    if (b && typeof b === 'object') {
      if (Number.isInteger(b.retries))   retries   = b.retries;
      if (Number.isFinite(b.baseDelay))  baseDelay = b.baseDelay;
    }
  } else if (a && typeof a === 'object' && typeof a.fn === 'function') {
    fn = a.fn;
    if (Number.isInteger(a.retries))   retries   = a.retries;
    if (Number.isFinite(a.baseDelay))  baseDelay = a.baseDelay;
  } else {
    throw new Error('withRetry: uso inválido — passe uma função ou { fn }');
  }

  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const status = e?.status || e?.response?.status;
      const retriable =
        [408, 409, 500, 502, 503, 504].includes(status) ||
        e?.code === 'ETIMEDOUT' || e?.code === 'ECONNRESET';

      // 429 é tratado pelos gates/cooldown — não retentar aqui
      if (!retriable || i === retries) break;

      const jitter = Math.floor(Math.random() * 250);
      const waitMs = baseDelay * Math.pow(2, i) + jitter;
      await new Promise(r => setTimeout(r, waitMs));
    }
  }
  throw lastErr;
}

function logLLM(kind, info) {
  try {
    const safe = { ...info };
    if (typeof safe.user === 'string') {
      safe.user = safe.user.slice(0, 200) + (safe.user.length > 200 ? '…' : '');
    }
    console.log(`[llm:${kind}]`, JSON.stringify(safe));
  } catch {}
}

// aproximação: ~4 chars/token (PT/EN)
function estimateTokensFromText(s) {
  if (!s) return 0;
  return Math.ceil(String(s).length / 4);
}
function buildTokenCost({ system, user, max_tokens }) {
  const inTok  = estimateTokensFromText(system) + estimateTokensFromText(user);
  const outTok = Math.max(0, Number(max_tokens || 0));
  return inTok + outTok;
}

function parseRetryAfter(e) {
  try {
    const hdr = e?.response?.headers?.['retry-after'];
    if (hdr) return Number(hdr);
  } catch {}
  const msg = String(e?.message || '');
  const m = msg.match(/try again in\s+(\d+)s/i);
  return m ? Number(m[1]) : null;
}
// 429 pode ser rate limit OU insufficient_quota.
function classify429(e) {
    const code = e?.response?.data?.error?.code || e?.code || '';
    const type = e?.response?.data?.error?.type || '';
    const msg  = (e?.response?.data?.error?.message || e?.message || '').toLowerCase();
    if (code === 'insufficient_quota' || type === 'insufficient_quota') return 'insufficient_quota';
    if (msg.includes('insufficient quota') || msg.includes('exceeded your current quota') || msg.includes('billing')) {
      return 'insufficient_quota';
    }
    return 'rate_limit';
  }
// -----------------------------
// Gates e estado (RPM / TPM / cooldown)
// -----------------------------
const _rpmTimestamps = [];      // timestamps (ms) em 60s
const _tpmEvents = [];          // [{ ts, tokens }] em 60s
let _cooldownUntil = 0;         // imposto via Retry-After
let _lastTPMUsed = 0;           // métrica simples p/ /diag

function _tpmPrune() {
  const WINDOW = 60_000;
  const now = Date.now();
  while (_tpmEvents.length && (now - _tpmEvents[0].ts) >= WINDOW) _tpmEvents.shift();
}
function _tpmUsedNow() {
  _tpmPrune();
  return _tpmEvents.reduce((s, e) => s + e.tokens, 0);
}

async function tpmGate(tokensNeeded, limit = OPENAI_TPM_LIMIT) {
  const WINDOW = 60_000;
  for (;;) {
    _tpmPrune();
    const used = _tpmUsedNow();
    if (used + tokensNeeded <= limit) {
      _tpmEvents.push({ ts: Date.now(), tokens: tokensNeeded });
      return;
    }
    const now = Date.now();
    const nextFreeMs = _tpmEvents.length ? Math.max(0, WINDOW - (now - _tpmEvents[0].ts)) : 250;
    await new Promise(r => setTimeout(r, Math.min(nextFreeMs, 1500)));
  }
}

function getCooldownMs() {
  return Math.max(0, _cooldownUntil - Date.now());
}
function getRpmState() {
  const WINDOW = 60_000;
  const now = Date.now();
  while (_rpmTimestamps.length && (now - _rpmTimestamps[0]) >= WINDOW) _rpmTimestamps.shift();
  return {
    limit: OPENAI_RPM_LIMIT,
    used: _rpmTimestamps.length,
    nextFreeMs: _rpmTimestamps[0] ? WINDOW - (now - _rpmTimestamps[0]) : 0
  };
}
function getTpmState() {
  _tpmPrune();
  return { limit: OPENAI_TPM_LIMIT, used: _tpmUsedNow() };
}

async function rpmGate(limit = OPENAI_RPM_LIMIT) {
  const WINDOW = 60_000; // 60s
  for (;;) {
    // respeita cooldown global
    const cd = getCooldownMs();
    if (cd > 0) {
      await new Promise(r => setTimeout(r, Math.min(cd, 1000)));
      continue;
    }

    const now = Date.now();
    while (_rpmTimestamps.length && (now - _rpmTimestamps[0]) >= WINDOW) _rpmTimestamps.shift();
    if (_rpmTimestamps.length < limit) {
      _rpmTimestamps.push(now);
      return; // liberado
    }
    const waitMs = Math.max(50, WINDOW - (now - _rpmTimestamps[0]) + 30);
    await new Promise(r => setTimeout(r, waitMs));
  }
}

// gap pequeno entre chamadas pra suavizar picos
let _lastAt = 0;
const MIN_GAP_MS = 800;
async function softThrottle() {
  const delta = Date.now() - _lastAt;
  if (delta < MIN_GAP_MS) await new Promise(r => setTimeout(r, MIN_GAP_MS - delta));
  _lastAt = Date.now();
}

// -----------------------------
// LLM: Chat / JSON / Visão
// -----------------------------
/** Chat texto livre */
async function askLLM({
  system, user,
  max_tokens = 480, temperature = 0.3,
  model = DEFAULT_MODEL, timeoutMs = DEFAULT_TIMEOUT_MS
}) {
  try {
    const tokensNeeded = buildTokenCost({ system, user, max_tokens });
    await tpmGate(tokensNeeded);
    await rpmGate();
    await softThrottle();

    const client = newClient();
    logLLM('req', { kind: 'chat', model, temperature, max_tokens });

    const run = () => client.chat.completions.create({
      model,
      messages: [
        ...(system ? [{ role: 'system', content: String(system) }] : []),
        { role: 'user', content: String(user || '') },
      ],
      temperature,
      max_tokens,
    }, { timeout: timeoutMs });

    const resp = await withRetry(run, { retries: 2, baseDelay: 800 });
    // tenta pegar usage real; senão usa a estimativa
    try {
      const u = resp?.usage;
      _lastTPMUsed = (u?.prompt_tokens || 0) + (u?.completion_tokens || 0) || tokensNeeded;
    } catch { _lastTPMUsed = tokensNeeded; }

    const content = resp?.choices?.[0]?.message?.content?.trim() || null;
    logLLM('ok', { kind: 'chat', haveContent: !!content });
    return content;
  } catch (e) {
    const status = e?.status || e?.response?.status;
    const raw = e?.response?.data || e?.message || e;
        console.error('askLLM error:', raw);
    
        if (status === 429) {
          const kind = classify429(e);
          if (kind === 'insufficient_quota') {
            // não inicia cooldown; é questão de créditos/billing
            return { _error: 'insufficient_quota', status: 429 };
         } else {
            let hdr = null;
            try { hdr = e?.response?.headers?.['retry-after'] ?? e?.headers?.['retry-after'] ?? null; } catch {}
            const retryAfterSec = (hdr ? Number(hdr) : null) ?? parseRetryAfter(e) ?? 30;
            _cooldownUntil = Date.now() + (retryAfterSec * 1000);
            return { _error: 'rate_limit', status: 429, retryAfterSec };
          }
        }
        // outros erros → null (caller decide 502/fallback)
        return null;
  }
}

/** Forçar JSON (retorna objeto, null ou {_error:'rate_limit',...}) */
async function askLLMJson({
  system, user,
  max_tokens = 900, temperature = 0.2,
  model = DEFAULT_MODEL, timeoutMs = DEFAULT_TIMEOUT_MS
}) {
  try {
    const tokensNeeded = buildTokenCost({ system, user, max_tokens });
    await tpmGate(tokensNeeded);
    await rpmGate();
    await softThrottle();

    const client = newClient();
    logLLM('req', { kind: 'json', model, temperature, max_tokens });

    const run = () => client.chat.completions.create({
      model,
      response_format: { type: 'json_object' },
      messages: [
        ...(system ? [{ role:'system', content:String(system) }] : []),
        { role:'user', content:String(user || '') },
      ],
      temperature,
      max_tokens,
    }, { timeout: timeoutMs });

    const resp = await withRetry(run, { retries: 2, baseDelay: 800 });
    try {
      const u = resp?.usage;
      _lastTPMUsed = (u?.prompt_tokens || 0) + (u?.completion_tokens || 0) || tokensNeeded;
    } catch { _lastTPMUsed = tokensNeeded; }

    const text = resp?.choices?.[0]?.message?.content || '';
    try { return JSON.parse(text); } catch {}
    const m = String(text).match(/\{[\s\S]*\}$/);
    if (m) { try { return JSON.parse(m[0]); } catch {} }
    return null; // JSON ruim → deixa caller decidir fallback
  } catch (e) {
        const status = e?.status || e?.response?.status;
        if (status === 429) {
          const kind = classify429(e);
          if (kind === 'insufficient_quota') {
            return { _error: 'insufficient_quota', status: 429 };
          } else {
            const retryAfterSec = parseRetryAfter(e) ?? 30;
            _cooldownUntil = Date.now() + (retryAfterSec * 1000);
            return { _error: 'rate_limit', status: 429, retryAfterSec };
          }
        }
        console.error('askLLMJson error:', e?.response?.data || e?.message || e);
        return null;
      }
}

/** Visão (imagens). Retorna string, null, ou {_error:'rate_limit',...} */
async function askLLMVision({
  system, text, imagesBase64 = [],
  max_tokens = 480, temperature = 0.3,
  model = DEFAULT_MODEL, timeoutMs = DEFAULT_TIMEOUT_MS
}) {
  try {
    // estima: prompt + “peso visual” simbólico + saída (só p/ gate)
    const textTok = estimateTokensFromText(text) + estimateTokensFromText(system);
    const visionTok = 1000;
    const tokensNeeded = textTok + visionTok + Math.max(0, Number(max_tokens || 0));

    await tpmGate(tokensNeeded);
    await rpmGate();
    await softThrottle();

    const client = newClient();
    const content = [];
    const trimmed = (text || '').trim();
    if (trimmed) content.push({ type:'text', text: trimmed.slice(0, 1200) });
    for (const b64 of imagesBase64) {
      content.push({ type:'image_url', image_url: { url:`data:image/jpeg;base64,${b64}` } });
    }

    const run = () => client.chat.completions.create({
      model,
      messages: [
        ...(system ? [{ role:'system', content:String(system) }] : []),
        { role:'user', content }
      ],
      temperature,
      max_tokens,
    }, { timeout: timeoutMs });

    const resp = await withRetry(run, { retries: 2, baseDelay: 800 });
    try {
      const u = resp?.usage;
      _lastTPMUsed = (u?.prompt_tokens || 0) + (u?.completion_tokens || 0) || tokensNeeded;
    } catch { _lastTPMUsed = tokensNeeded; }

    return resp?.choices?.[0]?.message?.content?.trim() || null;
  } catch (e) {
        const status = e?.status || e?.response?.status;
        if (status === 429) {
          const kind = classify429(e);
          if (kind === 'insufficient_quota') {
            return { _error: 'insufficient_quota', status: 429 };
          } else {
            const retryAfterSec = parseRetryAfter(e) ?? 30;
            _cooldownUntil = Date.now() + (retryAfterSec * 1000);
            return { _error: 'rate_limit', status: 429, retryAfterSec };
          }
        }
        console.error('askLLMVision error:', e?.response?.data || e?.message || e);
        return null;
      }
}

/** OCR simplificado usando visão */
async function ocrImageBase64(b64, { model = DEFAULT_MODEL, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return askLLMVision({
    system: 'Extraia APENAS o texto visível. Não comente, não traduza.',
    text: 'Extraia apenas o texto desta imagem.',
    imagesBase64: [b64],
    max_tokens: 600,
    temperature: 0,
    model,
    timeoutMs
  });
}

// -----------------------------
module.exports = {
  askLLM,
  askLLMJson,
  askLLMVision,
  ocrImageBase64,
  withRetry,
  // diags
  getRpmState,
  getTpmState,
  getCooldownMs
};
