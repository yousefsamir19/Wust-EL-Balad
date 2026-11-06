import { useEffect, useRef } from 'react';
import { citizenSprite } from './characters';
import { clampCamera, pickCitizen, screenToTile, TILE_SIZE, zoomAt, type Camera } from './camera';
import { tile, building } from './tiles';
import { texture } from './textures';
import { LAMP_POSITIONS, MAP_SIZE, TREE_POSITIONS, type VisibleCitizen } from '../../../shared/world';
import type { WorldSnapshot } from '../../../shared/realtime';
import type { Direction } from './pixels';
import { activeSpeech,publicEmote } from './overlays';

export interface TownMapProps {
  world: WorldSnapshot;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  followId: string | null;
  onStopFollow: () => void;
}

type TownPoint = { x: number; y: number };
type PointerPoint = TownPoint & { startX: number; startY: number; moved: boolean };
type SpritePoint = { x: number; y: number; targetX: number; targetY: number };
type BackgroundCache = { key: string; canvas: HTMLCanvasElement };
type MapMotion = {
  camera: Camera;
  targetCamera: Camera;
  width: number;
  height: number;
  dpr: number;
  reducedMotion: boolean;
  pointers: Map<number, PointerPoint>;
  pinchDistance: number | null;
  dragPointer: number | null;
  background: BackgroundCache | null;
  sprites: Map<string, HTMLCanvasElement>;
  positions: Map<string, SpritePoint>;
  frame: number;
  lastTime: number;
};

const WORLD_WIDTH = MAP_SIZE.width * TILE_SIZE;
const WORLD_HEIGHT = MAP_SIZE.height * TILE_SIZE;
const TILE_CACHE = new Map<string, HTMLCanvasElement>();
const BUILDING_CACHE = new Map<string, HTMLCanvasElement>();
const SCENERY_CACHE = new Map<'tree' | 'streetlamp', HTMLCanvasElement>();

function initialCamera(): Camera {
  return { x: 32 * TILE_SIZE + TILE_SIZE / 2, y: 24 * TILE_SIZE + TILE_SIZE / 2, zoom: 1 };
}

function clampPixel(value: number): number {
  return Math.round(value);
}

function distance(a: TownPoint, b: TownPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function tileTexture(name: 'grass' | 'road' | 'water', variant: number): HTMLCanvasElement {
  const key = `${name}:${variant}`;
  const saved = TILE_CACHE.get(key);
  if (saved) return saved;
  const savedTexture = texture(tile(name, variant));
  TILE_CACHE.set(key, savedTexture);
  return savedTexture;
}

function buildingTexture(type: string, width: number, height: number): HTMLCanvasElement {
  const key = `${type}:${width}:${height}`;
  const saved = BUILDING_CACHE.get(key);
  if (saved) return saved;
  const savedTexture = texture(building(type, width, height));
  BUILDING_CACHE.set(key, savedTexture);
  return savedTexture;
}

function spriteTexture(citizen: VisibleCitizen, frame: number, cache: Map<string, HTMLCanvasElement>): HTMLCanvasElement {
  const key = `${citizen.id}:${citizen.direction}:${citizen.appearance.hair}:${citizen.appearance.clothing}:${citizen.appearance.accessory}:${frame}`;
  const saved = cache.get(key);
  if (saved) return saved;
  const savedTexture = texture(citizenSprite(citizen.appearance, citizen.direction as Direction, frame));
  cache.set(key, savedTexture);
  return savedTexture;
}

function roadAt(x: number, y: number): boolean {
  return (y >= 16 && y <= 18) || (y >= 38 && y <= 40) || (y >= 53 && y <= 55) ||
    (x >= 11 && x <= 13) || (x >= 32 && x <= 34) || (x >= 51 && x <= 53);
}

function sceneryKey(world: WorldSnapshot): string {
  return world.buildings.map((item) => `${item.id}:${item.type}:${item.x}:${item.y}:${item.width}:${item.height}`).join('|');
}

function makeBackground(world: WorldSnapshot): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = WORLD_WIDTH;
  canvas.height = WORLD_HEIGHT;
  const context = canvas.getContext('2d');
  if (!context) return canvas;
  context.imageSmoothingEnabled = false;
  for (let y = 0; y < MAP_SIZE.height; y += 1) {
    for (let x = 0; x < MAP_SIZE.width; x += 1) {
      const water = x >= 72 && y < 24;
      const name = water ? 'water' : roadAt(x, y) ? 'road' : 'grass';
      context.drawImage(tileTexture(name, (x * 3 + y) % 4), x * TILE_SIZE, y * TILE_SIZE);
    }
  }
  const treeImage = SCENERY_CACHE.get('tree') ?? texture(tile('tree'));
  const lampImage = SCENERY_CACHE.get('streetlamp') ?? texture(tile('streetlamp'));
  SCENERY_CACHE.set('tree', treeImage);
  SCENERY_CACHE.set('streetlamp', lampImage);
  for (const point of TREE_POSITIONS) context.drawImage(treeImage, point.x * TILE_SIZE - TILE_SIZE / 2, point.y * TILE_SIZE - TILE_SIZE * 3);
  for (const point of LAMP_POSITIONS) context.drawImage(lampImage, point.x * TILE_SIZE, point.y * TILE_SIZE - TILE_SIZE * 2);
  for (const item of world.buildings) {
    context.drawImage(buildingTexture(item.type, item.width * TILE_SIZE, item.height * TILE_SIZE), item.x * TILE_SIZE, item.y * TILE_SIZE);
  }
  return canvas;
}

function midpoint(a: TownPoint, b: TownPoint): TownPoint {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function shortText(value: string, length: number): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean.length > length ? `${clean.slice(0, Math.max(0, length - 1))}…` : clean;
}

function drawSpeech(context: CanvasRenderingContext2D, citizen: VisibleCitizen, text: string): void {
  const label = shortText(text, 23);
  if (!label) return;
  const x = clampPixel(citizen.x * TILE_SIZE + 8);
  const y = clampPixel(citizen.y * TILE_SIZE - 13);
  context.font = '12px "VT323", monospace';
  const width = Math.ceil(context.measureText(label).width) + 8;
  const left = x - Math.floor(width / 2);
  context.fillStyle = '#f9e8b0';
  context.fillRect(left, y - 10, width, 12);
  context.fillStyle = '#2c3037';
  context.fillRect(left + 4, y + 2, 3, 3);
  context.fillRect(left + 3, y + 4, 2, 2);
  context.strokeStyle = '#2c3037';
  context.lineWidth = 1;
  context.strokeRect(left + 0.5, y - 9.5, width - 1, 11);
  context.fillStyle = '#2c3037';
  context.fillText(label, left + 4, y - 2);
}

function pixelGlow(context: CanvasRenderingContext2D, x: number, y: number, radius: number, color: string) {
  context.fillStyle = color;
  for (let row = -radius; row <= radius; row++) {
    const half = Math.floor(Math.sqrt(radius * radius - row * row));
    context.fillRect(x - half, y + row, half * 2 + 1, 1);
  }
}

function drawLighting(context: CanvasRenderingContext2D, world: WorldSnapshot): void {
  const dayWarm = world.lighting === 'day' && world.minute >= 12 * 60;
  context.fillStyle = world.lighting === 'night' ? 'rgba(13,25,64,.58)' :
    world.lighting === 'sunset' ? 'rgba(194,110,57,.24)' : dayWarm ? 'rgba(247,199,117,.10)' : 'rgba(247,219,163,.035)';
  context.fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
  if (world.lighting === 'day') return;
  context.save();
  context.globalCompositeOperation = 'lighter';
  for (const point of LAMP_POSITIONS) {
    const x = point.x * TILE_SIZE + 8;
    const y = point.y * TILE_SIZE - 24;
    pixelGlow(context, x, y, 18, 'rgba(255,207,105,.055)');
    pixelGlow(context, x, y, 10, 'rgba(255,215,119,.13)');
    context.fillStyle = '#ffe9a2';
    context.fillRect(x - 3, y - 3, 6, 6);
  }
  for (const buildingItem of world.buildings) {
    if (buildingItem.type === 'square') continue;
    for (const offset of [11, buildingItem.width * TILE_SIZE - 19]) {
      const x = buildingItem.x * TILE_SIZE + offset;
      const y = buildingItem.y * TILE_SIZE + Math.floor(buildingItem.height * TILE_SIZE * .4) + 14;
      pixelGlow(context, x + 1, y + 4, 6, 'rgba(255,207,105,.05)');
      context.fillStyle = '#f6d48d';
      context.fillRect(x, y, 3, 8);
    }
  }
  context.restore();
}

function drawSelected(context: CanvasRenderingContext2D, citizen: VisibleCitizen, zoom: number): void {
  const x = clampPixel(citizen.x * TILE_SIZE + 8);
  const y = clampPixel(citizen.y * TILE_SIZE + 15);
  context.strokeStyle = '#f8df79';
  context.lineWidth = Math.max(1, 2 / zoom);
  context.strokeRect(x - 10, y - 26, 20, 26);
  context.fillStyle = '#f8df79';
  context.fillRect(x - 2, y - 29, 4, 2);
  context.fillRect(x - 2, y + 1, 4, 2);
}

function drawMap(
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
  world: WorldSnapshot,
  motion: MapMotion,
  selectedId: string | null,
): void {
  const { width, height, dpr } = motion;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, width, height);
  context.imageSmoothingEnabled = false;
  const camera = motion.camera;
  const translationX = clampPixel(width / 2 - camera.x * camera.zoom);
  const translationY = clampPixel(height / 2 - camera.y * camera.zoom);
  context.save();
  context.translate(translationX, translationY);
  context.scale(camera.zoom, camera.zoom);
  const key = sceneryKey(world);
  if (!motion.background || motion.background.key !== key) motion.background = { key, canvas: makeBackground(world) };
  context.drawImage(motion.background.canvas, 0, 0);

  const positions = world.citizens.map((citizen) => {
    const point = motion.positions.get(citizen.id);
    return point ? { ...citizen, x: point.x, y: point.y } : citizen;
  });
  for (const citizen of positions) {
    const point = motion.positions.get(citizen.id);
    const moving = point ? Math.hypot(point.targetX - point.x, point.targetY - point.y) > .03 : false;
    const frame = moving && !motion.reducedMotion ? Math.floor(motion.lastTime / 180) % 3 : 0;
    const image = spriteTexture(citizen, frame, motion.sprites);
    context.drawImage(image, clampPixel(citizen.x * TILE_SIZE), clampPixel(citizen.y * TILE_SIZE - 8));
  }
  drawLighting(context, world);
  const speech=activeSpeech(world),speaking=new Set(speech.map(e=>e.actorId));
  for (const event of speech) {
    const speaker = positions.find((citizen) => citizen.id === event.actorId);
    if (speaker) drawSpeech(context, speaker, event.text!);
  }
  for(const citizen of positions){const emote=publicEmote(citizen);if(emote&&!speaking.has(citizen.id)){context.fillStyle='#f9e8b0';context.fillRect(Math.round(citizen.x*TILE_SIZE+4),Math.round(citizen.y*TILE_SIZE-24),16,12);context.fillStyle='#2c3037';context.font='12px "VT323", monospace';context.fillText(emote,Math.round(citizen.x*TILE_SIZE+8),Math.round(citizen.y*TILE_SIZE-14));}}
  const selected = positions.find((citizen) => citizen.id === selectedId);
  if (selected) drawSelected(context, selected, camera.zoom);
  context.restore();
  void canvas;
}

function ensurePosition(motion: MapMotion, citizen: VisibleCitizen, reducedMotion: boolean): SpritePoint {
  const current = motion.positions.get(citizen.id);
  if (!current) {
    const created = { x: citizen.x, y: citizen.y, targetX: citizen.x, targetY: citizen.y };
    motion.positions.set(citizen.id, created);
    return created;
  }
  current.targetX = citizen.x;
  current.targetY = citizen.y;
  if (reducedMotion) {
    current.x = citizen.x;
    current.y = citizen.y;
  }
  return current;
}

function followCamera(motion: MapMotion, world: WorldSnapshot, followId: string | null): void {
  if (!followId) return;
  const citizen = world.citizens.find((item) => item.id === followId);
  const point = citizen ? motion.positions.get(citizen.id) : undefined;
  if (!point) return;
  motion.targetCamera = clampCamera({ x: point.x * TILE_SIZE + 8, y: point.y * TILE_SIZE + 8, zoom: motion.targetCamera.zoom }, motion.width, motion.height);
}

export function TownMap({ world, selectedId, onSelect, followId, onStopFollow }: TownMapProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const latestProps = useRef<TownMapProps>({ world, selectedId, onSelect, followId, onStopFollow });
  const motionRef = useRef<MapMotion | null>(null);
  latestProps.current = { world, selectedId, onSelect, followId, onStopFollow };

  useEffect(() => {
    const canvas = canvasRef.current;
    const root = rootRef.current;
    if (!canvas || !root) return undefined;
    const context = canvas.getContext('2d');
    if (!context) return undefined;
    const reducedMotion = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const motion: MapMotion = {
      camera: initialCamera(),
      targetCamera: initialCamera(),
      width: 1,
      height: 1,
      dpr: 1,
      reducedMotion,
      pointers: new Map(),
      pinchDistance: null,
      dragPointer: null,
      background: null,
      sprites: new Map(),
      positions: new Map(),
      frame: 0,
      lastTime: 0,
    };
    motionRef.current = motion;

    const resize = () => {
      const rect = root.getBoundingClientRect();
      motion.width = Math.max(1, Math.floor(rect.width || root.clientWidth || 1));
      motion.height = Math.max(1, Math.floor(rect.height || root.clientHeight || 1));
      motion.dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
      canvas.width = motion.width * motion.dpr;
      canvas.height = motion.height * motion.dpr;
      canvas.style.width = `${motion.width}px`;
      canvas.style.height = `${motion.height}px`;
      motion.camera = clampCamera(motion.camera, motion.width, motion.height);
      motion.targetCamera = clampCamera(motion.targetCamera, motion.width, motion.height);
    };
    resize();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
    observer?.observe(root);

    const pointFromEvent = (event: PointerEvent): TownPoint => {
      const rect = canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    const setCapture = (pointerId: number) => {
      try { canvas.setPointerCapture(pointerId); } catch { /* synthetic events may not support capture */ }
    };
    const stopFollowing = () => { if (latestProps.current.followId) latestProps.current.onStopFollow(); };
    const pointerDown = (event: PointerEvent) => {
      event.preventDefault();
      const point = pointFromEvent(event);
      motion.pointers.set(event.pointerId, { ...point, startX: point.x, startY: point.y, moved: false });
      setCapture(event.pointerId);
      if (motion.pointers.size === 1) motion.dragPointer = event.pointerId;
      if (motion.pointers.size === 2) {
        const values = [...motion.pointers.values()];
        values.forEach((value) => { value.moved = true; });
        motion.pinchDistance = distance(values[0], values[1]);
      }
    };
    const pointerMove = (event: PointerEvent) => {
      const point = pointFromEvent(event);
      const current = motion.pointers.get(event.pointerId);
      if (!current) return;
      event.preventDefault();
      const dx = point.x - current.x;
      const dy = point.y - current.y;
      current.x = point.x;
      current.y = point.y;
      current.moved = current.moved || distance(current, { x: current.startX, y: current.startY }) > 5;
      if (motion.pointers.size >= 2) {
        const values = [...motion.pointers.values()];
        const nextDistance = distance(values[0], values[1]);
        const previousDistance = motion.pinchDistance ?? nextDistance;
        if (previousDistance > 0 && Math.abs(nextDistance - previousDistance) > 12) {
          const center = midpoint(values[0], values[1]);
          const direction = nextDistance > previousDistance ? 1 : -1;
          motion.targetCamera = zoomAt(motion.targetCamera, motion.targetCamera.zoom + direction, center, motion.width, motion.height);
          motion.pinchDistance = nextDistance;
          stopFollowing();
        }
      } else if (motion.dragPointer === event.pointerId && (dx !== 0 || dy !== 0)) {
        motion.targetCamera = clampCamera({ ...motion.targetCamera, x: motion.targetCamera.x - dx / motion.targetCamera.zoom, y: motion.targetCamera.y - dy / motion.targetCamera.zoom }, motion.width, motion.height);
        stopFollowing();
      }
    };
    const pointerUp = (event: PointerEvent) => {
      const current = motion.pointers.get(event.pointerId);
      if (current && !current.moved && motion.pointers.size === 1) {
        const point = pointFromEvent(event);
        const tilePoint = screenToTile(motion.camera, point, motion.width, motion.height);
        const positions = latestProps.current.world.citizens.map((citizen) => {
          const value = motion.positions.get(citizen.id);
          return { id: citizen.id, x: value?.x ?? citizen.x, y: value?.y ?? citizen.y };
        });
        latestProps.current.onSelect(pickCitizen(positions, tilePoint));
      }
      motion.pointers.delete(event.pointerId);
      if (motion.pointers.size < 2) motion.pinchDistance = null;
      motion.dragPointer = motion.pointers.keys().next().value ?? null;
    };
    const pointerCancel = (event: PointerEvent) => {
      motion.pointers.delete(event.pointerId);
      motion.pinchDistance = null;
      if (motion.pointers.size === 0) motion.dragPointer = null;
    };
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const direction = event.deltaY < 0 ? 1 : -1;
      motion.targetCamera = zoomAt(motion.targetCamera, motion.targetCamera.zoom + direction, point, motion.width, motion.height);
      stopFollowing();
    };
    const keyDown = (event: KeyboardEvent) => {
      const key = event.key;
      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', '+', '=', '-', '_'].includes(key)) return;
      event.preventDefault();
      if (key === '+' || key === '=') {
        motion.targetCamera = zoomAt(motion.targetCamera, motion.targetCamera.zoom + 1, { x: motion.width / 2, y: motion.height / 2 }, motion.width, motion.height);
      } else if (key === '-' || key === '_') {
        motion.targetCamera = zoomAt(motion.targetCamera, motion.targetCamera.zoom - 1, { x: motion.width / 2, y: motion.height / 2 }, motion.width, motion.height);
      } else {
        const amount = 48 / motion.targetCamera.zoom;
        const x = key === 'ArrowLeft' ? -amount : key === 'ArrowRight' ? amount : 0;
        const y = key === 'ArrowUp' ? -amount : key === 'ArrowDown' ? amount : 0;
        motion.targetCamera = clampCamera({ ...motion.targetCamera, x: motion.targetCamera.x + x, y: motion.targetCamera.y + y }, motion.width, motion.height);
      }
      stopFollowing();
    };

    canvas.addEventListener('pointerdown', pointerDown);
    canvas.addEventListener('pointermove', pointerMove, { passive: false });
    canvas.addEventListener('pointerup', pointerUp);
    canvas.addEventListener('pointercancel', pointerCancel);
    canvas.addEventListener('wheel', wheel, { passive: false });
    root.addEventListener('keydown', keyDown);

    const render = (time: number) => {
      const props = latestProps.current;
      if (!motion.lastTime) motion.lastTime = time;
      motion.lastTime = time;
      for (const citizen of props.world.citizens) ensurePosition(motion, citizen, motion.reducedMotion);
      for (const id of [...motion.positions.keys()]) if (!props.world.citizens.some((citizen) => citizen.id === id)) motion.positions.delete(id);
      followCamera(motion, props.world, props.followId);
      const cameraAlpha = motion.reducedMotion ? 1 : .16;
      motion.camera = {
        ...motion.camera,
        x: motion.camera.x + (motion.targetCamera.x - motion.camera.x) * cameraAlpha,
        y: motion.camera.y + (motion.targetCamera.y - motion.camera.y) * cameraAlpha,
        zoom: motion.targetCamera.zoom,
      };
      for (const point of motion.positions.values()) {
        const alpha = motion.reducedMotion ? 1 : .2;
        point.x += (point.targetX - point.x) * alpha;
        point.y += (point.targetY - point.y) * alpha;
      }
      drawMap(canvas, context, props.world, motion, props.selectedId);
      motion.frame = window.requestAnimationFrame(render);
    };
    motion.frame = window.requestAnimationFrame(render);

    return () => {
      window.cancelAnimationFrame(motion.frame);
      observer?.disconnect();
      canvas.removeEventListener('pointerdown', pointerDown);
      canvas.removeEventListener('pointermove', pointerMove);
      canvas.removeEventListener('pointerup', pointerUp);
      canvas.removeEventListener('pointercancel', pointerCancel);
      canvas.removeEventListener('wheel', wheel);
      root.removeEventListener('keydown', keyDown);
      motionRef.current = null;
    };
  }, []);

  const setZoom = (delta: number) => {
    const motion = motionRef.current;
    if (!motion) return;
    motion.targetCamera = zoomAt(motion.targetCamera, motion.targetCamera.zoom + delta, { x: motion.width / 2, y: motion.height / 2 }, motion.width, motion.height);
  };

  return (
    <div ref={rootRef} className="town-map" tabIndex={0} role="application" aria-label="Downtown Cairo town map">
      <canvas ref={canvasRef} aria-label="Interactive town map" style={{ display: 'block', width: '100%', height: '100%', imageRendering: 'pixelated', touchAction: 'none' }} />
      <div className="map-controls" aria-label="Map controls">
        <button type="button" aria-label="Zoom out" onClick={() => setZoom(-1)}>−</button>
        <button type="button" aria-label="Zoom in" onClick={() => setZoom(1)}>+</button>
        {followId ? <button type="button" aria-label="Stop following citizen" onClick={onStopFollow}>Stop</button> : null}
      </div>
    </div>
  );
}
