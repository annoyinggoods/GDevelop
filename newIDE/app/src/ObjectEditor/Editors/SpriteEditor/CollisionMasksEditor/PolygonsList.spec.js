/**
 * @jest-environment jsdom
 */
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
 * A fake gd exposing only what addRectangleCollisionMaskTo touches,
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
 * Loads the PolygonsList module with the given fake gd on `global.gd` (the
 * module captures `global.gd` at import time), then restores the real gd for
 * the rest of the suite.
 */
const loadPolygonsListModuleWithFakeGd = (fakeGd: any) => {
  global.gd = fakeGd;
  try {
    jest.resetModules();
    return require('./PolygonsList');
  } finally {
    global.gd = realGd;
  }
};

describe('PolygonsList polygon wrapper lifecycle', () => {
  it('pushes the new collision mask rectangle without deleting it', () => {
    const { gd, state } = makeFakePolygonGd();
    const { addRectangleCollisionMaskTo } = loadPolygonsListModuleWithFakeGd(
      gd
    );
    const polygons: any = new gd.VectorPolygon2d();

    addRectangleCollisionMaskTo(polygons, 100, 80);

    expect(state.createdPolygons).toHaveLength(1);
    expect(polygons.pushedPolygons).toEqual(state.createdPolygons);
    // The regression pin: the vector takes ownership of the pushed polygon,
    // so the wrapper must never be delete()d (deleting corrupts the wasm
    // heap — see ByokSpriteTools.applyPolygonMaskToFrame).
    expect(state.createdPolygons[0].deleteCount).toBe(0);
  });

  it('creates the rectangle at the sprite size, centered on the sprite', () => {
    const { gd, state } = makeFakePolygonGd();
    const { addRectangleCollisionMaskTo } = loadPolygonsListModuleWithFakeGd(
      gd
    );
    const polygons: any = new gd.VectorPolygon2d();

    addRectangleCollisionMaskTo(polygons, 100, 80);

    expect(state.createdPolygons[0].width).toBe(100);
    expect(state.createdPolygons[0].height).toBe(80);
    expect(state.createdPolygons[0].movedTo).toEqual([50, 40]);
  });
});
