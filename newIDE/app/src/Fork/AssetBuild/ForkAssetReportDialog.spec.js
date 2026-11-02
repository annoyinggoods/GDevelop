/**
 * @jest-environment jsdom
 */
// @flow
import * as React from 'react';
import { act } from 'react-dom/test-utils';
import TestRenderer from 'react-test-renderer';
import { I18nProvider } from '@lingui/react';
import { setupI18n } from '@lingui/core';
import {
  dismissForkAssetReport,
  getPendingForkAssetReport,
  publishForkAssetReport,
  resetForkAssetReportForTests,
} from './ForkAssetReportStore';
import { formatForkAssetBytes } from './ForkAssetOptimizerPort';
import type { ForkAssetOptimizationReport } from './ForkAssetOptimizerPort';

// jsdom does not implement matchMedia and UI/Dialog reaches the Preferences
// context through it (PreferencesContext loads at import) — so the stub runs
// BEFORE the dialog module (required below, not imported).
if (!(window: any).matchMedia) {
  (window: any).matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
  });
}

// MUI's Dialog mounts through a Portal react-test-renderer cannot drive
// (`parentInstance.children.indexOf is not a function`). The spec is about the
// report's CONTENT, so the Dialog primitive is replaced by a passthrough that
// renders its title and children — every string the user sees is still real.
jest.mock('../../UI/Dialog', () => {
  const react: any = require('react');
  return {
    __esModule: true,
    default: (props: any) =>
      react.createElement('div', null, props.title, props.children),
  };
});

const {
  ForkAssetReportDialog,
  ForkAssetReportDialogHost,
} = require('./ForkAssetReportDialog');

// The UI primitives read the app's i18n context; an empty catalog set renders
// the English source messages (the ByokSettingsTab spec convention).
const i18n = setupI18n({ language: 'en', catalogs: {} });
const withI18n = (element: React.Node) => (
  <I18nProvider i18n={i18n} language="en">
    {element}
  </I18nProvider>
);

const makeReport = (): ForkAssetOptimizationReport => ({
  folderPath: 'C:/tmp/export',
  ranOptimization: true,
  error: null,
  summary: {
    totalBytesBefore: 10000,
    totalBytesAfter: 4000,
    savedBytes: 6000,
    optimizedCount: 2,
    failedCount: 1,
    largestSavings: [{ relativePath: 'hero.png', savedBytes: 6000 }],
  },
  files: [
    {
      relativePath: 'hero.png',
      bytesBefore: 9000,
      bytesAfter: 3000,
      error: null,
    },
    {
      relativePath: 'locked.png',
      bytesBefore: 1000,
      bytesAfter: 1000,
      error: 'permission denied',
    },
  ],
  skipped: [
    {
      relativePath: 'notes.txt',
      reason: 'Unsupported extension ".txt".',
      reasonCode: 'unsupported-extension',
    },
    {
      relativePath: 'music.wav',
      reason: 'Lossless audio not re-encoded.',
      reasonCode: 'lossless-audio',
    },
  ],
});

/** Every string leaf of a rendered tree, joined (the visible text). */
const collectText = (node: any): string => {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(collectText).join(' ');
  if (node.children) return collectText(node.children);
  return '';
};

describe('ForkAssetReportDialog', () => {
  it('lists every skip with its reason and every failure with its error', () => {
    const onClose = (jest.fn(): any);
    let renderer: any = null;
    act(() => {
      renderer = TestRenderer.create(
        withI18n(
          <ForkAssetReportDialog report={makeReport()} onClose={onClose} />
        )
      );
    });
    const text = collectText(renderer.toJSON());

    // Totals.
    expect(text).toContain('2 file(s) re-encoded');
    expect(text).toContain(formatForkAssetBytes(6000));
    // Per-file skips with their reasons — the AC. Known reason CODES render
    // the localized message ([P16-reasons-i18n]).
    expect(text).toContain('notes.txt');
    expect(text).toContain(
      'Unsupported extension — only PNG, JPEG, WebP, GIF images and lossy audio are re-encoded.'
    );
    expect(text).toContain('music.wav');
    expect(text).toContain(
      'Lossless audio is not re-encoded — it would lose fidelity without a real size win.'
    );
    // Per-file failures.
    expect(text).toContain('locked.png');
    expect(text).toContain('permission denied');
    // Largest savings.
    expect(text).toContain('hero.png');
    // The non-destructiveness reminder.
    expect(text).toContain('original files');
  });

  it('falls back to the planner prose for an unknown or missing reason code', () => {
    const report = makeReport();
    report.skipped = [
      {
        relativePath: 'weird.bin',
        reason: 'A reason a future planner wrote.',
        reasonCode: 'brand-new-code',
      },
      {
        relativePath: 'older.bin',
        reason: 'A report written before reason codes existed.',
        reasonCode: null,
      },
    ];
    let renderer: any = null;
    act(() => {
      renderer = TestRenderer.create(
        withI18n(<ForkAssetReportDialog report={report} onClose={() => {}} />)
      );
    });
    const text = collectText(renderer.toJSON());
    expect(text).toContain('A reason a future planner wrote.');
    expect(text).toContain('A report written before reason codes existed.');
  });

  it('renders without the optional sections when nothing was skipped', () => {
    const report = makeReport();
    const empty: ForkAssetOptimizationReport = {
      ...report,
      files: [],
      skipped: [],
      summary: {
        ...report.summary,
        failedCount: 0,
        largestSavings: [],
        optimizedCount: 0,
        savedBytes: 0,
      },
    };
    let renderer: any = null;
    act(() => {
      renderer = TestRenderer.create(
        withI18n(<ForkAssetReportDialog report={empty} onClose={() => {}} />)
      );
    });
    const text = collectText(renderer.toJSON());
    expect(text).not.toContain('notes.txt');
    expect(text).toContain('0 file(s) re-encoded');
  });
});

describe('ForkAssetReportDialogHost', () => {
  beforeEach(() => {
    resetForkAssetReportForTests();
  });

  it('shows nothing until a report is published, then the pending report', () => {
    let renderer: any = null;
    act(() => {
      renderer = TestRenderer.create(withI18n(<ForkAssetReportDialogHost />));
    });
    expect(renderer.toJSON()).toBeNull();

    act(() => {
      publishForkAssetReport(makeReport());
    });
    const text = collectText(renderer.toJSON());
    expect(text).toContain('notes.txt');
  });

  it('hides the report once it is dismissed (it is shown once)', () => {
    let renderer: any = null;
    act(() => {
      renderer = TestRenderer.create(withI18n(<ForkAssetReportDialogHost />));
    });
    act(() => {
      publishForkAssetReport(makeReport());
    });
    act(() => {
      dismissForkAssetReport();
    });
    expect(renderer.toJSON()).toBeNull();
  });

  it('drops an unread report when the hosting export dialog closes', () => {
    let renderer: any = null;
    act(() => {
      renderer = TestRenderer.create(withI18n(<ForkAssetReportDialogHost />));
    });
    act(() => {
      publishForkAssetReport(makeReport());
    });
    expect(collectText(renderer.toJSON())).toContain('notes.txt');

    // Unmounting the host (the export dialog closed) must not leave the
    // report pending for the next, unrelated export.
    act(() => {
      renderer.unmount();
    });
    expect(getPendingForkAssetReport()).toBeNull();
  });
});
