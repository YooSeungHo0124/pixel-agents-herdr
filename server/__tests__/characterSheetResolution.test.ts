import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';

import { characterSheetResolution, decodeCharacterPng } from '../../core/src/assets/pngDecoder.js';

describe('character sheet resolution', () => {
  it('detects 1x and integer hi-res sheets, falling back to 1x for odd sizes', () => {
    expect(characterSheetResolution(112, 96)).toBe(1);
    expect(characterSheetResolution(224, 192)).toBe(2);
    expect(characterSheetResolution(224, 96)).toBe(1);
  });

  it('decodes a 2x sheet into 32x64 frames', () => {
    const png = new PNG({ width: 224, height: 192 });
    const sheet = decodeCharacterPng(PNG.sync.write(png));
    expect(sheet.down).toHaveLength(7);
    expect(sheet.down[0]).toHaveLength(64);
    expect(sheet.down[0][0]).toHaveLength(32);
  });
});
