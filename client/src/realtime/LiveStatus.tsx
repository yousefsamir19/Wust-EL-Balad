import { timeLabel, useWorld } from './useWorld';
export function LiveStatus() {
  const { world, status } = useWorld();
  return <div className="status mt-3" role="status">{status}{world && ` · Day ${world.day} ${timeLabel(world.minute)} · Players ${world.playerCount}/6 · Tick ${world.tick} · Walking ${world.citizens.filter((citizen) => citizen.activity === 'walking').length}/10`}</div>;
}
