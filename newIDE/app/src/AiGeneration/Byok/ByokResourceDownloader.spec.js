// @flow
/* eslint-disable no-restricted-globals */
// $FlowFixMe[cannot-resolve-module]
const path: any = require('path');
const {
  isByokGDevelopHost,
  validateByokResourceDownloadRequest,
  createByokResourceDownloader,
} = require('./ByokResourceDownloader');

const PROJECT_FILE = path.resolve('/projects/game/game.json3');
const PROJECT_FOLDER = path.dirname(PROJECT_FILE);

// A minimal stream pair: the fake response pushes chunks then ends; the
// fake writer records writes and finishes on end().
const makeFakeResponse = (chunks: Array<string>): any => {
  const response: any = {
    statusCode: 200,
    headers: {},
    pipedTo: null,
    resume: () => {},
    on: () => {},
    pipe(writer: any) {
      response.pipedTo = writer;
      for (const chunk of chunks) writer.write(stringToBytes(chunk));
      writer.end();
    },
  };
  return response;
};

/** "abc" -> the char codes (a Uint8Array; Buffer is unavailable to Flow). */
const stringToBytes = (text: string): any => {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index++) {
    bytes[index] = text.charCodeAt(index);
  }
  return bytes;
};

const concatBytes = (a: any, b: any): any => {
  const merged = new Uint8Array(a.length + b.length);
  merged.set(a, 0);
  merged.set(b, a.length);
  return merged;
};

const bytesToString = (bytes: any): string => {
  let text = '';
  for (let index = 0; index < bytes.length; index++) {
    text += String.fromCharCode(bytes[index]);
  }
  return text;
};

const makeFakeWriter = (): any => {
  const writer: any = {
    written: new Uint8Array(0),
    destroyed: false,
    handlers: {},
    write(chunk: any) {
      writer.written = concatBytes(writer.written, chunk);
    },
    end() {
      if (writer.handlers.finish) writer.handlers.finish();
    },
    on(kind: string, handler: any) {
      writer.handlers[kind] = handler;
    },
    destroy() {
      writer.destroyed = true;
    },
  };
  return writer;
};

const makeFakeTransport = (
  handler: (url: string, options: any) => any
): any => {
  const transport: any = {
    lastOptions: null,
    get(url: string, options: any, callback: any) {
      transport.lastOptions = options;
      const request = {
        setTimeout: () => {},
        on: () => {},
        destroy: () => {},
      };
      const response = handler(url, options);
      callback(response);
      return request;
    },
  };
  return transport;
};

const makeFakeFs = (): any => {
  const fs: any = {
    writers: [],
    createWriteStream: () => {
      const writer = makeFakeWriter();
      fs.writers.push(writer);
      return writer;
    },
    unlinked: [],
    unlinkSync: (filePath: string) => {
      // The recorded writers model the on-disk file.
      fs.writers.forEach((writer: any) => {
        writer.destroyed = true;
      });
    },
  };
  return fs;
};

describe('ByokResourceDownloader (audit011026 B-ELEC-14)', () => {
  describe('isByokGDevelopHost', () => {
    it('accepts gdevelop.io and its subdomains only', () => {
      expect(isByokGDevelopHost('gdevelop.io')).toBe(true);
      expect(isByokGDevelopHost('assets.gdevelop.io')).toBe(true);
      expect(isByokGDevelopHost('evil.example')).toBe(false);
      expect(isByokGDevelopHost('gdevelop.io.evil.example')).toBe(false);
    });
  });

  describe('validateByokResourceDownloadRequest', () => {
    it('accepts an in-project http(s) target', () => {
      expect(
        validateByokResourceDownloadRequest({
          url: 'https://host.example/a.png',
          outputPath: path.join(PROJECT_FOLDER, 'a.png'),
          projectFile: PROJECT_FILE,
          pathLib: path,
        })
      ).toEqual({ ok: true });
    });

    it('refuses non-http protocols', () => {
      expect(
        validateByokResourceDownloadRequest({
          url: 'file:///C:/Windows/system.ini',
          outputPath: path.join(PROJECT_FOLDER, 'a.png'),
          projectFile: PROJECT_FILE,
          pathLib: path,
        }).ok
      ).toBe(false);
    });

    it('refuses a target outside the project folder', () => {
      const result = validateByokResourceDownloadRequest({
        url: 'https://host.example/a.png',
        outputPath: path.resolve('/elsewhere/a.png'),
        projectFile: PROJECT_FILE,
        pathLib: path,
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain('outside the project folder');
    });

    it('refuses a sibling folder whose name merely extends the project folder', () => {
      expect(
        validateByokResourceDownloadRequest({
          url: 'https://host.example/a.png',
          outputPath: path.resolve('/projects/game2/a.png'),
          projectFile: PROJECT_FILE,
          pathLib: path,
        }).ok
      ).toBe(false);
    });
  });

  describe('createByokResourceDownloader', () => {
    const makeDownloader = (transport: any, cookieValue: ?string = null) => {
      const fs = makeFakeFs();
      const downloader = createByokResourceDownloader({
        https: transport,
        http: (transport: any),
        fs,
        pathLib: path,
        getCloudCookieValue: async () => cookieValue,
      });
      return { downloader, fs };
    };

    it('downloads a 200 response to the target without any cookie for foreign hosts', async () => {
      const transport = makeFakeTransport(() => makeFakeResponse(['abc']));
      const { downloader, fs } = makeDownloader(transport, 'SECRET');

      const result = await downloader({
        url: 'https://host.example/a.png',
        outputPath: path.join(PROJECT_FOLDER, 'a.png'),
        projectFile: PROJECT_FILE,
      });

      expect(result).toEqual({ ok: true });
      expect(transport.lastOptions.headers.Cookie).toBeUndefined();
      expect(bytesToString(fs.writers[0].written)).toBe('abc');
    });

    it('sends the cloud cookie only to gdevelop.io hosts', async () => {
      const transport = makeFakeTransport(() => makeFakeResponse(['abc']));
      const { downloader } = makeDownloader(transport, 'SECRET');

      await downloader({
        url: 'https://assets.gdevelop.io/private/a.png',
        outputPath: path.join(PROJECT_FOLDER, 'a.png'),
        projectFile: PROJECT_FILE,
      });

      expect(transport.lastOptions.headers.Cookie).toBe('gd_resource=SECRET');
    });

    it('reports a non-200 status as a failure', async () => {
      const transport = makeFakeTransport(() => ({
        statusCode: 404,
        headers: {},
        resume: () => {},
      }));
      const { downloader } = makeDownloader(transport);

      const result = await downloader({
        url: 'https://host.example/a.png',
        outputPath: path.join(PROJECT_FOLDER, 'a.png'),
        projectFile: PROJECT_FILE,
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain('404');
    });

    it('refuses the request before any network call when the target escapes the project', async () => {
      const transport = makeFakeTransport(() => makeFakeResponse(['abc']));
      const { downloader, fs } = makeDownloader(transport);

      const result = await downloader({
        url: 'https://host.example/a.png',
        outputPath: path.resolve('/elsewhere/a.png'),
        projectFile: PROJECT_FILE,
      });

      expect(result.ok).toBe(false);
      expect(fs.writers).toHaveLength(0);
    });
  });
});
