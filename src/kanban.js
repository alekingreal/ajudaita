// src/kanban.js
'use strict';

module.exports = function registerKanban(
  app,
  { addEvent, listEvents, removeEvent, uuid, askLLMJson }
) {
  if (!app) throw new Error('kanban: app inexistente');
  if (!addEvent || !listEvents || !removeEvent || !uuid) {
    throw new Error('kanban: db helpers/uuid ausentes');
  }
  if (!askLLMJson) throw new Error('kanban: askLLMJson ausente');

  /* =========================
   * Helpers
   * ========================= */
  // [HELP-AI] FASE1: utils de datas e progresso
  function toDate(v){ try{ return v? new Date(v): null; }catch{ return null; } }
  function isSameDay(a,b){ return a && b && a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate(); }
  function startOfDay(d){ return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function computeChecklistProgress(card){
    const ch=(card&&Array.isArray(card.checklists)?card.checklists:[]);
    let total=0, done=0;
    ch.forEach(c=>{ const it = Array.isArray(c.items)?c.items:[]; it.forEach(i=>{ total++; if(i&&i.done===true) done++; }); });
    const percent = total? Math.round((done/total)*100): 0;
    return { done, total, percent };
  }

  const TYP = 'kanban';
  const MAX = 10000;
  const nowISO = () => new Date().toISOString();

  function getAll(userId) {
    return (listEvents(userId, MAX) || []).filter((e) => e.type === TYP);
  }

  function save(kind, userId, payload, idOpt) {
    const id = idOpt || uuid();
    addEvent({
      id,
      userId,
      type: TYP,
      payload: { kind, ...payload },
      createdAt: nowISO(),
    });
    return id;
  }

  function updateById(userId, id, patchPayloadFn) {
    const all = getAll(userId);
    const found = all.find((e) => e.id === id);
    if (!found) return null;
    const next = { ...found, payload: patchPayloadFn(found.payload) };
    removeEvent(id, userId);
    addEvent(next);
    return next;
  }

  function removeById(userId, id) {
    return removeEvent(id, userId) > 0;
  }

  // ===== Validação do plano do LLM =====
  const { z } = require('zod');

  const ChecklistSchema = z.object({
    title: z.string().trim().min(1).max(120).optional(),
    items: z.array(z.string().trim().min(1)).default([]),
  });

  const OpCreateCard = z.object({
    action: z.literal('createCard'),
    listTitle: z.string().trim().min(1).max(120),
    title: z.string().trim().min(1).max(120),
    description: z.string().max(5000).optional(),
    due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    startTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    endTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    labels: z.array(z.string().trim().min(1).max(24)).optional(),
    checklists: z.array(ChecklistSchema).optional(),
    meta: z.record(z.any()).optional(),
  });

  const OpUpdateCard = z.object({
    action: z.literal('updateCard'),
    select: z.object({
      byId: z.string().uuid().optional(),
      byTitle: z.string().trim().min(1).max(120).optional(),
    }),
    patch: z.object({
      title: z.string().trim().min(1).max(120).optional(),
      description: z.string().max(5000).optional(),
      due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      startTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
      endTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
      labels: z.array(z.string().trim().min(1).max(24)).optional(),
      favorite: z.boolean().optional(),
      done: z.boolean().optional(),
      meta: z.record(z.any()).optional(),
    }),
  });

  const OpMoveCard = z.object({
    action: z.literal('moveCard'),
    select: z.object({
      byId: z.string().uuid().optional(),
      byTitle: z.string().trim().min(1).max(120).optional(),
    }),
    toListTitle: z.string().trim().min(1).max(120),
    toIndex: z.number().int().nonnegative().optional(),
  });

  const PlanSchema = z.object({
    lists: z
      .array(z.object({ ensure: z.object({ title: z.string().trim().min(1).max(120) }) }))
      .default([]),
    ops: z
      .array(z.discriminatedUnion('action', [OpCreateCard, OpUpdateCard, OpMoveCard]))
      .default([]),
  });

  function parsePlan(raw) {
    let obj = raw;
    if (typeof raw === 'string') {
      try {
        obj = JSON.parse(raw);
      } catch {
        obj = {};
      }
    }
    const parsed = PlanSchema.safeParse(obj || {});
    if (!parsed.success) {
      console.warn('[ai/plan] zod errors:', parsed.error.issues?.slice(0, 3));
      return { lists: [], ops: [] };
    }
    const lists = (parsed.data.lists || []).slice(0, 50);
    const ops = (parsed.data.ops || []).slice(0, 200);
    return { lists, ops };
  }

  // ===== Helpers de normalização =====
  const norm = {
    label(s) {
      return String(s || '').trim().toLowerCase().replace(/\s+/g, '').slice(0, 24);
    },
    date(s) {
      return /^\d{4}-\d{2}-\d{2}$/.test(s || '') ? s : null;
    },
    time(s) {
      return /^\d{2}:\d{2}$/.test(s || '') ? s : null;
    },
  };

  /* =========================
   * Boards
   * ========================= */
  // [HELP-AI] GET /kanban/boards/:id?userId
  app.get('/kanban/boards/:id', (req, res) => {
    const { id } = req.params;
    const { userId } = req.query || {};
    if (!userId) return res.status(400).json({ error: 'userId é obrigatório' });
    const all = getAll(userId);
    const ev = all.find(e=> e.id===id && e.payload?.kind==='board');
    if(!ev) return res.status(404).json({ error: 'Board não encontrado' });
    const board = { id: ev.id, title: ev.payload.title, description: ev.payload.description || '', favorite: !!ev.payload.favorite, createdAt: ev.createdAt };
    return res.json({ board });
  });


  // GET /kanban/boards?userId
  app.get('/kanban/boards', (req, res) => {
    const { userId } = req.query || {};
    if (!userId) return res.status(400).json({ error: 'userId é obrigatório' });
    const boards = getAll(userId)
      .filter((e) => e.payload?.kind === 'board')
      .map((e) => ({
        id: e.id,
        title: e.payload.title,
        description: e.payload.description || '',
        favorite: !!e.payload.favorite,
        createdAt: e.createdAt,
      }));
    res.json({ boards });
  });

  // POST /kanban/boards { userId, title, description? }
  app.post('/kanban/boards', (req, res) => {
    const { userId, title, description = '' } = req.body || {};
    if (!userId || !title?.trim())
      return res.status(400).json({ error: 'userId e title obrigatórios' });

    const id = save('board', userId, {
      title: String(title).trim(),
      description: String(description || '').trim(),
      favorite: false,
    });

    // listas padrão
    const defaults = ['A Fazer', 'Fazendo', 'Feito'];
    const defaultLists = defaults.map((ttl, i) => {
      const lid = save('list', userId, {
        boardId: id,
        title: ttl,
        order: (i + 1) * 100,
        createdAt: nowISO(),
      });
      return { id: lid, boardId: id, title: ttl, order: (i + 1) * 100 };
    });

    res.json({
      board: {
        id,
        title: String(title).trim(),
        description: String(description || ''),
        favorite: false,
        createdAt: nowISO(),
      },
      defaultLists,
    });
  });

  // PATCH /kanban/boards/:id { userId, title?, description?, favorite? }
  app.patch('/kanban/boards/:id', (req, res) => {
    const { id } = req.params;
    const { userId, title, description, favorite } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId é obrigatório' });

    const updated = updateById(userId, id, (p) => {
      if (p.kind !== 'board') return p;
      return {
        ...p,
        title: typeof title === 'string' ? title : p.title,
        description: typeof description === 'string' ? description : p.description,
        favorite: typeof favorite === 'boolean' ? favorite : p.favorite,
      };
    });
    if (!updated) return res.status(404).json({ error: 'Board não encontrado' });

    res.json({
      board: {
        id: updated.id,
        title: updated.payload.title,
        description: updated.payload.description || '',
        favorite: !!updated.payload.favorite,
        createdAt: updated.createdAt,
      },
    });
  });

  // DELETE /kanban/boards/:id?userId
  app.delete('/kanban/boards/:id', (req, res) => {
    const { id } = req.params;
    const { userId } = req.query || {};
    if (!userId) return res.status(400).json({ error: 'userId é obrigatório' });

    const all = getAll(userId);
    const lists = all.filter((e) => e.payload?.kind === 'list' && e.payload.boardId === id);
    const cards = all.filter((e) => e.payload?.kind === 'card' && e.payload.boardId === id);
    lists.forEach((l) => removeEvent(l.id, userId));
    cards.forEach((c) => removeEvent(c.id, userId));

    const ok = removeById(userId, id);
    return res.json({ ok });
  });

  /* =========================
   * AI Planner p/ Boards
   * ========================= */
  // POST /kanban/ai/plan { userId, boardId, prompt, dryRun?, preferencias? }
  app.post('/kanban/ai/plan', async (req, res) => {
    try {
      let {
        userId,
        boardId: boardIdIn,
        prompt = '',
        dryRun = true,
        preferencias = {},
      } = req.body || {};
      if (!userId) return res.status(400).json({ error: 'userId é obrigatório' });

      // aceita tanto preferencias: {...} quanto preferencias: { preferencias: {...} }
      if (preferencias && preferencias.preferencias && typeof preferencias.preferencias === 'object') {
        preferencias = preferencias.preferencias;
      }

      // helpers locais (sem HTTP)
      const normTitle = (s = '') =>
        String(s).normalize('NFD').replace(/\p{Diacritic}/gu, '').trim().toLowerCase();

      const getLists = (bid) =>
        getAll(userId)
          .filter((e) => e.payload?.kind === 'list' && e.payload.boardId === bid)
          .map((e) => ({
            id: e.id,
            boardId: bid,
            title: e.payload.title,
            order: Number(e.payload.order) || 100,
            createdAt: e.createdAt,
          }))
          .sort((a, b) => a.order - b.order);

      const getCards = (bid) =>
        getAll(userId)
          .filter((e) => e.payload?.kind === 'card' && e.payload.boardId === bid)
          .map((e) => ({
            id: e.id,
            boardId: e.payload.boardId,
            listId: e.payload.listId,
            title: e.payload.title,
            description: e.payload.description || '',
            due: e.payload.due || null,
            startDate: e.payload.startDate || null,
            endDate: e.payload.endDate || null,
            startTime: e.payload.startTime || null,
            endTime: e.payload.endTime || null,
        remindAt: e.payload.remindAt || null,
            labels: e.payload.labels || [],
            checklists: e.payload.checklists || [],
            attachments: e.payload.attachments || [],
            comments: e.payload.comments || [],
            favorite: !!e.payload.favorite,
            done: !!e.payload.done,
            order: Number(e.payload.order) || 100,
            createdAt: e.createdAt,
            updatedAt: e.payload.updatedAt || e.createdAt,
            meta: e.payload.meta || null,
          }))
          .sort((a, b) => a.order - b.order);

      const createBoardLocal = (title, description = '') => {
        const id = save('board', userId, {
          title: String(title || 'Plano').trim(),
          description: String(description || '').trim(),
          favorite: false,
        });
        // listas padrão
        ['A Fazer', 'Fazendo', 'Feito'].forEach((ttl, i) => {
          save('list', userId, {
            boardId: id,
            title: ttl,
            order: (i + 1) * 100,
            createdAt: nowISO(),
          });
        });
        return id;
      };

      const getListByTitle = (listsArr, ttl) => {
        const want = normTitle(ttl);
        return listsArr.find((l) => normTitle(l.title) === want) || null;
      };

      const createListLocal = (boardId, title) => {
        const existingOrders = getAll(userId)
          .filter((e) => e.payload?.kind === 'list' && e.payload.boardId === boardId)
          .map((e) => Number(e.payload.order) || 100);
        const nextOrder = (existingOrders.length ? Math.max(...existingOrders) : 0) + 100;
        const id = save('list', userId, {
          boardId,
          title: String(title).trim(),
          order: nextOrder,
          createdAt: nowISO(),
        });
        return { id, boardId, title, order: nextOrder };
      };

      const createCardLocal = (boardId, listId, payload) => {
        const existingOrders = getAll(userId)
          .filter((e) => e.payload?.kind === 'card' && e.payload.listId === listId)
          .map((e) => Number(e.payload.order) || 100);
        const nextOrder = (existingOrders.length ? Math.max(...existingOrders) : 0) + 100;

        const id = save('card', userId, {
          boardId,
          listId,
          title: String(payload.title || 'Tarefa').trim(),
          description: String(payload.description || ''),
          due: payload.due || null,
          startDate: payload.startDate || null,
          endDate: payload.endDate || null,
          startTime: payload.startTime || null,
          endTime: payload.endTime || null,
          labels: payload.labels || [],
          checklists: payload.checklists || [],
          attachments: [],
          comments: [],
          favorite: false,
          done: false,
          order: nextOrder,
          updatedAt: nowISO(),
          meta: payload.meta || null,
        });

        const ev = getAll(userId).find((e) => e.id === id);
        const createdAtReal = ev?.createdAt || nowISO();
        return {
          id,
          boardId,
          listId,
          title: String(payload.title || 'Tarefa').trim(),
          description: String(payload.description || ''),
          due: payload.due || null,
          startDate: payload.startDate || null,
          endDate: payload.endDate || null,
          startTime: payload.startTime || null,
          endTime: payload.endTime || null,
          labels: payload.labels || [],
          checklists: payload.checklists || [],
          attachments: [],
          comments: [],
          favorite: false,
          done: false,
          order: nextOrder,
          createdAt: createdAtReal,
          updatedAt: ev?.payload?.updatedAt || createdAtReal,
          meta: payload.meta || null,
        };
      };

      const updateCardLocal = (cardId, patch) => {
        const ALLOW = [
          'title',
          'description',
          'due',
          'labels',
          'favorite',
          'done',
          'order',
          'listId',
          'boardId',
          'meta',
          'startDate',
          'endDate',
          'startTime',
          'endTime',
        ];
        const updated = updateById(userId, cardId, (p) => {
          if (p.kind !== 'card') return p;
          const next = { ...p };
          for (const k of ALLOW) if (typeof patch[k] !== 'undefined') next[k] = patch[k];
          next.updatedAt = nowISO();
          return next;
        });
        if (!updated) return null;
        const c = updated.payload;
        return {
          id: updated.id,
          boardId: c.boardId,
          listId: c.listId,
          title: c.title,
          description: c.description || '',
          due: c.due || null,
          startDate: c.startDate || null,
          endDate: c.endDate || null,
          startTime: c.startTime || null,
          endTime: c.endTime || null,
        remindAt: c.remindAt || null,
          labels: c.labels || [],
          checklists: c.checklists || [],
          attachments: c.attachments || [],
          comments: c.comments || [],
          favorite: !!c.favorite,
          done: !!c.done,
          order: Number(c.order) || 100,
          createdAt: updated.createdAt,
          updatedAt: c.updatedAt || updated.createdAt,
          meta: c.meta || null,
        };
      };

      const moveCardLocal = (cardId, toListId, toIndex) => {
        const all = getAll(userId);
        const destListEv = all.find((e) => e.id === toListId && e.payload?.kind === 'list');
        if (!destListEv) return null;

        const cardEv = all.find((e) => e.id === cardId && e.payload?.kind === 'card');
        if (!cardEv) return null;

        const fromListId = cardEv.payload.listId;

        const destCards = all
          .filter((e) => e.payload?.kind === 'card' && e.payload.listId === toListId && e.id !== cardEv.id)
          .sort((a, b) => Number(a.payload.order || 100) - Number(b.payload.order || 100));

        const insertAt = Number.isInteger(toIndex)
          ? Math.min(Math.max(0, toIndex), destCards.length)
          : destCards.length;

        const finalDest = destCards
          .slice(0, insertAt)
          .concat([cardEv])
          .concat(destCards.slice(insertAt));

        let movedPayload = null;
        let movedCreatedAt = cardEv.createdAt;

        finalDest.forEach((ev, i) => {
          const newOrder = (i + 1) * 100;
          if (ev.id === cardEv.id) {
            const updated = {
              ...ev,
              payload: {
                ...ev.payload,
                listId: toListId,
                boardId: destListEv.payload.boardId,
                order: newOrder,
                updatedAt: nowISO(),
              },
            };
            removeEvent(ev.id, userId);
            addEvent(updated);
            movedPayload = updated.payload;
            movedCreatedAt = updated.createdAt;
          } else if (Number(ev.payload.order || 0) !== newOrder) {
            removeEvent(ev.id, userId);
            addEvent({ ...ev, payload: { ...ev.payload, order: newOrder, updatedAt: nowISO() } });
          }
        });

        if (fromListId && fromListId !== toListId) {
          const sourceCards = all
            .filter((e) => e.payload?.kind === 'card' && e.payload.listId === fromListId && e.id !== cardEv.id)
            .sort((a, b) => Number(a.payload.order || 100) - Number(b.payload.order || 100));
          sourceCards.forEach((ev, i) => {
            const newOrder = (i + 1) * 100;
            if (Number(ev.payload.order || 0) !== newOrder) {
              removeEvent(ev.id, userId);
              addEvent({ ...ev, payload: { ...ev.payload, order: newOrder, updatedAt: nowISO() } });
            }
          });
        }

        if (!movedPayload) {
          const after = getAll(userId);
          const movedEv = after.find((e) => e.id === cardId && e.payload?.kind === 'card');
          if (!movedEv) return null;
          movedPayload = movedEv.payload;
          movedCreatedAt = movedEv.createdAt;
        }

        const c = movedPayload;
        return {
          id: cardId,
          boardId: c.boardId,
          listId: c.listId,
          title: c.title,
          description: c.description || '',
          due: c.due || null,
          labels: c.labels || [],
          checklists: c.checklists || [],
          attachments: c.attachments || [],
          comments: c.comments || [],
          favorite: !!c.favorite,
          done: !!c.done,
          order: Number(c.order) || 100,
          createdAt: movedCreatedAt,
          updatedAt: c.updatedAt || movedCreatedAt,
          meta: c.meta || null,
        };
      };

      // ===== 1) board alvo — NUNCA gravar no dryRun =====
      let workingBoardId = boardIdIn;
      if (!workingBoardId) {
        if (dryRun) {
          // ID temporário somente para snapshot/LLM
          workingBoardId = '__preview__';
        } else {
          const title =
            preferencias?.boardTitle ||
            `Plano de estudos - ${new Date().toLocaleDateString('pt-BR')}`;
          workingBoardId = createBoardLocal(title, preferencias?.boardDescription || '');
        }
      }

      // ===== snapshot =====
      let lists, cards;
      if (workingBoardId === '__preview__') {
        // snapshot em memória (sem tocar disco)
        const target = preferencias?.targetListTitle || 'A Fazer';
        lists = [
          { id: '__L1__', boardId: workingBoardId, title: target, order: 100, createdAt: nowISO() },
          { id: '__L2__', boardId: workingBoardId, title: 'Fazendo', order: 200, createdAt: nowISO() },
          { id: '__L3__', boardId: workingBoardId, title: 'Feito', order: 300, createdAt: nowISO() },
        ];
        cards = [];
      } else {
        lists = getLists(workingBoardId);
        cards = getCards(workingBoardId);
      }

      // ===== 2) chama LLM (sem HTTP interno) =====
      // ===== 2) chama LLM (sem self-HTTP) =====
const system = `Você é um planejador que TRABALHA EXCLUSIVAMENTE com Quadros Kanban.
Retorne APENAS JSON válido no formato abaixo (sem comentários, sem texto fora do JSON).

{
  "lists": [{"ensure":{"title":"string"}}],
  "ops": [
    {
      "action": "createCard",
      "listTitle": "string",
      "title": "string",
      "description": "string?",
      "due": "YYYY-MM-DD?",
      "startDate": "YYYY-MM-DD?",
      "endDate": "YYYY-MM-DD?",
      "startTime": "HH:MM?",
      "endTime": "HH:MM?",
      "labels": ["curtas_sem_espaco"]?,
      "checklists": [{"title":"string","items":["..."]}]?,
      "meta": {}
    },
    {
      "action": "updateCard",
      "select": { "byId": "uuid?", "byTitle": "string?" },
      "patch": {
        "title":"string?", "description":"string?", "due":"YYYY-MM-DD?",
        "startDate":"YYYY-MM-DD?", "endDate":"YYYY-MM-DD?",
        "startTime":"HH:MM?", "endTime":"HH:MM?",
        "labels":["curtas"]?, "favorite":true?, "done":false?, "meta": {}
      }
    },
    {
      "action": "moveCard",
      "select": { "byId": "uuid?", "byTitle": "string?" },
      "toListTitle": "string",
      "toIndex": 0?
    }
  ]
}

Regras:
- Use listas existentes quando fizer sentido; crie novas em "lists.ensure" quando necessário.
- Converta o pedido do usuário em cards claros e objetivos, com datas/horas e checklists úteis.
- Labels devem ser curtas (sem espaços), ex.: ["alta","prova","listening"].
- NÃO invente IDs; para referenciar cards existentes, use "select.byTitle" se não souber o id.`;

const user = `BOARD SNAPSHOT
Listas:
${lists.map(l => `- ${l.id} | ${l.title}`).join('\n')}

Cards:
${cards.slice(0,200).map(c => `- ${c.id} | ${c.title} @${lists.find(l => l.id===c.listId)?.title || '??'}`).join('\n')}

Preferências: ${JSON.stringify(preferencias || {})}
Pedido:
"${prompt}"
Produza apenas o JSON pedido.`;

// ==== CHAMADA LLM
let planRaw = await askLLMJson({ system, user, max_tokens: 1200, temperature: 0.15 });

// valida e parseia
let { lists: ensureLists, ops } = parsePlan(planRaw);

// ===== Fallback local: se nada veio da IA, gerar cards básicos (ex.: inglês 30min por 5 dias)
if ((!ensureLists || ensureLists.length === 0) && (!ops || ops.length === 0)) {
  console.warn('[ai/plan] IA retornou vazio; usando fallback local.');
  const targetListTitle = preferencias?.targetListTitle || (preferencias?.preferDefaultList ? 'A Fazer' : 'A Fazer');

  const dias = ['Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta'];
  const hoje = new Date();
  const yyyy = hoje.getFullYear();
  const mm = String(hoje.getMonth()+1).padStart(2,'0');
  const dd = String(hoje.getDate()).padStart(2,'0');

  ensureLists = []; // não cria lista extra se preferimos default

  ops = dias.flatMap((dia, idx) => {
    const startH = 19; // noturno como default
    const d = new Date(hoje.getTime() + idx*86400000);
    const dateStr = d.toISOString().slice(0,10);

    const blocos = [
      { titulo:'Vocabulário', desc:'30min — 10 palavras novas + frases curtas.', label:'vocab' },
      { titulo:'Listening',   desc:'30min — vídeo curto/podcast com repetição.', label:'listening' },
    ];

    return blocos.map((b, j) => ({
      action: 'createCard',
      listTitle: targetListTitle,
      title: `${dia}: ${b.titulo} (30min)`,
      description: b.desc,
      startDate: dateStr,
      startTime: `${String(startH + j).padStart(2,'0')}:00`,
      endDate: dateStr,
      endTime: `${String(startH + j).padStart(2,'0')}:30`,
      labels: [b.label, 'ingles'],
      checklists: [
        { title: 'Checklist', items: ['Ajustar dificuldade', 'Revisar anotações', 'Registrar aprendizados'] }
      ],
      meta: { from: 'fallback' }
    }));
  });
}

if (dryRun) {
  return res.json({
    preview: { ensureLists, ops },
    stats: { lists: lists.length, cards: cards.length },
  });
}


      // ===== 3) aplicar =====
      const preferDefault = !!preferencias?.preferDefaultList;
      const targetListTitle =
        preferencias?.targetListTitle || (preferDefault ? 'A Fazer' : null);

      // ensureList cria somente no apply (não no preview)
      const ensureList = (title) => {
        if (targetListTitle) {
          const t = getListByTitle(lists, targetListTitle);
          if (t) return t;
        }
        const found = getListByTitle(lists, title);
        if (found) return found;

        const desired =
          preferDefault && normTitle(title).includes('a fazer') ? 'A Fazer' : title;

        const created = createListLocal(workingBoardId, desired);
        lists = getLists(workingBoardId); // refresh
        return created;
      };

      // aplica ensures (somente no apply)
      if (!preferDefault) {
        for (const it of ensureLists) {
          const t = it?.ensure?.title;
          if (t) ensureList(t);
        }
        lists = getLists(workingBoardId);
      }

      const created = [];
      const updated = [];
      const moved = [];

      for (const op of ops) {
        try {
          if (op.action === 'createCard') {
            const L = ensureList(op.listTitle);
            if (!L) continue;

            const labels = Array.isArray(op.labels)
              ? op.labels
                  .map((s) =>
                    String(s || '').trim().toLowerCase().replace(/\s+/g, '').slice(0, 24)
                  )
                  .filter(Boolean)
              : [];

            const payload = {
              title: op.title?.slice(0, 120) || 'Tarefa',
              description: op.description || '',
              due: /^\d{4}-\d{2}-\d{2}$/.test(op.due || '') ? op.due : null,
              startDate: /^\d{4}-\d{2}-\d{2}$/.test(op.startDate || '') ? op.startDate : null,
              endDate: /^\d{4}-\d{2}-\d{2}$/.test(op.endDate || '') ? op.endDate : null,
              startTime: /^\d{2}:\d{2}$/.test(op.startTime || '') ? op.startTime : null,
              endTime: /^\d{2}:\d{2}$/.test(op.endTime || '') ? op.endTime : null,
              labels,
              meta: op.meta || null,
            };

            const c = createCardLocal(workingBoardId, L.id, payload);

            if (Array.isArray(op.checklists)) {
              const full = updateById(userId, c.id, (p) => {
                if (p.kind !== 'card') return p;
                const exist = Array.isArray(p.checklists) ? p.checklists.slice() : [];
                for (const ch of op.checklists) {
                  const ckId = uuid();
                  exist.push({
                    id: ckId,
                    title: String(ch.title || 'Checklist').trim(),
                    items: (Array.isArray(ch.items) ? ch.items : []).map((t) => ({
                      id: uuid(),
                      text: String(t),
                      done: false,
                    })),
                  });
                }
                return { ...p, checklists: exist, updatedAt: nowISO() };
              });
              if (full) {
                c.checklists = full.payload.checklists || [];
              }
            }

            created.push(c);
            cards = getCards(workingBoardId);
          }

          if (op.action === 'updateCard') {
            let cur = null;
            if (op.select?.byId) {
              cur = cards.find((c) => c.id === op.select.byId);
            } else if (op.select?.byTitle) {
              const low = op.select.byTitle.trim().toLowerCase();
              cur = cards.find((c) => (c.title || '').trim().toLowerCase() === low);
            }
            if (!cur) continue;

            const patch = { ...op.patch };
            if (patch.labels) {
              patch.labels = patch.labels
                .map((s) =>
                  String(s || '').trim().toLowerCase().replace(/\s+/g, '').slice(0, 24)
                )
                .filter(Boolean);
            }
            if (patch.due && !/^\d{4}-\d{2}-\d{2}$/.test(patch.due)) delete patch.due;
            if (patch.startDate && !/^\d{4}-\d{2}-\d{2}$/.test(patch.startDate))
              delete patch.startDate;
            if (patch.endDate && !/^\d{4}-\d{2}-\d{2}$/.test(patch.endDate))
              delete patch.endDate;
            if (patch.startTime && !/^\d{2}:\d{2}$/.test(patch.startTime))
              delete patch.startTime;
            if (patch.endTime && !/^\d{2}:\d{2}$/.test(patch.endTime)) delete patch.endTime;

            const up = updateCardLocal(cur.id, { userId, ...patch });
            if (up) updated.push({ id: cur.id, patch });
            cards = getCards(workingBoardId);
          }

          if (op.action === 'moveCard') {
            let cur = null;
            if (op.select?.byId) {
              cur = cards.find((c) => c.id === op.select.byId);
            } else if (op.select?.byTitle) {
              const low = op.select.byTitle.trim().toLowerCase();
              cur = cards.find((c) => (c.title || '').trim().toLowerCase() === low);
            }
            const L = ensureList(op.toListTitle);
            if (!cur || !L) continue;

            const mv = moveCardLocal(cur.id, L.id, op.toIndex);
            if (mv) moved.push(mv);
            cards = getCards(workingBoardId);
          }
        } catch (e) {
          console.warn('[ai/plan] op error', op?.action, e?.message || e);
        }
      }

      return res.json({ ok: true, boardId: workingBoardId, created, updated, moved });
    } catch (e) {
      console.error('ai/plan error', e);
      return res.status(500).json({ error: 'erro interno' });
    }
  });

  /* =========================
   * Lists
   * ========================= */

  // GET /kanban/lists?userId&boardId
  app.get('/kanban/lists', (req, res) => {
    const { userId, boardId } = req.query || {};
    if (!userId || !boardId)
      return res.status(400).json({ error: 'userId e boardId obrigatórios' });
    const lists = getAll(userId)
      .filter((e) => e.payload?.kind === 'list' && e.payload.boardId === boardId)
      .map((e) => ({
        id: e.id,
        boardId,
        title: e.payload.title,
        order: Number(e.payload.order) || 100,
        createdAt: e.createdAt,
      }))
      .sort((a, b) => a.order - b.order);
    res.json({ lists });
  });

  // POST /kanban/lists { userId, boardId, title }
  app.post('/kanban/lists', (req, res) => {
    const { userId, boardId, title } = req.body || {};
    if (!userId || !boardId || !title?.trim()) {
      return res.status(400).json({ error: 'userId, boardId e title são obrigatórios' });
    }
    const existing = getAll(userId)
      .filter((e) => e.payload?.kind === 'list' && e.payload.boardId === boardId)
      .map((e) => Number(e.payload.order) || 100);
    const nextOrder = (existing.length ? Math.max(...existing) : 0) + 100;

    const id = save('list', userId, {
      boardId,
      title: String(title).trim(),
      order: nextOrder,
      createdAt: nowISO(),
    });

    res.json({
      list: {
        id,
        boardId,
        title: String(title).trim(),
        order: nextOrder,
        createdAt: nowISO(),
      },
    });
  });

  // PATCH /kanban/lists/reorder { userId, boardId, orderedIds: [] }
  app.patch('/kanban/lists/reorder', (req, res) => {
    const { userId, boardId, orderedIds } = req.body || {};
    if (!userId || !boardId || !Array.isArray(orderedIds)) {
      return res.status(400).json({ error: 'userId, boardId e orderedIds obrigatórios' });
    }
    const all = getAll(userId);
    orderedIds.forEach((lid, i) => {
      const ev = all.find(
        (e) => e.id === lid && e.payload?.kind === 'list' && e.payload.boardId === boardId
      );
      if (!ev) return;
      removeEvent(ev.id, userId);
      addEvent({ ...ev, payload: { ...ev.payload, order: (i + 1) * 100 } });
    });
    res.json({ ok: true });
  });

  // PATCH /kanban/lists/:id { userId, title?, order? }
  app.patch('/kanban/lists/:id', (req, res) => {
    const { id } = req.params;
    const { userId, title, order } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId é obrigatório' });

    const updated = updateById(userId, id, (p) => {
      if (p.kind !== 'list') return p;
      return {
        ...p,
        title: typeof title === 'string' ? title : p.title,
        order: typeof order === 'number' ? order : p.order,
      };
    });
    if (!updated) return res.status(404).json({ error: 'Lista não encontrada' });

    res.json({
      list: {
        id: updated.id,
        boardId: updated.payload.boardId,
        title: updated.payload.title,
        order: Number(updated.payload.order) || 100,
        createdAt: updated.createdAt,
      },
    });
  });

  // DELETE /kanban/lists/:id?userId
  app.delete('/kanban/lists/:id', (req, res) => {
    const { id } = req.params;
    const { userId } = req.query || {};
    if (!userId) return res.status(400).json({ error: 'userId é obrigatório' });

    const all = getAll(userId);
    const cards = all.filter((e) => e.payload?.kind === 'card' && e.payload.listId === id);
    cards.forEach((c) => removeEvent(c.id, userId));

    const ok = removeById(userId, id);
    res.json({ ok });
  });

  /* =========================
   * Cards
   * ========================= */
  // [HELP-AI] GET /kanban/overview?userId
  // Buckets por due: today, overdue, upcoming
  app.get('/kanban/overview', (req, res) => {
    const { userId } = req.query || {};
    if (!userId) return res.status(400).json({ error: 'userId é obrigatório' });
    const all = getAll(userId);
    const today = startOfDay(new Date());
    const cards = all.filter(e=> e.payload?.kind==='card').map(e => ({ id:e.id, ...e.payload }));
    const out = { today: [], overdue: [], upcoming: [] };
    cards.forEach(c=>{
      const d = toDate(c.due);
      if(!d){ out.upcoming.push(c.id); return; }
      const dd = startOfDay(d);
      if (dd < today) out.overdue.push(c.id);
      else if (isSameDay(dd, today)) out.today.push(c.id);
      else out.upcoming.push(c.id);
    });
    return res.json({ overview: { counts: { today: out.today.length, overdue: out.overdue.length, upcoming: out.upcoming.length }, ids: out } });
  });


  // GET /kanban/cards?userId&boardId[&listId]
  // [HELP-AI] GET /kanban/cards/enhanced?userId&boardId[&listId]
  // Retorna 'progress' e inclui 'remindAt'
  app.get('/kanban/cards/enhanced', (req, res) => {
    const { userId, boardId, listId } = req.query || {};
    if (!userId || !boardId)
      return res.status(400).json({ error: 'userId e boardId obrigatórios' });
    const result = getAll(userId)
      .filter(e => e.payload?.kind==='card' && e.payload.boardId===boardId && (!listId || e.payload.listId===listId))
      .map(e => {
        const c = {
          id: e.id,
          boardId: e.payload.boardId,
          listId: e.payload.listId,
          title: e.payload.title,
          description: e.payload.description || '',
          due: e.payload.due || null,
          startDate: e.payload.startDate || null,
          endDate: e.payload.endDate || null,
          startTime: e.payload.startTime || null,
          endTime: e.payload.endTime || null,
          remindAt: e.payload.remindAt || null,
          labels: e.payload.labels || [],
          checklists: e.payload.checklists || [],
          attachments: e.payload.attachments || [],
          comments: e.payload.comments || [],
          favorite: !!e.payload.favorite,
          done: !!e.payload.done,
          order: Number(e.payload.order) || 100,
          createdAt: e.createdAt,
          updatedAt: e.payload.updatedAt || e.createdAt,
          meta: e.payload.meta || null
        };
        return { ...c, progress: computeChecklistProgress(c) };
      })
      .sort((a,b)=> a.order - b.order);
    res.json({ cards: result });
  });

  app.get('/kanban/cards', (req, res) => {
    const { userId, boardId, listId } = req.query || {};
    if (!userId || !boardId)
      return res.status(400).json({ error: 'userId e boardId obrigatórios' });
    const result = getAll(userId)
      .filter(
        (e) =>
          e.payload?.kind === 'card' &&
          e.payload.boardId === boardId &&
          (!listId || e.payload.listId === listId)
      )
      .map((e) => ({
        id: e.id,
        boardId: e.payload.boardId,
        listId: e.payload.listId,
        title: e.payload.title,
        description: e.payload.description || '',
        due: e.payload.due || null,
        startDate: e.payload.startDate || null,
        endDate: e.payload.endDate || null,
        startTime: e.payload.startTime || null,
        endTime: e.payload.endTime || null,
        labels: e.payload.labels || [],
        checklists: e.payload.checklists || [],
        attachments: e.payload.attachments || [],
        comments: e.payload.comments || [],
        favorite: !!e.payload.favorite,
        done: !!e.payload.done,
        order: Number(e.payload.order) || 100,
        createdAt: e.createdAt,
        updatedAt: e.payload.updatedAt || e.createdAt,
        meta: e.payload.meta || null,
      }))
      .sort((a, b) => a.order - b.order);

    res.json({ cards: result });
  });

  // POST /kanban/cards { userId, boardId, listId, title, ... }
  app.post('/kanban/cards', (req, res) => {
    const {
      userId,
      boardId,
      listId,
      title,
      description = '',
      due = null,
      startDate = null,
      endDate = null,
      startTime = null,
      endTime = null,
      remindAt = null,
      meta = null,
    } = req.body || {};

    if (!userId || !boardId || !listId || !title?.trim()) {
      return res
        .status(400)
        .json({ error: 'userId, boardId, listId e title são obrigatórios' });
    }

    const existingOrders = getAll(userId)
      .filter((e) => e.payload?.kind === 'card' && e.payload.listId === listId)
      .map((e) => Number(e.payload.order) || 100);
    const nextOrder = (existingOrders.length ? Math.max(...existingOrders) : 0) + 100;

    const id = save('card', userId, {
      boardId,
      listId,
      title: String(title).trim(),
      description: String(description || ''),
      due: due || null,
      startDate: startDate || null,
      endDate: endDate || null,
      startTime: startTime || null,
      endTime: endTime || null,
      remindAt: remindAt || null,
      labels: [],
      checklists: [],
      attachments: [],
      comments: [],
      favorite: false,
      done: false,
      order: nextOrder,
      updatedAt: nowISO(),
      meta: meta || null,
    });

    const ev = getAll(userId).find((e) => e.id === id);
    const createdAtReal = ev?.createdAt || nowISO();

    res.json({
      card: {
        id,
        boardId,
        listId,
        title: String(title).trim(),
        description: String(description || ''),
        due: due || null,
        startDate: startDate || null,
        endDate: endDate || null,
        startTime: startTime || null,
        endTime: endTime || null,
        remindAt: remindAt || null,
        labels: [],
        checklists: [],
        attachments: [],
        comments: [],
        favorite: false,
        done: false,
        order: nextOrder,
        createdAt: createdAtReal,
        updatedAt: ev?.payload?.updatedAt || createdAtReal,
        meta: meta || null,
      },
    });
  });

  // PATCH /kanban/cards/reorder { userId, listId, orderedIds }
  app.patch('/kanban/cards/reorder', (req, res) => {
    const { userId, listId, orderedIds } = req.body || {};
    if (!userId || !listId || !Array.isArray(orderedIds)) {
      return res.status(400).json({ error: 'userId, listId e orderedIds obrigatórios' });
    }
    const all = getAll(userId);
    orderedIds.forEach((cid, i) => {
      const ev = all.find(
        (e) => e.id === cid && e.payload?.kind === 'card' && e.payload.listId === listId
      );
      if (!ev) return;
      removeEvent(ev.id, userId);
      addEvent({
        ...ev,
        payload: { ...ev.payload, order: (i + 1) * 100, updatedAt: nowISO() },
      });
    });
    res.json({ ok: true });
  });

  // PATCH /kanban/cards/move { userId, cardId, toListId, toIndex? }
  app.patch('/kanban/cards/move', (req, res) => {
    const { userId, cardId, toListId, toIndex } = req.body || {};
    console.log('[kanban/move] IN', { userId, cardId, toListId, toIndex });
    if (!userId || !cardId || !toListId) {
      return res.status(400).json({ error: 'userId, cardId e toListId são obrigatórios' });
    }

    const all = getAll(userId);

    const destListEv = all.find((e) => e.id === toListId && e.payload?.kind === 'list');
    if (!destListEv) {
      console.warn('[kanban/move] Dest list NOT FOUND', { userId, toListId });
      return res.status(404).json({ error: 'Lista de destino não encontrada' });
    }

    const cardEv = all.find((e) => e.id === cardId && e.payload?.kind === 'card');
    if (!cardEv) {
      console.warn('[kanban/move] Card NOT FOUND', { userId, cardId });
      return res.status(404).json({ error: 'Card não encontrado' });
    }

    const fromListId = cardEv.payload.listId;

    const destCards = all
      .filter(
        (e) =>
          e.payload?.kind === 'card' && e.payload.listId === toListId && e.id !== cardEv.id
      )
      .sort(
        (a, b) => Number(a.payload.order || 100) - Number(b.payload.order || 100)
      );

    const insertAt = Number.isInteger(toIndex)
      ? Math.min(Math.max(0, toIndex), destCards.length)
      : destCards.length;

    const finalDest = destCards.slice(0, insertAt).concat([cardEv]).concat(destCards.slice(insertAt));

    let movedPayload = null;
    let movedCreatedAt = cardEv.createdAt;

    finalDest.forEach((ev, i) => {
      const newOrder = (i + 1) * 100;
      if (ev.id === cardEv.id) {
        const updated = {
          ...ev,
          payload: {
            ...ev.payload,
            listId: toListId,
            boardId: destListEv.payload.boardId,
            order: newOrder,
            updatedAt: nowISO(),
          },
        };
        removeEvent(ev.id, userId);
        addEvent(updated);
        movedPayload = updated.payload;
        movedCreatedAt = updated.createdAt;
      } else if (Number(ev.payload.order || 0) !== newOrder) {
        removeEvent(ev.id, userId);
        addEvent({
          ...ev,
          payload: { ...ev.payload, order: newOrder, updatedAt: nowISO() },
        });
      }
    });

    if (fromListId && fromListId !== toListId) {
      const sourceCards = all
        .filter(
          (e) =>
            e.payload?.kind === 'card' && e.payload.listId === fromListId && e.id !== cardEv.id
        )
        .sort(
          (a, b) => Number(a.payload.order || 100) - Number(b.payload.order || 100)
        );

      sourceCards.forEach((ev, i) => {
        const newOrder = (i + 1) * 100;
        if (Number(ev.payload.order || 0) !== newOrder) {
          removeEvent(ev.id, userId);
          addEvent({
            ...ev,
            payload: { ...ev.payload, order: newOrder, updatedAt: nowISO() },
          });
        }
      });
    }

    if (!movedPayload) {
      const after = getAll(userId);
      const movedEv = after.find((e) => e.id === cardId && e.payload?.kind === 'card');
      if (!movedEv) return res.status(500).json({ error: 'Falha ao localizar card após mover' });
      movedPayload = movedEv.payload;
      movedCreatedAt = movedEv.createdAt;
    }

    const c = movedPayload;
    return res.json({
      ok: true,
      card: {
        id: cardId,
        boardId: c.boardId,
        listId: c.listId,
        title: c.title,
        description: c.description || '',
        due: c.due || null,
        labels: c.labels || [],
        checklists: c.checklists || [],
        attachments: c.attachments || [],
        comments: c.comments || [],
        favorite: !!c.favorite,
        done: !!c.done,
        order: Number(c.order) || 100,
        createdAt: movedCreatedAt,
        updatedAt: c.updatedAt || movedCreatedAt,
        meta: c.meta || null,
      },
      toListId,
      index: insertAt,
    });
  });

  // util: GET /kanban/cards/byid/:id?userId=...
  app.get('/kanban/cards/byid/:id', (req, res) => {
    const { id } = req.params;
    const { userId } = req.query || {};
    if (!userId) return res.status(400).json({ error: 'userId é obrigatório' });
    const all = getAll(userId);
    const cardEv = all.find((e) => e.id === id && e.payload?.kind === 'card');
    if (!cardEv) return res.status(404).json({ error: 'Card não encontrado para este userId' });
    return res.json({ ok: true, id: cardEv.id, payload: cardEv.payload });
  });

  // GET /kanban/cards/:id?userId     (detalhe)
  app.get('/kanban/cards/:id', (req, res) => {
    const { id } = req.params;
    const { userId } = req.query || {};
    if (!userId) return res.status(400).json({ error: 'userId é obrigatório' });

    const all = getAll(userId);
    const ev = all.find((e) => e.id === id && e.payload?.kind === 'card');
    if (!ev) return res.status(404).json({ error: 'Card não encontrado' });

    const p = ev.payload;
    res.json({
      card: {
        id: ev.id,
        boardId: p.boardId,
        listId: p.listId,
        title: p.title,
        description: p.description || '',
        due: p.due || null,
        startDate: p.startDate || null,
        endDate: p.endDate || null,
        startTime: p.startTime || null,
        endTime: p.endTime || null,
        labels: p.labels || [],
        checklists: p.checklists || [],
        attachments: p.attachments || [],
        comments: p.comments || [],
        favorite: !!p.favorite,
        done: !!p.done,
        order: Number(p.order) || 100,
        createdAt: ev.createdAt,
        updatedAt: p.updatedAt || ev.createdAt,
        meta: p.meta || null,
      },
    });
  });

  // PATCH /kanban/cards/:id { userId, ...patch }// PATCH /kanban/cards/:id { userId, ...patch }
app.patch('/kanban/cards/:id', (req, res) => {
  const { id } = req.params;
  const { userId, ...patch } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'userId é obrigatório' });

  const ALLOW = [
    'title', 'description', 'due', 'labels', 'favorite', 'done', 'order',
    'listId', 'boardId', 'meta', 'startDate', 'endDate', 'startTime', 'endTime',
    'remindAt'
  ];

  const updated = updateById(userId, id, (p) => {
    if (p.kind !== 'card') return p;
    const next = { ...p };
    for (const k of ALLOW) if (typeof patch[k] !== 'undefined') next[k] = patch[k];
    next.updatedAt = nowISO();
    return next;
  });
  if (!updated) return res.status(404).json({ error: 'Card não encontrado' });

  const c = updated.payload;
  return res.json({
    card: {
      id: updated.id,
      boardId: c.boardId,
      listId: c.listId,
      title: c.title,
      description: c.description || '',
      due: c.due || null,
      startDate: c.startDate || null,
      endDate: c.endDate || null,
      startTime: c.startTime || null,
      endTime: c.endTime || null,
      remindAt: c.remindAt || null,
      labels: c.labels || [],
      checklists: c.checklists || [],
      attachments: c.attachments || [],
      comments: c.comments || [],
      favorite: !!c.favorite,
      done: !!c.done,
      order: Number(c.order) || 100,
      createdAt: updated.createdAt,
      updatedAt: c.updatedAt || updated.createdAt,
      meta: c.meta || null
    }
  });
});

// DELETE /kanban/cards/:id?userId// DELETE /kanban/cards/:id?userId
  app.delete('/kanban/cards/:id', (req, res) => {
    const { id } = req.params;
    const { userId } = req.query || {};
    if (!userId) return res.status(400).json({ error: 'userId é obrigatório' });
    const ok = removeById(userId, id);
    res.json({ ok });
  });

  /* =========================
   * Checklists
   * ========================= */

  // POST /kanban/cards/:cardId/checklist { userId, title }
  app.post('/kanban/cards/:cardId/checklist', (req, res) => {
    const { cardId } = req.params;
    const { userId, title } = req.body || {};
    if (!userId || !title?.trim())
      return res.status(400).json({ error: 'userId e title obrigatórios' });

    const updated = updateById(userId, cardId, (p) => {
      if (p.kind !== 'card') return p;
      const checklists = Array.isArray(p.checklists) ? p.checklists.slice() : [];
      checklists.push({ id: uuid(), title: String(title).trim(), items: [] });
      return { ...p, checklists, updatedAt: nowISO() };
    });
    if (!updated) return res.status(404).json({ error: 'Card não encontrado' });

    res.json({ checklists: updated.payload.checklists || [] });
  });

  // PATCH /kanban/cards/:cardId/checklist/:cid { userId, title }
  app.patch('/kanban/cards/:cardId/checklist/:cid', (req, res) => {
    const { cardId, cid } = req.params;
    const { userId, title } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId é obrigatório' });

    const updated = updateById(userId, cardId, (p) => {
      if (p.kind !== 'card') return p;
      const checklists = (p.checklists || []).map((ch) =>
        ch.id === cid ? { ...ch, title: typeof title === 'string' ? title : ch.title } : ch
      );
      return { ...p, checklists, updatedAt: nowISO() };
    });
    if (!updated) return res.status(404).json({ error: 'Card não encontrado' });

    res.json({ checklists: updated.payload.checklists || [] });
  });

  // POST /kanban/cards/:cardId/checklist/:cid/item { userId, text }
  app.post('/kanban/cards/:cardId/checklist/:cid/item', (req, res) => {
    const { cardId, cid } = req.params;
    const { userId, text } = req.body || {};
    if (!userId || !text?.trim())
      return res.status(400).json({ error: 'userId e text obrigatórios' });

    const updated = updateById(userId, cardId, (p) => {
      if (p.kind !== 'card') return p;
      const checklists = (p.checklists || []).map((ch) => {
        if (ch.id !== cid) return ch;
        const items = Array.isArray(ch.items) ? ch.items.slice() : [];
        items.push({ id: uuid(), text: String(text).trim(), done: false });
        return { ...ch, items };
      });
      return { ...p, checklists, updatedAt: nowISO() };
    });
    if (!updated) return res.status(404).json({ error: 'Card não encontrado' });

    res.json({ checklists: updated.payload.checklists || [] });
  });

  // PATCH /kanban/cards/:cardId/checklist/:cid/item/:iid { userId, text?, done? }
  app.patch('/kanban/cards/:cardId/checklist/:cid/item/:iid', (req, res) => {
    const { cardId, cid, iid } = req.params;
    const { userId, text, done } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId é obrigatório' });

    const updated = updateById(userId, cardId, (p) => {
      if (p.kind !== 'card') return p;
      const checklists = (p.checklists || []).map((ch) => {
        if (ch.id !== cid) return ch;
        const items = (ch.items || []).map((it) =>
          it.id === iid
            ? {
                ...it,
                text: typeof text === 'string' ? text : it.text,
                done: typeof done === 'boolean' ? done : it.done,
              }
            : it
        );
        return { ...ch, items };
      });
      return { ...p, checklists, updatedAt: nowISO() };
    });
    if (!updated) return res.status(404).json({ error: 'Card não encontrado' });

    res.json({ checklists: updated.payload.checklists || [] });
  });

  // DELETE /kanban/cards/:cardId/checklist/:cid/item/:iid?userId
  app.delete('/kanban/cards/:cardId/checklist/:cid/item/:iid', (req, res) => {
    const { cardId, cid, iid } = req.params;
    const { userId } = req.query || {};
    if (!userId) return res.status(400).json({ error: 'userId é obrigatório' });

    const updated = updateById(userId, cardId, (p) => {
      if (p.kind !== 'card') return p;
      const checklists = (p.checklists || []).map((ch) => {
        if (ch.id !== cid) return ch;
        return { ...ch, items: (ch.items || []).filter((it) => it.id !== iid) };
      });
      return { ...p, checklists, updatedAt: nowISO() };
    });
    if (!updated) return res.status(404).json({ error: 'Card não encontrado' });

    res.json({ checklists: updated.payload.checklists || [] });
  });

  /* =========================
   * Comentários
   * ========================= */

  // POST /kanban/cards/:cardId/comments { userId, text }
  app.post('/kanban/cards/:cardId/comments', (req, res) => {
    const { cardId } = req.params;
    const { userId, text } = req.body || {};
    if (!userId || !text?.trim())
      return res.status(400).json({ error: 'userId e text obrigatórios' });

    const updated = updateById(userId, cardId, (p) => {
      if (p.kind !== 'card') return p;
      const comments = Array.isArray(p.comments) ? p.comments.slice() : [];
      comments.push({ id: uuid(), text: String(text).trim(), ts: nowISO() });
      return { ...p, comments, updatedAt: nowISO() };
    });
    if (!updated) return res.status(404).json({ error: 'Card não encontrado' });

    res.json({ comments: updated.payload.comments || [] });
  });

  // DELETE /kanban/cards/:cardId/comments/:commentId?userId
  app.delete('/kanban/cards/:cardId/comments/:commentId', (req, res) => {
    const { cardId, commentId } = req.params;
    const { userId } = req.query || {};
    if (!userId) return res.status(400).json({ error: 'userId é obrigatório' });

    const updated = updateById(userId, cardId, (p) => {
      if (p.kind !== 'card') return p;
      const comments = (p.comments || []).filter((c) => c.id !== commentId);
      return { ...p, comments, updatedAt: nowISO() };
    });
    if (!updated) return res.status(404).json({ error: 'Card não encontrado' });

    res.json({ comments: updated.payload.comments || [] });
  });
};
