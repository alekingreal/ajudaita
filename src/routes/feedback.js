const express = require('express');
const router = express.Router();
const { setVote, getCounts } = require('../lib/feedbackStore');

// Validação leve (sem depender de lib)
function parseBody(body) {
  const userId = String(body?.userId || '').trim();
  const historyId = String(body?.historyId || '').trim();
  const vote = (body?.vote || '').trim(); // 'up' | 'down' | 'none' (remoção)
  if (!userId || !historyId) return { error: 'invalid_body' };
  if (vote && !['up', 'down', 'none'].includes(vote)) return { error: 'invalid_vote' };
  return { userId, historyId, vote };
}

// POST /feedback { userId, historyId, vote: 'up'|'down' }  (ou 'none' para remover)
router.post('/', async (req, res) => {
  try {
    const parsed = parseBody(req.body);
    if (parsed.error) return res.status(400).json(parsed);

    await setVote(parsed);
    // “falhar em silêncio” → 204 No Content
    return res.status(204).end();
  } catch (e) {
    console.error('[POST /feedback]', e);
    return res.status(204).end(); // mantém UX silenciosa mesmo em erro
  }
});

// (Opcional) GET /feedback/:historyId  -> { up, down }
router.get('/:historyId', (req, res) => {
  try {
    const { historyId } = req.params;
    const counts = getCounts(historyId);
    return res.json(counts);
  } catch (e) {
    console.error('[GET /feedback/:historyId]', e);
    return res.json({ up: 0, down: 0 });
  }
});

module.exports = router;