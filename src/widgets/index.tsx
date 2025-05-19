import { declareIndexPlugin, ReactRNPlugin, WidgetLocation } from '@remnote/plugin-sdk';
import '../style.css';
import '../App.css';

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
}

async function onDeactivate(_: ReactRNPlugin) {}

declareIndexPlugin(onActivate, onDeactivate);
