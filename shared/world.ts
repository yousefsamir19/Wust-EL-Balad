export const MAP_SIZE = { width: 80, height: 64 } as const;
export interface TilePoint { x: number; y: number }
export interface TownBuilding extends TilePoint {
  id: string; name: string; type: string; width: number; height: number; door_x: number; door_y: number;
}
export interface VisibleCitizen extends TilePoint {
  id: string; name: string; job: string; mood: string; buildingId: string | null;
  activity: string; direction: 'up' | 'down' | 'left' | 'right';
}
