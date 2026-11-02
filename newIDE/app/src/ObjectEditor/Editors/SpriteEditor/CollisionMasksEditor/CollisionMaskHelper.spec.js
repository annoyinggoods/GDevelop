// @flow

// The module under test reads `global.gd` at import time, so the polygon
// wrapper lifecycle is observed with a fake gd — loaded through a fresh
// module registry (the pattern of ByokKeyStorage.spec.js). The real gd is
// restored after the require.
const realGd: any = global.gd;

/**
 * A Polygon2d fake recording what happened to it, so the wrapper lifecycle is
 * observable: a polygon pushed into a mask vector must never be delete()d.
 */
const makeFakePolygon = (width: number, height: number) => {
  const polygon: any = {
    width,
    height,
    movedTo: null,
    deleteCount: 0,
    move: (x: number, y: number) => {
      polygon.movedTo = [x, y];
    },
    delete: () => {
      polygon.deleteCount += 1;
    },
  };
  return polygon;
};

/**
 * A fake gd exposing only what createCollisionMaskFromBounds touches,
 * recording every wrapper it creates.
 */
const makeFakePolygonGd = () => {
  const state = {
    createdPolygons: [],
    createdVectors: [],
  };

  const gd: any = {
    Polygon2d: {
      createRectangle: (width: number, height: number) => {
        const polygon = makeFakePolygon(width, height);
        state.createdPolygons.push(polygon);
        return polygon;
      },
    },
    VectorPolygon2d: function() {
      const vector: any = {
        pushedPolygons: [],
        push_back: (polygon: any) => {
          vector.pushedPolygons.push(polygon);
        },
      };
      state.createdVectors.push(vector);
      return vector;
    },
  };

  return { gd, state };
};

/**
 * Loads the CollisionMaskHelper module with the given fake gd on `global.gd`
 * (the module captures `global.gd` at import time), then restores the real
 * gd for the rest of the suite.
 */
const loadCollisionMaskHelperModuleWithFakeGd = (fakeGd: any) => {
  global.gd = fakeGd;
  try {
    jest.resetModules();
    return require('./CollisionMaskHelper');
  } finally {
    global.gd = realGd;
  }
};

describe('CollisionMaskHelper polygon wrapper lifecycle', () => {
  it('pushes the rectangle polygon into the mask vector without deleting it', () => {
    const { gd, state } = makeFakePolygonGd();
    const {
      createCollisionMaskFromBounds,
    } = loadCollisionMaskHelperModuleWithFakeGd(gd);

    // The fake VectorPolygon2d flows through the typed return value: read it
    // as any so its recorded calls are observable.
    const mask: any = createCollisionMaskFromBounds(10, 109, 20, 99);

    expect(state.createdPolygons).toHaveLength(1);
    expect(state.createdVectors).toHaveLength(1);
    expect(mask.pushedPolygons).toEqual(state.createdPolygons);
    // The regression pin: the vector takes ownership of the pushed polygon,
    // so the wrapper must never be delete()d (deleting corrupts the wasm
    // heap — see ByokSpriteTools.applyPolygonMaskToFrame).
    expect(state.createdPolygons[0].deleteCount).toBe(0);
  });

  it('builds the rectangle from the bounds and centers it on them', () => {
    const { gd, state } = makeFakePolygonGd();
    const {
      createCollisionMaskFromBounds,
    } = loadCollisionMaskHelperModuleWithFakeGd(gd);

    createCollisionMaskFromBounds(10, 109, 20, 99);

    expect(state.createdPolygons[0].width).toBe(100);
    expect(state.createdPolygons[0].height).toBe(80);
    expect(state.createdPolygons[0].movedTo).toEqual([60, 60]);
  });

  it('refuses invalid bounds before creating any wrapper', () => {
    const { gd, state } = makeFakePolygonGd();
    const {
      createCollisionMaskFromBounds,
    } = loadCollisionMaskHelperModuleWithFakeGd(gd);

    expect(() => createCollisionMaskFromBounds(10, 9, 20, 99)).toThrow(
      'Invalid collision mask size.'
    );
    expect(state.createdPolygons).toHaveLength(0);
  });
});
