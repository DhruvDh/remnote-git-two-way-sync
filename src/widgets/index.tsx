import {
  declareIndexPlugin,
  ReactRNPlugin,
  WidgetLocation,
} from '@remnote/plugin-sdk';
import {
  pushCardById,
  deleteCardFile,
  processFailedQueue,
  loadShaMap,
  saveShaMap,
  fileShaMap,
  pullUpdates,
  pushAllCards,
  syncNow,
} from '../github/sync';
import '../style.css';
import '../App.css';

// Timer references for cleanup on deactivation
let syncInterval: ReturnType<typeof setInterval> | undefined;
let retryInterval: ReturnType<typeof setInterval> | undefined;
let pullInterval: ReturnType<typeof setInterval> | undefined;

export async function restartTimers(plugin: ReactRNPlugin) {
  if (retryInterval) {
    clearInterval(retryInterval);
    retryInterval = undefined;
  }
  if (pullInterval) {
    clearInterval(pullInterval);
    pullInterval = undefined;
  }

  const retryMin =
    (await plugin.settings.getSetting<number>('retry-interval')) ?? 5;
  retryInterval = setInterval(() => {
    processFailedQueue(plugin);
  }, retryMin * 60 * 1000);

  const autoPull = await plugin.settings.getSetting<boolean>('auto-pull');
  if (autoPull) {
    const pullMin =
      (await plugin.settings.getSetting<number>('pull-interval')) ?? 5;
    pullInterval = setInterval(() => {
      pullUpdates(plugin);
    }, pullMin * 60 * 1000);
    await pullUpdates(plugin);
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
    id: 'use-slug-filenames',
    title: 'Use slugs in file names',
    description: 'Prefix files with a slug of the question text',
    defaultValue: false,
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

  await plugin.settings.registerNumberSetting({
    id: 'pull-interval',
    title: 'Auto Pull Interval (minutes)',
    description: 'How often to fetch updates from GitHub',
    defaultValue: 5,
  });

  await plugin.settings.registerNumberSetting({
    id: 'retry-interval',
    title: 'Retry Interval (minutes)',
    description: 'How often to retry failed pushes',
    defaultValue: 5,
  });

  await plugin.settings.registerDropdownSetting({
    id: 'scheduler',
    title: 'Scheduler',
    description: 'Select FSRS or SM2 for card metadata',
    options: [
      { key: 'fsrs', label: 'FSRS', value: 'FSRS' },
      { key: 'sm2', label: 'SM2', value: 'SM2' },
    ],
    defaultValue: 'FSRS',
  });

  await plugin.settings.registerStringSetting({
    id: 'conflict-policy',
    title: 'Conflict Resolution Policy',
    description: 'newer | prefer-github | prefer-remnote',
    defaultValue: 'newer',
  });

  await loadShaMap(plugin);

  await plugin.app.registerCommand({
    id: 'github-sync-pull',
    name: 'github-sync pull',
    action: async () => {
      await pullUpdates(plugin);
      await plugin.storage.setLocal('sync-status', 'Synced');
      await plugin.app.toast('Pulled updates from GitHub');
    },
  });

  await plugin.app.registerCommand({
    id: 'github-sync-push',
    name: 'github-sync push',
    action: async () => {
      try {
        await pushAllCards(plugin);
        await plugin.storage.setLocal('sync-status', 'Synced');
        await plugin.app.toast('Pushed local changes to GitHub');
      } catch (err) {
        console.error(err);
        await plugin.storage.setLocal('sync-status', 'Error');
        await plugin.app.toast('Push to GitHub failed');
      }
    },
  });

  await plugin.storage.setLocal('sync-status', 'Synced');

  // Register a sidebar widget showing sync status
  await plugin.app.registerWidget('sync_widget', WidgetLocation.RightSidebar, {
    dimensions: { height: 'auto', width: '100%' },
  });

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
    for (const id of Object.keys(fileShaMap)) {
      if (fileShaMap[id].remId === remId && !currentIds.includes(id)) {
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

  await restartTimers(plugin);

  // kick off any queued pushes immediately on load
  await processFailedQueue(plugin);
}

async function onDeactivate(plugin: ReactRNPlugin) {
  await saveShaMap(plugin);
  await plugin.event.removeListener('RemChanged', 'sync-rem-changed');
  await plugin.event.removeListener('queue.complete-card', 'sync-complete-card');
  await plugin.event.removeListener('queue.load-card', 'sync-load-card');

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
