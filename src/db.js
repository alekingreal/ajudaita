// src/db.js
'use strict';
const { prisma } = require('./lib/prisma');

async function addEvent(eventObj) {
  const createdAt = eventObj?.createdAt ? new Date(eventObj.createdAt) : undefined;

  await prisma.event.create({
    data: {
      id: eventObj.id,
      type: String(eventObj.type || 'log'),
      payload: eventObj.payload ?? {},
      createdAt, // Prisma dá default se vier undefined
    }
  });

  await prisma.userEvent.upsert({
    where: { eventId: eventObj.id },
    create: { eventId: eventObj.id, userId: eventObj.userId || 'anon' },
    update: { userId: eventObj.userId || 'anon' }
  });

  return true;
}

async function listEvents(userId, limit = 50) {
  const items = await prisma.event.findMany({
    where: {
      // ⚠️ AQUI é "userEvent", não "UserEvent"
      userEvent: { userId: userId || 'anon' }
    },
    orderBy: { createdAt: 'desc' },
    take: Number(limit) || 50
  });

  return items.map(it => ({
    id: it.id,
    userId,
    type: it.type,
    payload: it.payload || {},
    createdAt: it.createdAt.toISOString()
  }));
}

async function removeEvent(id, userId) {
  const link = await prisma.userEvent.findUnique({ where: { eventId: id } });
  if (!link || (userId && link.userId !== userId)) return 0;

  await prisma.userEvent.delete({ where: { eventId: id } });
  await prisma.event.delete({ where: { id } });
  return 1;
}

module.exports = { addEvent, listEvents, removeEvent, prisma };
