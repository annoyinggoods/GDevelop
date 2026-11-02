// @flow
import { DEFAULT_FORK_ASSET_BUILD_SETTINGS } from './ForkAssetBuildSettings';
import {
  DEFAULT_FORK_ASSET_ENCODER_CAPABILITIES,
  FORK_ASSET_IMAGE_FLOOR_BYTES,
  getForkAssetFileExtension,
  planForkAssetOptimization,
  summarizeForkAssetPlanResults,
} from './ForkAssetPlan';
import type { ForkAssetApplyResult, ForkAssetPlanFile } from './ForkAssetPlan';

const makeFile = (
  relativePath: string,
  sizeBytes: number
): ForkAssetPlanFile => ({
  relativePath,
  extension: getForkAssetFileExtension(relativePath),
  sizeBytes,
});

const planOne = (file: ForkAssetPlanFile): Object => {
  const plan = planForkAssetOptimization({
    files: [file],
    settings: DEFAULT_FORK_ASSET_BUILD_SETTINGS,
  });
  return plan[0];
};

describe('getForkAssetFileExtension', () => {
  it('lower-cases the extension and keeps the dot', () => {
    expect(getForkAssetFileExtension('hero.PNG')).toBe('.png');
    expect(getForkAssetFileExtension('a/b/hero.jpeg')).toBe('.jpeg');
  });

  it('returns an empty string for a name without extension or a dot-file', () => {
    expect(getForkAssetFileExtension('README')).toBe('');
    expect(getForkAssetFileExtension('.gitignore')).toBe('');
    expect(getForkAssetFileExtension('')).toBe('');
  });
});

describe('planForkAssetOptimization', () => {
  it('plans a PNG, a JPEG, a WAV and a .txt exactly as the policy states', () => {
    const plan = planForkAssetOptimization({
      files: [
        makeFile('hero.png', 200000),
        makeFile('background.jpg', 400000),
        makeFile('jump.wav', 90000),
        makeFile('notes.txt', 500),
      ],
      settings: DEFAULT_FORK_ASSET_BUILD_SETTINGS,
    });

    expect(plan).toHaveLength(4);
    expect(plan[0]).toEqual({
      relativePath: 'hero.png',
      kind: 'image',
      transform: 'png',
      options: { compressionLevel: 9, effort: 10, palette: false },
      skipReason: null,
      skipReasonCode: null,
    });
    expect(plan[1]).toEqual({
      relativePath: 'background.jpg',
      kind: 'image',
      transform: 'jpeg',
      options: { quality: 85 },
      skipReason: null,
      skipReasonCode: null,
    });
    // A lossless WAV is left alone: re-encoding it cannot shrink it without
    // losing fidelity, and format migration is out of the phase.
    expect(plan[2].kind).toBe('skip');
    expect(plan[2].transform).toBeNull();
    expect(plan[2].skipReason).toContain('Lossless audio');
    expect(plan[3].kind).toBe('skip');
    expect(plan[3].skipReason).toContain('Unsupported extension');
  });

  it('plans a transparent PNG as a lossless PNG transform, never as JPEG', () => {
    const entry = planOne(makeFile('player-idle-transparent.png', 120000));
    expect(entry.kind).toBe('image');
    expect(entry.transform).toBe('png');
    // The corruption this guards: a transparent PNG re-encoded as JPEG would
    // turn its alpha into a black/white matte.
    expect(entry.transform).not.toBe('jpeg');
  });

  it('keeps the image format in place for every supported image', () => {
    expect(planOne(makeFile('a.png', 10000)).transform).toBe('png');
    expect(planOne(makeFile('a.jpg', 10000)).transform).toBe('jpeg');
    expect(planOne(makeFile('a.jpeg', 10000)).transform).toBe('jpeg');
    expect(planOne(makeFile('a.webp', 10000)).transform).toBe('webp');
    expect(planOne(makeFile('a.gif', 10000)).transform).toBe('gif');
  });

  it('plans an animated GIF with animated: true so the frames survive', () => {
    const entry = planOne(makeFile('walk.gif', 200000));
    expect(entry.kind).toBe('image');
    expect(entry.transform).toBe('gif');
    // The corruption this guards: re-encoding a GIF without animated: true
    // silently keeps only the first frame.
    expect(entry.options).toEqual({ animated: true });
  });

  it('uses its own quality knob for WebP and the JPEG knob for JPEG', () => {
    const settings = {
      ...DEFAULT_FORK_ASSET_BUILD_SETTINGS,
      jpegQuality: 70,
      webpQuality: 90,
    };
    const plan = planForkAssetOptimization({
      files: [makeFile('a.jpg', 10000), makeFile('b.webp', 10000)],
      settings,
    });
    expect(plan[0].options).toEqual({ quality: 70 });
    expect(plan[1].options).toEqual({ quality: 90 });
  });

  it('skips a zero-byte file with a reason instead of dropping it', () => {
    const entry = planOne(makeFile('empty.png', 0));
    expect(entry.kind).toBe('skip');
    expect(entry.skipReason).toContain('empty');
  });

  it('skips an image below the floor and plans one at the floor', () => {
    const small = planOne(
      makeFile('icon.png', FORK_ASSET_IMAGE_FLOOR_BYTES - 1)
    );
    expect(small.kind).toBe('skip');
    expect(small.skipReason).toContain('floor');

    const atFloor = planOne(makeFile('icon.png', FORK_ASSET_IMAGE_FLOOR_BYTES));
    expect(atFloor.kind).toBe('image');
  });

  it('skips a vector or raster image of an unsupported format with a reason', () => {
    const svg = planOne(makeFile('logo.svg', 20000));
    expect(svg.kind).toBe('skip');
    expect(svg.skipReason).toContain('Unsupported');
    expect(svg.skipReasonCode).toBe('unsupported-extension');
    const bmp = planOne(makeFile('tile.bmp', 20000));
    expect(bmp.kind).toBe('skip');
    expect(bmp.skipReasonCode).toBe('unsupported-extension');
  });

  it('carries a stable reason code on every skip', () => {
    const codes = [
      planOne(makeFile('empty.png', 0)).skipReasonCode,
      planOne(makeFile('icon.png', 100)).skipReasonCode,
      planOne(makeFile('a.wav', 100000)).skipReasonCode,
      planOne(makeFile('a.mp3', 100000)).skipReasonCode,
      planForkAssetOptimization({
        files: [makeFile('a.mp3', 100000)],
        settings: { ...DEFAULT_FORK_ASSET_BUILD_SETTINGS, audioEnabled: false },
      })[0].skipReasonCode,
      planForkAssetOptimization({
        files: [makeFile('a.mp3', 100000)],
        capabilities: { images: true, audio: false },
      })[0].skipReasonCode,
      planForkAssetOptimization({
        files: [makeFile('a.png', 100000)],
        capabilities: { images: false, audio: true },
      })[0].skipReasonCode,
      planOne(makeFile('a.xyz', 100)).skipReasonCode,
    ];
    expect(codes).toEqual([
      'empty-file',
      'below-byte-floor',
      'lossless-audio',
      null,
      'audio-disabled',
      'encoder-unavailable-audio',
      'encoder-unavailable-image',
      'unsupported-extension',
    ]);
  });

  it('plans a lossy audio re-encode at the bitrate knob', () => {
    const plan = planForkAssetOptimization({
      files: [makeFile('music.mp3', 3000000)],
      settings: { ...DEFAULT_FORK_ASSET_BUILD_SETTINGS, audioBitrateKbps: 96 },
    });
    expect(plan[0]).toEqual({
      relativePath: 'music.mp3',
      kind: 'audio',
      transform: 'audio',
      options: { format: 'mp3', bitrateKbps: 96 },
      skipReason: null,
      skipReasonCode: null,
    });
  });

  it('skips audio when the setting is off, or when no encoder is configured', () => {
    const audioOff = planForkAssetOptimization({
      files: [makeFile('music.ogg', 100000)],
      settings: { ...DEFAULT_FORK_ASSET_BUILD_SETTINGS, audioEnabled: false },
    });
    expect(audioOff[0].kind).toBe('skip');
    expect(audioOff[0].skipReason).toContain('turned off');

    const noEncoder = planForkAssetOptimization({
      files: [makeFile('music.ogg', 100000)],
      settings: DEFAULT_FORK_ASSET_BUILD_SETTINGS,
      capabilities: { images: true, audio: false },
    });
    expect(noEncoder[0].kind).toBe('skip');
    expect(noEncoder[0].skipReason).toContain('audio encoder');
  });

  it('skips every image when no image encoder is available', () => {
    const plan = planForkAssetOptimization({
      files: [makeFile('hero.png', 200000)],
      settings: DEFAULT_FORK_ASSET_BUILD_SETTINGS,
      capabilities: { images: false, audio: true },
    });
    expect(plan[0].kind).toBe('skip');
    expect(plan[0].skipReason).toContain('image encoder');
  });

  it('uses the safe defaults when no settings or capabilities are given', () => {
    const plan = planForkAssetOptimization({ files: [] });
    expect(plan).toEqual([]);
    expect(DEFAULT_FORK_ASSET_ENCODER_CAPABILITIES).toEqual({
      images: true,
      audio: true,
    });
  });
});

describe('summarizeForkAssetPlanResults', () => {
  it('totals the bytes, counts the optimized and notes the failures', () => {
    const results: Array<ForkAssetApplyResult> = [
      {
        relativePath: 'a.png',
        bytesBefore: 1000,
        bytesAfter: 600,
        error: null,
      },
      {
        relativePath: 'b.jpg',
        bytesBefore: 2000,
        bytesAfter: 1500,
        error: null,
      },
      {
        relativePath: 'c.png',
        bytesBefore: 500,
        bytesAfter: 500,
        error: 'locked',
      },
    ];
    const summary = summarizeForkAssetPlanResults(results);
    expect(summary.totalBytesBefore).toBe(3500);
    expect(summary.totalBytesAfter).toBe(2600);
    expect(summary.savedBytes).toBe(900);
    expect(summary.optimizedCount).toBe(2);
    expect(summary.failedCount).toBe(1);
    expect(summary.largestSavings).toEqual([
      { relativePath: 'b.jpg', savedBytes: 500 },
      { relativePath: 'a.png', savedBytes: 400 },
    ]);
  });

  it('never claims savings on a file the applier grew', () => {
    const summary = summarizeForkAssetPlanResults([
      {
        relativePath: 'a.png',
        bytesBefore: 1000,
        bytesAfter: 1200,
        error: null,
      },
    ]);
    expect(summary.savedBytes).toBe(0);
    expect(summary.optimizedCount).toBe(1);
    expect(summary.largestSavings).toEqual([]);
  });

  it('caps the largest-savings list', () => {
    const results: Array<ForkAssetApplyResult> = [];
    for (let index = 0; index < 9; index++) {
      results.push({
        relativePath: `file-${index}.png`,
        bytesBefore: 1000 * (index + 1),
        bytesAfter: 10,
        error: null,
      });
    }
    const summary = summarizeForkAssetPlanResults(results);
    expect(summary.largestSavings).toHaveLength(5);
    expect(summary.largestSavings[0].relativePath).toBe('file-8.png');
  });

  it('returns zeroed totals for an empty result list', () => {
    const summary = summarizeForkAssetPlanResults([]);
    expect(summary).toEqual({
      totalBytesBefore: 0,
      totalBytesAfter: 0,
      savedBytes: 0,
      optimizedCount: 0,
      failedCount: 0,
      largestSavings: [],
    });
  });
});
