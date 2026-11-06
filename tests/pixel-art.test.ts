import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { grid, pixel, observerAppearance, type PixelGrid, type Direction } from '../client/src/game/pixels';
import { TILE_NAMES, BUILDING_TYPES, tile, building } from '../client/src/game/tiles';
import { citizenSprite, portrait } from '../client/src/game/characters';
import { ICON_NAMES, icon } from '../client/src/game/icons';
const hash = (image: PixelGrid) => createHash('sha256').update(JSON.stringify(image)).digest('hex');
function valid(image: PixelGrid) {
  assert.equal(image.pixels.length, image.width * image.height);
  assert.ok(image.pixels.some(Boolean));
  for (const color of image.pixels) assert.ok(color === '' || /^#[0-9a-f]{6}$/i.test(color), color);
}

test('terrain and all seven signed building types are deterministic nonempty pixel matrices', () => {
  for (const name of TILE_NAMES) { const image = tile(name); valid(image); assert.equal(hash(image), hash(tile(name))); }
  const images = BUILDING_TYPES.map((type) => building(type));
  images.forEach(valid);
  assert.equal(new Set(images.map(hash)).size, 7);
  assert.equal(building('bank', 160, 112).width, 160);
  assert.equal(building('bank', 160, 112).height, 112);
  assert.notEqual(hash(tile('water', 0)), hash(tile('water', 1)));
});

test('ten unique citizen sprites and portraits retain identity in every direction', () => {
  const sprites = Array.from({ length: 10 }, (_, index) => citizenSprite(observerAppearance(index), 'down'));
  const portraits = Array.from({ length: 10 }, (_, index) => portrait(observerAppearance(index)));
  assert.equal(new Set(sprites.map(hash)).size, 10);
  assert.equal(new Set(portraits.map(hash)).size, 10);
  for (const image of sprites) { valid(image); assert.equal(image.width, 16); assert.equal(image.height, 24); }
  for (const image of portraits) { valid(image); assert.equal(image.width, 32); assert.equal(image.height, 32); }
  for (const direction of ['down','left','up','right'] as Direction[]) {
    const frames = [0,1,2].map((frame) => citizenSprite(observerAppearance(0), direction, frame));
    frames.forEach(valid);
    assert.equal(new Set(frames.map(hash)).size, 3);
  }
  assert.equal(new Set((['down','left','up','right'] as Direction[]).map((direction) => hash(citizenSprite(observerAppearance(0), direction)))).size, 4);
});

test('all HUD/job/emote icons are present and pixel writes remain bounded', () => {
  for (const name of ICON_NAMES) { const image = icon(name); valid(image); assert.equal(image.width, 16); assert.equal(image.height, 16); }
  assert.equal(new Set(ICON_NAMES.map((name) => hash(icon(name)))).size, ICON_NAMES.length);
  const image = grid(2, 2);
  pixel(image, -1, 0, '#ffffff'); pixel(image, 3, 0, '#ffffff');
  assert.deepEqual(image.pixels, ['', '', '', '']);
});
