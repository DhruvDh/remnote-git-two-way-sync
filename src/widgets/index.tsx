import {
  declareIndexPlugin,
  ReactRNPlugin,
  WidgetLocation,
} from '@remnote/plugin-sdk';
import {
  pushCardById,
  deleteCardFile,
  processFailedQueue,
  pushAllCards,
  loadShaMap,
  pullUpdates,
  setSyncStatus,
} from '../github/sync';
import '../style.css';
import '../App.css';

// Timer references for cleanup on deactivation
let syncInterval: ReturnType<typeof setInterval> | undefined;
let retryInterval: ReturnType<typeof setInterval> | undefined;
let pullInterval: ReturnType<typeof setInterval> | undefined;

async function syncNow(plugin: ReactRNPlugin) {
  try {
    await pullUpdates(plugin);
    await pushAllCards(plugin);
    await plugin.app.toast('Sync completed');
  } catch (e) {
    await plugin.app.toast('Sync failed');
    await setSyncStatus(plugin, 'Error');
    console.error(e);
  }
}

async function onActivate(plugin: ReactRNPlugin) {
  // Register GitHub sync settings
  await plugin.settings.registerStringSetting({
    id: 'github-token',
    title: 'GitHub Personal Access Token',
    description:
      'Token with repo access used for authentication when syncing.',
    defaultValue: '',
  });

  await plugin.settings.registerStringSetting({
    id: 'github-repo',
    title: 'Repository (owner/repo)',
    description: 'Example: username/repo',
    defaultValue: '',
  });

  await plugin.settings.registerStringSetting({
    id: 'github-branch',
    title: 'Branch name',
    description: 'Branch of the repository to use for sync',
    defaultValue: 'main',
  });

  await plugin.settings.registerStringSetting({
    id: 'github-subdir',
    title: 'Cards subdirectory',
    description:
      'Optional folder inside the repo where flashcard files are stored',
    defaultValue: '',
  });

  await plugin.settings.registerBooleanSetting({
    id: 'auto-push',
    title: 'Enable auto-push',
    description: 'Automatically push local changes to GitHub',
    defaultValue: true,
  });

  await plugin.settings.registerBooleanSetting({
    id: 'auto-pull',
    title: 'Enable auto-pull',
    description: 'Automatically pull updates from GitHub',
    defaultValue: true,
  });

  await plugin.settings.registerStringSetting({
    id: 'conflict-policy',
    title: 'Conflict Resolution Policy',
    description: 'newer | prefer-github | prefer-remnote',
    defaultValue: 'newer',
  });

  await plugin.app.registerCommand({
    id: 'github-sync-pull',
    name: 'GitHub Sync: Pull',
    quickCode: 'github pull',
    action: async () => {
      await pullUpdates(plugin);
      await plugin.app.toast('Pulled updates from GitHub');
    },
  });

  await plugin.app.registerCommand({
    id: 'github-sync-push',
    name: 'GitHub Sync: Push',
    quickCode: 'github push',
    action: async () => {
      await pushAllCards(plugin);
      await plugin.app.toast('Pushed flashcards to GitHub');
    },
  });

  // Register a sidebar widget showing sync status.
  await plugin.app.registerWidget('sync_widget', WidgetLocation.RightSidebar, {
    dimensions: { height: 'auto', width: '100%' },
  });

  await plugin.event.addListener(
    'message.broadcast',
    'sync-now-msg',
    async (payload) => {
      if (payload === 'sync-now') {
        await syncNow(plugin);
      }
    }
  );

  // Listen for Rem changes to detect flashcard edits
  await plugin.event.addListener('RemChanged', 'sync-rem-changed', async ({ remId }) => {
    if (!remId) return;
    const rem = await plugin.rem.findOne(remId);
    if (!rem) return;
    const cards = await rem.getCards();
    const currentIds = cards.map((c) => c._id);
    for (const id of currentIds) {
      await pushCardById(plugin, id);
    }
    const shaMap = await loadShaMap(plugin);
    for (const id of Object.keys(shaMap)) {
      if (shaMap[id].remId === remId && !currentIds.includes(id)) {
        await deleteCardFile(plugin, id);
      }
    }
  });

  // Listen for completed cards in the queue
  await plugin.event.addListener(
    'queue.complete-card',
    'sync-complete-card',
    async (payload) => {
      const cardId = payload?.cardId || (await plugin.queue.getCurrentCard())?._id;
      if (cardId) {
        await pushCardById(plugin, cardId);
      }
    }
  );

  // Listen for queue load events (optional)
  await plugin.event.addListener('queue.load-card', 'sync-load-card', (payload) => {
    console.log('Queue load-card event', payload);
  });

  // Basic timer to demonstrate cleanup
  syncInterval = setInterval(() => {
    console.log('Periodic timer fired');
  }, 60 * 1000);

  retryInterval = setInterval(() => {
    processFailedQueue(plugin);
  }, 5 * 60 * 1000);

  const autoPull = await plugin.settings.getSetting<boolean>('auto-pull');
  if (autoPull) {
    pullInterval = setInterval(() => {
      pullUpdates(plugin);
    }, 5 * 60 * 1000);
    await pullUpdates(plugin);
  }

  // kick off any queued pushes immediately on load
  await processFailedQueue(plugin);
  await setSyncStatus(plugin, 'Synced');
}

async function onDeactivate(plugin: ReactRNPlugin) {
  await plugin.event.removeListener('RemChanged', 'sync-rem-changed');
  await plugin.event.removeListener('queue.complete-card', 'sync-complete-card');
  await plugin.event.removeListener('queue.load-card', 'sync-load-card');
  await plugin.event.removeListener('message.broadcast', 'sync-now-msg');

  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = undefined;
  }

  if (retryInterval) {
    clearInterval(retryInterval);
    retryInterval = undefined;
  }

  if (pullInterval) {
    clearInterval(pullInterval);
    pullInterval = undefined;
  }
}

declareIndexPlugin(onActivate, onDeactivate);
