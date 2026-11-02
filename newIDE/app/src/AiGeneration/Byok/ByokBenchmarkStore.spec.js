/**
 * @jest-environment jsdom
 */
// @flow
import {
  loadByokBenchmarkReport,
  makeByokBenchmarkStoreKey,
  saveByokBenchmarkReport,
} from './ByokBenchmarkStore';

describe('ByokBenchmarkStore', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('keys the reports per endpoint and model', () => {
    expect(
      makeByokBenchmarkStoreKey({
        endpointUrl: 'http://127.0.0.1:1234/v1',
        modelName: 'gpt-4o',
      })
    ).toBe('gd-byok-benchmark-http_127.0.0.1_1234_v1|gpt-4o');
    expect(
      makeByokBenchmarkStoreKey({
        endpointUrl: 'http://host/v1',
        modelName: 'a b/c',
      })
    ).not.toContain(' ');
  });

  it('round-trips a saved report', () => {
    saveByokBenchmarkReport({
      endpointUrl: 'http://host/v1',
      modelName: 'model-a',
      reportText: '3/4 tasks passed',
    });
    expect(
      loadByokBenchmarkReport({
        endpointUrl: 'http://host/v1',
        modelName: 'model-a',
      })
    ).toEqual({
      reportText: '3/4 tasks passed',
      finishedAt: expect.any(String),
    });
  });

  it('keeps reports of different models separate', () => {
    saveByokBenchmarkReport({
      endpointUrl: 'http://host/v1',
      modelName: 'model-a',
      reportText: 'report a',
    });
    saveByokBenchmarkReport({
      endpointUrl: 'http://host/v1',
      modelName: 'model-b',
      reportText: 'report b',
    });
    expect(
      loadByokBenchmarkReport({
        endpointUrl: 'http://host/v1',
        modelName: 'model-a',
      })
    ).toMatchObject({ reportText: 'report a' });
    expect(
      loadByokBenchmarkReport({
        endpointUrl: 'http://host/v1',
        modelName: 'model-b',
      })
    ).toMatchObject({ reportText: 'report b' });
  });

  it('answers null for missing or corrupted entries', () => {
    expect(
      loadByokBenchmarkReport({
        endpointUrl: 'http://host/v1',
        modelName: 'never-run',
      })
    ).toBe(null);
    localStorage.setItem(
      makeByokBenchmarkStoreKey({
        endpointUrl: 'http://host/v1',
        modelName: 'corrupted',
      }),
      '{broken'
    );
    expect(
      loadByokBenchmarkReport({
        endpointUrl: 'http://host/v1',
        modelName: 'corrupted',
      })
    ).toBe(null);
  });
});
