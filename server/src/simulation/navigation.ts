import { MAP_SIZE, type TilePoint, type TownBuilding } from '../../../shared/world.js';

export const tileKey = (point: TilePoint) => `${point.x},${point.y}`;
export function walkable(point: TilePoint, buildings: TownBuilding[]) {
  if (!Number.isInteger(point.x) || !Number.isInteger(point.y) || point.x < 0 || point.y < 0 || point.x >= MAP_SIZE.width || point.y >= MAP_SIZE.height) return false;
  if (point.x >= 72 && point.y < 24) return false;
  return !buildings.some((building) => building.type !== 'square' && point.x >= building.x && point.x < building.x + building.width && point.y >= building.y && point.y < building.y + building.height);
}

export function findPath(start: TilePoint, goal: TilePoint, buildings: TownBuilding[], occupied = new Set<string>()): TilePoint[] | null {
  if (!walkable(start, buildings) || !walkable(goal, buildings) || occupied.has(tileKey(goal))) return null;
  if (tileKey(start) === tileKey(goal)) return [];
  const queue: TilePoint[] = [start];
  const visited = new Map<string, TilePoint | null>([[tileKey(start), null]]);
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head];
    for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
      const next = { x: current.x + dx, y: current.y + dy };
      const key = tileKey(next);
      if (visited.has(key) || occupied.has(key) || !walkable(next, buildings)) continue;
      visited.set(key, current);
      if (key === tileKey(goal)) {
        const path: TilePoint[] = [next];
        let previous = current;
        while (tileKey(previous) !== tileKey(start)) {
          path.push(previous);
          previous = visited.get(tileKey(previous))!;
        }
        return path.reverse();
      }
      queue.push(next);
    }
  }
  return null;
}

export function entrance(building: TownBuilding, buildings: TownBuilding[], occupied: Set<string>, citizenId: string): TilePoint | null {
  const offset = [...citizenId].reduce((sum, letter) => sum + letter.charCodeAt(0), 0) % 3 - 1;
  const candidates = [
    { x: building.door_x + offset, y: building.door_y },
    { x: building.door_x, y: building.door_y },
    { x: building.door_x - 1, y: building.door_y },
    { x: building.door_x + 1, y: building.door_y },
    { x: building.door_x, y: building.door_y + 1 },
    { x: building.door_x - 2, y: building.door_y },
    { x: building.door_x + 2, y: building.door_y },
    { x: building.door_x, y: building.door_y + 2 },
  ];
  return candidates.find((point) => walkable(point, buildings) && !occupied.has(tileKey(point))) ?? null;
}
