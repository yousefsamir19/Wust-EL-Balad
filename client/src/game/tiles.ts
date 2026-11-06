import { grid, rect, pixel, shade, type PixelGrid } from './pixels';

export const TILE_NAMES = ['grass','road','water','tree','flowers','streetlamp'] as const;
export const BUILDING_TYPES = ['cafe','bank','police','mechanic','store','house','square'] as const;
const letters: Record<string, string[]> = {
  A:['010','101','111','101','101'], B:['110','101','110','101','110'], C:['011','100','100','100','011'],
  D:['110','101','101','101','110'], E:['111','100','110','100','111'], F:['111','100','110','100','100'],
  G:['011','100','101','101','011'], H:['101','101','111','101','101'], I:['111','010','010','010','111'],
  J:['001','001','001','101','010'], K:['101','101','110','101','101'], L:['100','100','100','100','111'],
  M:['101','111','111','101','101'], N:['101','111','111','111','101'], O:['010','101','101','101','010'],
  P:['110','101','110','100','100'], Q:['010','101','101','111','011'], R:['110','101','110','101','101'],
  S:['011','100','010','001','110'], T:['111','010','010','010','010'], U:['101','101','101','101','111'],
  V:['101','101','101','101','010'], W:['101','101','111','111','101'], X:['101','101','010','101','101'],
  Y:['101','101','010','010','010'], Z:['111','001','010','100','111'],
  '0':['111','101','101','101','111'], '1':['010','110','010','010','111'], '2':['110','001','010','100','111'],
  '3':['110','001','010','001','110'], '4':['101','101','111','001','001'], '5':['111','100','110','001','110'],
  '6':['011','100','111','101','111'], '7':['111','001','010','010','010'], '8':['111','101','111','101','111'], '9':['111','101','111','001','110'],
};
export function pixelText(image: PixelGrid, text: string, x: number, y: number, color = '#f5e5bc', scale = 1) {
  for (const [index, character] of [...text.toUpperCase()].entries()) {
    const glyph = letters[character];
    if (!glyph) continue;
    for (let row = 0; row < glyph.length; row++) for (let col = 0; col < glyph[row].length; col++) {
      if (glyph[row][col] === '1') rect(image, x + index * 4 * scale + col * scale, y + row * scale, scale, scale, color);
    }
  }
}
export function tile(name: typeof TILE_NAMES[number], variant = 0): PixelGrid {
  if (name === 'tree') {
    const image = grid(32, 48);
    rect(image, 10, 36, 16, 4, '#354439'); rect(image, 14, 21, 5, 23, '#69462f'); rect(image, 15, 25, 2, 18, '#916444');
    rect(image, 8, 5, 18, 21, '#294b40'); rect(image, 4, 11, 25, 14, '#35634b'); rect(image, 9, 2, 14, 22, '#467f55');
    rect(image, 6, 9, 9, 10, '#538d59'); rect(image, 16, 6, 8, 10, '#61945f'); rect(image, 11, 19, 12, 6, '#376b48');
    for (let i = 0; i < 12; i++) rect(image, 7 + i * 7 % 19, 6 + i * 5 % 18, 2, 2, '#73a269');
    return image;
  }
  if (name === 'streetlamp') {
    const image = grid(16, 32);
    rect(image, 5, 29, 7, 3, '#263c42'); rect(image, 7, 7, 3, 24, '#344952'); rect(image, 8, 10, 1, 19, '#617b82');
    rect(image, 4, 3, 9, 2, '#213039'); rect(image, 5, 5, 7, 6, '#f5d989'); rect(image, 4, 11, 9, 2, '#263c42');
    rect(image, 6, 6, 4, 4, '#ffe8a2'); rect(image, 7, 0, 3, 3, '#344952');
    return image;
  }
  const image = grid(16, 16, name === 'road' ? '#b9aa86' : name === 'water' ? '#386d89' : '#6f8959');
  if (name === 'grass' || name === 'flowers') {
    for (let i = 0; i < 20; i++) pixel(image, (i * 7 + variant * 3) % 16, (i * 11 + variant) % 16, i % 2 ? '#819965' : '#607e50');
    if (name === 'flowers') for (const [x,y,color] of [[4,5,'#e6a36e'],[11,10,'#c67489'],[7,13,'#f0d788']] as const) {
      rect(image, x, y, 1, 3, '#3d6646'); rect(image, x - 1, y - 1, 3, 2, color); pixel(image, x, y - 1, '#ffe1a0');
    }
  } else if (name === 'road') {
    for (let y = 0; y < 16; y += 4) for (let x = -4 + (y % 8 ? 3 : 0); x < 16; x += 7) {
      rect(image, x, y, 6, 3, '#c9bd97'); rect(image, x, y + 2, 6, 1, '#a79879');
    }
  } else for (let i = 0; i < 6; i++) rect(image, (i * 5 + variant) % 13, (i * 3 + 1) % 16, 4, 1, i % 2 ? '#5791a5' : '#6aa5b8');
  return image;
}
export function building(type: string, width = 64, height = 64): PixelGrid {
  const image = grid(width, height);
  if (type === 'square') {
    rect(image, 1, 1, width - 2, height - 2, '#b8b28e');
    for (let y = 2; y < height; y += 8) rect(image, 2, y, width - 4, 1, '#a19d7e');
    rect(image, width / 2 - 12, height / 2 - 10, 24, 20, '#777f7d'); rect(image, width / 2 - 10, height / 2 - 8, 20, 16, '#4a8999');
    rect(image, width / 2 - 2, height / 2 - 16, 4, 20, '#d0c5a6'); rect(image, width / 2 - 5, height / 2 - 16, 10, 3, '#ece1bc');
    rect(image, 5, height - 15, 15, 4, '#795642'); rect(image, 6, height - 11, 2, 6, '#4e4439'); rect(image, 17, height - 11, 2, 6, '#4e4439');
    return image;
  }
  const roofs: Record<string,string> = { cafe:'#af624b',bank:'#577583',police:'#45648a',mechanic:'#717b7c',store:'#648265',house:'#b48158' };
  const roof = roofs[type] ?? roofs.house;
  const bottom = height - 4;
  const roofBottom = Math.floor(height * .4);
  rect(image, 4, bottom, width - 4, 4, '#324044');
  rect(image, 5, roofBottom, width - 10, bottom - roofBottom, '#bda57d');
  rect(image, 7, roofBottom + 4, width - 14, bottom - roofBottom - 4, '#dbc39c');
  for (let y = roofBottom + 8; y < bottom; y += 6) for (let x = 8 + y % 12; x < width - 8; x += 12) rect(image, x, y, 5, 1, '#c5ad85');
  rect(image, 2, 10, width - 4, roofBottom - 7, shade(roof, -30));
  rect(image, 5, 5, width - 10, roofBottom - 1, roof);
  for (let y = 8; y < roofBottom; y += 4) {
    rect(image, 6, y, width - 12, 1, shade(roof, 20));
    for (let x = 8 + y % 8; x < width - 8; x += 8) rect(image, x, y, 1, 4, shade(roof, -16));
  }
  rect(image, width - 17, 0, 6, 10, '#87705b'); rect(image, width - 18, 0, 8, 2, '#b29b7b');
  const center = Math.floor(width / 2);
  const doorWidth = type === 'mechanic' ? Math.floor(width / 2) : 10;
  rect(image, center - Math.floor(doorWidth / 2) - 1, bottom - 19, doorWidth + 2, 19, '#715848');
  rect(image, center - Math.floor(doorWidth / 2), bottom - 17, doorWidth, 17, type === 'mechanic' ? '#36464b' : '#635044');
  if (type === 'mechanic') for (let y = bottom - 16; y < bottom; y += 3) rect(image, center - doorWidth / 2, y, doorWidth, 1, '#617076');
  else rect(image, center + 2, bottom - 8, 2, 2, '#e0b45f');
  for (const x of [10, width - 20]) {
    rect(image, x - 1, roofBottom + 12, 12, 13, '#856c57'); rect(image, x, roofBottom + 13, 10, 10, '#5d8190');
    rect(image, x + 1, roofBottom + 14, 3, 8, '#e3cf8d'); rect(image, x + 5, roofBottom + 13, 1, 10, '#4d6b72');
    rect(image, x - 2, roofBottom + 25, 14, 2, '#9d8665');
  }
  if (type === 'bank' || type === 'police') for (const x of [6,width-10]) { rect(image,x,roofBottom+8,4,bottom-roofBottom-8,'#ece0bc'); rect(image,x-1,bottom-3,6,3,'#a6977f'); }
  if (type === 'cafe' || type === 'store') {
    for (let x = 7; x < width - 7; x += 4) rect(image, x, roofBottom + 7, 4, 5, x % 8 ? '#e4cf9a' : type === 'cafe' ? '#b4564d' : '#47725a');
  }
  const label: Record<string,string> = { cafe:'CAFE',bank:'BANK',police:'POLICE',mechanic:'MECHANIC',store:'STORE',house:'HOME' };
  const word = label[type] ?? 'HOME';
  const signWidth = word.length * 4 + 4;
  rect(image, center - Math.floor(signWidth / 2), roofBottom - 4, signWidth, 9, '#253843');
  pixelText(image, word, center - word.length * 2 + 1, roofBottom - 2, '#f3dba1');
  return image;
}
