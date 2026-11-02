// @flow

/**
 * The "+" attach button's pure helpers (Phase 13.3): read a picked file as a
 * text attachment (extension whitelist + NUL-byte sniff + size cap) or as an
 * image attachment (base64 data URL through the BYOK image pipeline), and
 * inline the text attachments into the user message as fenced blocks. The
 * file system and the image store are injected, so the module stays testable
 * without Electron.
 */

/** The hard cap of one text attachment, in CHARACTERS of the content. */
export const BYOK_TEXT_ATTACHMENT_MAX_BYTES = 100 * 1000;

/** How many leading bytes the binary sniff looks at. */
export const BYOK_TEXT_ATTACHMENT_SNIFF_BYTES = 8192;

/**
 * The input-file cap of a text attachment (audit011026 B-UI-11): the file
 * is stat'ed BEFORE it is read, so a multi-gigabyte log never loads (the
 * content cap above only truncated AFTER the full read).
 */
export const BYOK_TEXT_ATTACHMENT_INPUT_MAX_BYTES = 10 * 1000 * 1000;

/** The input-file cap of an image attachment (same rationale). */
export const BYOK_IMAGE_ATTACHMENT_INPUT_MAX_BYTES = 20 * 1000 * 1000;

/**
 * The extensions considered text: a file outside this list is refused with a
 * friendly error instead of dumping binary garbage into the conversation.
 */
const TEXT_ATTACHMENT_EXTENSIONS: Set<string> = new Set([
  'txt',
  'md',
  'markdown',
  'json',
  'js',
  'mjs',
  'cjs',
  'ts',
  'tsx',
  'jsx',
  'css',
  'scss',
  'html',
  'htm',
  'xml',
  'yaml',
  'yml',
  'toml',
  'ini',
  'cfg',
  'csv',
  'tsv',
  'log',
  'py',
  'lua',
  'gd',
  'cpp',
  'h',
  'hpp',
  'c',
  'cs',
  'java',
  'kt',
  'rs',
  'go',
  'sh',
  'ps1',
  'bat',
  'sql',
]);

export const isByokTextAttachmentExtension = (fileName: string): boolean => {
  const dotIndex = fileName.lastIndexOf('.');
  if (dotIndex === -1) return false;
  return TEXT_ATTACHMENT_EXTENSIONS.has(
    fileName.slice(dotIndex + 1).toLowerCase()
  );
};

/**
 * True when the sample looks binary: a NUL byte in the first bytes is the
 * classic tell (UTF-8 and Latin-1 text never contain one).
 */
export const byokContentLooksBinary = (sample: string): boolean =>
  sample.indexOf('\u0000') !== -1;

/** One picked text attachment, already read and validated. */
export type ByokTextAttachment = {|
  kind: 'text',
  name: string,
  content: string,
  truncated: boolean,
|};

/** One picked image attachment, registered in the BYOK image store. */
export type ByokImageAttachment = {|
  kind: 'image',
  name: string,
  imageId: string,
|};

export type ByokAttachment = ByokTextAttachment | ByokImageAttachment;

export type ByokAttachmentReadResult =
  | {| ok: true, attachment: ByokAttachment |}
  | {| ok: false, error: string |};

const getBaseName = (filePath: string): string => {
  const separators = filePath.split(/[\\/]/);
  return separators[separators.length - 1] || filePath;
};

/**
 * Read a picked file as a text attachment: extension whitelist, NUL-byte
 * sniff, and the size cap (a truncated attachment says so, so the model
 * knows it is not seeing the whole file). `fsLike` is Node's `fs` module
 * (or a test double with the same `promises.readFile`).
 */
export const readByokTextAttachment = async (
  fsLike: any,
  filePath: string
): Promise<ByokAttachmentReadResult> => {
  const name = getBaseName(filePath);
  if (!isByokTextAttachmentExtension(name)) {
    return {
      ok: false,
      error: `"${name}" does not look like a text file — only text files can be attached.`,
    };
  }

  // The size pre-check runs on the stat, before any byte is loaded
  // (audit011026 B-UI-11). The test doubles may not implement stat — the
  // cap then falls back to the post-read length below.
  if (typeof fsLike.promises.stat === 'function') {
    let stats: any = null;
    try {
      stats = await fsLike.promises.stat(filePath);
    } catch (error) {
      stats = null;
    }
    if (stats && stats.size > BYOK_TEXT_ATTACHMENT_INPUT_MAX_BYTES) {
      return {
        ok: false,
        error: `"${name}" is larger than ${Math.round(
          BYOK_TEXT_ATTACHMENT_INPUT_MAX_BYTES / (1024 * 1024)
        )} MB — attach an excerpt instead.`,
      };
    }
  }

  let buffer: any;
  try {
    buffer = await fsLike.promises.readFile(filePath);
  } catch (error) {
    return {
      ok: false,
      error: `"${name}" could not be read.`,
    };
  }
  if (buffer.length > BYOK_TEXT_ATTACHMENT_INPUT_MAX_BYTES) {
    return {
      ok: false,
      error: `"${name}" is larger than ${Math.round(
        BYOK_TEXT_ATTACHMENT_INPUT_MAX_BYTES / (1024 * 1024)
      )} MB — attach an excerpt instead.`,
    };
  }

  // The binary sniff runs on the RAW BYTES of the head (audit011026
  // B-UI-11): sniffing the decoded string let a binary file whose first
  // NUL sits past 8192 decoded characters through as text. The buffer is a
  // Uint8Array — a NUL byte is the binary marker.
  const sniffByteCount = Math.min(
    buffer.length,
    BYOK_TEXT_ATTACHMENT_SNIFF_BYTES
  );
  for (let index = 0; index < sniffByteCount; index++) {
    if (buffer[index] === 0) {
      return {
        ok: false,
        error: `"${name}" looks like a binary file — only text files can be attached.`,
      };
    }
  }

  const fullContent: string = buffer.toString('utf8');

  const truncated = fullContent.length > BYOK_TEXT_ATTACHMENT_MAX_BYTES;
  return {
    ok: true,
    attachment: {
      kind: 'text',
      name,
      content: truncated
        ? fullContent.slice(0, BYOK_TEXT_ATTACHMENT_MAX_BYTES)
        : fullContent,
      truncated,
    },
  };
};

/** The MIME types of the image formats the attach pipeline accepts. */
const IMAGE_ATTACHMENT_MIME_BY_EXTENSION: { [string]: string } = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

export const isByokImageAttachmentExtension = (fileName: string): boolean => {
  const dotIndex = fileName.lastIndexOf('.');
  if (dotIndex === -1) return false;
  return !!IMAGE_ATTACHMENT_MIME_BY_EXTENSION[
    fileName.slice(dotIndex + 1).toLowerCase()
  ];
};

/**
 * Read a picked image file, downscale and register it through the BYOK image
 * store (the same pipeline `capture_scene_screenshot` uses), and return the
 * attachment referencing its id — the model request and the durable sidecar
 * both key on ids, never inline payloads.
 */
export const readByokImageAttachment = async (
  fsLike: any,
  filePath: string,
  storeImage: (dataUrl: string) => Promise<any>
): Promise<ByokAttachmentReadResult> => {
  const name = getBaseName(filePath);
  if (!isByokImageAttachmentExtension(name)) {
    return {
      ok: false,
      error: `"${name}" is not a png, jpg or webp image.`,
    };
  }

  let buffer: any;
  try {
    buffer = await fsLike.promises.readFile(filePath);
  } catch (error) {
    return {
      ok: false,
      error: `"${name}" could not be read.`,
    };
  }
  // Images were uncapped entirely (audit011026 B-UI-11): a 100 MB PNG was
  // fully read and base64-encoded (+33%) before any downscale.
  if (buffer.length > BYOK_IMAGE_ATTACHMENT_INPUT_MAX_BYTES) {
    return {
      ok: false,
      error: `"${name}" is larger than ${Math.round(
        BYOK_IMAGE_ATTACHMENT_INPUT_MAX_BYTES / (1024 * 1024)
      )} MB — downscale it before attaching.`,
    };
  }

  const dotIndex = name.lastIndexOf('.');
  const mime =
    IMAGE_ATTACHMENT_MIME_BY_EXTENSION[name.slice(dotIndex + 1).toLowerCase()];
  const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;
  try {
    const image = await storeImage(dataUrl);
    return {
      ok: true,
      attachment: { kind: 'image', name, imageId: image.id },
    };
  } catch (error) {
    return {
      ok: false,
      error: `"${name}" could not be decoded as an image.`,
    };
  }
};

/**
 * The fenced block a text attachment is inlined as, with the filename header
 * and the truncation note above the cap (the phase's wording: the note says
 * the content was cut, not silently dropped).
 */
export const buildByokTextAttachmentBlock = (
  attachment: ByokTextAttachment
): string => {
  const truncationNote = attachment.truncated
    ? `\n[The file was truncated at ${BYOK_TEXT_ATTACHMENT_MAX_BYTES} characters — the rest is not included.]`
    : '';
  return `\n[Attached file: ${attachment.name}]${truncationNote}\n\`\`\`\n${
    attachment.content
  }\n\`\`\``;
};

/**
 * Compose the user message text with its text attachments inlined: the typed
 * message first, then one fenced block per attachment, in pick order.
 */
export const buildByokUserMessageWithAttachments = (
  text: string,
  attachments: Array<ByokAttachment>
): string => {
  const textAttachments: Array<ByokTextAttachment> = [];
  for (const attachment of attachments) {
    if (attachment.kind === 'text') textAttachments.push(attachment);
  }
  if (textAttachments.length === 0) return text;
  return `${text}${textAttachments
    .map(attachment => buildByokTextAttachmentBlock(attachment))
    .join('')}`;
};

/** The image ids of the attachments (the message's `images` field). */
export const getByokAttachmentImageIds = (
  attachments: Array<ByokAttachment>
): Array<string> => {
  const imageIds: Array<string> = [];
  for (const attachment of attachments) {
    if (attachment.kind === 'image') imageIds.push(attachment.imageId);
  }
  return imageIds;
};

/**
 * Build the "+" button's menu (Phase 13.3, D13-5): *Attach text file…*
 * always, *Attach image…* only when the chat can use vision. Pure: the
 * translation function and the two pick handlers are injected.
 */
export const buildByokAttachMenuTemplate = (
  translate: (message: string) => string,
  options: {|
    canAttachImages: boolean,
    onAttachTextFile: () => void,
    onAttachImageFile: () => void,
  |}
): Array<{| label: string, click: () => void |}> => {
  const items: Array<{| label: string, click: () => void |}> = [
    {
      label: translate('Attach text file…'),
      click: options.onAttachTextFile,
    },
  ];
  if (options.canAttachImages) {
    items.push({
      label: translate('Attach image…'),
      click: options.onAttachImageFile,
    });
  }
  return items;
};
