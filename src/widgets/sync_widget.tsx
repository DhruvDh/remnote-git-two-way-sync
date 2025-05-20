import {
  renderWidget,
  usePlugin,
  useTrackerPlugin as useTracker,
  ReactRNPlugin,
} from '@remnote/plugin-sdk';
import { useEffect } from 'react';
import { syncNow } from '../github/sync';
import { restartTimers } from './index';

export const SyncWidget = () => {
  const plugin = usePlugin();
  const reactPlugin = plugin as unknown as ReactRNPlugin;
  const status = useTracker(() => plugin.storage.getLocal<string>('sync-status') ?? 'Idle');
  const pullMinutes = useTracker(() => plugin.settings.getSetting<number>('pull-interval') ?? 5);
  const retryMinutes = useTracker(() => plugin.settings.getSetting<number>('retry-interval') ?? 5);

  useEffect(() => {
    restartTimers(reactPlugin);
  }, [pullMinutes, retryMinutes]);

  const onClick = async () => {
    await plugin.storage.setLocal('sync-status', 'Syncing');
    const success = await syncNow(reactPlugin);
    await plugin.storage.setLocal('sync-status', success ? 'Synced' : 'Error');
    await plugin.app.toast(success ? 'Sync completed' : 'Sync failed');
  };

  return (
    <div className="p-2">
      <div className="mb-2">GitHub Sync Status: {status}</div>
      <button className="rn-btn rn-btn-primary" onClick={onClick}>Sync Now</button>
    </div>
  );
};

renderWidget(SyncWidget);
