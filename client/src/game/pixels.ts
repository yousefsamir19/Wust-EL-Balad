export interface PixelGrid { width: number; height: number; pixels: string[] }
export type Direction = 'up' | 'down' | 'left' | 'right';
export interface Appearance { hair: number; clothing: string; accessory: number }
export const OBSERVER_COLORS = ['#396b8c','#b45752','#54648d','#d6aa55','#5a875d','#87678f','#c3825b','#46586e','#a96e96','#758954'] as const;
export function grid(width: number, height: number, fill = ''): PixelGrid {
  return { width, height, pixels: Array(width * height).fill(fill) };
}
export function pixel(image: PixelGrid, x: number, y: number, color: string) {
  if (Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < image.width && y < image.height) image.pixels[y * image.width + x] = color;
}
export function rect(image: PixelGrid, x: number, y: number, width: number, height: number, color: string) {
  for (let yy = y; yy < y + height; yy++) for (let xx = x; xx < x + width; xx++) pixel(image, xx, yy, color);
}
export function stamp(target: PixelGrid, image: PixelGrid, x: number, y: number, scale = 1) {
  for (let yy = 0; yy < image.height; yy++) for (let xx = 0; xx < image.width; xx++) {
    const color = image.pixels[yy * image.width + xx];
    if (color) rect(target, x + xx * scale, y + yy * scale, scale, scale, color);
  }
}
export function shade(color: string, amount: number) {
  const channels = color.slice(1).match(/.{2}/g) ?? ['00','00','00'];
  return '#' + channels.map((part) => Math.max(0, Math.min(255, parseInt(part, 16) + amount)).toString(16).padStart(2, '0')).join('');
}
export function observerAppearance(index: number): Appearance {
  return { hair: index % 4, clothing: OBSERVER_COLORS[index % OBSERVER_COLORS.length], accessory: index % 3 };
}
