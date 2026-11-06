import { Appearance, Direction, PixelGrid, grid, pixel, rect, shade, stamp } from './pixels';

const INK = '#1c2435';
const SKIN = ['#f0bd91', '#d99872', '#b96f57', '#8c503f'] as const;
const HAIR = ['#2b2430', '#54352d', '#8a4f36', '#c07a3d', '#d6b45c', '#53616b'] as const;

function cycle(value: number, length: number) {
  return ((value % length) + length) % length;
}

function color(value: string, fallback: string) {
  return /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
}

function tone(value: string, amount: number) {
  return shade(color(value, '#53616b'), amount);
}

function drawDown(image: PixelGrid, appearance: Appearance, frame: number) {
  const skin = SKIN[cycle(appearance.accessory + 1, SKIN.length)];
  const hair = HAIR[cycle(appearance.hair, HAIR.length)];
  const shirt = color(appearance.clothing, '#396b8c');
  const shirtDark = tone(shirt, -32);
  const shirtLight = tone(shirt, 28);
  const hairLight = tone(hair, 24);
  const step = cycle(frame, 3);
  const armLift = step === 1 ? 1 : step === 2 ? -1 : 0;
  const leftLeg = step === 1 ? 4 : step === 2 ? 6 : 5;
  const rightLeg = step === 1 ? 9 : step === 2 ? 7 : 8;

  rect(image, 3, 22, 10, 1, '#20283a');
  rect(image, leftLeg, 17, 3, 5, INK);
  rect(image, rightLeg, 17, 3, 5, INK);
  rect(image, leftLeg, 17, 2, 4, shirtDark);
  rect(image, rightLeg, 17, 2, 4, shirtDark);
  rect(image, leftLeg - 1, 21, 3, 2, '#332c32');
  rect(image, rightLeg + 1, 21, 3, 2, '#332c32');

  rect(image, 4, 10, 8, 8, INK);
  rect(image, 5, 10, 6, 7, shirt);
  rect(image, 6, 10, 4, 1, shirtLight);
  rect(image, 3, 11 + armLift, 2, 5, INK);
  rect(image, 2, 13 + armLift, 2, 3, skin);
  rect(image, 11, 11 - armLift, 2, 5, INK);
  rect(image, 12, 13 - armLift, 2, 3, skin);
  rect(image, 5, 16, 6, 2, shirtDark);
  rect(image, 6, 17, 4, 1, '#ad7a47');
  pixel(image, 7, 12, shirtLight);
  pixel(image, 8, 13, shirtDark);

  rect(image, 5, 2, 6, 8, INK);
  rect(image, 4, 4, 8, 5, INK);
  rect(image, 5, 3, 6, 6, skin);
  rect(image, 6, 4, 4, 5, skin);
  rect(image, 5, 2, 6, 3, hair);
  rect(image, 4, 3, 2, 5, hair);
  rect(image, 10, 3, 2, 5, hair);
  rect(image, 6, 2, 4, 1, hairLight);
  pixel(image, 6, 6, INK);
  pixel(image, 9, 6, INK);
  rect(image, 7, 8, 2, 1, tone(skin, -38));

  if (appearance.accessory === 0) {
    rect(image, 5, 9, 6, 2, '#c64f50');
    pixel(image, 6, 10, '#f09a62');
    pixel(image, 9, 10, '#f09a62');
  } else if (appearance.accessory === 1) {
    rect(image, 4, 2, 8, 1, INK);
    rect(image, 5, 1, 6, 2, hair);
    rect(image, 6, 1, 4, 1, hairLight);
    rect(image, 3, 3, 10, 1, '#c08a4e');
  } else {
    rect(image, 5, 6, 2, 1, '#7ed0c2');
    rect(image, 9, 6, 2, 1, '#7ed0c2');
    pixel(image, 8, 6, INK);
    rect(image, 11, 12, 2, 5, '#b87945');
    pixel(image, 12, 15, '#e0a85b');
  }
}

function drawUp(image: PixelGrid, appearance: Appearance, frame: number) {
  const hair = HAIR[cycle(appearance.hair, HAIR.length)];
  const shirt = color(appearance.clothing, '#396b8c');
  const shirtDark = tone(shirt, -32);
  const hairLight = tone(hair, 24);
  const step = cycle(frame, 3);
  const leftLeg = step === 1 ? 4 : step === 2 ? 6 : 5;
  const rightLeg = step === 1 ? 9 : step === 2 ? 7 : 8;

  rect(image, 3, 22, 10, 1, '#20283a');
  rect(image, leftLeg, 17, 3, 5, INK);
  rect(image, rightLeg, 17, 3, 5, INK);
  rect(image, leftLeg, 17, 2, 4, shirtDark);
  rect(image, rightLeg, 17, 2, 4, shirtDark);
  rect(image, leftLeg - 1, 21, 3, 2, '#332c32');
  rect(image, rightLeg + 1, 21, 3, 2, '#332c32');

  rect(image, 4, 10, 8, 8, INK);
  rect(image, 5, 10, 6, 7, shirt);
  rect(image, 3, 11, 2, 5, INK);
  rect(image, 11, 11, 2, 5, INK);
  rect(image, 5, 16, 6, 2, shirtDark);
  rect(image, 7, 11, 2, 4, shirtDark);
  pixel(image, 8, 11, '#ad7a47');

  rect(image, 4, 2, 8, 8, INK);
  rect(image, 5, 2, 6, 7, hair);
  rect(image, 4, 4, 2, 5, hair);
  rect(image, 10, 4, 2, 5, hair);
  rect(image, 6, 2, 4, 1, hairLight);
  rect(image, 5, 8, 6, 2, tone(hair, -25));
  if (appearance.accessory === 0) {
    rect(image, 5, 9, 6, 2, '#c64f50');
  } else if (appearance.accessory === 1) {
    rect(image, 3, 2, 10, 2, '#c08a4e');
    rect(image, 5, 1, 6, 1, hair);
  } else {
    rect(image, 10, 12, 3, 5, '#b87945');
    pixel(image, 12, 15, '#e0a85b');
  }
}

function drawSide(image: PixelGrid, appearance: Appearance, frame: number, right: boolean) {
  const skin = SKIN[cycle(appearance.accessory + 1, SKIN.length)];
  const hair = HAIR[cycle(appearance.hair, HAIR.length)];
  const shirt = color(appearance.clothing, '#396b8c');
  const shirtDark = tone(shirt, -32);
  const hairLight = tone(hair, 24);
  const step = cycle(frame, 3);
  const mirror = (x: number, width = 1) => right ? 16 - x - width : x;
  const mrect = (x: number, y: number, width: number, height: number, fill: string) => rect(image, mirror(x, width), y, width, height, fill);
  const legA = step === 1 ? 4 : step === 2 ? 6 : 5;
  const legB = step === 1 ? 9 : step === 2 ? 7 : 8;

  rect(image, 3, 22, 10, 1, '#20283a');
  mrect(legA, 17, 3, 5, INK);
  mrect(legB, 17, 3, 5, INK);
  mrect(legA, 17, 2, 4, shirtDark);
  mrect(legB, 17, 2, 4, shirtDark);
  mrect(legA - 1, 21, 3, 2, '#332c32');
  mrect(legB + 1, 21, 3, 2, '#332c32');

  mrect(5, 10, 7, 8, INK);
  mrect(6, 10, 5, 7, shirt);
  mrect(3, 11 + (step === 1 ? 1 : 0), 3, 5, INK);
  mrect(2, 13 + (step === 1 ? 1 : 0), 2, 3, skin);
  mrect(10, 11, 2, 5, INK);
  mrect(5, 16, 6, 2, shirtDark);

  mrect(5, 2, 7, 8, INK);
  mrect(5, 3, 6, 6, skin);
  mrect(6, 2, 6, 5, hair);
  mrect(10, 4, 2, 5, hair);
  mrect(6, 2, 4, 1, hairLight);
  mrect(4, 6, 2, 3, hair);
  mrect(3, 6, 2, 1, skin);
  mrect(6, 6, 1, 1, INK);

  if (appearance.accessory === 0) {
    mrect(5, 9, 6, 2, '#c64f50');
  } else if (appearance.accessory === 1) {
    mrect(4, 2, 9, 2, '#c08a4e');
    mrect(6, 1, 5, 1, hair);
  } else {
    mrect(4, 6, 3, 1, '#7ed0c2');
    mrect(10, 12, 3, 5, '#b87945');
    mrect(11, 15, 1, 1, '#e0a85b');
  }
}

export function citizenSprite(appearance: Appearance, direction: Direction, frame = 0): PixelGrid {
  const image = grid(16, 24);
  if (direction === 'down') drawDown(image, appearance, frame);
  else if (direction === 'up') drawUp(image, appearance, frame);
  else drawSide(image, appearance, frame, direction === 'right');
  return image;
}

export function portrait(appearance: Appearance): PixelGrid {
  const bust = grid(16, 16);
  drawDown(bust, appearance, 0);
  const image = grid(32, 32);
  stamp(image, bust, 0, 0, 2);
  return image;
}
