import { PixelGrid, grid, pixel, rect } from './pixels';

const INK = '#1c2435';
const PAPER = '#f2d9a0';
const GOLD = '#e4ad4f';
const RED = '#c95752';
const BLUE = '#5d9ac1';
const GREEN = '#6fa36d';
const PURPLE = '#9b78b5';

export const ICON_NAMES = [
  'coin', 'cup', 'wrench', 'police', 'bank', 'store', 'flower', 'clock',
  'map', 'citizens', 'events', 'players', 'influence', 'happy', 'angry',
  'tired', 'question', 'speech',
] as const;

function iconBase() {
  return grid(16, 16);
}

function coin() {
  const image = iconBase();
  rect(image, 5, 1, 6, 1, INK);
  rect(image, 3, 3, 10, 10, INK);
  rect(image, 2, 5, 1, 6, INK);
  rect(image, 13, 5, 1, 6, INK);
  rect(image, 5, 2, 6, 11, GOLD);
  rect(image, 4, 5, 8, 6, GOLD);
  rect(image, 6, 3, 4, 1, '#f6d878');
  rect(image, 6, 5, 2, 6, '#a96e32');
  rect(image, 8, 5, 2, 6, '#f6d878');
  rect(image, 5, 12, 6, 1, '#a96e32');
  return image;
}

function cup() {
  const image = iconBase();
  rect(image, 3, 3, 8, 2, INK);
  rect(image, 4, 5, 7, 7, INK);
  rect(image, 5, 5, 5, 6, PAPER);
  rect(image, 6, 6, 3, 4, '#c98955');
  rect(image, 11, 5, 3, 5, INK);
  rect(image, 11, 6, 2, 3, GOLD);
  rect(image, 6, 1, 1, 2, '#d9b77c');
  rect(image, 9, 1, 1, 2, '#d9b77c');
  rect(image, 3, 12, 9, 2, INK);
  rect(image, 5, 12, 5, 1, PAPER);
  return image;
}

function wrench() {
  const image = iconBase();
  rect(image, 3, 2, 4, 2, INK);
  rect(image, 2, 3, 2, 4, INK);
  pixel(image, 4, 5, INK);
  rect(image, 5, 5, 2, 2, INK);
  rect(image, 6, 6, 6, 3, INK);
  rect(image, 11, 8, 3, 3, INK);
  rect(image, 12, 10, 2, 3, INK);
  rect(image, 4, 3, 2, 2, GOLD);
  rect(image, 6, 6, 5, 1, GOLD);
  rect(image, 8, 7, 4, 1, '#bd803d');
  rect(image, 11, 9, 2, 2, GOLD);
  pixel(image, 12, 12, GOLD);
  return image;
}

function police() {
  const image = iconBase();
  rect(image, 5, 1, 6, 1, INK);
  rect(image, 4, 2, 8, 2, INK);
  rect(image, 3, 4, 10, 2, INK);
  rect(image, 4, 6, 8, 7, INK);
  pixel(image, 5, 13, INK);
  pixel(image, 10, 13, INK);
  rect(image, 5, 6, 6, 6, BLUE);
  pixel(image, 8, 6, GOLD);
  rect(image, 7, 7, 3, 1, GOLD);
  pixel(image, 6, 9, '#b9d9e0');
  pixel(image, 9, 9, '#b9d9e0');
  rect(image, 7, 10, 2, 2, '#b9d9e0');
  return image;
}

function bank() {
  const image = iconBase();
  rect(image, 2, 3, 12, 2, INK);
  pixel(image, 3, 2, INK);
  pixel(image, 12, 2, INK);
  rect(image, 4, 1, 8, 1, INK);
  rect(image, 5, 2, 6, 1, PAPER);
  rect(image, 3, 5, 10, 2, PAPER);
  rect(image, 4, 7, 2, 6, INK);
  rect(image, 7, 7, 2, 6, INK);
  rect(image, 10, 7, 2, 6, INK);
  rect(image, 5, 7, 1, 5, PAPER);
  rect(image, 8, 7, 1, 5, PAPER);
  rect(image, 11, 7, 1, 5, PAPER);
  rect(image, 2, 13, 12, 2, INK);
  rect(image, 4, 13, 8, 1, GOLD);
  return image;
}

function store() {
  const image = iconBase();
  rect(image, 2, 5, 12, 2, INK);
  rect(image, 3, 2, 10, 3, INK);
  rect(image, 4, 3, 8, 1, RED);
  rect(image, 3, 7, 10, 7, INK);
  rect(image, 4, 8, 8, 5, PAPER);
  rect(image, 5, 9, 2, 4, BLUE);
  rect(image, 8, 9, 3, 4, '#c98955');
  rect(image, 2, 14, 12, 1, INK);
  rect(image, 3, 5, 2, 2, RED);
  rect(image, 7, 5, 2, 2, GOLD);
  rect(image, 11, 5, 2, 2, GREEN);
  return image;
}

function flower() {
  const image = iconBase();
  rect(image, 7, 8, 2, 6, GREEN);
  rect(image, 5, 11, 3, 2, GREEN);
  rect(image, 9, 10, 3, 2, GREEN);
  pixel(image, 6, 13, GREEN);
  rect(image, 6, 3, 4, 2, INK);
  rect(image, 4, 5, 8, 5, INK);
  rect(image, 3, 6, 2, 3, INK);
  rect(image, 11, 6, 2, 3, INK);
  rect(image, 6, 4, 4, 5, RED);
  rect(image, 4, 6, 8, 2, RED);
  rect(image, 7, 6, 2, 2, GOLD);
  return image;
}

function clock() {
  const image = iconBase();
  rect(image, 5, 1, 6, 1, INK);
  rect(image, 3, 3, 10, 2, INK);
  rect(image, 2, 5, 2, 6, INK);
  rect(image, 12, 5, 2, 6, INK);
  rect(image, 4, 11, 8, 2, INK);
  rect(image, 5, 13, 6, 1, INK);
  rect(image, 4, 5, 8, 6, PAPER);
  rect(image, 7, 5, 2, 5, INK);
  rect(image, 8, 8, 4, 2, INK);
  pixel(image, 8, 8, RED);
  rect(image, 5, 5, 2, 1, '#fff0c6');
  return image;
}

function map() {
  const image = iconBase();
  rect(image, 2, 3, 12, 10, INK);
  rect(image, 3, 4, 3, 8, '#d9ad65');
  rect(image, 7, 4, 3, 8, '#f1d89b');
  rect(image, 11, 4, 2, 8, '#d9ad65');
  rect(image, 6, 4, 1, 8, INK);
  rect(image, 10, 4, 1, 8, INK);
  pixel(image, 4, 8, GREEN);
  rect(image, 4, 7, 1, 3, GREEN);
  pixel(image, 8, 6, RED);
  rect(image, 8, 5, 1, 2, RED);
  rect(image, 11, 10, 2, 1, BLUE);
  return image;
}

function citizens() {
  const image = iconBase();
  rect(image, 3, 3, 4, 4, INK);
  rect(image, 4, 4, 2, 2, SKIN_TONE);
  rect(image, 6, 7, 4, 2, INK);
  rect(image, 6, 9, 4, 5, BLUE);
  rect(image, 2, 10, 3, 4, INK);
  rect(image, 3, 10, 1, 2, '#c98955');
  rect(image, 9, 2, 4, 5, INK);
  rect(image, 10, 3, 2, 2, '#d99872');
  rect(image, 8, 6, 6, 2, INK);
  rect(image, 9, 8, 4, 6, INK);
  rect(image, 10, 8, 2, 5, GREEN);
  rect(image, 5, 1, 3, 3, INK);
  rect(image, 5, 2, 3, 2, '#b96f57');
  rect(image, 4, 5, 5, 2, INK);
  rect(image, 4, 7, 5, 7, INK);
  rect(image, 5, 8, 3, 5, PURPLE);
  return image;
}

function events() {
  const image = iconBase();
  rect(image, 2, 3, 12, 11, INK);
  rect(image, 4, 1, 2, 4, INK);
  rect(image, 10, 1, 2, 4, INK);
  rect(image, 4, 5, 8, 1, RED);
  rect(image, 4, 7, 2, 2, PAPER);
  rect(image, 7, 7, 2, 2, PAPER);
  rect(image, 10, 7, 2, 2, PAPER);
  rect(image, 4, 10, 2, 2, PAPER);
  rect(image, 7, 10, 2, 2, GOLD);
  rect(image, 10, 10, 2, 2, PAPER);
  return image;
}

function players() {
  const image = iconBase();
  rect(image, 3, 2, 4, 4, INK);
  rect(image, 4, 3, 2, 2, '#d99872');
  rect(image, 9, 3, 4, 4, INK);
  rect(image, 10, 4, 2, 2, '#f0bd91');
  rect(image, 2, 7, 6, 7, INK);
  rect(image, 3, 8, 4, 5, BLUE);
  rect(image, 8, 8, 6, 6, INK);
  rect(image, 9, 9, 4, 4, RED);
  rect(image, 1, 9, 2, 3, INK);
  rect(image, 13, 9, 2, 3, INK);
  rect(image, 5, 13, 1, 2, INK);
  rect(image, 10, 13, 1, 2, INK);
  return image;
}

function influence() {
  const image = iconBase();
  rect(image, 7, 1, 2, 2, INK);
  rect(image, 5, 3, 6, 2, INK);
  rect(image, 3, 5, 10, 2, INK);
  rect(image, 4, 7, 8, 5, INK);
  rect(image, 2, 12, 12, 2, INK);
  rect(image, 6, 4, 4, 2, PURPLE);
  rect(image, 5, 6, 6, 4, PURPLE);
  rect(image, 7, 7, 2, 3, '#d8b3e2');
  rect(image, 5, 11, 6, 1, '#d8b3e2');
  pixel(image, 4, 4, GOLD);
  pixel(image, 11, 4, GOLD);
  return image;
}

function face(mood: 'happy' | 'angry' | 'tired') {
  const image = iconBase();
  rect(image, 4, 2, 8, 1, INK);
  rect(image, 2, 4, 12, 8, INK);
  rect(image, 4, 12, 8, 2, INK);
  rect(image, 4, 4, 8, 8, '#f0bd91');
  if (mood === 'happy') {
    rect(image, 4, 6, 2, 1, INK);
    rect(image, 10, 6, 2, 1, INK);
    pixel(image, 5, 5, INK);
    pixel(image, 10, 5, INK);
    rect(image, 6, 9, 4, 2, RED);
    rect(image, 7, 9, 2, 1, '#fff0c6');
  } else if (mood === 'angry') {
    rect(image, 4, 5, 3, 1, INK);
    rect(image, 9, 5, 3, 1, INK);
    pixel(image, 6, 6, INK);
    pixel(image, 9, 6, INK);
    rect(image, 6, 10, 4, 1, INK);
    pixel(image, 5, 4, RED);
    pixel(image, 10, 4, RED);
  } else {
    rect(image, 4, 6, 3, 1, INK);
    rect(image, 9, 6, 3, 1, INK);
    rect(image, 6, 10, 4, 1, INK);
    pixel(image, 5, 11, '#78909b');
    pixel(image, 10, 11, '#78909b');
  }
  return image;
}

function question() {
  const image = iconBase();
  rect(image, 6, 2, 4, 1, INK);
  rect(image, 4, 3, 3, 2, INK);
  rect(image, 9, 3, 3, 2, INK);
  rect(image, 10, 5, 2, 3, INK);
  rect(image, 8, 7, 3, 2, INK);
  rect(image, 7, 9, 2, 2, INK);
  rect(image, 7, 13, 2, 2, GOLD);
  rect(image, 5, 3, 2, 1, GOLD);
  rect(image, 9, 4, 2, 1, GOLD);
  return image;
}

function speech() {
  const image = iconBase();
  rect(image, 2, 3, 12, 9, INK);
  rect(image, 4, 5, 8, 5, PAPER);
  rect(image, 4, 11, 3, 3, INK);
  rect(image, 5, 10, 2, 2, PAPER);
  rect(image, 5, 6, 6, 1, BLUE);
  rect(image, 5, 8, 4, 1, RED);
  return image;
}

const SKIN_TONE = '#d99872';

export function icon(name: string): PixelGrid {
  switch (name) {
    case 'coin': return coin();
    case 'cup': return cup();
    case 'wrench': return wrench();
    case 'police': return police();
    case 'bank': return bank();
    case 'store': return store();
    case 'flower': return flower();
    case 'clock': return clock();
    case 'map': return map();
    case 'citizens': return citizens();
    case 'events': return events();
    case 'players': return players();
    case 'influence': return influence();
    case 'happy': return face('happy');
    case 'angry': return face('angry');
    case 'tired': return face('tired');
    case 'question': return question();
    case 'speech': return speech();
    default: return question();
  }
}
