import { describe, expect, it, vi } from 'vitest';

import { run } from './uninstall.js';

describe('uninstall step', () => {
  it('uninstalls all known services on linux', async () => {
    const uninstallLinuxImpl = vi.fn();

    await run([], {
      getPlatformImpl: () => 'linux',
      getHomeDir: () => '/home/tester',
      getProjectRoot: () => '/srv/goodkiddo',
      uninstallLinuxImpl,
    });

    expect(uninstallLinuxImpl).toHaveBeenCalledTimes(1);
    expect(uninstallLinuxImpl).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ name: 'goodkiddo' }),
        expect.objectContaining({ name: 'goodkiddo-codex' }),
        expect.objectContaining({ name: 'goodkiddo-review' }),
      ]),
      '/srv/goodkiddo',
      '/home/tester',
    );
  });

  it('uninstalls each launchd service on macos', async () => {
    const uninstallLaunchdImpl = vi.fn();

    await run([], {
      getPlatformImpl: () => 'macos',
      getHomeDir: () => '/Users/tester',
      getProjectRoot: () => '/srv/goodkiddo',
      uninstallLaunchdImpl,
    });

    expect(uninstallLaunchdImpl).toHaveBeenCalledTimes(3);
    expect(uninstallLaunchdImpl).toHaveBeenCalledWith(
      expect.objectContaining({ launchdLabel: 'com.goodkiddo' }),
      '/Users/tester',
    );
    expect(uninstallLaunchdImpl).toHaveBeenCalledWith(
      expect.objectContaining({ launchdLabel: 'com.goodkiddo-codex' }),
      '/Users/tester',
    );
    expect(uninstallLaunchdImpl).toHaveBeenCalledWith(
      expect.objectContaining({ launchdLabel: 'com.goodkiddo-review' }),
      '/Users/tester',
    );
  });
});
