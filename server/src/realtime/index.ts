import { Server as SocketServer } from 'socket.io';
import type { Server as HttpServer } from 'node:http';
import type { Request } from 'express';
import type { WorldDatabase } from '../db/index.js';
import type { SimulationClock } from '../simulation/clock.js';
import { playerFromRequest } from '../auth/session.js';
import { projectWorld, publicEvents } from './projection.js';
import type { WorldDelta } from '../../../shared/realtime.js';

export function attachRealtime(server: HttpServer, db: WorldDatabase, clock: SimulationClock) {
  const io = new SocketServer(server, {
    maxHttpBufferSize: 16384,
    allowRequest(req, accept) {
      const origin = req.headers.origin;
      try { accept(null, !origin || new URL(origin).host === req.headers.host); }
      catch { accept('Invalid origin', false); }
    },
  });
  const count = () => new Set([...io.sockets.sockets.values()].filter((socket) => socket.data.role === 'player').map((socket) => socket.data.playerId)).size;
  let previous = projectWorld(db, 0);
  let eventCursor = previous.events.at(-1)?.id ?? 0;
  let observerCursor=(db.prepare('SELECT COALESCE(MAX(id),0) n FROM observer_messages').get() as {n:number}).n;
  let characterCursor=(db.prepare('SELECT COALESCE(MAX(id),0) n FROM conversations').get() as {n:number}).n;
  io.use((socket, next) => {
    const player = playerFromRequest(db, socket.request as Request);
    if (!player) { next(new Error('Login required')); return; }
    socket.data.playerId = player.id; socket.data.role = player.role;
    next();
  });
  io.on('connection', (socket) => {
    socket.emit('world:snapshot', projectWorld(db, count()));
    io.emit('world:presence', { playerCount: count() });
    let lastResync = 0;
    socket.on('world:resync', () => {
      if (Date.now() - lastResync < 1000) return;
      lastResync = Date.now();
      const player = playerFromRequest(db, socket.request as Request);
      if (!player) { socket.disconnect(true); return; }
      socket.emit('world:snapshot', projectWorld(db, count()));
    });
    socket.on('disconnect', () => io.emit('world:presence', { playerCount: count() }));
  });
  const unsubscribe = clock.subscribe(() => {
    for (const socket of io.sockets.sockets.values()) {
      if (!playerFromRequest(db, socket.request as Request)) socket.disconnect(true);
    }
    const current = projectWorld(db, count());
    const byId = new Map(previous.citizens.map((citizen) => [citizen.id, JSON.stringify(citizen)]));
    const events = publicEvents(db, eventCursor, 1000);
    const delta: WorldDelta = {
      previousVersion: previous.version, version: current.version, tick: current.tick,
      gameTimeMs: current.gameTimeMs, day: current.day, minute: current.minute,
      lighting: current.lighting, playerCount: current.playerCount,
      changes: current.citizens.filter((citizen) => byId.get(citizen.id) !== JSON.stringify(citizen)), events,
    };
    if (events.length) eventCursor = events.at(-1)!.id;
    previous = current;
    io.emit('world:delta', delta);
    const observer=(db.prepare('SELECT COALESCE(MAX(id),0) n FROM observer_messages').get() as {n:number}).n;
    if(observer>observerCursor){observerCursor=observer;io.emit('chat:observer',{lastId:observer});}
    const character=(db.prepare('SELECT COALESCE(MAX(id),0) n FROM conversations').get() as {n:number}).n;
    if(character>characterCursor){characterCursor=character;io.emit('chat:character',{lastId:character});}
  });
  return { io, close() { unsubscribe(); io.disconnectSockets(true); io.close(); } };
}
