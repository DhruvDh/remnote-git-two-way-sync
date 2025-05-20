import { usePlugin, renderWidget, useTracker } from '@remnote/plugin-sdk';

export const SyncWidget = () => {
  const plugin = usePlugin();
  const status = useTracker(() =>
    plugin.storage.getSynced<string>('github-sync-status')
  );

  const onClick = async () => {
    await plugin.messaging.broadcast('sync-now');
  };

  return (
    <div className="p-2">
      <div className="mb-2">GitHub Sync Status: {status ?? 'Idle'}</div>
      <button
        className="rn-button"
        onClick={onClick}
      >
        Sync Now
      </button>
    </div>
  );
};

renderWidget(SyncWidget);
