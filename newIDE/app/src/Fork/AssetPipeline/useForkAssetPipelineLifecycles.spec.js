/**
 * @jest-environment jsdom
 */
// @flow
import * as React from 'react';
import { act } from 'react-dom/test-utils';
import TestRenderer from 'react-test-renderer';
import useForkAssetPipelineLifecycles from './useForkAssetPipelineLifecycles';
import { startForkAssetAutoRegister } from './ForkAssetAutoRegister';
import { startForkAssetAutoReload } from './ForkAssetAutoReload';

jest.mock('./ForkAssetAutoRegister', () => ({
  startForkAssetAutoRegister: (jest.fn(): any).mockReturnValue(() => {}),
}));
jest.mock('./ForkAssetAutoReload', () => ({
  startForkAssetAutoReload: (jest.fn(): any).mockReturnValue(() => {}),
}));

const mockAutoRegister = (startForkAssetAutoRegister: any);
const mockAutoReload = (startForkAssetAutoReload: any);

const makeProject = (name: string): any => ({
  getName: () => name,
  getProjectFile: () => `C:/projects/${name}/game.json`,
});

type HostProps = {|
  project: ?any,
  onProjectModified: () => void,
|};

const Host = ({ project, onProjectModified }: HostProps): React.Node => {
  useForkAssetPipelineLifecycles({ project, onProjectModified });
  return null;
};

const renderHost = async (props: HostProps) => {
  let renderer: any = null;
  await act(async () => {
    renderer = TestRenderer.create(<Host {...props} />);
  });
  return {
    renderer,
    rerender: async (nextProps: HostProps) => {
      await act(async () => {
        renderer.update(<Host {...nextProps} />);
      });
    },
    unmount: async () => {
      await act(async () => {
        renderer.unmount();
      });
    },
  };
};

describe('useForkAssetPipelineLifecycles', () => {
  beforeEach(() => {
    mockAutoRegister.mockClear();
    mockAutoReload.mockClear();
    mockAutoRegister.mockReturnValue(() => {});
    mockAutoReload.mockReturnValue(() => {});
  });

  it('starts both lifecycles for the open project (whatever editor is open)', async () => {
    const project = makeProject('game-a');
    const onProjectModified = (jest.fn(): any);
    await renderHost({ project, onProjectModified });

    expect(mockAutoRegister).toHaveBeenCalledTimes(1);
    expect(mockAutoRegister).toHaveBeenCalledWith({
      project,
      onProjectModified,
    });
    expect(mockAutoReload).toHaveBeenCalledTimes(1);
    expect(mockAutoReload).toHaveBeenCalledWith({ project });
  });

  it('starts nothing without a project, and stops on a project change', async () => {
    const stopRegister = (jest.fn(): any);
    const stopReload = (jest.fn(): any);
    mockAutoRegister.mockReturnValueOnce(stopRegister);
    mockAutoReload.mockReturnValueOnce(stopReload);

    const onProjectModified = () => {};
    const first = await renderHost({ project: null, onProjectModified });
    expect(mockAutoRegister).not.toHaveBeenCalled();
    expect(mockAutoReload).not.toHaveBeenCalled();

    const project = makeProject('game-a');
    await first.rerender({ project, onProjectModified });
    expect(mockAutoRegister).toHaveBeenCalledTimes(1);

    await first.rerender({ project: makeProject('game-b'), onProjectModified });
    // The previous project's lifecycles were stopped before the new ones.
    expect(stopRegister).toHaveBeenCalledTimes(1);
    expect(stopReload).toHaveBeenCalledTimes(1);
    expect(mockAutoRegister).toHaveBeenCalledTimes(2);

    await first.unmount();
    expect(mockAutoRegister).toHaveBeenCalledTimes(2);
    expect(mockAutoReload).toHaveBeenCalledTimes(2);
  });

  it('stops both lifecycles on unmount', async () => {
    const stopRegister = (jest.fn(): any);
    const stopReload = (jest.fn(): any);
    mockAutoRegister.mockReturnValueOnce(stopRegister);
    mockAutoReload.mockReturnValueOnce(stopReload);

    const host = await renderHost({
      project: makeProject('game-a'),
      onProjectModified: () => {},
    });
    await host.unmount();
    expect(stopRegister).toHaveBeenCalledTimes(1);
    expect(stopReload).toHaveBeenCalledTimes(1);
  });
});
