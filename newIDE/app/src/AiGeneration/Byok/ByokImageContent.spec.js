// @flow
import {
  BYOK_IMAGE_MAX_LONG_EDGE,
  estimateByokImageTokens,
  getByokImage,
  isImageDataUrl,
  makeDefaultByokImageStore,
  registerByokImage,
} from './ByokImageContent';

describe('isImageDataUrl', () => {
  it('accepts base64 png and jpeg data URLs', () => {
    expect(isImageDataUrl('data:image/png;base64,AAAA')).toBe(true);
    expect(isImageDataUrl('data:image/jpeg;base64,AAAA')).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isImageDataUrl('data:text/plain;base64,AAAA')).toBe(false);
    expect(isImageDataUrl('https://example.com/image.png')).toBe(false);
    expect(isImageDataUrl('')).toBe(false);
  });
});

describe('estimateByokImageTokens', () => {
  it('follows the w*h/784 formula, rounded up', () => {
    expect(estimateByokImageTokens(784, 1)).toBe(1);
    expect(estimateByokImageTokens(1024, 1024)).toBe(
      Math.ceil((1024 * 1024) / 784)
    );
  });

  it('is monotonic in the image area', () => {
    expect(estimateByokImageTokens(512, 512)).toBeLessThan(
      estimateByokImageTokens(1024, 1024)
    );
  });
});

describe('registerByokImage / getByokImage', () => {
  it('registers an image under a unique id with its token estimate', () => {
    const image = registerByokImage({
      dataUrl: 'data:image/png;base64,AAAA',
      width: 1024,
      height: 512,
    });

    expect(image.id).toContain('byok-img-');
    expect(image.approxTokens).toBe(Math.ceil((1024 * 512) / 784));
    expect(getByokImage(image.id)).toEqual(image);
  });

  it('returns null for an unknown id (evicted or reloaded away)', () => {
    expect(getByokImage('byok-img-does-not-exist')).toBeNull();
  });
});

describe('makeDefaultByokImageStore', () => {
  it('rejects a non-image data URL without registering anything', async () => {
    const store = makeDefaultByokImageStore();
    await expect(store('not a data url')).rejects.toThrow('base64 image');
  });

  it('registers a valid image even without a canvas pipeline (node tests)', async () => {
    const store = makeDefaultByokImageStore();
    const image = await store('data:image/png;base64,AAAA');

    expect(image.id).toContain('byok-img-');
    expect(getByokImage(image.id)).toEqual(image);
    // Without a canvas the size falls back to the cap, so the estimate is
    // the worst case.
    expect(image.width).toBe(BYOK_IMAGE_MAX_LONG_EDGE);
  });
});
