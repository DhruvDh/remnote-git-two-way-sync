# RemNote GitHub Two Way Sync Plugin

This plugin synchronizes your RemNote flashcards with a GitHub repository. Each card is stored as a Markdown file containing its content, tags and scheduling metadata. Updates made inside RemNote are pushed to GitHub and changes in the repository can be pulled back into RemNote.

## Features

- **Automatic push** – card edits, reviews and tag changes in RemNote are committed to GitHub.
- **Automatic pull** – periodically fetches updates from GitHub and applies them to your knowledge base.
- **Markdown format** – cards are saved as Markdown with YAML front‑matter including FSRS fields.
- **Media support** – images in cards are stored under `media/` in the repository and linked from Markdown.
- **Conflict handling** – basic conflict resolution with optional policies and conflict files.
- **Settings** – configure repository, branch, subdirectory and whether auto push/pull is enabled.

## Development Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Start the development server:

   ```bash
   npm run dev
   ```

3. In RemNote open **Settings → Plugins → Build → Develop from localhost** and enter `http://localhost:8080`.
4. Grant the requested permissions. The plugin will reload whenever the source is rebuilt.

To create a production bundle run `npm run build` which outputs `dist/PluginZip.zip`.

## GitHub Configuration

The plugin requires a GitHub Personal Access Token (PAT) with access to the repository where card files will be stored.

1. Visit **GitHub → Settings → Developer settings → Personal access tokens** and generate a token with at least the `repo` scope.
2. In RemNote open **Settings → Plugins → RemNote GitHub Two Way Sync** and enter:
   - **GitHub Personal Access Token** – the token you generated.
   - **Repository (owner/repo)** – e.g. `username/flashcards`.
   - **Branch name** – branch used for sync (default `main`).
   - **Cards subdirectory** – optional folder within the repo for card files.
   - Enable or disable **auto‑push** and **auto‑pull** as desired.

### Security Notes

Your PAT gives write access to the specified repository. Keep it secret and do not share knowledge bases containing this token. Be cautious if syncing to a public repository because your flashcard content and scheduling data will be publicly visible.

## Known Limitations

- Scheduling parameters may not be perfectly merged when both GitHub and RemNote modify the same card. The plugin attempts simple resolution but complex conflicts may require manual edits.
- Deletions from GitHub prompt for confirmation before removing cards locally.
- Large knowledge bases may take time for the initial sync.

## Running Tests

This repository includes automated unit tests run with **Jest**. Execute them with:

```bash
npm test
```

All tests should pass.

## Manual Verification

To verify two-way syncing:

1. Create a new GitHub repository and generate a Personal Access Token with `repo` scope.
2. In a fresh RemNote knowledge base install this plugin and enter the token and repository info in its settings.
3. Make a simple flashcard such as `Planet::Earth` and wait for it to appear in the repository as a Markdown file.
4. Edit the answer text directly on GitHub and commit the change.
5. Trigger **Sync Now** from the plugin sidebar and confirm the update shows in RemNote.
6. Delete the card in RemNote and after syncing confirm the file is removed from GitHub.

