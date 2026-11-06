import { useEffect, useRef, useState } from 'react';
import { grid, observerAppearance, type Direction } from './pixels';
import { BUILDING_TYPES, TILE_NAMES, building, pixelText, tile } from './tiles';
import { citizenSprite, portrait } from './characters';
import { ICON_NAMES, icon } from './icons';
import { texture } from './textures';

export function PixelAvatar({ avatar, label, size = 64 }: { avatar: number; label: string; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = ref.current!.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, 32, 32);
    ctx.drawImage(texture(portrait(observerAppearance(avatar))), 0, 0);
  }, [avatar]);
  return <canvas ref={ref} width={32} height={32} style={{ width: size, height: size, imageRendering: 'pixelated' }} role="img" aria-label={label} />;
}

function GalleryCanvas() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    const terrain = TILE_NAMES.map((name) => texture(tile(name)));
    const buildings = BUILDING_TYPES.map((type) => texture(building(type)));
    const portraits = Array.from({ length: 10 }, (_, index) => texture(portrait(observerAppearance(index))));
    const directions: Direction[] = ['down','left','up','right'];
    const sprites = directions.map((direction) => Array.from({ length: 10 }, (_, index) => Array.from({ length: 3 }, (_, frame) => texture(citizenSprite(observerAppearance(index), direction, frame)))));
    const icons = ICON_NAMES.map((name) => texture(icon(name)));
    const labels = grid(480, 560);
    TILE_NAMES.forEach((name, index) => pixelText(labels, name, 8 + index * 78, 8));
    BUILDING_TYPES.forEach((name, index) => pixelText(labels, name, 8 + index * 66, 83));
    pixelText(labels, 'TEN DISTINCT PORTRAITS', 8, 174);
    directions.forEach((direction, index) => pixelText(labels, direction, 8, 226 + index * 60));
    pixelText(labels, 'PIXEL ICONS', 8, 470);
    const labelTexture = texture(labels);
    let frameId = 0;
    function draw(time: number) {
      const frame = Math.floor(time / 180) % 3;
      ctx.fillStyle = '#172c35'; ctx.fillRect(0, 0, 480, 560);
      ctx.drawImage(labelTexture, 0, 0);
      terrain.forEach((image, index) => ctx.drawImage(image, 8 + index * 78, 20));
      buildings.forEach((image, index) => ctx.drawImage(image, 8 + index * 66, 96));
      portraits.forEach((image, index) => ctx.drawImage(image, 8 + index * 46, 186));
      sprites.forEach((row, rowIndex) => row.forEach((frames, index) => ctx.drawImage(frames[frame], 8 + index * 46, 236 + rowIndex * 60, 32, 48)));
      icons.forEach((image, index) => ctx.drawImage(image, 8 + index % 12 * 38, 488 + Math.floor(index / 12) * 32));
      frameId = requestAnimationFrame(draw);
    }
    frameId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frameId);
  }, []);
  return <div className="pixel-preview mt-4"><canvas ref={ref} width={480} height={560} role="img" aria-label="Procedural terrain, seven building types, ten portraits, animated citizens walking in four directions, and pixel icons" /></div>;
}
export function AssetGallery() {
  const [open, setOpen] = useState(false);
  return <section className="accounts mt-6"><button onClick={() => setOpen(!open)} aria-expanded={open}>{open ? 'Hide pixel art' : 'Preview pixel art'}</button>{open && <GalleryCanvas />}</section>;
}
