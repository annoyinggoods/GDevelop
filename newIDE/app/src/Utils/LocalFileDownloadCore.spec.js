// @flow
/* eslint-disable no-restricted-globals */
// $FlowFixMe[cannot-resolve-module]
const path: any = require('path');
const {
  LOCAL_FILE_DOWNLOAD_MAX_BYTES,
  LOCAL_FILE_DOWNLOAD_TIMEOUT_MS,
  LOCAL_FILE_DOWNLOAD_MAX_REDIRECTS,
  shouldAttachGDevelopCloudCookie,
  isPathInsideFolder,
  validateLocalFileDownloadRequest,
  validateLocalFileSavePath,
  makeByteCapGuard,
} = require('./LocalFileDownloadCore');

const BASE_FOLDER = path.resolve('/exports/game');

const validate = (
  outputPath: string,
  url: string = 'https://example.com/image.png'
) =>
  validateLocalFileDownloadRequest({
    url,
    outputPath,
    basePath: BASE_FOLDER,
    pathLib: path,
  });

describe('LocalFileDownloadCore (security fix UP-1)', () => {
  it('exports the expected download limits', () => {
    expect(LOCAL_FILE_DOWNLOAD_MAX_BYTES).toBe(200 * 1000 * 1000);
    expect(LOCAL_FILE_DOWNLOAD_TIMEOUT_MS).toBe(60 * 1000);
    expect(LOCAL_FILE_DOWNLOAD_MAX_REDIRECTS).toBe(5);
  });

  describe('shouldAttachGDevelopCloudCookie', () => {
    it('accepts gdevelop.io and its subdomains only', () => {
      expect(shouldAttachGDevelopCloudCookie('gdevelop.io')).toBe(true);
      expect(shouldAttachGDevelopCloudCookie('assets.gdevelop.io')).toBe(true);
      expect(shouldAttachGDevelopCloudCookie('evil.com')).toBe(false);
      expect(shouldAttachGDevelopCloudCookie('gdevelop.io.evil.com')).toBe(
        false
      );
    });
  });

  describe('isPathInsideFolder', () => {
    it('is segment-aware about folder containment', () => {
      expect(
        isPathInsideFolder(path, BASE_FOLDER, path.join(BASE_FOLDER, 'a.png'))
      ).toBe(true);
      expect(isPathInsideFolder(path, BASE_FOLDER, BASE_FOLDER)).toBe(true);
      // A sibling whose name merely extends the base folder is NOT inside it.
      expect(
        isPathInsideFolder(
          path,
          BASE_FOLDER,
          path.join(`${BASE_FOLDER}2`, 'a.png')
        )
      ).toBe(false);
    });
  });

  describe('validateLocalFileDownloadRequest', () => {
    it('accepts an in-folder https target', () => {
      expect(validate(path.join(BASE_FOLDER, 'resources', 'a.png'))).toEqual({
        ok: true,
      });
      expect(
        validate(path.join(BASE_FOLDER, 'a.png'), 'http://example.com')
      ).toEqual({
        ok: true,
      });
    });

    it('refuses a URL that does not parse', () => {
      const result = validate(path.join(BASE_FOLDER, 'a.png'), 'not a url');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('Not a valid URL');
    });

    it('refuses non-http(s) protocols', () => {
      for (const url of [
        'file:///etc/passwd',
        'ftp://example.com/a.png',
        'about:blank',
      ]) {
        const result = validate(path.join(BASE_FOLDER, 'a.png'), url);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toContain('Only http(s)');
      }
    });

    it('refuses an outputPath escaping the base folder with ..', () => {
      const escapingPath = path.join(
        BASE_FOLDER,
        'resources',
        '..',
        '..',
        'outside.png'
      );
      const result = validate(escapingPath);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('outside the base folder');
    });

    it('refuses an absolute outputPath outside the base folder', () => {
      const result = validate(path.resolve('/somewhere/else/a.png'));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('outside the base folder');
    });

    it('refuses a sibling folder whose name merely extends the base folder', () => {
      const result = validate(path.join(`${BASE_FOLDER}2`, 'a.png'));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('outside the base folder');
    });

    it('refuses empty or non-string arguments', () => {
      expect(validate('')).toEqual({
        ok: false,
        error: 'Invalid download request.',
      });
      expect(
        validateLocalFileDownloadRequest({
          url: 'https://example.com/a.png',
          outputPath: (null: any),
          basePath: BASE_FOLDER,
          pathLib: path,
        })
      ).toEqual({ ok: false, error: 'Invalid download request.' });
      expect(
        validateLocalFileDownloadRequest({
          url: 'https://example.com/a.png',
          outputPath: path.join(BASE_FOLDER, 'a.png'),
          basePath: '',
          pathLib: path,
        })
      ).toEqual({ ok: false, error: 'Invalid download request.' });
    });
  });

  describe('validateLocalFileSavePath', () => {
    const validateSave = (outputPath: string) =>
      validateLocalFileSavePath({
        outputPath,
        basePath: BASE_FOLDER,
        pathLib: path,
      });

    it('accepts a save target inside the base folder', () => {
      expect(validateSave(path.join(BASE_FOLDER, 'assets', 'a.png'))).toEqual({
        ok: true,
      });
    });

    it('refuses a save target escaping the base folder', () => {
      const escapingPath = path.join(BASE_FOLDER, '..', 'elsewhere', 'a.png');
      const result = validateSave(escapingPath);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('outside the base folder');
    });

    it('refuses an absolute save target outside the base folder', () => {
      const result = validateSave(path.resolve('/somewhere/else/a.png'));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('outside the base folder');
    });

    it('refuses empty or non-string arguments', () => {
      expect(validateSave('')).toEqual({
        ok: false,
        error: 'Invalid save request.',
      });
      expect(
        validateLocalFileSavePath({
          outputPath: path.join(BASE_FOLDER, 'a.png'),
          basePath: (null: any),
          pathLib: path,
        })
      ).toEqual({ ok: false, error: 'Invalid save request.' });
    });
  });

  describe('makeByteCapGuard', () => {
    it('accepts chunks up to the cap and refuses the first byte over it', () => {
      const guard = makeByteCapGuard(100);
      expect(guard.accept({ length: 60 })).toBe(true);
      // Exactly at the cap: still accepted.
      expect(guard.accept({ length: 40 })).toBe(true);
      expect(guard.bytesRead()).toBe(100);
      // One byte over the cap: refused.
      expect(guard.accept({ length: 1 })).toBe(false);
      expect(guard.bytesRead()).toBe(101);
    });

    it('keeps refusing once the cap is exceeded', () => {
      const guard = makeByteCapGuard(10);
      expect(guard.accept({ length: 11 })).toBe(false);
      expect(guard.accept({ length: 1 })).toBe(false);
      expect(guard.accept({ length: 0 })).toBe(false);
    });
  });
});
