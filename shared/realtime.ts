import type { TownBuilding, VisibleCitizen } from './world.js';
export interface PublicEvent {
  id: number; gameTimeMs: number; type: string; actorId: string | null; target: string | null;
  amount: number | null; importance: number; text?: string; activity?: string;
}
export interface WorldSnapshot {
  version: number; tick: number; gameTimeMs: number; day: number; minute: number;
  lighting: 'day' | 'sunset' | 'night'; playerCount: number;
  citizens: VisibleCitizen[]; buildings: TownBuilding[]; events: PublicEvent[];
}
export interface WorldDelta extends Omit<WorldSnapshot, 'citizens' | 'buildings'> {
  previousVersion: number; changes: VisibleCitizen[];
}
