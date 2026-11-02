// @flow
import {
  makeForkSpriteSheetFrameNames,
  planForkSpriteSheetFrames,
} from './ForkSpriteSheetPlan';

describe('planForkSpriteSheetFrames', () => {
  it('tiles a 512x512 image with a 4x4 grid exactly, in row-major order', () => {
    const result = planForkSpriteSheetFrames({
      imageWidth: 512,
      imageHeight: 512,
      grid: { mode: 'rows-columns', rows: 4, columns: 4 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.frames).toHaveLength(16);
    expect(result.frames[0]).toEqual({
      index: 0,
      x: 0,
      y: 0,
      width: 128,
      height: 128,
    });
    // Row-major: the second frame is the NEXT COLUMN of the first row.
    expect(result.frames[1]).toEqual({
      index: 1,
      x: 128,
      y: 0,
      width: 128,
      height: 128,
    });
    // The fifth frame starts the second row.
    expect(result.frames[4]).toEqual({
      index: 4,
      x: 0,
      y: 128,
      width: 128,
      height: 128,
    });
    expect(result.frames[15]).toEqual({
      index: 15,
      x: 384,
      y: 384,
      width: 128,
      height: 128,
    });
  });

  it('computes the per-frame origins with a margin and a spacing', () => {
    // margin 8, spacing 4, 4x4 over 512: inner 496, frame (496 - 3*4)/4 = 121.
    const result = planForkSpriteSheetFrames({
      imageWidth: 512,
      imageHeight: 512,
      grid: {
        mode: 'rows-columns',
        rows: 4,
        columns: 4,
        margin: 8,
        spacing: 4,
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.frames).toHaveLength(16);
    expect(result.frames[0]).toEqual({
      index: 0,
      x: 8,
      y: 8,
      width: 121,
      height: 121,
    });
    expect(result.frames[1]).toEqual({
      index: 1,
      x: 8 + 121 + 4,
      y: 8,
      width: 121,
      height: 121,
    });
    expect(result.frames[5]).toEqual({
      index: 5,
      x: 8 + 121 + 4,
      y: 8 + 121 + 4,
      width: 121,
      height: 121,
    });
    expect(result.frames[15]).toEqual({
      index: 15,
      x: 8 + 3 * (121 + 4),
      y: 8 + 3 * (121 + 4),
      width: 121,
      height: 121,
    });
  });

  it('computes the same tiling in frame-size mode as the equivalent rows/columns', () => {
    const byRowsColumns = planForkSpriteSheetFrames({
      imageWidth: 512,
      imageHeight: 512,
      grid: { mode: 'rows-columns', rows: 4, columns: 4 },
    });
    const byFrameSize = planForkSpriteSheetFrames({
      imageWidth: 512,
      imageHeight: 512,
      grid: { mode: 'frame-size', frameWidth: 128, frameHeight: 128 },
    });

    expect(byFrameSize.ok).toBe(true);
    if (!byRowsColumns.ok || !byFrameSize.ok) return;
    expect(byFrameSize.frames).toEqual(byRowsColumns.frames);
  });

  it('refuses a non-dividing rows-columns grid with no partial frames', () => {
    const result = planForkSpriteSheetFrames({
      imageWidth: 512,
      imageHeight: 512,
      grid: { mode: 'rows-columns', rows: 3, columns: 3 },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('does not divide');
  });

  it('refuses frame sizes that leave more than margin-sized slack', () => {
    // 100 px frames over 512 px: 5 columns cover 500, leaving 12 px with a
    // 0 px margin — a grid that does not match the image.
    const result = planForkSpriteSheetFrames({
      imageWidth: 512,
      imageHeight: 512,
      grid: { mode: 'frame-size', frameWidth: 100, frameHeight: 100 },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('does not divide');
  });

  it('accepts a grid leaving only margin-sized slack', () => {
    // 520 px image, 8 px margin: 504 px inner. 124 px frames cover 496 px
    // over 4 columns, leaving 8 px — exactly the margin, so it is slack.
    const result = planForkSpriteSheetFrames({
      imageWidth: 520,
      imageHeight: 520,
      grid: {
        mode: 'frame-size',
        frameWidth: 124,
        frameHeight: 124,
        margin: 8,
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.frames).toHaveLength(16);
    expect(result.frames[0]).toEqual({
      index: 0,
      x: 8,
      y: 8,
      width: 124,
      height: 124,
    });
    expect(result.frames[15]).toEqual({
      index: 15,
      x: 8 + 3 * 124,
      y: 8 + 3 * 124,
      width: 124,
      height: 124,
    });
  });

  it('refuses a frame size that produces zero frames', () => {
    const result = planForkSpriteSheetFrames({
      imageWidth: 512,
      imageHeight: 512,
      grid: { mode: 'frame-size', frameWidth: 600, frameHeight: 600 },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('no complete frame');
  });

  it('refuses non-positive or non-integer dimensions and grid numbers', () => {
    const refusals = [
      planForkSpriteSheetFrames({
        imageWidth: 0,
        imageHeight: 512,
        grid: { mode: 'rows-columns', rows: 4, columns: 4 },
      }),
      planForkSpriteSheetFrames({
        imageWidth: 512.5,
        imageHeight: 512,
        grid: { mode: 'rows-columns', rows: 4, columns: 4 },
      }),
      planForkSpriteSheetFrames({
        imageWidth: 512,
        imageHeight: 512,
        grid: { mode: 'rows-columns', rows: 0, columns: 4 },
      }),
      planForkSpriteSheetFrames({
        imageWidth: 512,
        imageHeight: 512,
        grid: { mode: 'rows-columns', rows: 4, columns: -1 },
      }),
      planForkSpriteSheetFrames({
        imageWidth: 512,
        imageHeight: 512,
        grid: {
          mode: 'frame-size',
          frameWidth: 128,
          frameHeight: 128,
          spacing: -4,
        },
      }),
      planForkSpriteSheetFrames({
        imageWidth: 512,
        imageHeight: 512,
        grid: {
          mode: 'frame-size',
          frameWidth: 128,
          frameHeight: 0,
        },
      }),
      planForkSpriteSheetFrames({
        imageWidth: 512,
        imageHeight: 512,
        grid: ({ mode: 'diagonal' }: any),
      }),
    ];
    for (const result of refusals) {
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(typeof result.error).toBe('string');
      expect(result.error.length).toBeGreaterThan(0);
    }
  });

  it('refuses a margin that consumes the whole image', () => {
    const result = planForkSpriteSheetFrames({
      imageWidth: 64,
      imageHeight: 64,
      grid: {
        mode: 'rows-columns',
        rows: 2,
        columns: 2,
        margin: 32,
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('no room for frames');
  });
});

describe('makeForkSpriteSheetFrameNames', () => {
  it('names the frames Object_anim_0.png onwards, respecting the count', () => {
    const names = makeForkSpriteSheetFrameNames({
      objectName: 'Player',
      animationName: 'Run',
      count: 3,
    });

    expect(names).toEqual([
      'Player_Run_0.png',
      'Player_Run_1.png',
      'Player_Run_2.png',
    ]);
    expect(
      makeForkSpriteSheetFrameNames({
        objectName: 'Player',
        animationName: 'Run',
        count: 0,
      })
    ).toEqual([]);
  });

  it('sanitizes hostile object and animation names', () => {
    const names = makeForkSpriteSheetFrameNames({
      objectName: 'My Player*',
      animationName: 'Run 1',
      count: 1,
    });

    // The app's sanitizeFilename replaces ILLEGAL characters ('*' → '_')
    // but keeps legal ones (spaces) — the prefix follows that convention.
    expect(names).toEqual(['My Player__Run 1_0.png']);
  });

  it('dedupes against an existing set without colliding', () => {
    const names = makeForkSpriteSheetFrameNames({
      objectName: 'Player',
      animationName: 'Run',
      count: 3,
      existingFileNames: ['Player_Run_0.png'],
    });

    // The NewNameGenerator convention: the taken name gets a number suffix.
    expect(names[0]).toBe('Player_Run_02.png');
    expect(names[1]).toBe('Player_Run_1.png');
    expect(names[2]).toBe('Player_Run_2.png');
    expect(names).not.toContain('Player_Run_0.png');
  });

  it('never collides with itself when a dedupe lands on a later frame name', () => {
    // Taking "Player_Run_1.png" pushes frame 1 onto "Player_Run_2.png",
    // which frame 2 then also wants — the chain must stay collision-free.
    const names = makeForkSpriteSheetFrameNames({
      objectName: 'Player',
      animationName: 'Run',
      count: 4,
      existingFileNames: ['Player_Run_1.png'],
    });

    expect(new Set(names).size).toBe(names.length);
    expect(names).not.toContain('Player_Run_1.png');
    expect(names[0]).toBe('Player_Run_0.png');
  });
});
