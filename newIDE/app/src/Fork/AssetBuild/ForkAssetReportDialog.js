// @flow
import { Trans } from '@lingui/macro';
import * as React from 'react';

import Dialog from '../../UI/Dialog';
import FlatButton from '../../UI/FlatButton';
import Text from '../../UI/Text';
import { Column, Line } from '../../UI/Grid';
import { ColumnStackLayout } from '../../UI/Layout';
import {
  formatForkAssetBytes,
  type ForkAssetOptimizationReport,
} from './ForkAssetOptimizerPort';
import {
  dismissForkAssetReport,
  getPendingForkAssetReport,
  subscribeForkAssetReport,
} from './ForkAssetReportStore';

export type ForkAssetReportDialogProps = {|
  report: ForkAssetOptimizationReport,
  onClose: () => void,
|};

const FailureRow = ({
  relativePath,
  error,
}: {|
  relativePath: string,
  error: ?string,
|}) => (
  <Line noMargin>
    <Text size="body2" color="error">
      {`${relativePath} — ${error || 'left as exported'}`}
    </Text>
  </Line>
);

/**
 * The translation layer of the skip reasons ([P16-reasons-i18n]): the pure
 * planner emits stable reason CODES plus an English prose fallback (the
 * prose is what the model sees); the report maps every known code to a
 * Lingui message so the user-facing report is localizable. An unknown or
 * missing code falls back to the planner's prose — a report must never
 * lose the reason.
 */
export const translateForkAssetSkipReason = (
  reasonCode: ?string,
  fallbackReason: string
): React.Node => {
  if (reasonCode === 'encoder-unavailable-image') {
    return (
      <Trans>
        No image encoder is available in this build, so the file was left as
        exported.
      </Trans>
    );
  }
  if (reasonCode === 'unsupported-image-format') {
    return (
      <Trans>
        Unsupported image format — only PNG, JPEG, WebP and GIF are re-encoded.
      </Trans>
    );
  }
  if (reasonCode === 'below-byte-floor') {
    return (
      <Trans>
        The image is below the small-file floor — re-encoding would not help.
      </Trans>
    );
  }
  if (reasonCode === 'audio-disabled') {
    return (
      <Trans>Audio optimization is turned off in the Build preferences.</Trans>
    );
  }
  if (reasonCode === 'encoder-unavailable-audio') {
    return (
      <Trans>
        No audio encoder is configured (the ffmpeg dependency is missing), so
        the file was left as exported.
      </Trans>
    );
  }
  if (reasonCode === 'lossless-audio') {
    return (
      <Trans>
        Lossless audio is not re-encoded — it would lose fidelity without a real
        size win.
      </Trans>
    );
  }
  if (reasonCode === 'unsupported-audio-format') {
    return <Trans>Unsupported audio format.</Trans>;
  }
  if (reasonCode === 'empty-file') {
    return <Trans>The file is empty (0 bytes) — nothing to re-encode.</Trans>;
  }
  if (reasonCode === 'unsupported-extension') {
    return (
      <Trans>
        Unsupported extension — only PNG, JPEG, WebP, GIF images and lossy audio
        are re-encoded.
      </Trans>
    );
  }
  return fallbackReason;
};

const SkipRow = ({
  relativePath,
  reason,
  reasonCode,
}: {|
  relativePath: string,
  reason: string,
  reasonCode: ?string,
|}) => (
  <Line noMargin>
    <Text size="body2" color="secondary">
      {`${relativePath} — `}
      {translateForkAssetSkipReason(reasonCode, reason)}
    </Text>
  </Line>
);

const SavingRow = ({
  relativePath,
  savedBytes,
}: {|
  relativePath: string,
  savedBytes: number,
|}) => (
  <Line noMargin>
    <Text size="body2">
      {`${relativePath} — saved ${formatForkAssetBytes(savedBytes)}`}
    </Text>
  </Line>
);

/**
 * The one-shot after-export report (16.4): the totals, the per-file wins and
 * — the part that matters for trust — every file that was NOT re-encoded,
 * with the reason (a skip is a policy decision, a failure is an encoder
 * error; both are named, never silently dropped).
 */
export const ForkAssetReportDialog = ({
  report,
  onClose,
}: ForkAssetReportDialogProps): React.Node => {
  const { summary } = report;
  const failures = report.files.filter(file => !!file.error);

  return (
    <Dialog
      title={<Trans>Build assets optimized</Trans>}
      open
      fullscreen="never-even-on-mobile"
      maxWidth="sm"
      onRequestClose={onClose}
      actions={[
        <FlatButton
          key="close"
          keyboardFocused
          label={<Trans>Close</Trans>}
          onClick={onClose}
        />,
      ]}
    >
      <ColumnStackLayout noMargin>
        <Column noMargin>
          <Text>
            {`${
              summary.optimizedCount
            } file(s) re-encoded · saved ${formatForkAssetBytes(
              summary.savedBytes
            )} (${formatForkAssetBytes(
              summary.totalBytesBefore
            )} → ${formatForkAssetBytes(summary.totalBytesAfter)})`}
          </Text>
        </Column>
        {summary.largestSavings.length > 0 && (
          <Column noMargin>
            <Text size="block-title">
              <Trans>Largest savings</Trans>
            </Text>
            {summary.largestSavings.map(saving => (
              <SavingRow
                key={saving.relativePath}
                relativePath={saving.relativePath}
                savedBytes={saving.savedBytes}
              />
            ))}
          </Column>
        )}
        {failures.length > 0 && (
          <Column noMargin>
            <Text size="block-title">
              <Trans>Left as exported (encoder error)</Trans>
            </Text>
            {failures.map(failure => (
              <FailureRow
                key={failure.relativePath}
                relativePath={failure.relativePath}
                error={failure.error}
              />
            ))}
          </Column>
        )}
        {report.skipped.length > 0 && (
          <Column noMargin>
            <Text size="block-title">
              <Trans>Skipped</Trans>
            </Text>
            {report.skipped.map(skip => (
              <SkipRow
                key={skip.relativePath}
                relativePath={skip.relativePath}
                reason={skip.reason}
                reasonCode={skip.reasonCode}
              />
            ))}
          </Column>
        )}
        <Column noMargin>
          <Text size="body2" color="secondary">
            <Trans>
              Only the export folder was touched — your project's original files
              are unchanged.
            </Trans>
          </Text>
        </Column>
      </ColumnStackLayout>
    </Dialog>
  );
};

/**
 * The host mounted once at the MainFrame level ([P16-report-host]): it shows
 * the pending report as soon as an export publishes it, whatever the export
 * path, then dismisses it (a report is never re-shown on a later, unrelated
 * export).
 */
export const ForkAssetReportDialogHost = (): React.Node => {
  const [report, setReport] = React.useState<?ForkAssetOptimizationReport>(
    null
  );

  React.useEffect(() => {
    const sync = () => setReport(getPendingForkAssetReport());
    sync();
    const unsubscribe = subscribeForkAssetReport(sync);
    return () => {
      unsubscribe();
      // "Shown once" (16.4): when the host unmounts, an unread report does
      // not linger into a later, unrelated export.
      dismissForkAssetReport();
    };
  }, []);

  if (!report) return null;
  return (
    <ForkAssetReportDialog report={report} onClose={dismissForkAssetReport} />
  );
};

export default ForkAssetReportDialog;
