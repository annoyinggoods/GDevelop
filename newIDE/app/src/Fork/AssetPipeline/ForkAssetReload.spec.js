// @flow
import { reloadForkResourceFromDisk } from './ForkAssetReload';

const makeResource = (name: string, file: string) => ({
  getName: () => name,
  getFile: () => file,
});

describe('reloadForkResourceFromDisk', () => {
  it('fires the existing external-change trigger with the FILE identifier', () => {
    const trigger = (jest.fn(): any);
    const result = reloadForkResourceFromDisk({
      resource: makeResource('hero', 'art/hero.png'),
      triggerOnResourceExternallyChanged: trigger,
    });

    expect(result).toEqual({ ok: true, reloadedIdentifier: 'art/hero.png' });
    expect(trigger).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveBeenCalledWith({ fileIdentifier: 'art/hero.png' });
  });

  it('falls back to the resource name when the file is empty', () => {
    const trigger = (jest.fn(): any);
    const result = reloadForkResourceFromDisk({
      resource: makeResource('hero', ''),
      triggerOnResourceExternallyChanged: trigger,
    });
    expect(result).toEqual({ ok: true, reloadedIdentifier: 'hero' });
    expect(trigger).toHaveBeenCalledWith({ fileIdentifier: 'hero' });
  });

  it('refuses a missing resource or one with no identifier at all', () => {
    const trigger = (jest.fn(): any);
    expect(
      reloadForkResourceFromDisk({
        resource: null,
        triggerOnResourceExternallyChanged: trigger,
      }).ok
    ).toBe(false);
    expect(
      reloadForkResourceFromDisk({
        resource: makeResource('', ''),
        triggerOnResourceExternallyChanged: trigger,
      }).ok
    ).toBe(false);
    expect(trigger).not.toHaveBeenCalled();
  });

  it('does nothing besides the trigger and the preview hop (no file access, no writes)', () => {
    // The reload IS the burst + the editor fan-out; prove nothing else is
    // consulted by passing a bare resource object with no other methods.
    const trigger = (jest.fn(): any);
    reloadForkResourceFromDisk({
      resource: { getFile: () => 'x.png', getName: () => 'x.png' },
      triggerOnResourceExternallyChanged: trigger,
    });
    expect(trigger).toHaveBeenCalledTimes(1);
  });

  it('notifies the preview reload seam after a successful reload ([P17-preview-reload])', () => {
    const trigger = (jest.fn(): any);
    const notifyPreviewReload = (jest.fn(): any);
    const result = reloadForkResourceFromDisk({
      resource: makeResource('hero', 'art/hero.png'),
      triggerOnResourceExternallyChanged: trigger,
      notifyPreviewReload,
    });

    expect(result.ok).toBe(true);
    expect(notifyPreviewReload).toHaveBeenCalledTimes(1);
    // The preview hop follows the editor-side burst, never precedes it.
    expect(trigger.mock.invocationCallOrder[0]).toBeLessThan(
      notifyPreviewReload.mock.invocationCallOrder[0]
    );
  });

  it('does not notify the preview reload seam on a refused reload', () => {
    const trigger = (jest.fn(): any);
    const notifyPreviewReload = (jest.fn(): any);
    reloadForkResourceFromDisk({
      resource: null,
      triggerOnResourceExternallyChanged: trigger,
      notifyPreviewReload,
    });
    expect(notifyPreviewReload).not.toHaveBeenCalled();
  });
});
