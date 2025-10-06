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

  // ===== DB helpers ASSÍNCRONOS
  async function getAll(userId) {
    const rows = await listEvents(userId, MAX);
    return (rows || []).filter(e => e.type === TYP);
  }

  async function save(kind, userId, payload, idOpt) {
    const id = idOpt || uuid();
    await addEvent({
      id,
      userId,
      type: TYP,
      payload: { kind, ...payload },
      createdAt: nowISO(),
    });
    return id;
  }

  async function updateById(userId, id, patchPayloadFn) {
    const all = await getAll(userId);
    const found = all.find(e => e.id === id);
    if (!found) return null;
    const next = { ...found, payload: patchPayloadFn(found.payload) };
    await removeEvent(id, userId);
    await addEvent(next);
    return next;
  }

  async function removeById(userId, id) {
    const n = await removeEvent(id, userId);
    return n > 0;
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
      try { obj = JSON.parse(raw); } catch { obj = {}; }
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

  const norm = {
    label(s){ return String(s||'').trim().toLowerCase().replace(/\s+/g,'').slice(0,24); },
    date(s){ return /^\d{4}-\d{2}-\d{2}$/.test(s||'') ? s : null; },
    time(s){ return /^\d{2}:\d{2}$/.test(s||'') ? s : null; },
  };

  /* =========================
   * Boards
   * ========================= */
  app.get('/kanban/boards/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const { userId } = req.query || {};
      if (!userId) return res.status(400).json({ error: 'userId é obrigatório' });

      const all = await getAll(userId);
      const ev = all.find(e => e.id === id && e.payload?.kind === 'board');
      if (!ev) return res.status(404).json({ error: 'Board não encontrado' });

      const board = {
        id: ev.id,
        title: ev.payload.title,
        description: ev.payload.description || '',
        favorite: !!ev.payload.favorite,
        createdAt: ev.createdAt,
      };
      return res.json({ board });
    } catch (e) {
      console.error('GET /kanban/boards/:id error', e);
      return res.status(500).json({ error: 'erro interno' });
    }
  });

  app.get('/kanban/boards', async (req, res) => {
    try {
      const { userId } = req.query || {};
      if (!userId) return res.status(400).json({ error: 'userId é obrigatório' });

      const all = await getAll(userId);
      const boards = all
        .filter(e => e.payload?.kind === 'board')
        .map(e => ({
          id: e.id,
          title: e.payload.title,
          description: e.payload.description || '',
          favorite: !!e.payload.favorite,
          createdAt: e.createdAt,
        }));
      return res.json({ boards });
    } catch (e) {
      console.error('GET /kanban/boards error', e);
      return res.status(500).json({ error: 'erro interno' });
    }
  });

  app.post('/kanban/boards', async (req, res) => {
    try {
      const { userId, title, description = '' } = req.body || {};
      if (!userId || !title?.trim())
        return res.status(400).json({ error: 'userId e title obrigatórios' });

      const id = await save('board', userId, {
        title: String(title).trim(),
        description: String(description || '').trim(),
        favorite: false,
      });

      const defaults = ['A Fazer', 'Fazendo', 'Feito'];
      const defaultLists = [];
      for (let i = 0; i < defaults.length; i++) {
        const ttl = defaults[i];
        const lid = await save('list', userId, {
          boardId: id,
          title: ttl,
          order: (i + 1) * 100,
          createdAt: nowISO(),
        });
        defaultLists.push({ id: lid, boardId: id, title: ttl, order: (i + 1) * 100 });
      }

      return res.json({
        board: {
          id,
          title: String(title).trim(),
          description: String(description || ''),
          favorite: false,
          createdAt: nowISO(),
        },
        defaultLists,
      });
    } catch (e) {
      console.error('POST /kanban/boards error', e);
      return res.status(500).json({ error: 'erro interno' });
    }
  });

  app.patch('/kanban/boards/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const { userId, title, description, favorite } = req.body || {};
      if (!userId) return res.status(400).json({ error: 'userId é obrigatório' });

      const updated = await updateById(userId, id, (p) => {
        if (p.kind !== 'board') return p;
        return {
          ...p,
          title: typeof title === 'string' ? title : p.title,
          description: typeof description === 'string' ? description : p.description,
          favorite: typeof favorite === 'boolean' ? favorite : p.favorite,
        };
      });
      if (!updated) return res.status(404).json({ error: 'Board não encontrado' });

      return res.json({
        board: {
          id: updated.id,
          title: updated.payload.title,
          description: updated.payload.description || '',
          favorite: !!updated.payload.favorite,
          createdAt: updated.createdAt,
        },
      });
    } catch (e) {
      console.error('PATCH /kanban/boards/:id error', e);
      return res.status(500).json({ error: 'erro interno' });
    }
  });

  app.delete('/kanban/boards/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const { userId } = req.query || {};
      if (!userId) return res.status(400).json({ error: 'userId é obrigatório' });

      const all = await getAll(userId);
      const lists = all.filter(e => e.payload?.kind === 'list' && e.payload.boardId === id);
      const cards = all.filter(e => e.payload?.kind === 'card' && e.payload.boardId === id);

      for (const l of lists) await removeEvent(l.id, userId);
      for (const c of cards) await removeEvent(c.id, userId);

      const ok = await removeById(userId, id);
      return res.json({ ok });
    } catch (e) {
      console.error('DELETE /kanban/boards/:id error', e);
      return res.status(500).json({ error: 'erro interno' });
    }
  });

  /* =========================
   * AI Planner p/ Boards
   * ========================= */
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

      if (preferencias && preferencias.preferencias && typeof preferencias.preferencias === 'object') {
        preferencias = preferencias.preferencias;
      }

      const normTitle = (s = '') =>
        String(s).normalize('NFD').replace(/\p{Diacritic}/gu, '').trim().toLowerCase();

      const getLists = async (bid) => {
        const all = await getAll(userId);
        return all
          .filter(e => e.payload?.kind === 'list' && e.payload.boardId === bid)
          .map(e => ({
            id: e.id,
            boardId: bid,
            title: e.payload.title,
            order: Number(e.payload.order) || 100,
            createdAt: e.createdAt,
          }))
          .sort((a, b) => a.order - b.order);
      };

      const getCards = async (bid) => {
        const all = await getAll(userId);
        return all
          .filter(e => e.payload?.kind === 'card' && e.payload.boardId === bid)
          .map(e => ({
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
      };

      const createBoardLocal = async (title, description = '') => {
        const id = await save('board', userId, {
          title: String(title || 'Plano').trim(),
          description: String(description || '').trim(),
          favorite: false,
        });
        for (const [i, ttl] of ['A Fazer', 'Fazendo', 'Feito'].entries()) {
          await save('list', userId, {
            boardId: id, title: ttl, order: (i + 1) * 100, createdAt: nowISO(),
          });
        }
        return id;
      };

      const getListByTitle = (listsArr, ttl) => {
        const want = normTitle(ttl);
        return listsArr.find(l => normTitle(l.title) === want) || null;
      };

      const createListLocal = async (boardId, title) => {
        const all = await getAll(userId);
        const existingOrders = all
          .filter(e => e.payload?.kind === 'list' && e.payload.boardId === boardId)
          .map(e => Number(e.payload.order) || 100);
        const nextOrder = (existingOrders.length ? Math.max(...existingOrders) : 0) + 100;
        const id = await save('list', userId, {
          boardId, title: String(title).trim(), order: nextOrder, createdAt: nowISO(),
        });
        return { id, boardId, title, order: nextOrder };
      };

      const createCardLocal = async (boardId, listId, payload) => {
        const all = await getAll(userId);
        const existingOrders = all
          .filter(e => e.payload?.kind === 'card' && e.payload.listId === listId)
          .map(e => Number(e.payload.order) || 100);
        const nextOrder = (existingOrders.length ? Math.max(...existingOrders) : 0) + 100;

        const id = await save('card', userId, {
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

        const all2 = await getAll(userId);
        const ev = all2.find(e => e.id === id);
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

      const updateCardLocal = async (cardId, patch) => {
        const ALLOW = [
          'title','description','due','labels','favorite','done','order',
          'listId','boardId','meta','startDate','endDate','startTime','endTime'
        ];
        const updated = await updateById(userId, cardId, (p) => {
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

      const moveCardLocal = async (cardId, toListId, toIndex) => {
        const all = await getAll(userId);
        const destListEv = all.find(e => e.id === toListId && e.payload?.kind === 'list');
        if (!destListEv) return null;

        const cardEv = all.find(e => e.id === cardId && e.payload?.kind === 'card');
        if (!cardEv) return null;

        const fromListId = cardEv.payload.listId;

        const destCards = all
          .filter(e => e.payload?.kind === 'card' && e.payload.listId === toListId && e.id !== cardEv.id)
          .sort((a,b)=> Number(a.payload.order||100) - Number(b.payload.order||100));

        const insertAt = Number.isInteger(toIndex)
          ? Math.min(Math.max(0, toIndex), destCards.length)
          : destCards.length;

        const finalDest = destCards.slice(0, insertAt).concat([cardEv]).concat(destCards.slice(insertAt));

        let movedPayload = null;
        let movedCreatedAt = cardEv.createdAt;

        for (let i = 0; i < finalDest.length; i++) {
          const ev = finalDest[i];
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
            await removeEvent(ev.id, userId);
            await addEvent(updated);
            movedPayload = updated.payload;
            movedCreatedAt = updated.createdAt;
          } else if (Number(ev.payload.order || 0) !== newOrder) {
            await removeEvent(ev.id, userId);
            await addEvent({ ...ev, payload: { ...ev.payload, order: newOrder, updatedAt: nowISO() } });
          }
        }

        if (fromListId && fromListId !== toListId) {
          const allAgain = await getAll(userId);
          const sourceCards = allAgain
            .filter(e => e.payload?.kind === 'card' && e.payload.listId === fromListId && e.id !== cardEv.id)
            .sort((a,b)=> Number(a.payload.order||100) - Number(b.payload.order||100));
          for (let i = 0; i < sourceCards.length; i++) {
            const ev = sourceCards[i];
            const newOrder = (i + 1) * 100;
            if (Number(ev.payload.order || 0) !== newOrder) {
              await removeEvent(ev.id, userId);
              await addEvent({ ...ev, payload: { ...ev.payload, order: newOrder, updatedAt: nowISO() } });
            }
          }
        }

        if (!movedPayload) {
          const after = await getAll(userId);
          const movedEv = after.find(e => e.id === cardId && e.payload?.kind === 'card');
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
          workingBoardId = '__preview__';
        } else {
          const title = preferencias?.boardTitle || `Plano de estudos - ${new Date().toLocaleDateString('pt-BR')}`;
          workingBoardId = await createBoardLocal(title, preferencias?.boardDescription || '');
        }
      }

      // ===== snapshot =====
      let lists, cards;
      if (workingBoardId === '__preview__') {
        const target = preferencias?.targetListTitle || 'A Fazer';
        lists = [
          { id: '__L1__', boardId: workingBoardId, title: target, order: 100, createdAt: nowISO() },
          { id: '__L2__', boardId: workingBoardId, title: 'Fazendo', order: 200, createdAt: nowISO() },
          { id: '__L3__', boardId: workingBoardId, title: 'Feito', order: 300, createdAt: nowISO() },
        ];
        cards = [];
      } else {
        lists = await getLists(workingBoardId);
        cards = await getCards(workingBoardId);
      }

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

      let planRaw = await askLLMJson({ system, user, max_tokens: 1200, temperature: 0.15 });
      let { lists: ensureLists, ops } = parsePlan(planRaw);

      if ((!ensureLists || ensureLists.length === 0) && (!ops || ops.length === 0)) {
        console.warn('[ai/plan] IA retornou vazio; usando fallback local.');
        const targetListTitle = preferencias?.targetListTitle || 'A Fazer';
        const dias = ['Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta'];
        const hoje = new Date();

        ensureLists = [];
        ops = dias.flatMap((dia, idx) => {
          const startH = 19;
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

      const preferDefault = !!preferencias?.preferDefaultList;
      const targetListTitle = preferencias?.targetListTitle || (preferDefault ? 'A Fazer' : null);

      const ensureList = async (title) => {
        if (targetListTitle) {
          const t = getListByTitle(lists, targetListTitle);
          if (t) return t;
        }
        const found = getListByTitle(lists, title);
        if (found) return found;

        const desired = preferDefault && normTitle(title).includes('a fazer') ? 'A Fazer' : title;
        const created = await createListLocal(workingBoardId, desired);
        lists = await getLists(workingBoardId);
        return created;
      };

      if (!preferDefault) {
        for (const it of ensureLists) {
          const t = it?.ensure?.title;
          if (t) await ensureList(t);
        }
        lists = await getLists(workingBoardId);
      }

      const created = [];
      const updated = [];
      const moved = [];

      for (const op of ops) {
        try {
          if (op.action === 'createCard') {
            const L = await ensureList(op.listTitle);
            if (!L) continue;
            const labels = Array.isArray(op.labels)
              ? op.labels.map(s => norm.label(s)).filter(Boolean)
              : [];

            const payload = {
              title: op.title?.slice(0, 120) || 'Tarefa',
              description: op.description || '',
              due: norm.date(op.due),
              startDate: norm.date(op.startDate),
              endDate: norm.date(op.endDate),
              startTime: norm.time(op.startTime),
              endTime: norm.time(op.endTime),
              labels,
              meta: op.meta || null,
            };

            const c = await createCardLocal(workingBoardId, L.id, payload);

            if (Array.isArray(op.checklists)) {
              const full = await updateById(userId, c.id, (p) => {
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
              if (full) c.checklists = full.payload.checklists || [];
            }

            created.push(c);
            cards = await getCards(workingBoardId);
          }

          if (op.action === 'updateCard') {
            let cur = null;
            if (op.select?.byId) {
              cur = (await getCards(workingBoardId)).find(c => c.id === op.select.byId);
            } else if (op.select?.byTitle) {
              const low = op.select.byTitle.trim().toLowerCase();
              cur = (await getCards(workingBoardId)).find(c => (c.title || '').trim().toLowerCase() === low);
            }
            if (!cur) continue;

            const patch = { ...op.patch };
            if (patch.labels) {
              patch.labels = patch.labels.map(s => norm.label(s)).filter(Boolean);
            }
            if (patch.due && !/^\d{4}-\d{2}-\d{2}$/.test(patch.due)) delete patch.due;
            if (patch.startDate && !/^\d{4}-\d{2}-\d{2}$/.test(patch.startDate)) delete patch.startDate;
            if (patch.endDate && !/^\d{4}-\d{2}-\d{2}$/.test(patch.endDate)) delete patch.endDate;
            if (patch.startTime && !/^\d{2}:\d{2}$/.test(patch.startTime)) delete patch.startTime;
            if (patch.endTime && !/^\d{2}:\d{2}$/.test(patch.endTime)) delete patch.endTime;

            const up = await updateCardLocal(cur.id, { userId, ...patch });
            if (up) updated.push({ id: cur.id, patch });
            cards = await getCards(workingBoardId);
          }

          if (op.action === 'moveCard') {
            let cur = null;
            if (op.select?.byId) {
              cur = (await getCards(workingBoardId)).find(c => c.id === op.select.byId);
            } else if (op.select?.byTitle) {
              const low = op.select.byTitle.trim().toLowerCase();
              cur = (await getCards(workingBoardId)).find(c => (c.title || '').trim().toLowerCase() === low);
            }
            const L = await ensureList(op.toListTitle);
            if (!cur || !L) continue;

            const mv = await moveCardLocal(cur.id, L.id, op.toIndex);
            if (mv) moved.push(mv);
            cards = await getCards(workingBoardId);
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
  });  /* =========================
  * Lists
  * ========================= */

 // GET /kanban/lists?userId&boardId
 app.get('/kanban/lists', async (req, res) => {
   try {
     const { userId, boardId } = req.query || {};
     if (!userId || !boardId)
       return res.status(400).json({ error: 'userId e boardId obrigatórios' });

     const all = await getAll(userId);
     const lists = all
       .filter(e => e.payload?.kind === 'list' && e.payload.boardId === boardId)
       .map(e => ({
         id: e.id,
         boardId,
         title: e.payload.title,
         order: Number(e.payload.order) || 100,
         createdAt: e.createdAt,
       }))
       .sort((a, b) => a.order - b.order);

     return res.json({ lists });
   } catch (e) {
     console.error('GET /kanban/lists error', e);
     return res.status(500).json({ error: 'erro interno' });
   }
 });

 // POST /kanban/lists { userId, boardId, title }
 app.post('/kanban/lists', async (req, res) => {
   try {
     const { userId, boardId, title } = req.body || {};
     if (!userId || !boardId || !title?.trim()) {
       return res.status(400).json({ error: 'userId, boardId e title são obrigatórios' });
     }

     const all = await getAll(userId);
     const existing = all
       .filter(e => e.payload?.kind === 'list' && e.payload.boardId === boardId)
       .map(e => Number(e.payload.order) || 100);
     const nextOrder = (existing.length ? Math.max(...existing) : 0) + 100;

     const id = await save('list', userId, {
       boardId,
       title: String(title).trim(),
       order: nextOrder,
       createdAt: nowISO(),
     });

     return res.json({
       list: {
         id,
         boardId,
         title: String(title).trim(),
         order: nextOrder,
         createdAt: nowISO(),
       },
     });
   } catch (e) {
     console.error('POST /kanban/lists error', e);
     return res.status(500).json({ error: 'erro interno' });
   }
 });

 // PATCH /kanban/lists/reorder { userId, boardId, orderedIds: [] }
 app.patch('/kanban/lists/reorder', async (req, res) => {
   try {
     const { userId, boardId, orderedIds } = req.body || {};
     if (!userId || !boardId || !Array.isArray(orderedIds)) {
       return res.status(400).json({ error: 'userId, boardId e orderedIds obrigatórios' });
     }
     const all = await getAll(userId);
     for (let i = 0; i < orderedIds.length; i++) {
       const lid = orderedIds[i];
       const ev = all.find(e => e.id === lid && e.payload?.kind === 'list' && e.payload.boardId === boardId);
       if (!ev) continue;
       await removeEvent(ev.id, userId);
       await addEvent({ ...ev, payload: { ...ev.payload, order: (i + 1) * 100 } });
     }
     return res.json({ ok: true });
   } catch (e) {
     console.error('PATCH /kanban/lists/reorder error', e);
     return res.status(500).json({ error: 'erro interno' });
   }
 });

 // PATCH /kanban/lists/:id { userId, title?, order? }
 app.patch('/kanban/lists/:id', async (req, res) => {
   try {
     const { id } = req.params;
     const { userId, title, order } = req.body || {};
     if (!userId) return res.status(400).json({ error: 'userId é obrigatório' });

     const updated = await updateById(userId, id, (p) => {
       if (p.kind !== 'list') return p;
       return {
         ...p,
         title: typeof title === 'string' ? title : p.title,
         order: typeof order === 'number' ? order : p.order,
       };
     });
     if (!updated) return res.status(404).json({ error: 'Lista não encontrada' });

     return res.json({
       list: {
         id: updated.id,
         boardId: updated.payload.boardId,
         title: updated.payload.title,
         order: Number(updated.payload.order) || 100,
         createdAt: updated.createdAt,
       },
     });
   } catch (e) {
     console.error('PATCH /kanban/lists/:id error', e);
     return res.status(500).json({ error: 'erro interno' });
   }
 });

 // DELETE /kanban/lists/:id?userId
 app.delete('/kanban/lists/:id', async (req, res) => {
   try {
     const { id } = req.params;
     const { userId } = req.query || {};
     if (!userId) return res.status(400).json({ error: 'userId é obrigatório' });

     const all = await getAll(userId);
     const cards = all.filter(e => e.payload?.kind === 'card' && e.payload.listId === id);
     for (const c of cards) await removeEvent(c.id, userId);

     const ok = await removeById(userId, id);
     return res.json({ ok });
   } catch (e) {
     console.error('DELETE /kanban/lists/:id error', e);
     return res.status(500).json({ error: 'erro interno' });
   }
 });

 /* =========================
  * Overview
  * ========================= */
 app.get('/kanban/overview', async (req, res) => {
   try {
     const { userId } = req.query || {};
     if (!userId) return res.status(400).json({ error: 'userId é obrigatório' });
     const all = await getAll(userId);
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
   } catch (e) {
     console.error('GET /kanban/overview error', e);
     return res.status(500).json({ error: 'erro interno' });
   }
 });  /* =========================
 * Cards
 * ========================= */

// GET /kanban/cards/enhanced
app.get('/kanban/cards/enhanced', async (req, res) => {
  try {
    const { userId, boardId, listId } = req.query || {};
    if (!userId || !boardId)
      return res.status(400).json({ error: 'userId e boardId obrigatórios' });

    const all = await getAll(userId);
    const result = all
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

    return res.json({ cards: result });
  } catch (e) {
    console.error('GET /kanban/cards/enhanced error', e);
    return res.status(500).json({ error: 'erro interno' });
  }
});

// GET /kanban/cards
app.get('/kanban/cards', async (req, res) => {
  try {
    const { userId, boardId, listId } = req.query || {};
    if (!userId || !boardId)
      return res.status(400).json({ error: 'userId e boardId obrigatórios' });

    const all = await getAll(userId);
    const result = all
      .filter(e => e.payload?.kind === 'card' && e.payload.boardId === boardId && (!listId || e.payload.listId === listId))
      .map(e => ({
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

    return res.json({ cards: result });
  } catch (e) {
    console.error('GET /kanban/cards error', e);
    return res.status(500).json({ error: 'erro interno' });
  }
});

// GET /kanban/cards/:id
app.get('/kanban/cards/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.query || {};
    if (!userId) return res.status(400).json({ error: 'userId é obrigatório' });

    const all = await getAll(userId);
    const ev = all.find(e => e.id === id && e.payload?.kind === 'card');
    if (!ev) return res.status(404).json({ error: 'Card não encontrado' });

    const p = ev.payload;
    return res.json({
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
  } catch (e) {
    console.error('GET /kanban/cards/:id error', e);
    return res.status(500).json({ error: 'erro interno' });
  }
});

// util: GET /kanban/cards/byid/:id?userId=...
app.get('/kanban/cards/byid/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.query || {};
    if (!userId) return res.status(400).json({ error: 'userId é obrigatório' });
    const all = await getAll(userId);
    const cardEv = all.find(e => e.id === id && e.payload?.kind === 'card');
    if (!cardEv) return res.status(404).json({ error: 'Card não encontrado para este userId' });
    return res.json({ ok: true, id: cardEv.id, payload: cardEv.payload });
  } catch (e) {
    console.error('GET /kanban/cards/byid/:id error', e);
    return res.status(500).json({ error: 'erro interno' });
  }
});

// POST /kanban/cards
app.post('/kanban/cards', async (req, res) => {
  try {
    const {
      userId, boardId, listId, title,
      description = '', due = null,
      startDate = null, endDate = null,
      startTime = null, endTime = null,
      remindAt = null, meta = null,
    } = req.body || {};

    if (!userId || !boardId || !listId || !title?.trim()) {
      return res.status(400).json({ error: 'userId, boardId, listId e title são obrigatórios' });
    }

    const all = await getAll(userId);
    const existingOrders = all
      .filter(e => e.payload?.kind === 'card' && e.payload.listId === listId)
      .map(e => Number(e.payload.order) || 100);
    const nextOrder = (existingOrders.length ? Math.max(...existingOrders) : 0) + 100;

    const id = await save('card', userId, {
      boardId, listId,
      title: String(title).trim(),
      description: String(description || ''),
      due, startDate, endDate, startTime, endTime,
      remindAt: remindAt || null,
      labels: [], checklists: [], attachments: [], comments: [],
      favorite: false, done: false,
      order: nextOrder, updatedAt: nowISO(), meta: meta || null,
    });

    const all2 = await getAll(userId);
    const ev = all2.find(e => e.id === id);
    const createdAtReal = ev?.createdAt || nowISO();

    return res.json({
      card: {
        id, boardId, listId,
        title: String(title).trim(),
        description: String(description || ''),
        due, startDate, endDate, startTime, endTime,
        remindAt: remindAt || null,
        labels: [], checklists: [], attachments: [], comments: [],
        favorite: false, done: false,
        order: nextOrder,
        createdAt: createdAtReal,
        updatedAt: ev?.payload?.updatedAt || createdAtReal,
        meta: meta || null,
      },
    });
  } catch (e) {
    console.error('POST /kanban/cards error', e);
    return res.status(500).json({ error: 'erro interno' });
  }
});

// PATCH /kanban/cards/reorder
app.patch('/kanban/cards/reorder', async (req, res) => {
  try {
    const { userId, listId, orderedIds } = req.body || {};
    if (!userId || !listId || !Array.isArray(orderedIds)) {
      return res.status(400).json({ error: 'userId, listId e orderedIds obrigatórios' });
    }
    const all = await getAll(userId);
    for (let i = 0; i < orderedIds.length; i++) {
      const cid = orderedIds[i];
      const ev = all.find(e => e.id === cid && e.payload?.kind === 'card' && e.payload.listId === listId);
      if (!ev) continue;
      await removeEvent(ev.id, userId);
      await addEvent({ ...ev, payload: { ...ev.payload, order: (i + 1) * 100, updatedAt: nowISO() } });
    }
    return res.json({ ok: true });
  } catch (e) {
    console.error('PATCH /kanban/cards/reorder error', e);
    return res.status(500).json({ error: 'erro interno' });
  }
});

// PATCH /kanban/cards/move
app.patch('/kanban/cards/move', async (req, res) => {
  try {
    const { userId, cardId, toListId, toIndex } = req.body || {};
    console.log('[kanban/move] IN', { userId, cardId, toListId, toIndex });
    if (!userId || !cardId || !toListId) {
      return res.status(400).json({ error: 'userId, cardId e toListId são obrigatórios' });
    }

    const all = await getAll(userId);

    const destListEv = all.find(e => e.id === toListId && e.payload?.kind === 'list');
    if (!destListEv) {
      console.warn('[kanban/move] Dest list NOT FOUND', { userId, toListId });
      return res.status(404).json({ error: 'Lista de destino não encontrada' });
    }

    const cardEv = all.find(e => e.id === cardId && e.payload?.kind === 'card');
    if (!cardEv) {
      console.warn('[kanban/move] Card NOT FOUND', { userId, cardId });
      return res.status(404).json({ error: 'Card não encontrado' });
    }

    const fromListId = cardEv.payload.listId;

    const destCards = all
      .filter(e => e.payload?.kind === 'card' && e.payload.listId === toListId && e.id !== cardEv.id)
      .sort((a, b) => Number(a.payload.order || 100) - Number(b.payload.order || 100));

    const insertAt = Number.isInteger(toIndex)
      ? Math.min(Math.max(0, toIndex), destCards.length)
      : destCards.length;

    const finalDest = destCards.slice(0, insertAt).concat([cardEv]).concat(destCards.slice(insertAt));

    let movedPayload = null;
    let movedCreatedAt = cardEv.createdAt;

    for (let i = 0; i < finalDest.length; i++) {
      const ev = finalDest[i];
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
        await removeEvent(ev.id, userId);
        await addEvent(updated);
        movedPayload = updated.payload;
        movedCreatedAt = updated.createdAt;
      } else if (Number(ev.payload.order || 0) !== newOrder) {
        await removeEvent(ev.id, userId);
        await addEvent({ ...ev, payload: { ...ev.payload, order: newOrder, updatedAt: nowISO() } });
      }
    }

    if (fromListId && fromListId !== toListId) {
      const allAgain = await getAll(userId);
      const sourceCards = allAgain
        .filter(e => e.payload?.kind === 'card' && e.payload.listId === fromListId && e.id !== cardEv.id)
        .sort((a,b)=> Number(a.payload.order||100) - Number(b.payload.order||100));
      for (let i = 0; i < sourceCards.length; i++) {
        const ev = sourceCards[i];
        const newOrder = (i + 1) * 100;
        if (Number(ev.payload.order || 0) !== newOrder) {
          await removeEvent(ev.id, userId);
          await addEvent({ ...ev, payload: { ...ev.payload, order: newOrder, updatedAt: nowISO() } });
        }
      }
    }

    if (!movedPayload) {
      const after = await getAll(userId);
      const movedEv = after.find(e => e.id === cardId && e.payload?.kind === 'card');
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
  } catch (e) {
    console.error('PATCH /kanban/cards/move error', e);
    return res.status(500).json({ error: 'erro interno' });
  }
});

// PATCH /kanban/cards/:id
app.patch('/kanban/cards/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { userId, ...patch } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId é obrigatório' });

    const ALLOW = [
      'title','description','due','labels','favorite','done','order',
      'listId','boardId','meta','startDate','endDate','startTime','endTime','remindAt'
    ];

    const updated = await updateById(userId, id, (p) => {
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
  } catch (e) {
    console.error('PATCH /kanban/cards/:id error', e);
    return res.status(500).json({ error: 'erro interno' });
  }
});

// DELETE /kanban/cards/:id
app.delete('/kanban/cards/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.query || {};
    if (!userId) return res.status(400).json({ error: 'userId é obrigatório' });
    const ok = await removeById(userId, id);
    return res.json({ ok });
  } catch (e) {
    console.error('DELETE /kanban/cards/:id error', e);
    return res.status(500).json({ error: 'erro interno' });
  }
});

/* =========================
 * Checklists
 * ========================= */

app.post('/kanban/cards/:cardId/checklist', async (req, res) => {
  try {
    const { cardId } = req.params;
    const { userId, title } = req.body || {};
    if (!userId || !title?.trim())
      return res.status(400).json({ error: 'userId e title obrigatórios' });

    const updated = await updateById(userId, cardId, (p) => {
      if (p.kind !== 'card') return p;
      const checklists = Array.isArray(p.checklists) ? p.checklists.slice() : [];
      checklists.push({ id: uuid(), title: String(title).trim(), items: [] });
      return { ...p, checklists, updatedAt: nowISO() };
    });
    if (!updated) return res.status(404).json({ error: 'Card não encontrado' });

    return res.json({ checklists: updated.payload.checklists || [] });
  } catch (e) {
    console.error('POST /kanban/cards/:cardId/checklist error', e);
    return res.status(500).json({ error: 'erro interno' });
  }
});

app.patch('/kanban/cards/:cardId/checklist/:cid', async (req, res) => {
  try {
    const { cardId, cid } = req.params;
    const { userId, title } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId é obrigatório' });

    const updated = await updateById(userId, cardId, (p) => {
      if (p.kind !== 'card') return p;
      const checklists = (p.checklists || []).map((ch) =>
        ch.id === cid ? { ...ch, title: typeof title === 'string' ? title : ch.title } : ch
      );
      return { ...p, checklists, updatedAt: nowISO() };
    });
    if (!updated) return res.status(404).json({ error: 'Card não encontrado' });

    return res.json({ checklists: updated.payload.checklists || [] });
  } catch (e) {
    console.error('PATCH /kanban/cards/:cardId/checklist/:cid error', e);
    return res.status(500).json({ error: 'erro interno' });
  }
});

app.post('/kanban/cards/:cardId/checklist/:cid/item', async (req, res) => {
  try {
    const { cardId, cid } = req.params;
    const { userId, text } = req.body || {};
    if (!userId || !text?.trim())
      return res.status(400).json({ error: 'userId e text obrigatórios' });

    const updated = await updateById(userId, cardId, (p) => {
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

    return res.json({ checklists: updated.payload.checklists || [] });
  } catch (e) {
    console.error('POST /kanban/cards/:cardId/checklist/:cid/item error', e);
    return res.status(500).json({ error: 'erro interno' });
  }
});

app.patch('/kanban/cards/:cardId/checklist/:cid/item/:iid', async (req, res) => {
  try {
    const { cardId, cid, iid } = req.params;
    const { userId, text, done } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId é obrigatório' });

    const updated = await updateById(userId, cardId, (p) => {
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

    return res.json({ checklists: updated.payload.checklists || [] });
  } catch (e) {
    console.error('PATCH /kanban/cards/:cardId/checklist/:cid/item/:iid error', e);
    return res.status(500).json({ error: 'erro interno' });
  }
});

app.delete('/kanban/cards/:cardId/checklist/:cid/item/:iid', async (req, res) => {
  try {
    const { cardId, cid, iid } = req.params;
    const { userId } = req.query || {};
    if (!userId) return res.status(400).json({ error: 'userId é obrigatório' });

    const updated = await updateById(userId, cardId, (p) => {
      if (p.kind !== 'card') return p;
      const checklists = (p.checklists || []).map((ch) => {
        if (ch.id !== cid) return ch;
        return { ...ch, items: (ch.items || []).filter((it) => it.id !== iid) };
      });
      return { ...p, checklists, updatedAt: nowISO() };
    });
    if (!updated) return res.status(404).json({ error: 'Card não encontrado' });

    return res.json({ checklists: updated.payload.checklists || [] });
  } catch (e) {
    console.error('DELETE /kanban/cards/:cardId/checklist/:cid/item/:iid error', e);
    return res.status(500).json({ error: 'erro interno' });
  }
});

/* =========================
 * Comentários
 * ========================= */
app.post('/kanban/cards/:cardId/comments', async (req, res) => {
  try {
    const { cardId } = req.params;
    const { userId, text } = req.body || {};
    if (!userId || !text?.trim())
      return res.status(400).json({ error: 'userId e text obrigatórios' });

    const updated = await updateById(userId, cardId, (p) => {
      if (p.kind !== 'card') return p;
      const comments = Array.isArray(p.comments) ? p.comments.slice() : [];
      comments.push({ id: uuid(), text: String(text).trim(), ts: nowISO() });
      return { ...p, comments, updatedAt: nowISO() };
    });
    if (!updated) return res.status(404).json({ error: 'Card não encontrado' });

    return res.json({ comments: updated.payload.comments || [] });
  } catch (e) {
    console.error('POST /kanban/cards/:cardId/comments error', e);
    return res.status(500).json({ error: 'erro interno' });
  }
});

app.delete('/kanban/cards/:cardId/comments/:commentId', async (req, res) => {
  try {
    const { cardId, commentId } = req.params;
    const { userId } = req.query || {};
    if (!userId) return res.status(400).json({ error: 'userId é obrigatório' });

    const updated = await updateById(userId, cardId, (p) => {
      if (p.kind !== 'card') return p;
      const comments = (p.comments || []).filter((c) => c.id !== commentId);
      return { ...p, comments, updatedAt: nowISO() };
    });
    if (!updated) return res.status(404).json({ error: 'Card não encontrado' });

    return res.json({ comments: updated.payload.comments || [] });
  } catch (e) {
    console.error('DELETE /kanban/cards/:cardId/comments/:commentId error', e);
    return res.status(500).json({ error: 'erro interno' });
  }
});
};
