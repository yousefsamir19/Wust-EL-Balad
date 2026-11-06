import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import type { WorldDelta, WorldSnapshot } from '../../../shared/realtime';
import { applyDelta } from './reconcile';

export function useWorld() {
  const [world, setWorld] = useState<WorldSnapshot | null>(null);
  const [status, setStatus] = useState('Connecting');
  const [observerRevision,setObserverRevision]=useState(0),[characterRevision,setCharacterRevision]=useState(0);
  useEffect(() => {
    const socket = io({ withCredentials: true });
    let current: WorldSnapshot | null = null;
    let firstSnapshot = true;
    socket.on('connect', () => { firstSnapshot = true; setStatus('Synchronizing');setObserverRevision(v=>v+1);setCharacterRevision(v=>v+1); });
    socket.on('chat:observer',()=>setObserverRevision(v=>v+1));
    socket.on('chat:character',()=>setCharacterRevision(v=>v+1));
    socket.on('world:snapshot', (snapshot: WorldSnapshot) => {
      if (!firstSnapshot && current && snapshot.version < current.version) return;
      firstSnapshot = false; current = snapshot; setWorld(snapshot); setStatus('Live');
    });
    socket.on('world:delta', (delta: WorldDelta) => {
      const update = applyDelta(current, delta);
      if (update.needsResync) { socket.emit('world:resync'); return; }
      current = update.world; setWorld(current);
    });
    socket.on('world:presence', ({ playerCount }: { playerCount: number }) => {
      if (current) { current = { ...current, playerCount }; setWorld(current); }
    });
    socket.on('disconnect', (reason) => { setStatus('Reconnecting'); if (reason === 'io server disconnect') socket.connect(); });
    socket.on('connect_error', (error) => setStatus(error.message === 'Login required' ? 'Login required' : 'Reconnecting'));
    return () => { socket.disconnect(); };
  }, []);
  return { world, status,observerRevision,characterRevision };
}
export function timeLabel(minute: number) {
  return `${Math.floor(minute / 60).toString().padStart(2, '0')}:${Math.floor(minute % 60).toString().padStart(2, '0')}`;
}
