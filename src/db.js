// src/db.js
'use strict';
const { prisma } = require('./lib/prisma');

/**
 * eventObj esperado pelo seu server:
 * {
 *   id, userId, type, payload, createdAt
 * }
 */
async function addEvent(eventObj) {
  // tolera createdAt string ISO
  const createdAt =
    eventObj?.createdAt ? new Date(eventObj.createdAt) : undefined;

  await prisma.event.create({
    data: {
      id: eventObj.id,                 // você já gera com uuid()
      type: String(eventObj.type || 'log'),
      payload: eventObj.payload ?? {},
      createdAt,
      // se quiser filtrar por user depois, armazene userId dentro do payload também:
      // mas vamos criar um campo próprio abaixo via upsert na tabela UserEvents (opcional)
    }
  });

  // Opcional: index auxiliar por usuário (para buscas rápidas por userId)
  // Se não quiser uma tabela auxiliar, ignore este bloco e filtre por payload.userId.
  await prisma.userEvent.upsert({
    where: { eventId: eventObj.id },
    create: { eventId: eventObj.id, userId: eventObj.userId || 'anon' },
    update: { userId: eventObj.userId || 'anon' }
  });

  return true;
}

/**
 * Lista eventos recentes por userId (limite padrão do seu server).
 * Mantém compatibilidade com listEvents(userId, limit).
 */
async function listEvents(userId, limit = 50) {
  // Se você não quiser tabela auxiliar, dá pra filtrar por payload->>'userId'
  // mas é menos performático. Como criamos UserEvent acima, usamos join leve.

  const items = await prisma.event.findMany({
    where: {
      UserEvent: { userId: userId || 'anon' }
    },
    orderBy: { createdAt: 'desc' },
    take: Number(limit) || 50
  });

  // O server espera que cada item tenha .payload.favorite etc.
  // Mantemos o formato igual.
  return items.map(it => ({
    id: it.id,
    userId,
    type: it.type,
    payload: it.payload || {},
    createdAt: it.createdAt.toISOString()
  }));
}

/**
 * Remove 1 evento do usuário (retorna quantidade removida).
 */
async function removeEvent(id, userId) {
  // Verifica vinculação ao user antes de deletar
  const link = await prisma.userEvent.findUnique({ where: { eventId: id } });
  if (!link || (userId && link.userId !== userId)) return 0;

  // apaga link e evento
  await prisma.userEvent.delete({ where: { eventId: id } });
  await prisma.event.delete({ where: { id } });
  return 1;
}

module.exports = {
  addEvent,
  listEvents,
  removeEvent,
  prisma
};