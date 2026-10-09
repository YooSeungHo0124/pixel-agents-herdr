import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';

import {
  characterSheetResolution,
  decodeCharacterPng,
  decodePetPng,
} from '../../core/src/assets/pngDecoder.js';

describe('character sheet resolution', () => {
  it('detects 1x and integer hi-res sheets, falling back to 1x for odd sizes', () => {
    expect(characterSheetResolution(112, 96)).toBe(1);
    expect(characterSheetResolution(224, 192)).toBe(2);
    expect(characterSheetResolution(224, 96)).toBe(1);
    expect(characterSheetResolution(100, 192)).toBe(1);
  });

  it('accepts hi-res frames wider than 16 logical px', () => {
    const png = new PNG({ width: 896, height: 384 });
    const sheet = decodeCharacterPng(PNG.sync.write(png));
    expect(sheet.right[3]).toHaveLength(128);
    expect(sheet.right[3][0]).toHaveLength(128);
  });

  it('decodes a 2x sheet into 32x64 frames', () => {
    const png = new PNG({ width: 224, height: 192 });
    const sheet = decodeCharacterPng(PNG.sync.write(png));
    expect(sheet.down).toHaveLength(7);
    expect(sheet.down[0]).toHaveLength(64);
    expect(sheet.down[0][0]).toHaveLength(32);
  });
});

describe('pet sheet resolution', () => {
  it('decodes a 2x pet sheet into 32x64 vertical and 64x64 side frames', () => {
    const png = new PNG({ width: 192, height: 192 });
    const pet = decodePetPng(PNG.sync.write(png));
    expect(pet.walkDown[0]).toHaveLength(64);
    expect(pet.walkDown[0][0]).toHaveLength(32);
    expect(pet.walkRight[0][0]).toHaveLength(64);
  });
});
