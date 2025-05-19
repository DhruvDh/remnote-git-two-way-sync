import { declareIndexPlugin, ReactRNPlugin, WidgetLocation } from '@remnote/plugin-sdk';
import '../style.css';
import '../App.css';

// Timer reference for cleanup on deactivation
let syncInterval: ReturnType<typeof setInterval> | undefined;

async function onActivate(plugin: ReactRNPlugin) {
  // Register settings
  await plugin.settings.registerStringSetting({
    id: 'name',
    title: 'What is your Name?',
    defaultValue: 'Bob',
  });

  await plugin.settings.registerBooleanSetting({
    id: 'pizza',
    title: 'Do you like pizza?',
    defaultValue: true,
  });

  await plugin.settings.registerNumberSetting({
    id: 'favorite-number',
    title: 'What is your favorite number?',
    defaultValue: 42,
  });

  // A command that inserts text into the editor if focused.
  await plugin.app.registerCommand({
    id: 'editor-command',
    name: 'Editor Command',
    action: async () => {
      plugin.editor.insertPlainText('Hello World!');
    },
  });

  // Show a toast notification to the user.
  await plugin.app.toast("I'm a toast!");

  // Register a sidebar widget.
  await plugin.app.registerWidget('sample_widget', WidgetLocation.RightSidebar, {
    dimensions: { height: 'auto', width: '100%' },
  });

  // Listen for Rem changes to detect flashcard edits
  await plugin.event.addListener('RemChanged', 'sync-rem-changed', (payload) => {
    console.log('RemChanged event', payload);
  });

  // Listen for completed cards in the queue
  await plugin.event.addListener(
    'queue.complete-card',
    'sync-complete-card',
    (payload) => {
      console.log('Queue complete-card event', payload);
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
}

async function onDeactivate(plugin: ReactRNPlugin) {
  await plugin.event.removeListener('RemChanged', 'sync-rem-changed');
  await plugin.event.removeListener('queue.complete-card', 'sync-complete-card');
  await plugin.event.removeListener('queue.load-card', 'sync-load-card');

  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = undefined;
  }
}

declareIndexPlugin(onActivate, onDeactivate);
