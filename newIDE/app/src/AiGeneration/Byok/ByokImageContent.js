// @flow

/**
 * The image pipeline of the BYOK perception phase: screenshots captured by
 * the tools are downscaled, re-encoded and registered under an id, so the
 * transcript can reference them cheaply and the model request only carries
 * the images that survived eviction. The registry is session-scoped (like
 * the BYOK chats themselves — durable history is a later phase): after a
 * reload, references degrade to placeholders instead of crashing.
 */

/** Images never exceed this long edge (tokens ≈ 1.1–1.6k at this size). */
export const BYOK_IMAGE_MAX_LONG_EDGE = 1024;

/** The JPEG quality matching the gameplay-test screenshot harness. */
export const BYOK_IMAGE_JPEG_QUALITY = 0.7;

/**
 * The token estimate of one image, following the Anthropic formula
 * (w×h/784) — close enough to OpenAI's at the sizes we send, and only used
 * to budget the context, never billed.
 */
export const estimateByokImageTokens = (
  width: number,
  height: number
): number => Math.ceil((width * height) / 784);

export type ByokImageInfo = {|
  id: string,
  dataUrl: string,
  width: number,
  height: number,
  approxTokens: number,
|};

/** One OpenAI-compatible content part of a user message. */
export type ByokUserContentItem =
  | {| type: 'text', text: string |}
  | {| type: 'image_url', image_url: {| url: string |} |};

let byokImageCounter = 0;
const byokImagesById: Map<string, ByokImageInfo> = new Map();

const makeByokImageId = (): string => {
  byokImageCounter++;
  return `byok-img-${Date.now().toString(36)}-${byokImageCounter}`;
};

/** Register a prepared image (tests and the replay path use this). */
export const registerByokImage = (image: {|
  dataUrl: string,
  width: number,
  height: number,
|}): ByokImageInfo => {
  const info: ByokImageInfo = {
    id: makeByokImageId(),
    dataUrl: image.dataUrl,
    width: image.width,
    height: image.height,
    approxTokens: estimateByokImageTokens(image.width, image.height),
  };
  byokImagesById.set(info.id, info);
  return info;
};

/**
 * Re-register a stored image under its original id (the durable history
 * 9.3): the transcript references must resolve again after a reload.
 * Untrusted data: only well-shaped entries are accepted.
 */
export const restoreByokImage = (image: any): ?ByokImageInfo => {
  if (!image || typeof image !== 'object') return null;
  if (typeof image.id !== 'string' || !image.id) return null;
  if (typeof image.dataUrl !== 'string' || !isImageDataUrl(image.dataUrl)) {
    return null;
  }
  if (typeof image.width !== 'number' || typeof image.height !== 'number') {
    return null;
  }
  const info: ByokImageInfo = {
    id: image.id,
    dataUrl: image.dataUrl,
    width: image.width,
    height: image.height,
    approxTokens:
      typeof image.approxTokens === 'number'
        ? image.approxTokens
        : estimateByokImageTokens(image.width, image.height),
  };
  byokImagesById.set(info.id, info);
  return info;
};

/** The registered image of this id, or null (evicted or reloaded away). */
export const getByokImage = (id: string): ByokImageInfo | null =>
  byokImagesById.get(id) || null;

/**
 * True when the data URL looks like a base64 image the pipeline accepts.
 */
export const isImageDataUrl = (dataUrl: string): boolean =>
  /^data:image\/(png|jpeg|jpg|webp);base64,/.test(dataUrl);

/**
 * Downscale and re-encode an image data URL to the BYOK caps (≤1024 long
 * edge, JPEG 0.7) using an offscreen canvas. Environments without a usable
 * canvas (tests, exotic embedders) get the original image back — the caps
 * are a cost optimization, not a correctness rule.
 */
export const downscaleByokImageDataUrl = async (
  dataUrl: string,
  documentLike: any
): Promise<{| dataUrl: string, width: number, height: number |}> => {
  if (!documentLike || typeof documentLike.createElement !== 'function') {
    return { dataUrl, width: 0, height: 0 };
  }

  const image = documentLike.createElement('img');
  const decodePromise = new Promise((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('The image could not be decoded.'));
  });
  image.src = dataUrl;
  await decodePromise;

  const longEdge = Math.max(image.naturalWidth, image.naturalHeight);
  const scale =
    longEdge > BYOK_IMAGE_MAX_LONG_EDGE
      ? BYOK_IMAGE_MAX_LONG_EDGE / longEdge
      : 1;
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));

  const canvas = documentLike.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return { dataUrl, width: 0, height: 0 };
  context.drawImage(image, 0, 0, width, height);
  const encodedDataUrl = canvas.toDataURL(
    'image/jpeg',
    BYOK_IMAGE_JPEG_QUALITY
  );
  if (!isImageDataUrl(encodedDataUrl)) {
    return { dataUrl, width: 0, height: 0 };
  }
  return { dataUrl: encodedDataUrl, width, height };
};

/**
 * The default store of the perception tools: validate, downscale and
 * register a captured screenshot, returning the info the transcript and
 * the budget guard read.
 */
export const makeDefaultByokImageStore = (): ((
  dataUrl: string
) => Promise<ByokImageInfo>) => {
  return async (dataUrl: string) => {
    if (!isImageDataUrl(dataUrl)) {
      throw new Error('The captured image is not a base64 image data URL.');
    }
    const downscaled = await downscaleByokImageDataUrl(
      dataUrl,
      typeof document !== 'undefined' ? document : null
    );
    if (downscaled.width === 0 || downscaled.height === 0) {
      // No canvas pipeline available: register as-is with an estimate from
      // the data size (rare — the desktop app always has a canvas).
      return registerByokImage({
        dataUrl,
        width: BYOK_IMAGE_MAX_LONG_EDGE,
        height: BYOK_IMAGE_MAX_LONG_EDGE,
      });
    }
    return registerByokImage(downscaled);
  };
};
