import { MAP_SIZE, type TilePoint, type VisibleCitizen } from '../../../shared/world';
export const TILE_SIZE = 16;
export interface Camera { x: number; y: number; zoom: number }
export function clampCamera(camera: Camera, width: number, height: number): Camera {
  const zoom = Math.max(1, Math.min(4, Math.round(camera.zoom)));
  const bound = (value: number, view: number, size: number) => view >= size ? size / 2 : Math.max(view / 2, Math.min(size - view / 2, value));
  return { x: bound(camera.x, width / zoom, MAP_SIZE.width * TILE_SIZE), y: bound(camera.y, height / zoom, MAP_SIZE.height * TILE_SIZE), zoom };
}
export function zoomAt(camera: Camera, zoom: number, point: TilePoint, width: number, height: number): Camera {
  const nextZoom = Math.max(1, Math.min(4, Math.round(zoom)));
  const x = camera.x + (point.x - width / 2) / camera.zoom - (point.x - width / 2) / nextZoom;
  const y = camera.y + (point.y - height / 2) / camera.zoom - (point.y - height / 2) / nextZoom;
  return clampCamera({ x, y, zoom: nextZoom }, width, height);
}
export function screenToTile(camera: Camera, point: TilePoint, width: number, height: number) {
  return { x: (camera.x + (point.x - width / 2) / camera.zoom) / TILE_SIZE, y: (camera.y + (point.y - height / 2) / camera.zoom) / TILE_SIZE };
}
export function pickCitizen(citizens: readonly Pick<VisibleCitizen, 'id' | 'x' | 'y'>[], tile: TilePoint): string | null {
  let nearest: string | null = null;
  let distance = .85;
  for (const citizen of citizens) {
    const next = Math.hypot(citizen.x + .5 - tile.x, citizen.y + .4 - tile.y);
    if (next < distance) { nearest = citizen.id; distance = next; }
  }
  return nearest;
}
