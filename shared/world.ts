export const MAP_SIZE = { width: 80, height: 64 } as const;
export const TREE_POSITIONS = [{x:4,y:5},{x:20,y:5},{x:42,y:5},{x:65,y:7},{x:5,y:24},{x:20,y:24},{x:42,y:24},{x:64,y:26},{x:4,y:43},{x:20,y:44},{x:43,y:43},{x:66,y:44}] as const;
export const LAMP_POSITIONS = [{x:12,y:19},{x:33,y:19},{x:52,y:19},{x:12,y:41},{x:33,y:41},{x:52,y:41},{x:8,y:56},{x:26,y:56},{x:44,y:56},{x:62,y:56}] as const;
export interface TilePoint { x: number; y: number }
export interface TownBuilding extends TilePoint {
  id: string; name: string; type: string; width: number; height: number; door_x: number; door_y: number;
}
export interface VisibleCitizen extends TilePoint {
  id: string; name: string; job: string; mood: string; buildingId: string | null;
  activity: string; direction: 'up' | 'down' | 'left' | 'right';
  appearance: { hair: number; clothing: string; accessory: number };
  money: number; needs: { hunger: number; energy: number; social: number };
  publicThought: string;
}
