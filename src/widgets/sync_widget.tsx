import { renderWidget, usePlugin, useTracker } from '@remnote/plugin-sdk';
import { syncNow } from '../github/sync';

export const SyncWidget = () => {
  const plugin = usePlugin();
  const status = useTracker(() => plugin.storage.getLocal<string>('sync-status') ?? 'Idle');

  const onClick = async () => {
    await plugin.storage.setLocal('sync-status', 'Syncing');
    const success = await syncNow(plugin);
    await plugin.storage.setLocal('sync-status', success ? 'Synced' : 'Error');
    await plugin.app.toast(success ? 'Sync completed' : 'Sync failed', success ? 'info' : 'error');
  };

  return (
    <div className="p-2">
      <div className="mb-2">GitHub Sync Status: {status}</div>
      <button className="rn-btn rn-btn-primary" onClick={onClick}>Sync Now</button>
    </div>
  );
};

renderWidget(SyncWidget);
