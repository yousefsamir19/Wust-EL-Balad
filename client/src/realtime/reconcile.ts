import type { WorldDelta, WorldSnapshot } from '../../../shared/realtime';
export function applyDelta(world: WorldSnapshot | null, delta: WorldDelta) {
  if (!world) return { world, needsResync: true };
  if (delta.version <= world.version) return { world, needsResync: false };
  if (delta.previousVersion !== world.version) return { world, needsResync: true };
  const changes = new Map(delta.changes.map((citizen) => [citizen.id, citizen]));
  const events = [...world.events, ...delta.events].filter((event, index, all) => all.findIndex((candidate) => candidate.id === event.id) === index).slice(-40);
  return {
    needsResync: false,
    world: { ...world, version: delta.version, tick: delta.tick, gameTimeMs: delta.gameTimeMs, day: delta.day,
      minute: delta.minute, lighting: delta.lighting, playerCount: delta.playerCount,
      citizens: world.citizens.map((citizen) => changes.get(citizen.id) ?? citizen), events },
  };
}
