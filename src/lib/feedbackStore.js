const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, '..', 'data', 'feedback.json');

// cache em memória
let state = { votes: [] };
// serializa gravações pra evitar race condition
let writing = Promise.resolve();

function loadOnce() {
  if (loadOnce._loaded) return;
  try {
    const txt = fs.readFileSync(DB_FILE, 'utf8');
    state = JSON.parse(txt);
  } catch {
    // se não existir, cria vazio
    state = { votes: [] };
    fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
    fs.writeFileSync(DB_FILE, JSON.stringify(state, null, 2));
  }
  loadOnce._loaded = true;
}

function save() {
  // enfileira a escrita pra evitar corrupção do arquivo
  writing = writing.then(() => new Promise((resolve, reject) => {
    fs.writeFile(DB_FILE, JSON.stringify(state, null, 2), (err) => {
      if (err) reject(err);
      else resolve();
    });
  })).catch(() => {});
  return writing;
}

function key(userId, historyId) {
  return `${String(userId)}|${String(historyId)}`;
}

function setVote({ userId, historyId, vote }) {
  loadOnce();
  const k = key(userId, historyId);
  const now = new Date().toISOString();

  // procura existente
  const idx = state.votes.findIndex(v => key(v.userId, v.historyId) === k);

  if (vote === 'none' || !vote) {
    if (idx >= 0) {
      state.votes.splice(idx, 1);
      return save();
    }
    return Promise.resolve();
  }

  if (idx >= 0) {
    state.votes[idx].vote = vote;
    state.votes[idx].updatedAt = now;
  } else {
    state.votes.push({ userId: String(userId), historyId: String(historyId), vote, createdAt: now, updatedAt: now });
  }
  return save();
}

function getCounts(historyId) {
  loadOnce();
  const hid = String(historyId);
  let up = 0, down = 0;
  for (const v of state.votes) {
    if (String(v.historyId) !== hid) continue;
    if (v.vote === 'up') up++;
    if (v.vote === 'down') down++;
  }
  return { up, down };
}

module.exports = { setVote, getCounts };