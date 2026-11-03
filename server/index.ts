/**
 * Serveur de parties temps réel — hébergeable gratuitement sur Render / Railway / Fly.io.
 * Le serveur est la source de vérité : il stocke l'état des rooms, diffuse les strokes,
 * gère le timer et demande aux clients de calculer leur score (rendu canvas côté client).
 */
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import crypto from 'crypto';

const MAX_PLAYERS = 4;
const ROUND_DURATION = parseInt(process.env.ROUND_DURATION ?? '120', 10); // secondes

type Pt = [number, number];
interface Stroke { id: string; playerId: string; color: string; size: number; points: Pt[] }

interface Player { id: string; socketId?: string; name: string; color: string; connected: boolean }
interface RoomState {
  code: string;
  phase: 'lobby' | 'playing' | 'results';
  players: Player[];
  strokes: Stroke[];
  model: { seed: number; shapes: unknown[] } | null;
  roundDuration: number;
  endsAt: number | null;
  scores: Record<string, number>;
  hostId: string;
}
interface Room extends RoomState {
  playerSockets: Map<string, string>; // playerId -> socketId
  timer: NodeJS.Timeout | null;
}

const rooms = new Map<string, Room>();
const PLAYER_COLORS = ['#e63946', '#457b9d', '#2a9d8f', '#9b5de5'];

// ---- Génération du modèle (dupliquée depuis src/app/core/model-generator.ts, à factoriser en package partagé) ----
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const MODEL_COLORS = ['#e63946', '#f4a261', '#2a9d8f', '#457b9d', '#9b5de5', '#f15bb5', '#00bbf9', '#ff7b00'];
function generateModel(seed: number, playerCount: number) {
  const rnd = mulberry32(seed);
  const shapeCount = 3 + 2 * playerCount + Math.floor(rnd() * 3);
  const palette = MODEL_COLORS.slice(0, Math.min(playerCount + 1, MODEL_COLORS.length));
  const shapes: any[] = [];
  const clamp = (v: number) => Math.min(0.96, Math.max(0.04, v));
  for (let i = 0; i < shapeCount; i++) {
    const kinds = ['circle', 'rect', 'triangle', 'line'];
    const kind = kinds[Math.floor(rnd() * kinds.length)];
    const color = palette[Math.floor(rnd() * palette.length)];
    const fill = rnd() > 0.35;
    const ax = 0.08 + rnd() * 0.84, ay = 0.08 + rnd() * 0.84;
    if (kind === 'circle') shapes.push({ kind, color, fill, a: [ax, ay], radius: 0.05 + rnd() * 0.16 });
    else if (kind === 'line') shapes.push({ kind, color, fill: false, a: [ax, ay], b: [clamp(ax + (rnd() - 0.5) * 0.8), clamp(ay + (rnd() - 0.5) * 0.8)], lineWidth: 0.004 + rnd() * 0.012 });
    else shapes.push({ kind, color, fill, a: [ax, ay], b: [clamp(ax + (rnd() - 0.5) * 0.7), clamp(ay + (rnd() - 0.5) * 0.7)] });
  }
  return { seed, shapes };
}

// ---- App HTTP + Socket.IO ----
const app = express();
app.use(cors());
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

function publicState(room: Room): RoomState {
  return {
    code: room.code, phase: room.phase, players: room.players.map(({ socketId, ...p }) => p as any),
    strokes: room.strokes, model: room.model, roundDuration: room.roundDuration,
    endsAt: room.endsAt, scores: room.scores, hostId: room.hostId,
  };
}

function broadcast(room: Room): void {
  io.to(room.code).emit('state', publicState(room));
}

function makeCode(): string {
  let code: string;
  do {
    code = Array.from(crypto.randomBytes(4)).map((b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');
  } while (rooms.has(code));
  return code;
}

function startRound(room: Room): void {
  room.phase = 'playing';
  room.strokes = [];
  room.scores = {};
  room.model = generateModel(Math.floor(Math.random() * 2 ** 31), room.players.filter((p) => p.connected).length);
  room.endsAt = Date.now() + room.roundDuration * 1000;
  if (room.timer) clearInterval(room.timer);
  room.timer = setInterval(() => {
    if (room.endsAt && Date.now() >= room.endsAt) endRound(room);
  }, 1000);
  broadcast(room);
}

function endRound(room: Room): void {
  if (room.timer) { clearInterval(room.timer); room.timer = null; }
  room.phase = 'results';
  room.endsAt = null;
  broadcast(room);
  // Les clients calculent leur score localement (canvas) et l'envoient via 'score'.
}

io.on('connection', (socket) => {
  console.log('connecté:', socket.id);

  socket.on('create-room', ({ name }: { name: string }, cb?: (r: any) => void) => {
    const code = makeCode();
    const playerId = crypto.randomUUID();
    const room: Room = {
      code, phase: 'lobby',
      players: [{ id: playerId, name: (name || 'Anonyme').slice(0, 20), color: PLAYER_COLORS[0], connected: true }],
      playerSockets: new Map([[playerId, socket.id]]),
      strokes: [], model: null, roundDuration: ROUND_DURATION, endsAt: null, scores: {},
      hostId: playerId, timer: null,
    };
    rooms.set(code, room);
    socket.join(code);
    cb?.({ playerId });
    broadcast(room);
  });

  socket.on('join-room', ({ code, name }: { code: string; name: string }, cb?: (r: any) => void) => {
    const room = rooms.get(String(code).toUpperCase());
    if (!room) return cb?.({ error: 'Room introuvable' });
    const active = room.players.filter((p) => p.connected).length;
    if (active >= MAX_PLAYERS) return cb?.({ error: 'Room pleine (max 4 joueurs)' });
    const playerId = crypto.randomUUID();
    room.players.push({ id: playerId, socketId: socket.id, name: (name || 'Anonyme').slice(0, 20), color: PLAYER_COLORS[room.players.length % MAX_PLAYERS], connected: true });
    room.playerSockets.set(playerId, socket.id);
    socket.join(room.code);
    cb?.({ playerId });
    broadcast(room);
  });

  socket.on('start', () => {
    const room = findRoomBySocket(socket.id);
    if (!room || room.hostId !== myPlayerId(room, socket.id)) return;
    if (room.phase === 'lobby' || room.phase === 'results') startRound(room);
  });

  socket.on('stroke', (stroke: Stroke) => {
    const room = findRoomBySocket(socket.id);
    if (!room || room.phase !== 'playing') return;
    const pid = myPlayerId(room, socket.id);
    if (!pid || stroke.playerId !== pid) return; // anti-impersonation
    if (stroke.points.length > 2000) return;
    room.strokes.push(stroke);
    socket.to(room.code).emit('stroke', stroke);
  });

  socket.on('undo', ({ strokeId }: { strokeId: string }) => {
    const room = findRoomBySocket(socket.id);
    if (!room) return;
    const pid = myPlayerId(room, socket.id);
    const idx = room.strokes.findIndex((s) => s.id === strokeId);
    if (idx === -1 || room.strokes[idx].playerId !== pid) return; // on ne peut annuler que SES traits
    room.strokes.splice(idx, 1);
    broadcast(room);
  });

  socket.on('score', ({ value }: { value: number }) => {
    const room = findRoomBySocket(socket.id);
    if (!room || room.phase !== 'results') return;
    const pid = myPlayerId(room, socket.id);
    if (pid) {
      room.scores[pid] = Math.max(0, Math.min(100, Math.round(value)));
      broadcast(room);
    }
  });

  socket.on('disconnect', () => {
    const room = findRoomBySocket(socket.id);
    if (!room) return;
    const pid = myPlayerId(room, socket.id);
    if (pid) {
      const p = room.players.find((x) => x.id === pid);
      if (p) p.connected = false;
      // le trait d'un joueur déconnecté reste ; la room se ferme si plus personne
      if (!room.players.some((x) => x.connected)) {
        if (room.timer) clearInterval(room.timer);
        rooms.delete(room.code);
      } else broadcast(room);
    }
  });
});

function findRoomBySocket(socketId: string): Room | undefined {
  for (const room of rooms.values()) if ([...room.playerSockets.values()].includes(socketId)) return room;
  return undefined;
}
function myPlayerId(room: Room, socketId: string): string | undefined {
  for (const [pid, sid] of room.playerSockets) if (sid === socketId) return pid;
  return undefined;
}

const PORT = process.env.PORT ?? 3000;
server.listen(PORT, () => console.log(`🎨 Serveur peinture lancé sur le port ${PORT}`));
