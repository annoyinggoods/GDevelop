// @flow
import { Trans, t } from '@lingui/macro';
import * as React from 'react';

import Checkbox from '../../UI/Checkbox';
import { Line } from '../../UI/Grid';
import { ColumnStackLayout, LineStackLayout } from '../../UI/Layout';
import CompactSelectField from '../../UI/CompactSelectField';
import SelectOption from '../../UI/SelectOption';
import Text from '../../UI/Text';
import TextField from '../../UI/TextField';
import {
  getForkAssetBuildSettings,
  setForkAssetBuildSettings,
  subscribeForkAssetBuildSettings,
  type ForkAssetBuildSettings,
} from './ForkAssetBuildSettings';
import {
  createDefaultForkAssetOptimizerDeps,
  probeForkAssetEncoderCapabilities,
} from './ForkAssetOptimizerPort';
import { type ForkAssetPlanEncoderCapabilities } from './ForkAssetPlan';
import ForkGuardrailSettingsSection from '../Guardrails/ForkGuardrailSettingsSection';

/**
 * Phase 16.4 — the "Build" Preferences tab: the on/off switch, the two safe
 * knobs (D16-6), the manual-export opt-in (D16-5) and an honest note when an
 * encoder is missing (D16-3's native dependencies). The tab reads and writes
 * the fork-owned settings store, so the export pipeline and the chat tools
 * see exactly the same values (16.3/16.5).
 */

/** The tab subscribes to the settings store (it is the store's only UI). */
export const useForkAssetBuildSettings = (): ForkAssetBuildSettings => {
  const [settings, setSettings] = React.useState<ForkAssetBuildSettings>(
    getForkAssetBuildSettings
  );
  React.useEffect(() => {
    const sync = () => setSettings(getForkAssetBuildSettings());
    sync();
    return subscribeForkAssetBuildSettings(sync);
  }, []);
  return settings;
};

const PNG_LEVELS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
const AUDIO_BITRATES = [64, 96, 128, 160, 192, 256, 320];

const ForkAssetBuildSettingsTab = (): React.Node => {
  const settings = useForkAssetBuildSettings();
  // null: the probe did not run or there is no desktop IPC (the web build).
  const [
    capabilities,
    setCapabilities,
  ] = React.useState<?ForkAssetPlanEncoderCapabilities>(null);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const deps = createDefaultForkAssetOptimizerDeps();
      if (!deps) {
        if (!cancelled) setCapabilities(null);
        return;
      }
      const probed = await probeForkAssetEncoderCapabilities(deps);
      if (!cancelled) setCapabilities(probed);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const update = (partial: Partial<ForkAssetBuildSettings>) => {
    setForkAssetBuildSettings(partial);
  };

  return (
    <ColumnStackLayout noMargin>
      <Text size="block-title">
        <Trans>Build — asset optimization</Trans>
      </Text>
      <Text>
        <Trans>
          Shrink the images (and lossy audio) of the EXPORT copy, in place and
          under the same file names, so the game loads exactly the same assets.
          Your project's original files are never touched. Traffic is offline:
          the encoders run on this machine.
        </Trans>
      </Text>
      <Checkbox
        checked={settings.enabled}
        onCheck={(event, checked) => update({ enabled: checked })}
        label={<Trans>Optimize assets when exporting (experimental)</Trans>}
      />

      <Text size="block-title">
        <Trans>Images</Trans>
      </Text>
      <LineStackLayout noMargin alignItems="center">
        <CompactSelectField
          value={String(settings.pngLevel)}
          onChange={(value: string) => update({ pngLevel: Number(value) })}
        >
          {PNG_LEVELS.map(level => (
            <SelectOption
              key={level}
              value={String(level)}
              label={
                level === 9
                  ? t`PNG compression level ${level} (smallest, lossless)`
                  : t`PNG compression level ${level}`
              }
            />
          ))}
        </CompactSelectField>
      </LineStackLayout>
      <Line noMargin>
        <TextField
          name="fork-asset-jpeg-quality"
          type="number"
          floatingLabelText={<Trans>JPEG quality (1-100)</Trans>}
          value={String(settings.jpegQuality)}
          onChange={(event, text) => update({ jpegQuality: Number(text) })}
          fullWidth
        />
      </Line>
      <Line noMargin>
        <TextField
          name="fork-asset-webp-quality"
          type="number"
          floatingLabelText={<Trans>WebP quality (1-100)</Trans>}
          value={String(settings.webpQuality)}
          onChange={(event, text) => update({ webpQuality: Number(text) })}
          fullWidth
        />
      </Line>

      <Text size="block-title">
        <Trans>Audio</Trans>
      </Text>
      <Checkbox
        checked={settings.audioEnabled}
        onCheck={(event, checked) => update({ audioEnabled: checked })}
        label={
          <Trans>
            Re-encode lossy audio (mp3, ogg, m4a, aac, opus) at a lower bitrate
          </Trans>
        }
      />
      <LineStackLayout noMargin alignItems="center">
        <CompactSelectField
          value={String(settings.audioBitrateKbps)}
          onChange={(value: string) =>
            update({ audioBitrateKbps: Number(value) })
          }
        >
          {AUDIO_BITRATES.map(bitrate => (
            <SelectOption
              key={bitrate}
              value={String(bitrate)}
              label={t`${bitrate} kbps`}
            />
          ))}
        </CompactSelectField>
      </LineStackLayout>

      <Text size="block-title">
        <Trans>Manual export</Trans>
      </Text>
      <Checkbox
        checked={settings.optimizeManualExports}
        onCheck={(event, checked) => update({ optimizeManualExports: checked })}
        label={
          <Trans>
            Also optimize the "export to a folder" path (the one-click online
            build is optimized as soon as the main toggle is on)
          </Trans>
        }
      />

      {capabilities === null && (
        <Line noMargin>
          <Text size="body2" color="secondary">
            <Trans>
              The asset encoder is only available in the desktop app — the
              browser build keeps exporting as before.
            </Trans>
          </Text>
        </Line>
      )}
      {capabilities && !capabilities.images && (
        <Line noMargin>
          <Text size="body2" color="error">
            <Trans>
              No image encoder is configured (the sharp dependency is missing) —
              images are left as exported.
            </Trans>
          </Text>
        </Line>
      )}
      {capabilities && !capabilities.audio && (
        <Line noMargin>
          <Text size="body2" color="error">
            <Trans>
              No audio encoder is configured (the ffmpeg dependency is missing)
              — audio files are left as exported.
            </Trans>
          </Text>
        </Line>
      )}
      {capabilities && capabilities.images && capabilities.audio && (
        <Line noMargin>
          <Text size="body2" color="secondary">
            <Trans>Both encoders are available.</Trans>
          </Text>
        </Line>
      )}

      {/* Editor guardrails (Phase 18 [P18-master-switch]): the always
          reachable master switch + per-rule mutes — rendered here so the
          Build tab stays the fork's single Preferences touchpoint. */}
      <ForkGuardrailSettingsSection />
    </ColumnStackLayout>
  );
};

export default ForkAssetBuildSettingsTab;
