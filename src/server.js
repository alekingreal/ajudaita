// src/server.js
'use strict';

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { v4: uuid } = require('uuid');
const { addEvent, listEvents, removeEvent } = require('./db');
const multer = require('multer');
const os = require('os');
const fs = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const cpuCount = require('os').cpus()?.length || 2;


// ===== LLM Mutex (evita pico de TPM) =====
let llmBusy = false;
const waitFree = async () => {
  const start = Date.now();
  while (llmBusy && Date.now() - start < 8000) {
    await new Promise(r => setTimeout(r, 120));
  }
};
async function withLLMGate(fn) {
  await waitFree(); llmBusy = true;
  try { return await fn(); }
  finally { llmBusy = false; }
}


let ffmpegPath = null;
try { ffmpegPath = require('ffmpeg-static'); }
catch { console.warn('⚠️ ffmpeg-static ausente; /transcribe pode ficar indisponível.'); }

const sharpTry = () => {
  try { return require('sharp'); } catch { return null; }
};
const sharp = sharpTry();

const registerKanban = require('./kanban');

// 👉 use SEMPRE o llm.js (não duplicamos funções aqui)
const {
    askLLM, askLLMJson, askLLMVision, ocrImageBase64,
    getRpmState, getTpmState, getCooldownMs
  } = require('./llm');

process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED REJECTION:', err);
});
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
});

const app = express();
app.use(cors());
app.options(/^\/.*/, cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

const PORT = process.env.PORT || 4000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DEFAULT_FETCH_TIMEOUT_MS = 65000;

// Uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});
const uploadImages = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 6 },
});
app.use('/feedback', require('./routes/feedback'));
app.use('/auth', require('./routes/auth'));   // <-- ADICIONE ESTA LINHA
console.log('✔ routes mounted: /auth');
/* -------------------------------------------------------
   Logs básicos
------------------------------------------------------- */
app.use((req, _res, next) => {
  if (req.method !== 'OPTIONS') console.log(`➡️  ${req.method} ${req.url}`);
  next();
});
app.use((err, _req, res, next) => {
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'file_too_large', maxMB: 10 });
  }
  if (err?.code === 'LIMIT_FILE_COUNT') {
    return res.status(400).json({ error: 'too_many_files' });
  }
  if (err?.code) {
    return res.status(400).json({ error: 'multer_error', code: err.code, message: err.message });
  }
  next(err);
});

/* -------------------------------------------------------
   Helpers
------------------------------------------------------- */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const nowISO = () => new Date().toISOString();

function toBR(date) {
  const d = new Date(date);
  const dia = String(d.getDate()).padStart(2, '0');
  const mes = String(d.getMonth() + 1).padStart(2, '0');
  const ano = d.getFullYear();
  return `${dia}-${mes}-${ano}`;
}

function extractBullets(raw = "") {
  const lines = String(raw).split(/\r?\n/).map(s => s.trim());
  const bullets = [];
  for (const ln of lines) {
    if (/^[-*•]\s+/.test(ln)) bullets.push(ln.replace(/^[-*•]\s+/, '').slice(0, 140));
    else if (/^\d+[.)]\s+/.test(ln)) bullets.push(ln.replace(/^\d+[.)]\s+/, '').slice(0, 140));
    else if (/^#{1,3}\s+/.test(ln)) bullets.push(ln.replace(/^#{1,3}\s+/, '').slice(0, 140));
  }
  if (!bullets.length) bullets.push(raw.slice(0, 120));
  return bullets.slice(0, 8);
}

function isRichPlan(p) {
  if (!p || typeof p !== 'object' || !Array.isArray(p.schedule)) return false;
  const md = p.meta || {};
  const mpd = Number(md.minutosPorDia);
  return typeof md.titulo === 'string'
      && !Number.isNaN(mpd) && mpd >= 20 && mpd <= 240
      && Array.isArray(p.racional || []);
}

// salvar plano no “db”
function savePlanEvent({ userId, entrada, plano, meta = {} }) {
  const id = uuid();
  addEvent({
    id,
    userId,
    type: 'plan',
    payload: {
      ...meta,
      input: entrada,
      plan: plano,
      favorite: false,
    },
    createdAt: nowISO(),
  });
  return id;
}

/* -------------------------------------------------------
   Polyfills Web APIs (para vision)
------------------------------------------------------- */
async function ensureWebAPIs() {
  if (typeof FormData === 'undefined') {
    const FormDataMod = await import('form-data');
    global.FormData = FormDataMod.default || FormDataMod;
  }
  if (typeof Blob === 'undefined') {
    const { Blob: NodeBlob } = await import('buffer');
    global.Blob = NodeBlob;
  }
}
/* -------------------------------------------------------
   Diagnóstico / Status
------------------------------------------------------- */
app.get('/health', (_req, res) => {
  res.json({ ok: true, hasKey: !!OPENAI_API_KEY, envPort: PORT });
});
app.post('/ping', (req, res) => {
  res.json({ ok: true, received: req.body || null });
});
app.get('/diag/llm', async (_req, res) => {
  try {
    const out = await withLLMGate(() =>
            askLLM({ system:'Responda apenas "ok".', user:'diga ok', max_tokens:5, temperature:0 })
          );
      
          if (out && typeof out === 'object') {
            if (out._error === 'rate_limit') {
              if (out.retryAfterSec) res.set('Retry-After', String(out.retryAfterSec));
              return res.status(429).json({
                ok:false,
                error:'rate_limit',
                detail:'RPM or TPM exceeded',
                retryAfterSec: out.retryAfterSec ?? null,
                cooldownMs: getCooldownMs?.() || 0
              });
            }
            if (out._error === 'insufficient_quota') {
              // não seta Retry-After; é billing/credits
              return res.status(429).json({
                ok:false,
                error:'insufficient_quota',
                detail:'OpenAI: créditos/ billing insuficientes',
                cooldownMs: getCooldownMs?.() || 0
              });
            }
          }
          res.json({ ok:true, answer: out });
  } catch (e) {
    res.status(502).json({ ok:false, status: e?.status || null, error: e?.raw || String(e) });
  }
});
app.get('/diag/rpm', (_req, res) => {
    try {
      const s = getRpmState();
      res.json({ ok:true, ...s });
    } catch (e) {
      res.status(500).json({ ok:false, error:String(e) });
    }
  });
  app.get('/diag/limits', (_req, res) => {
      try {
        const rpm = getRpmState();
        const tpm = getTpmState();
        const cooldownMs = getCooldownMs();
        res.json({ ok: true, rpm, tpm, cooldownMs });
      } catch (e) {
        res.status(500).json({ ok:false, error:String(e) });
      }
    });
/* -------------------------------------------------------
   Auth anônima
------------------------------------------------------- */
app.post('/auth/anon', (_req, res) => {
  const id = uuid();
  res.json({ userId: id });
});

/* -------------------------------------------------------
   Extract matérias (utilitário)
------------------------------------------------------- */
app.post('/chat/extract-materias', async (req, res) => {
  try {
    const { history = [] } = req.body || {};
    const system = `Você extrai matérias/assuntos de uma conversa de estudos PT-BR.
- Responda APENAS JSON válido no formato:
{"materias":["Matemática","História"],"objetivo":"string curta","horasSemana":5}
- Max 3 matérias. Se não souber, retorne [].
- "horasSemana": inteiro 1..15 (estimativa se houver pista, senão 5).`;
    const user = `CONVERSA:
${history.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n')}

Retorne o JSON pedido.`;

    const parsed = await askLLMJson({ system, user, max_tokens: 140, temperature: 0.2 }) || {};
    const materias = Array.isArray(parsed.materias) ? parsed.materias.slice(0,3) : [];
    const objetivo = typeof parsed.objetivo === 'string' ? parsed.objetivo.slice(0,160) : '';
    const horasSemana = Math.max(1, Math.min(15, Number(parsed.horasSemana || 5)));
    res.json({ materias, objetivo, horasSemana });
  } catch (e) {
    console.error('extract-materias error', e);
    res.json({ materias: [], objetivo: '', horasSemana: 5 });
  }
});

/* -------------------------------------------------------
   Chat (com persona) — JSON (com fallback para imagens base64)
------------------------------------------------------- */
const MAX_TURNS = 6;
const HISTORY_CHAR_BUDGET = 900;
function joinHistoryToText(history = []) {
  return history.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');
}
// --- filtra histórico por conversa ---
// Somente mensagens cujo m.conversationId === conversationId.
// Se não vier conversationId, assume-se que todo o history pertence à conversa atual.
function filterHistoryByConversation(history = [], conversationId) {
    if (!conversationId) return Array.isArray(history) ? history : [];
    return (Array.isArray(history) ? history : [])
      .filter(m => {
        return m && typeof m === 'object' && m.conversationId === conversationId;
      });
  }
  

// 🔁 Agora NÃO chama LLM — só trunca localmente.
async function compressHistoryIfNeeded(history = []) {
  const txt = joinHistoryToText(history);
  if (txt.length <= HISTORY_CHAR_BUDGET) {
    return { historyText: txt, compressed: false };
  }
  const keepLast = Math.max(1, MAX_TURNS * 2);
  const suffix = history.slice(-keepLast);
  const head = (txt.slice(0, 600) + ' …');    // um teaser curto do início
  const tail = joinHistoryToText(suffix).slice(0, 600);
  const combined = `CONTEXTO RESUMIDO (local):
${head}

ÚLTIMAS MENSAGENS:
${tail}`;
  return { historyText: combined, compressed: true };
}

/* -------------------------------------------------------
   Chat (texto puro + opcionalmente imagens em JSON base64)
------------------------------------------------------- */
app.post('/chat', async (req, res) => {
  try {
    const {
      userId, message = '', nivel = 'medio', materia = 'geral',
      history = [], mode = 'explicar', goal = '',
      conversationId, conversationTitle = '', persona = {},
      images = [] // [{ base64, name, type }]
    } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId é obrigatório' });

    const isOnlyImages = Array.isArray(images) && images.length > 0 && (!message || !message.trim());
    if (!isOnlyImages && !message) {
      return res.status(400).json({ error: 'message é obrigatório quando não há imagens' });
    }

    // Persona → regras
    const { tone = 'didatico', examples = 'cotidiano', respLen = 'medio', favSubject = '' } = persona || {};
    const toneRule = {
      didatico: '- Tom didático, acolhedor e explicativo.',
      formal:   '- Tom objetivo e formal (sem coloquialismos).',
      motivador:'- Tom encorajador, com reforço positivo curto.'
    }[tone] || '';
    const lenRule = {
      curto: '- Seja conciso (~120 palavras).',
      medio: '- Tamanho médio (~200–300 palavras).',
      longo: '- Aprofunde (~350–500 palavras).'
    }[respLen] || '';
    const exRule  = examples ? `- Use exemplos do contexto de ${examples}.` : '';
    const favRule = favSubject ? `- Quando natural, conecte com ${favSubject}.` : '';
    const personaRule = [toneRule, lenRule, exRule, favRule].filter(Boolean).join('\n');

    const byMode = {
      explicar:   "- Explique claramente e dê 1 exemplo do nível do aluno.",
      exercicios: "- Entregue 3 exercícios graduais com gabarito comentado.",
      quiz:       "- Faça 3 perguntas de múltipla escolha (A-D) e depois dê o gabarito.",
      resumir:    "- Resuma em 5 bullets curtos e 2 exemplos aplicados.",
      passoapasso:"- Resolva passo a passo, mostrando o raciocínio de forma sucinta.",
    };
    const modeRule = byMode[mode] || byMode.explicar;

    const system = `Você é um tutor em PT-BR.
Nível: ${nivel} | Matéria: ${materia}${goal ? ` | Objetivo do aluno: ${goal}` : ""}
Regras:
${modeRule}
${personaRule}
- Formate em Markdown quando ajudar (títulos/itens/código).
- Seja direto, organizado em listas quando fizer sentido.
- Termine com um "Próximo passo" (1 linha).`;

       // Somente o contexto desta conversa:
    const filtered = filterHistoryByConversation(history, conversationId);
    const trimmed  = filtered.slice(-MAX_TURNS * 2);
    const { historyText, compressed } = await compressHistoryIfNeeded(trimmed);
 
     

    // =========== Caso 1: imagens por JSON (base64) → Vision ===========
    if (Array.isArray(images) && images.length > 0) {
      const imagesBase64 = images.map(f => (f?.base64 || '').trim()).filter(Boolean);
      if (!imagesBase64.length) return res.status(400).json({ error: 'images sem base64' });

      const userText =
        [
          filtered?.length ? `CONVERSA (CONTEXTO):\n${joinHistoryToText(filtered)}` : '',
          message ? `PERGUNTA ATUAL (USER):\n${message}` : ''
        ]
          .filter(Boolean)
          .join('\n\n')
          .trim() || 'Analise a(s) imagem(ns) e explique.';

      let answer;
      try {
        answer = await askLLMVision({ system, text: userText.slice(0, 2000), imagesBase64 });
      } catch (e) {
        if (e?.status === 429) {
          const sec = Number(e.retryAfterSec || 30);
          res.set('Retry-After', String(sec));
          return res.status(429).json({ error: 'rate_limit', detail: 'TPM exceeded', retryAfterSec: sec });
        }
        console.warn('Vision throw (/chat):', e?.message || e);
      }

      if (answer && typeof answer === 'object' && answer._error === 'rate_limit') {
        const sec = Number(answer.retryAfterSec || 30);
        res.set('Retry-After', String(sec));
        return res.status(429).json({ error: 'rate_limit', detail: 'TPM exceeded', retryAfterSec: sec });
      }
      if (!answer || typeof answer !== 'string') {
        return res.status(502).json({ error: 'llm_failed', hint: 'verifique /health, /diag/llm e logs' });
      }

      const userAttachments = images.map((f, idx) => ({
        name: f.name || `image_${idx + 1}.jpg`,
        type: f.type || 'image/jpeg',
        uri: `data:${(f.type || 'image/jpeg')};base64,${imagesBase64[idx]}`
      }));

      const eventId = uuid();
      res.json({ answer, usedCompression: false, historyId: eventId, userAttachments });

      if (typeof addEvent === 'function') {
        addEvent({
          id: eventId,
          userId,
          type: 'chat',
          payload: {
            nivel, materia: 'geral', question: message || '(só imagens)',
            answer, favorite: false,
            conversationId: conversationId || null,
            conversationTitle: conversationTitle || null,
            imagesCount: imagesBase64.length,
            attachmentsMeta: userAttachments.map(a => ({ name: a.name, type: a.type }))
          },
          createdAt: nowISO()
        });
      }
      return;
    }

    // =========== Caso 2: Fluxo texto puro ===========
    const userBlock = [
      historyText && `CONVERSA (CONTEXTO):\n${historyText}`,
      `PERGUNTA ATUAL (USER):\n${message}`
    ].filter(Boolean).join('\n\n');

    // tokens dinâmicos
    const approxLen = (message || '').length;
    const maxTokens = approxLen < 40 ? 180 : approxLen < 140 ? 260 : 360;


    // depois
let answer;
try {
  answer = await withLLMGate(() =>
    askLLM({ system, user: userBlock, max_tokens: maxTokens, temperature: 0.3 })
  );
} catch (e) {
  if (e?.status === 429) {
    const sec = Number(e.retryAfterSec || 30);
    res.set('Retry-After', String(sec));
    return res.status(429).json({ error: 'rate_limit', detail: 'TPM exceeded', retryAfterSec: sec });
  }
  console.error('askLLM throw (chat):', e?.message || e);
  return res.status(502).json({ error: 'llm_failed' });
}

    if (answer && typeof answer === 'object' && answer._error === 'rate_limit') {
      const sec = Number(answer.retryAfterSec || 30);
      res.set('Retry-After', String(sec));
      return res.status(429).json({ error: 'rate_limit', detail: 'TPM exceeded', retryAfterSec: sec });
    }

    if (!answer || typeof answer !== 'string') {
      return res.status(502).json({ error: 'llm_failed' });
    }

    const eventId = uuid();
    res.json({ answer, usedCompression: compressed, historyId: eventId });

    if (typeof addEvent === 'function') {
      addEvent({
        id: eventId,
        userId,
        type: 'chat',
        payload: {
          nivel, materia, question: message, answer, favorite: false,
          conversationId: conversationId || null, conversationTitle: conversationTitle || null
        },
        createdAt: nowISO()
      });
    }
  } catch (e) {
    console.error('chat error', e);
    return res.status(500).json({ error: 'erro interno' });
  }
});

/* -------------------------------------------------------
   Chat com IMAGENS (multipart/form-data) — compat com App.js
------------------------------------------------------- */
app.post('/chat-with-media', uploadImages.array('images', 6), async (req, res) => {
  try {
    const {
      userId,
      message = '',
      nivel = 'medio',
      mode = 'explicar',
      persona,
      conversationId,
      conversationTitle,
      history: historyRaw
    } = req.body || {};

    if (!userId) return res.status(400).json({ error: 'userId é obrigatório' });

    const history = (() => { try { return JSON.parse(historyRaw || '[]'); } catch { return []; } })();
    const p = (() => { try { return JSON.parse(persona || '{}'); } catch { return {}; } })();
    const { tone = 'didatico', examples = 'cotidiano', respLen = 'medio', favSubject = '' } = p || {};

    const toneRule = {
      didatico: '- Tom didático, acolhedor e explicativo.',
      formal:   '- Tom objetivo e formal (sem coloquialismos).',
      motivador:'- Tom encorajador, com reforço positivo curto.'
    }[tone] || '';
    const lenRule = {
      curto: '- Seja conciso (~120 palavras).',
      medio: '- Tamanho médio (~200–300 palavras).',
      longo: '- Aprofunde (~350–500 palavras).'
    }[respLen] || '';
    const exRule  = examples ? `- Use exemplos do contexto de ${examples}.` : '';
    const favRule = favSubject ? `- Quando natural, conecte com ${favSubject}.` : '';
    const personaRule = [toneRule, lenRule, exRule, favRule].filter(Boolean).join('\n');

    const byMode = {
      explicar:   "- Explique claramente e dê 1 exemplo do nível do aluno.",
      exercicios: "- Entregue 3 exercícios graduais com gabarito comentado.",
      quiz:       "- Faça 3 perguntas de múltipla escolha (A-D) e depois dê o gabarito.",
      resumir:    "- Resuma em 5 bullets curtos e 2 exemplos aplicados.",
      passoapasso:"- Resolva passo a passo, mostrando o raciocínio de forma sucinta.",
    };
    const modeRule = byMode[mode] || byMode.explicar;

    const system = `Você é um tutor em PT-BR com visão (interpreta imagens).
Nível: ${nivel}
Regras:
${modeRule}
${personaRule}
- Formate em Markdown quando ajudar (títulos/itens/código).
- Seja direto, organizado em listas quando fizer sentido.
- Termine com um "Próximo passo" (1 linha).`;

    const files = Array.isArray(req.files) ? req.files : [];
    if (!files.length && !message.trim()) {
      return res.status(400).json({ error: 'Envie ao menos uma imagem ou uma mensagem.' });
    }

    const MAX_SIDE = Number(process.env.VISION_MAX_SIDE || 768);
    const imagesBase64 = [];
    for (const f of files) {
      try {
        const buf = f.buffer;
        if (sharp) {
          const processed = await sharp(buf)
            .rotate()
            .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 55 })
            .toBuffer();
          imagesBase64.push(processed.toString('base64'));
        } else {
          imagesBase64.push(Buffer.from(buf).toString('base64'));
        }
      } catch (e) {
        console.warn('⚠️ falha ao processar imagem, usando original:', e?.message);
        imagesBase64.push(Buffer.from(f.buffer).toString('base64'));
      }
    }

   // Somente o contexto desta conversa:
    const filtered = filterHistoryByConversation(history, conversationId);
    const trimmed  = filtered.slice(-MAX_TURNS * 2);
    const { historyText } = await compressHistoryIfNeeded(trimmed);
 
   

    const parts = [];
    if (historyText && historyText.trim()) parts.push(`CONVERSA (CONTEXTO):\n${historyText}`);
    if (message && message.trim())        parts.push(`PERGUNTA ATUAL (USER):\n${message}`);
    const safeUserText = (parts.join('\n\n').trim() || 'Analise a(s) imagem(ns) e explique.').slice(0, 1200);

    // 1) tenta Vision
    let answer = null;
    try {
      const vr = await withLLMGate(() => askLLMVision({ system, text: safeUserText, imagesBase64 }));

     
      if (typeof vr === 'string') answer = vr;
      if (vr && typeof vr === 'object' && vr._error === 'rate_limit') {
        const sec = Number(vr.retryAfterSec || 30);
        res.set('Retry-After', String(sec));
        return res.status(429).json({ error: 'rate_limit', detail: 'TPM exceeded', retryAfterSec: sec });
      }
    } catch (e) {
      if (e?.status === 429) {
        const sec = Number(e.retryAfterSec || 30);
        res.set('Retry-After', String(sec));
        return res.status(429).json({ error: 'rate_limit', detail: 'TPM exceeded', retryAfterSec: sec });
      }
      console.warn('Vision falhou, vamos para OCR fallback:', e?.message || e);
    }

    // 2) Fallback OCR → texto + chat
    if (!answer) {
      const texts = [];
      for (const b64 of imagesBase64) {
        try {
          const t = await ocrImageBase64(b64);
          if (t) texts.push(t);
        } catch (e) {
          console.warn('OCR falhou para uma imagem:', e?.message || e);
        }
      }

      const imagesText = texts.join('\n\n---\n\n').slice(0, 2000);
      const textPrompt = [
        safeUserText,
        imagesText ? `\n\nTEXTO EXTRAÍDO DAS IMAGENS (OCR):\n${imagesText}` : ''
      ].join('').slice(0, 2200);

      const approxLen = (message || '').length + imagesText.length;
      const maxTokens = approxLen < 60 ? 260 : approxLen < 180 ? 340 : 380;

      let textAnswer;
            try {
              textAnswer = await withLLMGate(() =>
                askLLM({ system, user: textPrompt, max_tokens: maxTokens, temperature: 0.3 })
              );
            } catch (e) {
        if (e?.status === 429) {
          const sec = Number(e.retryAfterSec || 30);
          res.set('Retry-After', String(sec));
          return res.status(429).json({ error: 'rate_limit', detail: 'TPM exceeded', retryAfterSec: sec });
        }
        console.warn('askLLM throw (ocr_fallback):', e?.message || e);
        return res.status(502).json({ error: 'llm_failed' });
      }

      if (textAnswer && typeof textAnswer === 'object' && textAnswer._error === 'rate_limit') {
        const sec = Number(textAnswer.retryAfterSec || 30);
        res.set('Retry-After', String(sec));
        return res.status(429).json({ error: 'rate_limit', detail: 'TPM exceeded', retryAfterSec: sec });
      }
      if (!textAnswer) return res.status(502).json({ error: 'llm_failed' });

      answer = textAnswer;
    }

    const eventId = uuid();
    if (typeof addEvent === 'function') {
      addEvent({
        id: eventId,
        userId,
        type: 'chat',
        payload: {
          nivel,
          materia: 'geral',
          question: message || '(só imagens)',
          answer,
          favorite: false,
          conversationId: conversationId || null,
          conversationTitle: conversationTitle || null,
          imagesCount: imagesBase64.length
        },
        createdAt: nowISO()
      });
    }

    return res.json({ answer, usedCompression: false, historyId: eventId });
  } catch (e) {
    console.error('chat-with-media error', e);
    return res.status(500).json({ error: 'erro interno' });
  }
});

/* -------------------------------------------------------
   Summarize / Flashcards
------------------------------------------------------- */
app.post('/summarize', async (req, res) => {
  const { userId, text, nivel = 'medio', mode = 'resumo' } = req.body || {};
  if (!userId || !text) return res.status(400).json({ error: 'userId e text são obrigatórios' });

  let system, user;
  if (mode === 'flashcards') {
    system = 'Você gera flashcards de estudo em PT-BR.';
    user = `Crie 5 flashcards curtos em formato de PERGUNTA e RESPOSTA, claros e diretos, baseados neste texto:\n\n${text}`;
  } else {
    system = 'Você resume conteúdos de estudo em PT-BR.';
    user = `Resuma o seguinte texto em até 5 bullets e 2 exemplos aplicados:\n\n${text}`;
  }

  const answer = await withLLMGate(() => askLLM({ system, user, max_tokens: 300 }));

  if (!answer) return res.status(502).json({ error: 'Não consegui resumir agora' });

  if (typeof addEvent === 'function') {
    addEvent({
      id: uuid(),
      userId,
      type: 'summary',
      payload: { text, mode, summary: answer, favorite: false },
      createdAt: nowISO(),
    });
  }

  res.json({ summary: answer });
});

/* -------------------------------------------------------
   ASR (voz -> texto) com whisper-cli (offline)
------------------------------------------------------- */
app.post('/transcribe', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'arquivo de áudio ausente' });
    if (!ffmpegPath) return res.status(500).json({ error: 'ffmpeg-static ausente' });

    // aceita WHISPER_BIN ou WHISPER_CPP_BIN
    const whisperBin =
      process.env.WHISPER_BIN || process.env.WHISPER_CPP_BIN || 'whisper-cli';
    const modelPath  = process.env.WHISPER_CPP_MODEL || path.resolve(__dirname, '../models/ggml-small.bin');

    const tmpBase   = path.join(os.tmpdir(), `asr_${Date.now()}_${Math.random().toString(36).slice(2)}`);
    const srcPath   = `${tmpBase}.m4a`;
    const wavPath   = `${tmpBase}.wav`;
    const outPrefix = `${tmpBase}_out`;
    await fs.writeFile(srcPath, req.file.buffer);

    await new Promise((resolve, reject) => {
      const ff = spawn(ffmpegPath, ['-y', '-i', srcPath, '-ar', '16000', '-ac', '1', wavPath]);
      let err = '';
      ff.stderr.on('data', d => (err += d.toString()));
      ff.on('close', code => (code === 0 ? resolve() : reject(new Error('[ffmpeg] ' + err))));
    });

    try { await fs.stat(wavPath); }
    catch { return res.status(500).json({ error: 'falha ao converter áudio' }); }

    await new Promise((resolve, reject) => {
      const threads = Number(process.env.WHISPER_THREADS || cpuCount);
      const args = [
        '-m', modelPath, '-l', 'pt', '-otxt', '-of', outPrefix,
        '-t', String(threads), '-bs', '1', '-sns',
        wavPath,
      ];
      const w = spawn(whisperBin, args);
      let err = '';
      w.stderr.on('data', (d) => { err += d.toString(); });
      w.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err))));
    });

    let txt = await fs.readFile(`${outPrefix}.txt`, 'utf8').catch(() => '');
    txt = txt
      .replace(/\[(?:MUSIC|MÚSICA|APPLAUSE|NOISE|SILENCE|RISOS|LAUGHTER)\]/gi, '')
      .replace(/\s+/g, ' ')
      .trim();

    res.json({ text: txt });

    // limpeza
    fs.unlink(srcPath).catch(() => {});
    fs.unlink(wavPath).catch(() => {});
    fs.unlink(`${outPrefix}.txt`).catch(() => {});
  } catch (e) {
    console.error('ASR local error', e);
    return res.status(500).json({ error: 'erro interno' });
  }
});
app.get('/transcribe', (_req, res) => res.status(405).send('Use POST multipart/form-data.'));

/* -------------------------------------------------------
   OCR (foto -> texto) via llm.js (gpt-4o-mini visão)
------------------------------------------------------- */
app.post('/vision/ocr', async (req, res) => {
  try {
    const { userId, imageBase64 } = req.body || {};
    if (!userId || !imageBase64) return res.status(400).json({ error: 'userId e imageBase64 são obrigatórios' });

    const MAX_SIDE = Number(process.env.VISION_MAX_SIDE || 768);
    let processedBase64 = imageBase64;
    if (sharp) {
      const processed = await sharp(Buffer.from(imageBase64, 'base64'))
        .rotate()
        .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 60 })
        .toBuffer();
      processedBase64 = processed.toString('base64');
    }

    const text = await withLLMGate(() => ocrImageBase64(processedBase64));

    return res.json({ text: text || '' });
  } catch (e) {
    console.error('Vision OCR exception', e);
    if (e?.status === 429) return res.status(429).json({ error: 'quota', detail: 'insufficient_quota' });
    return res.status(500).json({ error: 'erro interno' });
  }
});

/* -------------------------------------------------------
   Histórico genérico (chat/summary)
------------------------------------------------------- */
// DEPOIS
app.get('/history', async (req, res) => {
  try {
    const { userId, limit = 50, favorite } = req.query || {};
    if (!userId) return res.status(400).json({ error: 'userId é obrigatório' });

    let items = await listEvents(userId, Number(limit) || 50);

    if (typeof favorite !== 'undefined') {
      const want = String(favorite) === '1' || String(favorite) === 'true';
      items = items.filter(it => Boolean(it.payload?.favorite) === want);
    }

    return res.json({ items });
  } catch (e) {
    console.error('GET /history error', e);
    return res.status(500).json({ error: 'erro interno' });
  }
});

// DEPOIS
app.patch('/history/:id/favorite', async (req, res) => {
  try {
    const { id } = req.params;
    const { userId, favorite } = req.body || {};
    if (!userId || typeof favorite !== 'boolean') {
      return res.status(400).json({ error: 'userId e favorite (boolean) são obrigatórios' });
    }

    const items = await listEvents(userId, 10000);
    const found = items.find(it => it.id === id);
    if (!found) return res.status(404).json({ error: 'Item não encontrado' });

    found.payload = { ...(found.payload || {}), favorite: Boolean(favorite) };

    await removeEvent(id, userId);
    await addEvent(found);

    return res.json({ ok: true });
  } catch (e) {
    console.error('PATCH /history/:id/favorite error', e);
    return res.status(500).json({ error: 'erro interno' });
  }
});

// DELETE /history/:id
app.delete('/history/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.query || {};
    if (!userId) return res.status(400).json({ error: 'userId é obrigatório' });

    const removed = await removeEvent(id, userId);
    return res.json({ ok: removed > 0 });
  } catch (e) {
    console.error('DELETE /history/:id error', e);
    return res.status(500).json({ error: 'erro interno' });
  }
});
/* -------------------------------------------------------
   Planner (APENAS 1 chamada ao LLM) — compat com App.js
------------------------------------------------------- */
app.post('/planner/compose', async (req, res) => {
  try {
    const { userId, nivel='medio', dataAlvo, minutosPorDia=60, itens=[] } = req.body || {};
    if (!userId || !dataAlvo || !Array.isArray(itens) || !itens.length) {
      return res.status(400).json({ error: 'userId, dataAlvo e itens são obrigatórios' });
    }

    const start = Date.now();
    const BUDGET_MS   = 52000;
    const FAST_TIMEOUT = 45000;
    const SAFE_ITEM_CHARS = 600;

    const alvoISO = new Date(dataAlvo);
    if (isNaN(alvoISO)) return res.status(400).json({ error: 'dataAlvo inválida' });

    const capDia = Math.max(20, Math.min(240, Number(minutosPorDia) || 60));

    const safeItens = itens.map((it, i) => ({
      idx: i + 1,
      materia: (it.materia || '').slice(0, 60),
      texto: String(it.texto || '').replace(/\s+/g, ' ').slice(0, SAFE_ITEM_CHARS),
      prioridade: it.prioridade || 'média'
    })).slice(0, 8);

    // tópicos locais (sem brief)
    const porMateria = new Map();
    for (const it of safeItens) {
      const nome = (it.materia || 'Geral').slice(0, 40);
      const bullets = extractBullets(it.texto);
      const arr = porMateria.get(nome) || [];
      porMateria.set(nome, arr.concat(bullets));
    }

    let materias = Array.from(porMateria.entries())
      .map(([nome, tops]) => ({
        nome,
        topicos: [...new Set(tops)].slice(0, 8),
        prioridade: 2
      }))
      .slice(0, 4);

    if (!materias.length) {
      const nome = (safeItens.find(x => x.materia)?.materia) || 'Geral';
      const tops = safeItens.flatMap(x => extractBullets(x.texto)).slice(0, 6);
      materias = [{ nome, topicos: tops, prioridade: 2 }];
    }

    // prompt do planner
    const systemPlan = `Você é um planner pessoal (PT-BR) para estudos, rotinas, viagens, finanças ou fitness.
RETORNE APENAS JSON válido com o formato:
{
 "planId": "string",
 "meta": {
   "titulo": "string",
   "categoria": "estudos|organizacional|viagem|fitness|finanças|outros",
   "janela": {"inicio":"AAAA-MM-DD","fim":"AAAA-MM-DD"},
   "minutosPorDia": 20..240,
   "premissas": ["..."]
 },
 "schedule": [
   {
     "data":"AAAA-MM-DD",
     "blocos":[
       {"inicio":"HH:MM","fim":"HH:MM","tipo":"tarefa|pausa|buffer","titulo":"...","descricao":"...","topicos":["..."],"prioridade":"alta|média|baixa","origem":{"from":"chat|manual","messageId":""}}
     ]
   }
 ],
 "checklist":[
   {"id":"t1","titulo":"...","prazo":"AAAA-MM-DD","prioridade":"alta|média|baixa"}
 ],
 "observacoes":"string",
 "racional":["decisão 1","decisão 2"]
}
Regras:
- Distribua blocos com horários reais, respeitando capacidade diária e preferências.
- Insira PAUSAS: a cada 45–60min, 10–15min de descanso (ajuste conforme input).
- Insira BUFFERS curtos quando fizer sentido (trânsito, imprevistos).
- Use prioridades para ordenar; antecipe 'alta'.
- Se itens vierem do chat, preencha "origem.from":"chat".
- Se faltar detalhes, faça suposições razoáveis e explique no "racional".`;

    const inicioPeriodo = (req.body.contexto?.janela?.inicio) || new Date().toISOString().slice(0,10);
    const fimPeriodo = new Date(req.body.dataAlvo).toISOString().slice(0,10);

    const userPlan = `Dados do usuário:
- Categoria desejada: ${req.body.categoriaDesejada || "auto"}
- Capacidade/dia: ${capDia} min
- Janela: ${toBR(inicioPeriodo)} → ${toBR(fimPeriodo)}
- Preferência horários: ${req.body.contexto?.preferenciaHorarios?.inicio || "07:30"}–${req.body.contexto?.preferenciaHorarios?.fim || "22:00"}
- Pausas: a cada ${req.body.contexto?.pausas?.aCadaMinutos || 50}min por ${req.body.contexto?.pausas?.duracaoMin || 10}min
- Indisponibilidades: ${JSON.stringify(req.body.contexto?.indisponibilidades || [])}
- Premissas: ${(req.body.contexto?.premissas || []).join('; ') || "nenhuma"}

Itens (com prioridade):
${safeItens.map((it, i) => `- [${i+1}] prio:${it.prioridade||'média'} ${it.materia||'Geral'} → ${it.texto.slice(0,120)}`).join('\n')}

Crie o JSON completo no formato exigido.`;

    function timeAdd(hhmm, minutes) {
      const [h,m] = (hhmm || '07:30').split(':').map(Number);
      const t = new Date(2000,0,1,h||7,m||30);
      t.setMinutes(t.getMinutes()+minutes);
      const hh = String(t.getHours()).padStart(2,'0');
      const mm2 = String(t.getMinutes()).padStart(2,'0');
      return `${hh}:${mm2}`;
    }

    function fallbackGenericPlan({ dataInicio, dataFim, minutosPorDia=60, itens=[], titulo="Plano rápido", categoria="organizacional" }) {
      const start = new Date(dataInicio);
      const end = new Date(dataFim);
      const dias = Math.max(1, Math.ceil((end - start)/86400000) + 1);
      const porDia = Math.min(itens.length || 3, 4);
      const schedule = [];
      const pausaDur = 10;

      for (let d=0; d<dias; d++) {
        const cur = new Date(start.getTime() + d*86400000);
        const iso = cur.toISOString().slice(0,10);
        let hora = "07:30";
        let rest = Math.min(minutosPorDia, 180);
        const blocos = [];
        const picks = itens.slice(d*porDia, d*porDia+porDia);
        for (const it of (picks.length ? picks : itens.slice(0,porDia))) {
          const dur = Math.min(rest, 45);
          if (dur <= 0) break;
          const fim = timeAdd(hora, dur);
          blocos.push({
            inicio: hora, fim, tipo: "tarefa",
            titulo: it.materia || "Tarefa",
            descricao: it.texto.slice(0,140),
            topicos: [],
            prioridade: it.prioridade || "média",
            origem: { from: "fallback" }
          });
          rest -= dur;
          hora = fim;
          if (rest > 15) {
            const f2 = timeAdd(hora, pausaDur);
            blocos.push({ inicio: hora, fim: f2, tipo: "pausa", titulo: "Pausa" });
            hora = f2;
            rest -= pausaDur;
          }
        }
        schedule.push({ data: iso, blocos });
      }

      return {
        planId: uuid(),
        meta: {
          titulo, categoria,
          janela: { inicio: dataInicio, fim: dataFim },
          minutosPorDia,
          premissas: ["Fallback local com blocos de 45min + pausas"]
        },
        schedule,
        checklist: [],
        observacoes: "Plano gerado localmente por falta de resposta do LLM.",
        racional: ["Distribuição uniforme", "Pausas programadas", "Duração 45min/bloco"]
      };
    }

    let plan = await withLLMGate(() => askLLMJson({ system: systemPlan, user: userPlan, max_tokens: 900, temperature: 0.2, timeoutMs: FAST_TIMEOUT }));


    const timeUp = Date.now() - start > BUDGET_MS;
    if (timeUp || !isRichPlan(plan)) {
      const fb = fallbackGenericPlan({
        dataInicio: inicioPeriodo,
        dataFim: fimPeriodo,
        minutosPorDia: capDia,
        itens: safeItens,
        titulo: (req.body?.contexto?.titulo || 'Plano rápido'),
        categoria: (req.body?.categoriaDesejada || 'organizacional')
      });
      const planId = savePlanEvent({
        userId,
        entrada: { dataAlvo: fimPeriodo, minutosPorDia, nivel, itens: safeItens, contexto: req.body.contexto || null, categoriaDesejada: req.body.categoriaDesejada || null },
        plano: fb,
        meta: { nivel, minutosPorDia: capDia, objetivoGeral: '(fallback)' }
      });
      return res.json({ id: planId, plan: fb });
    }

    const planId = savePlanEvent({
      userId,
      entrada: { dataAlvo, minutosPorDia, nivel, itens: safeItens, contexto: req.body.contexto || null, categoriaDesejada: req.body.categoriaDesejada || null },
      plano: plan,
      meta: { nivel, minutosPorDia: capDia, objetivoGeral: req.body?.objetivoGeral || '' }
    });
    return res.json({ id: planId, plan });
  } catch (e) {
    console.error('compose error', e);
    return res.status(500).json({ error: 'erro interno' });
  }
});

// GET /planner (lista leve)
app.get('/planner', (req, res) => {
  const { userId, limit = 50, favorite } = req.query || {};
  if (!userId) return res.status(400).json({ error: 'userId é obrigatório' });

  let items = listEvents(userId, Number(limit)).filter(it => it.type === 'plan');

  if (typeof favorite !== 'undefined') {
    const want = String(favorite) === '1' || String(favorite) === 'true';
    items = items.filter(it => Boolean(it.payload?.favorite) === want);
  }

  const plans = items.map(it => {
    const plan = it.payload?.plan || {};
    const meta = plan.meta || {};
    const schedule = Array.isArray(plan.schedule) ? plan.schedule : [];
    const totalBlocos = schedule.reduce((acc, d) => acc + (Array.isArray(d.blocos) ? d.blocos.length : 0), 0);

    return {
      id: it.id,
      createdAt: it.createdAt,
      favorite: Boolean(it.payload?.favorite),
      titulo: meta.titulo || it.payload?.objetivoGeral || 'Plano',
      categoria: meta.categoria || 'outros',
      janela: meta.janela || null,
      minutosPorDia: meta.minutosPorDia || it.payload?.minutosPorDia || null,
      dias: schedule.length,
      blocos: totalBlocos,
      dataAlvo: it.payload?.input?.dataAlvo || meta?.janela?.fim || null,
      materias: Array.from(new Set((it.payload?.input?.itens || []).map(x => x?.materia).filter(Boolean))),
    };
  });

  res.json({ plans });
});

// GET /planner/:id (detalhe completo)
// GET /planner (lista leve)
app.get('/planner', async (req, res) => {
  try {
    const { userId, limit = 50, favorite } = req.query || {};
    if (!userId) {
      return res.status(400).json({ error: 'userId é obrigatório' });
    }

    // listEvents é assíncrono → await
    let items = await listEvents(userId, Number(limit));
    // só planos
    items = items.filter(it => it.type === 'plan');

    if (typeof favorite !== 'undefined') {
      const want = String(favorite) === '1' || String(favorite) === 'true';
      items = items.filter(it => Boolean(it.payload?.favorite) === want);
    }

    const plans = items.map(it => {
      const plan = it.payload?.plan || {};
      const meta = plan.meta || {};
      const schedule = Array.isArray(plan.schedule) ? plan.schedule : [];
      const totalBlocos = schedule.reduce(
        (acc, d) => acc + (Array.isArray(d.blocos) ? d.blocos.length : 0),
        0
      );

      return {
        id: it.id,
        createdAt: it.createdAt,
        favorite: Boolean(it.payload?.favorite),
        titulo: meta.titulo || it.payload?.objetivoGeral || 'Plano',
        categoria: meta.categoria || 'outros',
        janela: meta.janela || null,
        minutosPorDia: meta.minutosPorDia || it.payload?.minutosPorDia || null,
        dias: schedule.length,
        blocos: totalBlocos,
        dataAlvo: it.payload?.input?.dataAlvo || meta?.janela?.fim || null,
        materias: Array.from(
          new Set((it.payload?.input?.itens || []).map(x => x?.materia).filter(Boolean))
        ),
      };
    });

    res.json({ plans });
  } catch (e) {
    console.error('GET /planner error', e);
    res.status(500).json({ error: 'erro interno' });
  }
});


// GET /planner/:id (detalhe completo)
app.get('/planner/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.query || {};
    if (!userId) {
      return res.status(400).json({ error: 'userId é obrigatório' });
    }

    // await aqui também
    const items = await listEvents(userId, 10000);
    const found = items.find(it => it.id === id && it.type === 'plan');
    if (!found) return res.status(404).json({ error: 'Plano não encontrado' });

    const payload = found.payload || {};
    const plan = payload.plan || {};

    // conversão legado → enriquece para o formato novo
    if (!plan.schedule && Array.isArray(plan.dias)) {
      plan.meta = plan.meta || {
        titulo: payload?.objetivoGeral || 'Plano (legado)',
        categoria: 'estudos',
        janela: {
          inicio: new Date().toISOString().slice(0, 10),
          fim: payload?.input?.dataAlvo || new Date().toISOString().slice(0, 10)
        },
        minutosPorDia: payload?.minutosPorDia || 60,
        premissas: ['convertido de formato legado'],
      };
      plan.schedule = plan.dias.map(d => ({
        data: d.data?.match(/^\d{2}-\d{2}-\d{4}$/)
          ? d.data.split('-').reverse().join('-')
          : (new Date(d.data).toISOString().slice(0, 10)),
        blocos: (d.tarefas || []).map(t => ({
          inicio: '07:30',
          fim: '08:15',
          tipo: 'tarefa',
          titulo: String(t).slice(0, 60),
          descricao: String(t).slice(0, 180),
          topicos: [],
          prioridade: 'média',
          origem: { from: 'legacy' }
        }))
      }));
      plan.checklist = plan.checklist || [];
      plan.observacoes = plan.observacoes || 'Plano convertido automaticamente do formato legado.';
      plan.racional = plan.racional || ['Conversão automática (legado→rico).'];
      delete plan.dias;
    }

    res.json({
      id: found.id,
      createdAt: found.createdAt,
      ...payload,
      plan,
    });
  } catch (e) {
    console.error('GET /planner/:id error', e);
    res.status(500).json({ error: 'erro interno' });
  }
});

// PATCH /planner/:id/block
app.patch('/planner/:id/block', async (req, res) => {
  try {
    const { id } = req.params;
    const { userId, date, start, done = true } = req.body || {};
    if (!userId || !date || !start) {
      return res.status(400).json({ error: 'userId, date, start obrigatórios' });
    }

    const items = await listEvents(userId, 10000);
    const found = items.find(it => it.id === id && it.type === 'plan');
    if (!found) return res.status(404).json({ error: 'Plano não encontrado' });

    const plan = found.payload?.plan || {};
    const day = (plan.schedule || []).find(d => d.data === date);
    if (!day) return res.status(404).json({ error: 'Dia não encontrado' });

    const blk = (day.blocos || []).find(b => b.inicio === start);
    if (!blk) return res.status(404).json({ error: 'Bloco não encontrado' });

    blk.done = Boolean(done);
    blk.doneAt = done ? nowISO() : null;

    await removeEvent(id, userId);
    await addEvent(found);

    res.json({ ok: true, block: blk });
  } catch (e) {
    console.error('PATCH /planner/:id/block error', e);
    res.status(500).json({ error: 'erro interno' });
  }
});


// PATCH /planner/:id/checklist/:itemId
app.patch('/planner/:id/checklist/:itemId', async (req, res) => {
  try {
    const { id, itemId } = req.params;
    const { userId, done = true } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId é obrigatório' });

    const items = await listEvents(userId, 10000);
    const found = items.find(it => it.id === id && it.type === 'plan');
    if (!found) return res.status(404).json({ error: 'Plano não encontrado' });

    const plan = found.payload?.plan || {};
    if (!Array.isArray(plan.checklist)) plan.checklist = [];

    plan.checklist = plan.checklist.map(ch =>
      ch.id === itemId
        ? { ...ch, done: Boolean(done), doneAt: done ? nowISO() : null }
        : ch
    );

    await removeEvent(id, userId);
    await addEvent(found);

    res.json({ ok: true, checklist: plan.checklist });
  } catch (e) {
    console.error('PATCH /planner/:id/checklist/:itemId error', e);
    res.status(500).json({ error: 'erro interno' });
  }
});


// PATCH /planner/:id/favorite
app.patch('/planner/:id/favorite', async (req, res) => {
  try {
    const { id } = req.params;
    const { userId, favorite } = req.body || {};
    if (!userId || typeof favorite !== 'boolean') {
      return res.status(400).json({ error: 'userId e favorite (boolean) são obrigatórios' });
    }

    const items = await listEvents(userId, 10000);
    const found = items.find(it => it.id === id && it.type === 'plan');
    if (!found) return res.status(404).json({ error: 'Plano não encontrado' });

    found.payload = { ...(found.payload || {}), favorite: Boolean(favorite) };

    await removeEvent(id, userId);
    await addEvent(found);

    res.json({ ok: true });
  } catch (e) {
    console.error('PATCH /planner/:id/favorite error', e);
    res.status(500).json({ error: 'erro interno' });
  }
});


// DELETE /planner/:id
app.delete('/planner/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.query || {};
    if (!userId) return res.status(400).json({ error: 'userId é obrigatório' });

    const items = await listEvents(userId, 10000);
    const found = items.find(it => it.id === id && it.type === 'plan');
    if (!found) return res.status(404).json({ error: 'Plano não encontrado' });

    const removed = await removeEvent(id, userId);
    res.json({ ok: removed > 0 });
  } catch (e) {
    console.error('DELETE /planner/:id error', e);
    res.status(500).json({ error: 'erro interno' });
  }
});

/* -------------------------------------------------------
   Raiz + Kanban + Boot
------------------------------------------------------- */
app.get('/', (_req, res) => res.send('help-ai-api ✅'));

registerKanban(app, { addEvent, listEvents, removeEvent, uuid, askLLMJson });

(async () => {
  try { await ensureWebAPIs(); } catch {}
  app.listen(PORT, () => {
    console.log(`API on http://localhost:${PORT}`);
  });
})();
