// src/routes/auth.js
'use strict';
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

function signToken(user) {
  const payload = { sub: user.id };
  const secret = process.env.JWT_SECRET || 'dev_secret';
  const expiresIn = process.env.JWT_EXPIRES_IN || '15d';
  return jwt.sign(payload, secret, { expiresIn });
}

// POST /auth/register  { email?, username?, phone?, password, firstName?, lastName?, birthday? }
router.post('/register', async (req, res) => {
  try {
    const {
      email,
      username,
      phone,
      password,
      firstName,
      lastName,
      birthday, // string "YYYY-MM-DD" opcional
    } = req.body || {};

    if (!password || (!email && !username && !phone)) {
      return res.status(400).json({ error: 'Informe (email ou username ou phone) e password.' });
    }

    // checar duplicidade
    if (email) {
      const e = await prisma.user.findUnique({ where: { email } });
      if (e) return res.status(409).json({ error: 'Email já cadastrado.' });
    }
    if (username) {
      const u = await prisma.user.findUnique({ where: { username } });
      if (u) return res.status(409).json({ error: 'Username já cadastrado.' });
    }
    if (phone) {
      const p = await prisma.user.findUnique({ where: { phone } });
      if (p) return res.status(409).json({ error: 'Telefone já cadastrado.' });
    }

    const passwordHash = await bcrypt.hash(String(password), 10);

    // tenta converter birthday -> Date, senão NULL
    let birthDate = null;
    if (birthday && typeof birthday === 'string') {
      const d = new Date(birthday);
      if (!isNaN(d)) birthDate = d;
    }

    const created = await prisma.user.create({
      data: {
        email: email || null,
        username: username || null,
        phone: phone || null,
        passwordHash,
        firstName: firstName || null,
        lastName: lastName || null,
        birthDate, // pode ser null
      },
      select: { id: true, email: true, username: true }
    });

    const token = signToken(created);
    return res.json({ ok: true, userId: created.id, token });
  } catch (e) {
    console.error('register error', e);
    return res.status(500).json({ error: 'erro_interno' });
  }
});

// POST /auth/login  { identifier, password }
router.post('/login', async (req, res) => {
  try {
    const { identifier, password } = req.body || {};
    if (!identifier || !password) {
      return res.status(400).json({ error: 'identifier e password são obrigatórios.' });
    }

    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { email: identifier },
          { username: identifier },
          { phone: identifier },
        ]
      },
      select: { id: true, passwordHash: true }
    });

    if (!user || !user.passwordHash) {
      return res.status(401).json({ error: 'Credenciais inválidas.' });
    }

    const ok = await bcrypt.compare(String(password), user.passwordHash);
    if (!ok) return res.status(401).json({ error: 'Credenciais inválidas.' });

    const token = signToken(user);
    return res.json({ ok: true, userId: user.id, token });
  } catch (e) {
    console.error('login error', e);
    return res.status(500).json({ error: 'erro_interno' });
  }
});

// POST /auth/oauth  { provider, access_token }  (MVP simplificado)
router.post('/oauth', async (req, res) => {
  try {
    const { provider, access_token } = req.body || {};
    if (!provider || !access_token) {
      return res.status(400).json({ error: 'provider e access_token são obrigatórios.' });
    }

    const pseudo = `${provider}_${String(access_token).slice(0,10)}`;
    let user = await prisma.user.findFirst({
      where: { username: pseudo },
      select: { id: true }
    });

    if (!user) {
      user = await prisma.user.create({
        data: { username: pseudo },
        select: { id: true }
      });
    }

    const token = signToken(user);
    return res.json({ ok: true, userId: user.id, token });
  } catch (e) {
    console.error('oauth error', e);
    return res.status(500).json({ error: 'erro_interno' });
  }
});
router.get('/debug', (_req, res) => res.json({ ok: true, where: 'auth router' }));
module.exports = router;