// @flow
import * as React from 'react';
import { Trans } from '@lingui/macro';

import Text from '../../UI/Text';
import TextField from '../../UI/TextField';
import IconButton from '../../UI/IconButton';
import Cross from '../../UI/CustomSvgIcons/Cross';
import useForceUpdate from '../../Utils/UseForceUpdate';
import UnsavedChangesContext from '../../MainFrame/UnsavedChangesContext';
import { normalizeForkAssetTag } from './ForkAssetTags';
import { getForkResourceTags, setForkResourceTags } from './ForkAssetTagStore';

/** The human-readable refusal messages (normalizeForkAssetTag's reasons). */
const refusalMessage = (reason: string): React.Node => {
  if (reason === 'empty') {
    return <Trans>A tag cannot be empty.</Trans>;
  }
  if (reason === 'control-characters') {
    return <Trans>A tag cannot contain control characters.</Trans>;
  }
  if (reason === 'path-separator') {
    return <Trans>A tag cannot contain slashes — tags are not paths.</Trans>;
  }
  if (reason === 'too-long') {
    return <Trans>A tag is capped at 64 characters.</Trans>;
  }
  return <Trans>This is not a valid tag.</Trans>;
};

type Props = {|
  resource: gdResource,
|};

/**
 * Phase 17.4 — the per-resource tag chips, rendered as an extra section of
 * the resource properties surface. Adds/removes tags through the Step 17.2
 * writer (metadata-only) and shows `normalizeForkAssetTag` refusals inline
 * — a refusal is never a silent drop.
 */
const ForkAssetTagEditor = ({ resource }: Props): React.Node => {
  const forceUpdate = useForceUpdate();
  const [draft, setDraft] = React.useState<string>('');
  const [refusal, setRefusal] = React.useState<React.Node | null>(null);
  const unsavedChanges = React.useContext(UnsavedChangesContext);
  const triggerUnsavedChanges = unsavedChanges.triggerUnsavedChanges;

  const tags = getForkResourceTags(resource);

  const writeTags = (nextTags: Array<string>) => {
    const result = setForkResourceTags({ resource, tags: nextTags });
    if (result.didChangeMetadata) triggerUnsavedChanges();
    forceUpdate();
    return result;
  };

  const handleAddDraft = (fromBlur: boolean) => {
    // Leaving the field empty-handed on blur is not an error to report;
    // pressing Enter on an empty draft IS explicit input worth refusing.
    if (fromBlur && draft.trim() === '') {
      setDraft('');
      setRefusal(null);
      return;
    }
    const normalized = normalizeForkAssetTag(draft);
    if (!normalized.ok) {
      setRefusal(refusalMessage(normalized.reason));
      return;
    }
    setRefusal(null);
    if (!tags.includes(normalized.tag)) {
      writeTags(tags.concat([normalized.tag]));
    }
    setDraft('');
  };

  const handleRemove = (tag: string) => {
    setRefusal(null);
    writeTags(tags.filter(existing => existing !== tag));
  };

  return (
    <div>
      <Text size="body" noMargin>
        <Trans>Tags</Trans>
      </Text>
      {tags.length === 0 ? (
        <Text size="body2" noMargin color="secondary">
          <Trans>No tags — this asset sits in the Untagged bucket.</Trans>
        </Text>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {tags.map(tag => (
            <span
              key={tag}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                padding: '2px 6px',
                borderRadius: 12,
                backgroundColor: 'rgba(0, 0, 0, 0.08)',
              }}
            >
              {tag}
              <IconButton size="small" onClick={() => handleRemove(tag)}>
                <Cross />
              </IconButton>
            </span>
          ))}
        </div>
      )}
      <TextField
        value={draft}
        floatingLabelText={<Trans>Add a tag</Trans>}
        onChange={(event, value) => {
          setDraft(value);
          setRefusal(null);
        }}
        onKeyUp={event => {
          if (event.key === 'Enter') handleAddDraft(false);
        }}
        onBlur={() => handleAddDraft(true)}
        fullWidth
      />
      {refusal && (
        <Text size="body2" noMargin>
          {refusal}
        </Text>
      )}
    </div>
  );
};

export default ForkAssetTagEditor;
