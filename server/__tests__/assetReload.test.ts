import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the asset loaders so we can assert WHICH loader runs for root vs external
// dirs (the load-vs-loadExternal asymmetry) without needing real PNG fixtures.
vi.mock('../src/assetLoader.js', () => ({
  loadFurnitureAssets: vi.fn((dir: string) =>
    Promise.resolve({ catalog: [{ id: `furn:${dir}` }], sprites: new Map([[`s:${dir}`, []]]) }),
  ),
  loadCharacterSprites: vi.fn((dir: string) =>
    Promise.resolve({ characters: [`char-root:${dir}`] }),
  ),
  loadExternalCharacterSprites: vi.fn((dir: string) =>
    Promise.resolve({ characters: [`char-ext:${dir}`] }),
  ),
  loadPetSprites: vi.fn((dir: string) =>
    Promise.resolve({ pets: [`pet-root:${dir}`], manifests: [{ name: `m:${dir}` }] }),
  ),
  loadExternalPetSprites: vi.fn((dir: string) =>
    Promise.resolve({ pets: [`pet-ext:${dir}`], manifests: [{ name: `me:${dir}` }] }),
  ),
  loadFloorTiles: vi.fn((dir: string) => Promise.resolve({ sprites: [[`floor:${dir}`]] })),
  loadWallTiles: vi.fn((dir: string) => Promise.resolve({ sets: [[`wall:${dir}`]] })),
  loadCarpetTiles: vi.fn((dir: string) => Promise.resolve({ sets: [[`carpet:${dir}`]] })),
  loadDefaultLayout: vi.fn((dir: string) => ({ version: 1, marker: dir })),
  mergeLoadedAssets: vi.fn((a, b) => ({
    catalog: [...a.catalog, ...b.catalog],
    sprites: new Map([...a.sprites, ...b.sprites]),
  })),
  mergeCharacterSprites: vi.fn((a, b) => ({ characters: [...a.characters, ...b.characters] })),
  mergePetSprites: vi.fn((a, b) => ({
    pets: [...a.pets, ...b.pets],
    manifests: [...a.manifests, ...b.manifests],
  })),
}));

import * as assetLoader from '../src/assetLoader.js';
import {
  buildAssetCache,
  loadAllCharacters,
  loadAllFurniture,
  loadAllPets,
  REPLACE_BUNDLED_CHARACTERS_MARKER,
} from '../src/assetReload.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('assetReload helpers', () => {
  it('loadAllCharacters uses the bundled loader for root and the external loader for extras (asymmetry)', async () => {
    const result = await loadAllCharacters('root', ['e1', 'e2']);

    expect(result?.characters).toEqual(['char-root:root', 'char-ext:e1', 'char-ext:e2']);
    // Root → loadCharacterSprites only; externals → loadExternalCharacterSprites only.
    expect(vi.mocked(assetLoader.loadCharacterSprites).mock.calls.map((c) => c[0])).toEqual([
      'root',
    ]);
    expect(vi.mocked(assetLoader.loadExternalCharacterSprites).mock.calls.map((c) => c[0])).toEqual(
      ['e1', 'e2'],
    );
  });

  it('a character set marked REPLACE_BUNDLED replaces the bundled cast instead of joining it', async () => {
    const themed = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-cast-'));
    const charDir = path.join(themed, 'assets', 'characters');
    fs.mkdirSync(charDir, { recursive: true });
    fs.writeFileSync(path.join(charDir, REPLACE_BUNDLED_CHARACTERS_MARKER), '');
    try {
      const result = await loadAllCharacters('root', [themed, 'e2']);
      expect(result?.characters).toEqual([`char-ext:${themed}`, 'char-ext:e2']);
    } finally {
      fs.rmSync(themed, { recursive: true, force: true });
    }
  });

  it('loadAllPets uses the bundled loader for root and the external loader for extras (asymmetry)', async () => {
    const result = await loadAllPets('root', ['e1']);

    expect(result?.pets).toEqual(['pet-root:root', 'pet-ext:e1']);
    expect(result?.manifests.map((m) => m.name)).toEqual(['m:root', 'me:e1']);
    expect(vi.mocked(assetLoader.loadPetSprites).mock.calls.map((c) => c[0])).toEqual(['root']);
    expect(vi.mocked(assetLoader.loadExternalPetSprites).mock.calls.map((c) => c[0])).toEqual([
      'e1',
    ]);
  });

  it('loadAllFurniture uses the same loader for root and externals, merged', async () => {
    const result = await loadAllFurniture('root', ['e1', 'e2']);

    expect(result?.catalog).toEqual([{ id: 'furn:root' }, { id: 'furn:e1' }, { id: 'furn:e2' }]);
    // Furniture: loadFurnitureAssets for BOTH root and externals (no separate external loader).
    expect(vi.mocked(assetLoader.loadFurnitureAssets).mock.calls.map((c) => c[0])).toEqual([
      'root',
      'e1',
      'e2',
    ]);
  });

  it('loadAll* with no external dirs returns the bundled result without merging', async () => {
    const result = await loadAllCharacters('root', []);
    expect(result?.characters).toEqual(['char-root:root']);
    expect(vi.mocked(assetLoader.mergeCharacterSprites)).not.toHaveBeenCalled();
    expect(vi.mocked(assetLoader.loadExternalCharacterSprites)).not.toHaveBeenCalled();
  });

  it('buildAssetCache reproduces the wrap/unwrap asymmetry', async () => {
    const cache = await buildAssetCache('dist', []);

    // Wrapped: characters/pets/furniture keep their wrapper objects.
    expect(cache.characters).toEqual({ characters: ['char-root:dist'] });
    expect(cache.pets).toEqual({ pets: ['pet-root:dist'], manifests: [{ name: 'm:dist' }] });
    expect(cache.furniture?.catalog).toEqual([{ id: 'furn:dist' }]);
    // Unwrapped: floor/wall/carpet store the inner array, not the wrapper.
    expect(cache.floorTiles).toEqual([['floor:dist']]);
    expect(cache.wallTiles).toEqual([['wall:dist']]);
    expect(cache.carpetTiles).toEqual([['carpet:dist']]);
    expect(cache.defaultLayout).toEqual({ version: 1, marker: 'dist' });
  });

  it('buildAssetCache merges external dirs into characters/pets/furniture at startup', async () => {
    const cache = await buildAssetCache('dist', ['ext']);

    expect(cache.characters?.characters).toEqual(['char-root:dist', 'char-ext:ext']);
    expect(cache.pets?.pets).toEqual(['pet-root:dist', 'pet-ext:ext']);
    expect(cache.furniture?.catalog).toEqual([{ id: 'furn:dist' }, { id: 'furn:ext' }]);
    // Floor/wall/carpet are bundled-only: loaded from dist, never from the external dir.
    expect(vi.mocked(assetLoader.loadFloorTiles).mock.calls.map((c) => c[0])).toEqual(['dist']);
  });
});
