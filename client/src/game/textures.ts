import type { PixelGrid } from './pixels';

const cache = new WeakMap<PixelGrid, HTMLCanvasElement>();
export function texture(image: PixelGrid) {
  const saved = cache.get(image);
  if (saved) return saved;
  const canvas = document.createElement('canvas');
  canvas.width = image.width; canvas.height = image.height;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  const data = ctx.createImageData(image.width, image.height);
  for (const [index, color] of image.pixels.entries()) {
    if (!color) continue;
    const value = parseInt(color.slice(1), 16);
    data.data[index * 4] = value >> 16 & 255;
    data.data[index * 4 + 1] = value >> 8 & 255;
    data.data[index * 4 + 2] = value & 255;
    data.data[index * 4 + 3] = 255;
  }
  ctx.putImageData(data, 0, 0);
  cache.set(image, canvas);
  return canvas;
}
