// src/lib/prisma.js
const { PrismaClient } = require('@prisma/client');

let prisma;
if (!global.__prisma__) {
  global.__prisma__ = new PrismaClient();
}
prisma = global.__prisma__;

module.exports = { prisma };