<context>
# RemNote–GitHub Sync Plug-in Implementation Plan

## Architecture Overview

The plug-in will run inside RemNote as a **native plugin** (or sandboxed plugin with elevated scopes) that listens for changes in the user’s Knowledge Base and communicates with GitHub via its REST API. It uses an **event-driven architecture**:

* **RemNote side:** The plug-in hooks into RemNote’s events to detect when flashcards are created, edited (content or metadata), or reviewed in the spaced repetition queue. It uses the RemNote Plugin API to read and write Rem (note) content and card scheduling data.
* **GitHub side:** The plug-in uses a stored GitHub Personal Access Token (PAT) to authenticate and calls GitHub’s REST endpoints to pull and push files. Flashcards are stored as Markdown files in a designated repository (e.g. under a `flashcards/` folder). Each file represents a single flashcard (question & answer pair) including its metadata (tags, scheduling info).
* **Two-way sync:** The system ensures changes propagate in both directions. When a user updates or reviews a card in RemNote, the change is **automatically pushed** to GitHub. Conversely, changes made in the GitHub repo (file edits, additions, or deletions) are **pulled into RemNote** either automatically (polling on an interval) or on-demand via a manual sync trigger (e.g. a sidebar button or slash command).
* **FSRS compatibility:** The plug-in captures all scheduling fields required by RemNote’s FSRS (Free Spaced Repetition Scheduler) algorithm so that syncing does not disrupt the spaced repetition schedule. RemNote’s FSRS uses *difficulty* (analogous to Anki “ease”) and *stability* (analogous to interval length) for each card. The plug-in will record these along with last review time, next due date, and any other relevant scheduling data. This ensures that if scheduling data is restored from GitHub, RemNote’s FSRS (or SM2) algorithm can continue without inconsistency.
* **Data flow:** On RemNote events, the plug-in serializes the flashcard’s data to a Markdown file and invokes GitHub API calls to commit the changes. On GitHub changes, the plug-in parses the Markdown and uses RemNote API calls to create or update the corresponding Rem and its card’s schedule. A **conflict resolution module** handles simultaneous edits (discussed below).

## Data Model Mapping (RemNote ↔️ Markdown)

Each flashcard will be represented as a Markdown document in the GitHub repo, with a human-readable format that preserves all essential data (content and metadata). The mapping is as follows:

* **RemNote Rem and Card structure:** In RemNote, a **flashcard** can be a single Rem with front/back text or a Rem with a child (for Q\&A), and it can generate one or more cards (forward, backward, cloze, etc.). Each *Card* in RemNote has a unique ID and links back to a Rem (the note content). The plug-in will treat each *Card* (each Q–A pair/direction) as a unit of sync. This means if one Rem yields multiple cards (e.g. forward and backward directions, or multiple cloze deletions), each card will get its own entry in the repo.

* **File naming and IDs:** To avoid ambiguity and enable two-way linking, files will be named using unique identifiers. For example, one strategy is to use the RemNote card’s UUID as the filename (or part of it). For instance, `card_9f8e1234.md` might correspond to a card with ID `9f8e1234`. We can optionally prefix the filename with a slug of the question text for readability (e.g. `Why_is_sky_blue_9f8e1234.md`), but the stable ID ensures the file path doesn’t change even if the question text changes. The file will also contain the Rem’s and Card’s IDs in metadata for cross-reference.

* **Markdown frontmatter for metadata:** Each file will start with a YAML frontmatter block delineating metadata like IDs, tags, and scheduling fields. This makes it easy to parse programmatically while keeping content human-readable. For example:

  ```yaml
  ---
  remId: "rem-12345678"              # RemNote Rem ID
  cardId: "card-9f8e1234"            # RemNote Card (flashcard) ID
  tags: ["Physics", "Sky"]          # Tags applied to the Rem
  scheduler: "FSRS"                 # Scheduler type (FSRS or SM2)
  difficulty: 4.1                   # FSRS difficulty rating (analogous to ease)
  stability: 30.5                   # FSRS stability (current interval in days)
  lastReviewed: 2025-05-01T10:00:00Z  # ISO timestamp of last review
  nextDue: 2025-05-31T10:00:00Z       # ISO timestamp of next scheduled review
  # For SM2 cards, we would use ease & interval instead of difficulty & stability
  ease: null                        # (example field if SM2, null if FSRS)
  interval: null                    # (interval in days if SM2)
  ---
  ```

  This frontmatter captures scheduling info needed for sync. For FSRS, we store *difficulty* and *stability* (since FSRS models these instead of a static ease factor). For SM-2 cards, we would store *ease factor* and *current interval*. Additionally, `lastReviewed` and `nextDue` timestamps record when the card was last seen and when it’s next due (these can be derived from RemNote’s card data: `lastRepetitionTime` and `nextRepetitionTime`). Storing these explicitly helps detect scheduling changes.

* **Question and Answer content:** Following the frontmatter, the Markdown body contains the actual flashcard text. We will format it to clearly distinguish the question (front) and answer (back). For example:

  ```markdown
  **Q:** Why is the sky blue?

  **A:** Because molecules in the atmosphere scatter blue light more than other colors, causing the sky to appear blue.
  ```

  This simple **Q:**/**A:** format is easy for humans to read and for the plug-in to parse. The question and answer content will preserve basic **Markdown** formatting: text styling, LaTeX (RemNote’s rich text can be converted to LaTeX between `$…$` or `$$…$$` in Markdown), and image references if any. If the Rem’s content includes embedded media (images, audio) or references, those will be handled as described below:

  * **Images:** The plug-in can handle images by either embedding them as data URIs or, more manageably, by downloading the image and committing it as a file in the repo (and then referencing it in the Markdown). Initially, we may assume flashcards are mostly text; support for images can be an extension (images could be stored in a subfolder like `media/` and linked with Markdown `![](media/image.png)`).
  * **Rem references and LaTeX:** RemNote references (links to other Rem) could be converted to their plaintext or Markdown link form if possible. LaTeX in RemNote is stored as rich text objects; we’ll convert those to LaTeX syntax in the Markdown so that math is preserved.

* **Tags:** Tags in RemNote are just references to other Rem (often in a #TagName form). The plug-in will represent tags as a list of tag names in the YAML frontmatter (`tags: ["Tag1","Tag2"]`). On sync to RemNote, the plug-in will resolve these names: if a tag Rem with that name exists, it will tag the card’s Rem accordingly; if not, it will create a new Rem to serve as that tag (or skip if creation is undesired). In RemNote’s API, tags can be applied by adding a reference – the plug-in can use the Rem API to add a tag reference. (If the Rem API doesn’t have a direct “addTag” method, we can insert the tag name as a reference in the Rem’s text or use the Powerup system to mark tags.)

* **Hierarchies and multi-cards:** If a single Rem had multiple cards (e.g. forward/backward directions, cloze deletions producing multiple Q-A pairs), each card is stored separately. To avoid duplicating content, the Markdown files can all contain the same Q or A text where appropriate, or we can denote the card *type*. For example, we might include a field `cardType: Forward`/`Reverse`/`Cloze1`, etc., or simply let the content speak for itself. Example: a Concept Rem “Sky – Blue color” might produce a forward card (“Why is the sky blue?” -> “Rayleigh scattering causes blue light…”) and a reverse card (“Rayleigh scattering” -> “causes the sky’s blue color”). Both files would have the same `remId` (pointing to the same Rem content) but different `cardId` and perhaps a note in frontmatter or file name about direction. This ensures both directions sync their own scheduling stats.

* **Deletion marking:** If a card is deleted in RemNote, the plug-in will remove the corresponding file in the GitHub repo (we commit a deletion). Conversely, if a Markdown file is deleted from the repo, the plug-in can either delete the Rem/card in RemNote or mark it as “archived.” For safety, it might be desirable to not auto-delete RemNote content without user confirmation. A safer approach is to have a “\_deleted” tag or a special marker in the repo to indicate removals, then the plug-in, on seeing that, could move the Rem to a trash document or add an “Archived” tag in RemNote rather than outright deleting (to prevent unintended data loss).

**Example Markdown Card File:** Here’s a full example putting it all together:

```markdown
---
remId: "rem-abcd1234"
cardId: "card-efgh5678"
tags: ["Astronomy", "LightScattering"]
scheduler: "FSRS"
difficulty: 5.6
stability: 15.2
lastReviewed: 2025-04-10T09:30:00Z
nextDue: 2025-05-10T09:30:00Z
---
**Q:** Why does the sky appear blue during the day?

**A:** The atmosphere scatters shorter wavelength (blue) sunlight more strongly than other colors. This **Rayleigh scattering** causes the sky to look blue.
```

This format is human-readable in GitHub and contains all data needed to reconstruct or update the flashcard in RemNote.

## RemNote Plugin API Usage

To implement the above, we leverage the RemNote Plugin API for reading and writing data. Key aspects of the API usage include:

* **Finding and Reading Rem/Card data:** We will use the `plugin.rem` and `plugin.card` namespaces to access RemNote content. For example, `plugin.card.getAll()` returns all Card objects (with fields like `remId`, `lastRepetitionTime`, `nextRepetitionTime`, etc.), which we can filter to identify cards that changed. Each `Card` object provides methods to get its Rem and type: e.g. `card.getRem()` returns the associated Rem (note) object. The Rem object gives us the text of the flashcard’s front, and if it’s an inline card with a back side, Rem has a `backText` property. If `backText` is undefined, it might be a concept card where the answer is in child Rems – in that case we gather the content of the first child Rem as the answer. The Rem API (e.g. `plugin.rem.findOne(remId)`) allows fetching a Rem’s full content (text, children, etc.).

* **Monitoring changes via events:** We register event listeners in the plugin’s `onActivate` function to respond to relevant events. Some critical events:

  * `RemChanged` – triggers whenever a Rem’s content or metadata changes. We’ll use this to catch edits to flashcard text (question or answer) and also tag changes. For example, if a user edits the wording of a question or adds a tag, the plug-in gets notified. In the callback, we can identify the Rem and check if it corresponds to a flashcard (e.g. by seeing if it has any cards).
  * `QueueCompleteCard` (`"queue.complete-card"`) – triggers when a user completes answering a card in the queue (i.e. they gave a quality response). This is the point at which scheduling data (ease/difficulty, interval/stability, next due date) is updated by RemNote’s scheduler. By listening to this event, we can respond immediately after a review to sync the new scheduling state to GitHub. The event callback might provide the card or we may call `plugin.queue.getCurrentCard()` or query the last reviewed card from `plugin.card` API.
  * We may also use `RemCreated`/`RemRemoved` events if available. The RemNote docs list a global `GlobalRemChanged` event which might fire on creation and deletion as well. If a new Rem is created that has flashcard content, or if a Rem is deleted, we want to sync those as well. Since an explicit `RemCreated` event isn’t shown in docs, we might infer creation from `RemChanged` (a new Rem getting content) or by scanning for new cards periodically.
  * If tag changes aren’t covered by `RemChanged`, we might use `PowerupSlotChanged` if tags are implemented via a power-up (the docs show a `PowerupSlotChanged` event). However, likely `RemChanged` covers adding/removing tags since that might alter the Rem’s relationships.
  * **Plugin Activation/Deactivation:** We will set up listeners in `onActivate` and remove them in `onDeactivate` to avoid memory leaks (especially if running in native mode). For sandboxed mode, removal on deactivate is not strictly required (RemNote handles it) but we will include it for completeness.

* **Creating and Updating Rem content:** When pulling changes from GitHub, the plug-in may need to create new Rems or update existing ones:

  * **Creating a new flashcard in RemNote:** This involves creating a new Rem and setting it up as a Q-A flashcard. For a basic card, we can create a Rem with `plugin.rem.createRem()`, then assign its text to the question and either assign its `backText` for the answer (if we want an inline card in RemNote with `::` separator) or create a child Rem for the answer content. RemNote supports both styles. Using `backText` is convenient for a single-line answer: e.g.

    ```js
    const rem = await plugin.rem.createRem();
    await rem.setText(questionRichText); 
    await rem.setBackText(answerRichText);
    ```

    This would produce a card with the given front/back (effectively creating a Rem with `front::back` in one go). Alternatively, for longer answers or if we want to preserve the structure, we could create the Rem for the question, then use `plugin.rem.createRem({ text: answer, parent: rem._id })` to create the answer as a child of the question Rem.
  * **Updating an existing Rem’s content:** If a markdown change indicates the question text or answer text changed, we find the corresponding Rem via the stored ID and then update its text. The Rem API provides methods like `rem.setText(richText)` or low-level operations to manipulate the rich text content. We will likely use `plugin.richText` helpers to convert plain markdown text back into RemNote’s RichText format (which may include bold/italic, etc.). For example, `plugin.richText.toApiJson(markdownString)` (if such exists) or manually constructing a RichText array.
  * **Updating tags:** If tags differ, we use the Rem API to add or remove tags. Since tags are Rem references, to *add a tag* we can use `plugin.rem.addRemReference(remId, tagRemId)` if available, or use the Search/Powerup API. Another approach: RemNote’s Powerup system could be utilized by treating tags as a property, but simpler is using built-in tag mechanism. The Hannes Frank API wrapper mentions an `addTag` function, indicating it is possible. We might implement by searching for a Rem with the tag name (`plugin.search` by name) and then linking it.

* **Reading and updating scheduling data:** RemNote’s Card objects contain scheduling info. From `Card` class, we have `card.lastRepetitionTime`, `card.nextRepetitionTime`, and even the full repetition history (`card.repetitionHistory` which is an array of past review logs). For FSRS specifically, RemNote likely updates *difficulty* and *stability* internally when a card is reviewed. These might not be exposed as simple properties, but we can infer them:

  * *Stability (interval):* Essentially the current interval, which is `nextRepetitionTime - lastRepetitionTime` (in days). We can compute that or store it explicitly as an integer if needed.
  * *Difficulty (ease):* FSRS difficulty is updated after each review (range \~1-10). RemNote might not store a single “difficulty” field accessible via API, but since FSRS was integrated, they likely store it in the card’s data or can compute from history. If not directly accessible, we can approximate difficulty by analyzing the last review’s `score` and perhaps prior stability. **However**, since our aim is to *preserve* whatever RemNote uses, a simpler approach is to store the *raw repetition history or the latest repetition’s pluginData.* The `RepetitionStatus` interface shows a `pluginData` field which the FSRS plugin used to store difficulty/stability at each review. We will check if `card.repetitionHistory` entries have a difficulty value in pluginData. If yes, we can take the latest values from there to sync. If not, we might run the same FSRS algorithm on the history to derive difficulty/stability (not ideal). At minimum, storing last review time and next due time (and interval) will preserve scheduling in a way that if re-imported, the card can be scheduled appropriately (RemNote can recalc FSRS internal state via its optimizer if needed).
  * *Ease (SM2):* If the user was on SM2 algorithm, each card does have an ease factor. RemNote might not expose it directly either, but it’s likely stored in the card’s repetition history or an attribute. Anki’s algorithm uses ease and interval, so we would similarly capture those.
  * The plug-in will **not** attempt to modify RemNote’s scheduling algorithm itself; it will just sync the parameters. To update scheduling from a Git pull, the plugin has a few options:

    * If a card’s next due date or interval is changed in the Markdown, we can call RemNote’s scheduling API to adjust it. RemNote does not currently have a direct “set interval” API for a card (to maintain algorithm integrity). But we could simulate a review event with a certain score to force a specific outcome. For example, if the external data shows the card was reviewed and now has a much longer interval, we could simulate a review in the plugin by calling `card.updateCardRepetitionStatus(score)` – this applies a review with a given quality (Again, Hard, Good, Easy). However, this always uses the current time. We might manipulate the system by backdating the last review time (possibly by writing to the `history` or using a custom scheduler) – these are advanced steps. In practice, a simpler strategy is:

      * If external scheduling data indicates a *future review* (nextDue) that is different from what RemNote has, we set the RemNote card’s next due to that by scheduling extra reviews or postponing. The RemNote API doesn’t have a direct “set nextTime”, but if the change is that the user reviewed externally, the more correct approach is to **register that review in RemNote**. For example, if external data says the card was reviewed yesterday with rating “Good” leading to a 30-day interval, we can mimic that by calling `updateCardRepetitionStatus(Good)` on the card. This will mark it reviewed now – unfortunately not yesterday – but will update difficulty/stability accordingly. We can then adjust the next due date by telling RemNote we reviewed early/late. RemNote’s FSRS supports custom review times (advance/delay), but it’s unclear if the plugin API allows setting a custom review timestamp. If not, this is an **edge case** where perfect fidelity might not be possible. The plan will note that direct scheduling edits from GitHub should be done with caution.
      * In summary, for scheduling, the plugin will prioritize **reading** and syncing the data (for backup and visibility). Applying scheduling changes from GitHub into RemNote may be limited; likely we will log differences or require an explicit user action to confirm resetting a schedule.

* **Permissions:** The plugin manifest will request broad permissions to access and modify the knowledge base. Specifically, we’ll use `"requiredScopes": [ { "type": "All", "level": "ReadCreateModifyDelete" } ]` so that the plugin can see and edit all Rem in the KB. Full access is needed because flashcards can be anywhere, and we need to create/update Rems. We also likely set `"requestNative": true` in manifest if we need to bypass sandbox restrictions for network calls (if sandbox doesn’t allow fetch to external URLs). However, if RemNote’s sandbox permits standard web requests (which it might, since the plugin runs in the browser context), we might not need native mode. Either way, the plugin’s security scopes will be clearly declared to the user.

* **Plugin settings and storage:** We use the Settings API to store user-specific configurations:

  * **GitHub Token:** The PAT will be stored using `plugin.settings.registerStringSetting` on activation. For example:

    ```ts
    await plugin.settings.registerStringSetting({
      id: "github-token",
      title: "GitHub Personal Access Token",
      description: "Token with repo access to sync flashcards",
      defaultValue: "",
      multiline: false
    });
    ```

    The user can paste their token in the plugin’s settings UI. The token will be retrieved via `plugin.settings.getSetting("github-token")` when needed for API calls.
  * **Repo/branch info:** We might also have settings for the GitHub repository name, owner, branch, and perhaps a subdirectory to store the files. These can be registered as string settings as well (with defaults or required input).
  * **Sync preferences:** A boolean setting could allow the user to toggle “auto-push on change” and “auto-pull periodically” if they want manual control. Another could set the polling interval for checking GitHub.
  * **Local storage:** For caching state like last synced commit or a map of Rem IDs to file SHA, we will use **Synced Storage** or RemNote Rem storage. RemNote encourages storing plugin data in Rem for automatic syncing and diff-merging. One idea is to create a hidden Power-Up Rem (e.g. “GitHub Sync”) and store child Rems that map card IDs to last-synced commit SHA or timestamp. However, this might complicate things. Alternatively, we use `plugin.storage.synced` key-value pairs to store a JSON mapping. For instance, a dictionary of `cardId -> lastSyncedSha`. Synced storage is account-wide and will be available on any device (helpful if the user runs the plugin on multiple devices). This helps with conflict detection – e.g., if a file’s SHA on GitHub differs from what we last synced, we know it changed externally.
  * We also store a global last sync time, etc., if needed.

## GitHub Integration Details

Interaction with GitHub is done via the GitHub REST API using fetch calls from the plugin. We will use the Personal Access Token for authentication on each request (via an HTTP Authorization header). Key integration points:

* **Repository structure:** The user can specify a repository (e.g. `username/remnote-flashcards`) and a branch (default to `main` or a special `remnote` branch). All flashcard Markdown files will live in one folder (e.g. `flashcards/` or `cards/`) for organization. We could also mirror RemNote’s hierarchy (e.g. separate folders per top-level document or tag), but that adds complexity. The initial approach is a flat list or a simple folder for all cards.

* **Creating or updating files (Push):** To push changes to GitHub (e.g. when a flashcard is added or edited in RemNote), we use the **“Create or update file contents”** API endpoint:
  `PUT /repos/:owner/:repo/contents/:path`.
  We will construct the request with the file path and commit info. For example:

  ```ts
  const content = generateMarkdownText(card);          // our function to serialize card to markdown string
  const base64Content = btoa(unescape(encodeURIComponent(content)));  // encode content to Base64
  const path = `flashcards/${cardId}.md`;              // or use a name with slug
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
  const payload = {
    message: `Update card ${cardId}: ${card.frontText.slice(0,50)}`,  // commit message (first 50 chars of Q for readability)
    content: base64Content,
    branch: pluginBranchName
    // sha: include the blob SHA if updating an existing file (we track this in storage)
  };
  await fetch(apiUrl, {
    method: 'PUT',
    headers: { 
      'Authorization': `token ${githubToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  ```

  In this payload, if the file already exists, we must include the current `sha` of the file to update; we retrieve that from our stored mapping (or by a preliminary GET). If `sha` is omitted, GitHub treats it as a new file. The commit message can be something generic or descriptive. We will likely include an identifier or short description.

  When a card is **reviewed**, only scheduling fields change. We still treat it as a file update: we regenerate the Markdown (which now has a new `lastReviewed` and `nextDue` and possibly updated difficulty/stability) and PUT it. These will produce a commit like “Update card due date…”.

  When a new card is **created** in RemNote, the plug-in will generate a new Markdown file and do a PUT (without sha) to create it. Similarly, if a card is **deleted** in RemNote, we call the Delete file API:

  ```ts
  await fetch(apiUrl, {
    method: 'DELETE',
    headers: { 'Authorization': `token ${githubToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: `Delete card ${cardId}`, sha: existingSha })
  });
  ```

  This will create a commit removing the file.

* **Retrieving files (Pull):** To sync changes from GitHub to RemNote, we need to fetch the latest files:

  * We can **list all files** in the repo folder using `GET /repos/:owner/:repo/contents/:path` on the folder path. This returns an array of file metadata (names, SHA, etc.). Alternatively, use the Git Trees API (`GET /repos/:owner/:repo/git/trees/branch?recursive=1`) to get a tree listing of files and their blobs. A simple approach is listing the directory.
  * For each file, if we have a stored last-known SHA, we compare it to the current SHA from GitHub:

    * If the SHA is different, that file changed (or is new if we didn’t have it).
    * If a file that we had tracked is missing from the list, it was deleted.
  * Then for each new/changed file, we fetch its content: `GET /repos/:owner/:repo/contents/flashcards/file.md`. The response will include the file content (base64 encoded) and its SHA. We decode the content and parse the Markdown:

    * We parse the YAML frontmatter to get the `remId`, `cardId`, tags, and scheduling fields.
    * We parse the Q and A from the markdown body (e.g. split by the `**Q:**` and `**A:**` markers).
  * Next, we reconcile with RemNote:

    * If the cardId exists in RemNote (we can check via `plugin.card.findOne(cardId)` or by searching the Rem with that ID), then this is an update to an existing card. We update content or tags if those differ:

      * If question text differs, update the Rem’s text.
      * If answer text differs, update the Rem’s back text or child content.
      * If tags differ, apply or remove tags via Rem API.
      * If scheduling differs (lastReviewed, nextDue, etc.), decide on conflict policy (see **Sync Logic & Conflict Resolution** below).
    * If the cardId does **not** exist in RemNote (meaning this is a new card created on GitHub side), we create a new Rem and card as described earlier. We might use the provided `remId` if it was also exported (this would be the original Rem’s ID if the card came from an export). Using the same Rem ID is not possible because RemNote cannot arbitrarily set a Rem’s ID (IDs are generated). So we actually ignore `remId` for creation; instead, create a new Rem with the given content. We might store a mapping from the old ID to new ID if needed, but since GitHub is now the source, we treat it as a new card entirely. (If the intention was to transfer a knowledge base between accounts, they’d likely start with an empty RemNote KB and import all from GitHub).

      * After creating the Rem and setting its Q & A, we should also propagate the scheduling state. For a new card, possibly it has never been reviewed (ease/difficulty default, etc.). But if the GitHub file includes scheduling (maybe the user wrote a schedule or it’s a re-import of an export), we attempt to apply it. For example, if `lastReviewed` and `nextDue` are set in the past and future respectively, we might mark the card as reviewed immediately with an appropriate score to approximate that interval. If that’s too complex, an alternative is to use RemNote’s **custom scheduler API** to directly set the interval. RemNote has a scheduler override interface (used for FSRS plugin before integration). As a last resort, we could instruct the user that after import they might need to manually adjust or just accept the schedule as is.
      * We also tag the new Rem if tags are present, and if the file provided a specific scheduler algorithm different from global, we might assign the custom scheduler (though in most cases it will be using the user’s global FSRS or SM2 as configured).
  * If a file was **deleted** on GitHub, as mentioned, we can either delete the corresponding Rem/card or flag it. Since the question expects full two-way sync, we should indeed handle deletion. The plug-in can find the Rem by cardId and then remove it via `plugin.rem.remove(remId)` (and maybe its children). We should be careful to not accidentally delete if the user didn’t intend it. A safeguard could be to move it to a “Trash” document in RemNote rather than permanent deletion, or prompt the user via a notification that “Card X was removed on GitHub – click to confirm deletion in RemNote.”
  * **GitHub rate limits & efficiency:** We have to be mindful of API rate limits (typically 5,000 requests/hour for authenticated calls). If the user has thousands of cards and we sync each one individually, we should batch where possible:

    * Use the directory listing to avoid fetching every file’s content unless changed.
    * Possibly use GraphQL or a single API call to fetch multiple files at once (not straightforward in REST, but GraphQL could query multiple files by path).
    * We can also implement a **batch push**: for example, if a user makes 20 edits in RemNote in quick succession (or reviews 50 cards in a session), instead of 50 separate GitHub commits, we could accumulate them and push in one go (e.g. aggregate changes for a minute). However, initial implementation can be one commit per event, which is simpler and still within reasonable limits for typical usage (each commit is just a few KB of data).
    * The plug-in will include minimal waiting/retry logic for API calls. If a request fails (network down or GitHub API error), we should catch it. Perhaps queue the change and retry after some time or when the user clicks “Sync now.” All unsynced changes could be kept in memory or storage and flushed later, to prevent data loss if offline.

* **Conflict detection and resolution:** This is crucial for two-way sync. A **conflict** arises if the same flashcard is modified in both RemNote and GitHub between syncs:

  * We will use timestamps and version IDs to detect this. For example, when pushing a change to GitHub, we include the file’s last known SHA. If GitHub rejects the commit due to a SHA mismatch, it means the file was updated by someone else in the meantime (i.e., conflict). Similarly, when pulling, if RemNote’s last update time for a Rem is more recent than the file’s last commit time and the file also changed after the last sync, that signals a conflict.
  * **Resolution strategy:** The plan is to prefer **manual resolution** with safe defaults. We do not want to silently overwrite potentially important data:

    * The plug-in could create a **conflict file** or log. For example, if a conflict is detected for `card-efgh5678`, we might create `card-efgh5678-conflict.md` in the repo or simply not auto-merge and instead notify the user: “Sync conflict on card ‘Why is the sky blue?’ – it was modified both locally and remotely. Please resolve manually.” Manual resolution may involve the user choosing which version to keep or merging the question/answer text by hand.
    * Alternatively, implement a simple rule: e.g. “Last edit wins.” We could compare the Rem’s last updated timestamp with the file’s last commit timestamp – whichever is more recent will overwrite the other. For instance, if the user edited a card in RemNote after the last Git commit, and someone also edited the file on GitHub later, the later change wins by default (either we overwrite RemNote or Git accordingly). This is a less safe approach but automated. We might make this behavior configurable (e.g. a setting: “On conflict, prefer GitHub version” vs “prefer RemNote version”).
    * Tag data and scheduling data conflicts might be easier to merge (we could combine tag sets, or choose the union, since adding a tag in one place and another tag in the other place can both apply). For scheduling, you generally wouldn’t want to merge values – one side’s schedule will prevail.
    * Because RemNote flashcards are usually single-user, conflicts might be rare (likely the user is primarily editing in one place at a time). But if the user does have collaborators editing the GitHub repo or they themselves edit the repo while also editing in RemNote without syncing, this scenario can happen.
    * We will implement at least logging: if a conflict is detected, we store the two versions. Possibly, store the GitHub version as a different Rem note (or as text in a special “Conflicts” document) so the user can see what changed and copy over if needed.
  * The plug-in’s use of RemNote Rem storage could assist: since *RemNote itself merges changes across devices*, if the user had two RemNote instances, RemNote’s sync engine would merge at the Rem level. But GitHub introduces an external source. We therefore handle it as above.

* **GitHub Authentication & Security:**

  * The PAT should have **repo access** scope. If the repo is public, a `public_repo` scope token is enough. If private, `repo` scope is needed. We instruct the user to generate a token with minimal scopes.
  * The token is stored in RemNote’s plugin settings, which are synced across devices but **not encrypted** (RemNote likely treats them as user data – only the user and RemNote’s servers see them; however, caution is advised). We will warn users **not to share their knowledge base if it contains the PAT**. Alternatively, the user can use a less sensitive token (perhaps limited to only that repo).
  * We ensure to **never log the PAT** or include it in error messages. We also won’t hardcode it anywhere; it’s only read from settings at runtime.
  * If the plugin runs sandboxed, it cannot access browser cookies or other sensitive data, and it can only communicate via allowed APIs. We rely solely on the user-provided token for GitHub. Communication with GitHub is over HTTPS.
  * Rate limiting: if hitting GitHub’s limit, we catch error 403 responses. The plugin can then back off. For example, if too many review syncs cause near-limit, we might switch to batch mode or ask the user to slow down sync frequency.
  * We will implement exponential backoff for failed network requests and possibly show a warning in the RemNote UI (maybe using `plugin.window.showToast("GitHub sync failed, will retry in 1 minute", "error")` if such UI API exists).

## Sync Logic & Operations

This section describes how the sync happens in both directions in detail, including pseudo-code for clarity:

### Outgoing Sync (RemNote → GitHub)

We want immediate or near-immediate push of changes to GitHub to keep the repo up-to-date. The plug-in will use the RemNote event system to achieve this:

1. **Flashcard content added or edited in RemNote:**

   * Listen for `RemChanged` events. When triggered, check if the changed Rem has any cards. We can call `plugin.card.getAll()` and filter by `card.remId == changedRemId` to see if a flashcard exists for that Rem. Alternatively, use `plugin.rem.getCards(remId)` if such helper exists.
   * Also, detect if this change introduced a new card. For example, the user might have just typed `::` to create a front/back card, or added an **Answer** child Rem under a **Question** Rem. Such an event could be just a content change on the Rem or addition of a child Rem. We might need to catch child addition events – possibly also covered by `RemChanged` or a separate event when a Rem’s children change. If needed, we could use a tracker: e.g. `useTracker(() => plugin.card.getAll().length)` to detect new card count changes, but an event is simpler.
   * **Action:** For each affected card, serialize it to Markdown (frontmatter + Q/A text) as described. Then call the GitHub API to create/update the file. We include the latest known SHA to avoid overwriting newer changes on GitHub.
   * **Example:** User edits the Q text of “Sky color” card in RemNote. `RemChanged` fires with that Rem’s ID. We find its card (say card-efgh5678). We generate the updated markdown (question changed) and see the file `card-efgh5678.md` exists on GitHub. We PUT the new content with the old SHA. GitHub will respond 200 OK with new SHA if success. We update our stored SHA mapping for that card.
   * If the user just created a card (new Rem), we create a new file on GitHub. We might not have an existing SHA; we PUT without one. We then store the returned SHA.
   * Push commits will typically be very quick (sub-second). We will perform them asynchronously so as not to block the UI. If a push fails, we catch it and possibly schedule a retry.

2. **Flashcard reviewed in RemNote (scheduling change):**

   * Use the `QueueCompleteCard` event to catch when a review is finished. The event likely indicates which card or at least that *some* card was completed. We’ll need to identify the card:

     * Possibly the event callback could provide the card ID or Rem ID. If not, we might call `plugin.queue.getCurrentCard()` but at the moment of completion, the “current card” might have moved to the next. Another approach: listen to `QueueLoadCard` (next card) and keep track of the *previous* card.
     * Simpler: each time a card is completed, we know *some* scheduling changed. We could mark all due cards as potentially changed, but that’s inefficient. Instead, we maintain a reference to the last card in the queue:

       * Listen `QueueLoadCard` (a new card is loaded in the queue for review) and store it as `currentCardId`.
       * Listen `QueueCompleteCard` – when it fires, the `currentCardId` we saved is the one just reviewed. Then we can proceed to sync it.
       * After syncing, when `QueueLoadCard` fires next, update `currentCardId`.
       * If `QueueExit` fires (queue finished), we know a session ended.
     * Once we identify the reviewed card, retrieve its updated scheduling data: e.g.

       ```js
       const card = await plugin.card.findOne(cardId);
       const newDue = card.nextRepetitionTime;
       const lastRev = card.lastRepetitionTime;
       ```

       Possibly also the card’s updated `repetitionHistory` for difficulty.
     * We then regenerate that card’s markdown frontmatter fields (update lastReviewed, nextDue, stability/difficulty if changed). The Q/A content likely unchanged by a review, so we can reuse or store it.
     * Commit this to GitHub via PUT as above.
   * **Edge case:** If the user reviews many cards in a short time (like going through 100 flashcards), the plugin will fire 100 rapid GitHub PUTs. This could be spammy on commit history and possibly hit rate limits. We might implement a batching: e.g. collect reviewed cards in an array and, every X minutes or on queue exit, push them all. However, pushing each individually with a commit message “Review card X” could be acceptable and provides a detailed history. We will gauge performance; the GitHub API can handle a few hundred requests per hour easily, and 100 small commits is not typically a problem (just not very clean history).
   * Also note, if **ease (SM2) or difficulty (FSRS)** changes on review, those are updated in the frontmatter on push. FSRS difficulty might only change when the user presses a certain rating (the algorithm changes difficulty on Hard/Again/Easy answers). We will fetch the new difficulty from pluginData if possible. If not, we might skip writing difficulty explicitly (since it can be derived from history).

3. **Other changes:**

   * **Tag changes:** When the user adds or removes a tag on a Rem, RemNote fires `RemChanged` (likely, because the Rem’s properties changed). We will detect that by comparing the Rem’s current tag set to what we have in the last synced frontmatter. We can maintain a cache of a card’s last synced tags (from our mapping or by quickly parsing the last known markdown which we can keep in memory). If a tag was added, we commit an update with new `tags` list in frontmatter. If removed, likewise.
   * **Card deletion:** If a Rem (with flashcard) is deleted in RemNote, how do we catch it? Possibly via `RemChanged` on its parent or a global event. RemNote might not explicitly inform plugin of a deletion via the current API (this is a known limitation in some earlier API versions). We may need to handle deletion in a less direct way:

     * We could use periodic scanning: e.g. every sync cycle, check our list of tracked card IDs vs `plugin.card.getAll()` output. If a card we tracked is no longer present in RemNote, it means it was deleted or its card status removed. We then issue a GitHub DELETE for that file.
     * The frequency of this scan can be maybe once every few minutes or on plugin startup.
     * Additionally, if a user converts a flashcard back to regular text (RemNote allows turning a card off), that might “delete” the card while keeping the Rem. We’d detect that because `plugin.card.getAll()` would no longer include it. In that case, we should delete the file too (since it’s no longer a flashcard to sync).
   * **Manual push:** The plugin might also offer a manual “Push All” command to force-upload all current RemNote flashcards to GitHub (useful if user wants to backup at a point in time). This would iterate through all cards and commit each (or batch commit). However, doing that in one commit might be nicer (but GitHub API for multi-file commit requires either multiple requests or using the Git Data API to create a tree and commit – more advanced). Initially, one-by-one commits are fine.

### Incoming Sync (GitHub → RemNote)

Incoming sync can be done on demand (e.g. user clicks a “Pull from GitHub” button or triggers a slash command like `/github-sync pull`), and/or periodically (say every N minutes check for updates). The implementation:

1. **Check for repository updates:** We keep track of the last known commit ID of the repository (could store the HEAD commit SHA after each push/pull). We can compare that with the current HEAD SHA to decide if anything changed. A quick way: call GitHub API for the branch’s latest commit (e.g. `GET /repos/:owner/:repo/commits/:branch` – returns latest commit SHA and date). If it’s unchanged since last pull, skip. If changed, we proceed to fetch file diffs.

   * If we want to be granular, we could fetch commit(s) since last sync and see which files changed from commit data. The commit API can list modified files. This is efficient:

     * e.g. `GET /repos/:owner/:repo/commits?sha=branch&since=<lastSyncTime>` could list commits. Or `GET /repos/:owner/:repo/compare/oldSha...newSha` lists all diff files.
   * A simpler approach: just re-list all files and compare SHAs as described earlier (suitable if not too many cards).
   * For initial implementation, assume moderate number of cards (<1000) and do a directory listing.
2. **Fetch and parse changed files:** For each changed or new file, do a GET to retrieve content (one file at a time):

   * Use the GitHub contents API which responds with JSON containing `content` (base64) and `sha`.
   * Decode content to a string. Use a Markdown/YAML parser (if available in JS environment – could include a small library like js-yaml for frontmatter, or do manual parsing since the format is known).
   * Example pseudo-code:

     ```js
     const res = await fetch(apiUrl);
     const data = await res.json();
     const fileContent = atob(data.content);
     const { frontmatter, body } = parseMarkdown(fileContent);
     // frontmatter is an object from YAML, body is the markdown text
     ```

   * The frontmatter gives us `cardId` and possibly `remId`. We use `cardId` as primary key.
3. **Apply changes to RemNote:**

   * **If card exists in RemNote:** (we can check by `await plugin.card.findOne(cardId)`)

     * If found, we get its Rem via `card.getRem()`. Now we compare each aspect:

       * **Question text:** Extracted from the Markdown body’s **Q:** line. Compare with the Rem’s current text. If different, update the Rem’s text via `rem.setText(newTextRich)`. We should convert the markdown text to RemNote rich text format. A simple conversion for plain text is fine (just wrap as one text element). If the markdown includes formatting like **bold** or *italic* or `code`, we might attempt to parse those and use `plugin.richText` builder to format appropriately (this could be elaborate; in first version we might just strip formatting or only handle a subset).
       * **Answer text:** Extract from **A:** section. If the Rem uses `backText` (i.e. it was an inline card), we do `rem.setBackText(newAnswerRich)`. If it uses a child for answer (common in concept cards), we find or create the first child and set its text. (We may detect which method by whether `rem.backText` was previously set).
       * **Tags:** Parse `tags` array from YAML. Retrieve current tags on the Rem. We might get tags via `rem.getTags()` if exists, or by searching for references where this Rem is the source. RemNote doesn’t have a direct getTags in the API docs I’ve seen, but one can search for all Rem referencing this Rem as a tag. Alternatively, maintain a mapping of tag names on our side from last sync:

         * If a tag in the markdown is not present on the Rem, we add it: find or create a Tag Rem by name and do `targetRem.tagWith(tagRemId)`.
         * If a tag is present on the Rem but not in markdown, remove it: remove that reference.
       * **Scheduling:** Compare the scheduling fields. This is tricky because RemNote’s actual scheduling state may differ if reviews happened. Potential scenarios:

         * If the GitHub version has a later `lastReviewed` date than RemNote knows, it implies an external review was logged. We might then *replay* that review in RemNote. For example, say RemNote shows last reviewed on Apr 1, but GitHub says Apr 5 with nextDue Apr 30. That suggests the user (or collaborator) reviewed externally on Apr 5. To reconcile, we could:

           * Option A: simply update the card’s due date in RemNote. But direct setting isn’t provided.
           * Option B: simulate a review: If we assume they marked it “Good”, we call `card.updateCardRepetitionStatus(QueueInteractionScore.Good)`. This will mark it reviewed now (let’s say today Apr 10) which is slightly off (the actual external review was Apr 5). The intervals might not match exactly, but FSRS might give a similar next interval. We then might manually adjust nextDue back to Apr 30 if possible by delaying it. There’s an API `doesntRequireInternetActiveNextTime` in CardData – unclear usage, but possibly related to scheduling reviews offline. We likely cannot set the last reviewed time directly for consistency.
           * Option C: if accuracy is paramount, we could warn the user or allow a “override scheduling” option, where we forcibly set the card’s scheduler parameters via the custom scheduler interface. But that would be complex (RemNote’s scheduler integration might not support direct param injection yet).
         * If the GitHub version has an *earlier* next due than RemNote (meaning someone made the card due sooner externally), we could handle that similarly – effectively the card needs to be reviewed sooner. We could potentially mark it as “due now” by adjusting or by scheduling a review.
         * If only ease/difficulty changed externally (unlikely to change in isolation), we might ignore it or log it.
         * In all cases, **we prefer not to automatically overwrite RemNote’s scheduling** unless we’re confident. One strategy is to adopt a **pull conflict policy for scheduling**: for example, default to whichever side has the most recent review (we assume that side is source-of-truth). So if external review is newer, we incorporate it and perhaps **mark the RemNote card as “manually scheduled”** to that next due date. RemNote has a “set custom interval” feature for cards (like a manual bury or postpone). If the plugin API has a way to set `nextTime`, we’d use it here (not documented, but maybe via the FSRS custom scheduler hooking).
         * We will document that scheduling conflicts might not be perfectly merged and may require user attention.
       * After applying content, tags, and possibly scheduling adjustments, the Rem in RemNote is now updated to reflect the GitHub version. We then update our local mapping (like update last synced commit for that file).
     * If the content in GitHub is identical to RemNote (no differences), do nothing. (This check prevents needless writes.)

   * **If card does NOT exist in RemNote:** This means a new flashcard was added in the repo:

     * We create a new Rem as described earlier. For the question text we use the Q content, for the answer text we use A content (child or back text).
     * Apply tags from YAML.
     * Now, scheduling: If the YAML shows that the card was already reviewed (lastReviewed is set, etc.), the user might be importing an existing deck with schedule. We have two options:

       * **Cold import:** Simply create the card as “new” (no history) and let it start fresh in RemNote’s scheduler. This is safer and simpler, but loses the review history (ease/difficulty).
       * **Attempt to apply schedule:** We could artificially set the card’s interval. For example, if `nextDue` is in 20 days and difficulty is X, we could create the card and then immediately call `updateCardRepetitionStatus(Easy/Good)` multiple times to stretch its interval. This is hacky. Another possibility is to use the **RemNote Custom Scheduler API**. The plugin can register a temporary custom scheduler that simply returns the desired interval as the next due. RemNote’s `plugin.scheduler.registerCustomScheduler(name, params)` can define algorithms, but to force a one-time schedule might not be straightforward.
       * As a middle ground, we could set the card’s creation date in the past to influence scheduler – not sure if possible.
       * Given the complexity, we might decide that imported cards will start as new unless user explicitly requests preserving schedule. We can at least set the card’s ease/difficulty so that subsequent scheduling will use that. For FSRS, if we know a difficulty value (say 5.6), we could attach it via the FSRS plugin’s method. Actually, since FSRS is integrated, difficulty might be stored internally. Possibly we can call an internal API to set difficulty: If FSRS was a plugin, it stored difficulty in `pluginData`. In integrated FSRS, maybe not exposed.
       * We might cheat: the FSRS integration might still accept `pluginData` on RepetitionStatus. If we manually insert a `RepetitionStatus` entry with a past date and a given score, we could effectively inject history – but the plugin API likely doesn’t allow directly manipulating the history array.
       * So, the approach: **Inform the user**. We could create the card and then show a message: “Card X imported with an existing schedule (due in 20 days). Please mark it as studied in RemNote to align scheduling.” Or possibly set a custom property on the Rem with the imported due date for reference.
     * In any case, the card is now in RemNote. Next, we should push it to GitHub? Actually, since it came from GitHub, we don’t push immediately (that would just re-commit the same file with maybe different ID if RemNote gave a different ID, but we used GitHub’s cardId, so it’s consistent).
     * We do update any internal mapping that this cardId is now present and link it to the new Rem’s ID.

   * **If a file was deleted on GitHub:** If the card still exists in RemNote, it means someone removed it from the repo intentionally. We then handle as mentioned:

     * Possibly prompt the user: e.g. show a confirmation toast: “Card ‘Sky blue’ was removed on GitHub. Click to delete it here or ignore to keep.”
     * If auto-delete is enabled, we proceed to remove it: use `plugin.rem.findOne(remId)` and then `plugin.rem.remove(remId)` to delete the Rem (and its subtree).
     * We should also remove any references in our mapping and maybe add a note in a log. We commit a deletion on GitHub was already done, so nothing to do on repo side.
     * If the Rem is already gone in RemNote (maybe user deleted but sync hadn’t removed file yet), then both sides deleted – no action needed except cleaning mapping.
4. **Pull scheduling conflict resolution:** Suppose a user reviews a card in RemNote and *also* the schedule was modified on GitHub (perhaps by another collaborator). This is a conflict scenario. Our conflict policy should catch that as described:

   * If RemNote has a later `lastReviewed` than the Git file (meaning user studied in RemNote after Git’s data), then the RemNote data is “ahead.” We might then ignore the older Git scheduling info (or treat it as stale).
   * Conversely, if the Git file shows a review that RemNote hasn’t seen, we consider whether RemNote’s local data has changed. If not (no local review done), we can import the Git schedule. If yes (both have diverged), it’s a true conflict – ideally ask user.
   * In absence of a UI for asking (RemNote plugins are somewhat limited in modal dialogs), perhaps log it. We could add a custom **“Conflict” power-up** on the Rem indicating the conflict, with details in its content, so the user can see it in RemNote and manually resolve by editing either side.
   * Content conflicts (question/answer text changed both places) we handle similarly: Mark and do not overwrite without user action.
5. **Periodic pull:** If auto-pull is on, we might do the above on an interval. We will ensure not to interfere if the user is in the middle of typing a note (we might delay if RemNote is being actively used to avoid sudden changes under the user’s cursor). Ideally, pulling could run when RemNote is idle or just at a set time daily. Manual pull is simpler for now.

## Edge Cases and Considerations

* **Multi-device concurrency:** If the user runs RemNote (with the plugin) on two devices concurrently, both might attempt to sync to the same GitHub repo. This could cause race conditions. To mitigate:

  * Synced plugin settings/storage means both have the same token and mapping. If both are online, a change on Device A will push to GitHub and then Device B’s plugin (if auto-pull is on) will get it shortly. That’s fine. But if the user is actively editing on both without internet, then later both connect, conflicts will occur similar to above.
  * We rely on RemNote’s own sync for multi-device *RemNote* conflicts (RemNote merges Rem changes reasonably). The GitHub layer adds complexity. Possibly advise using one device at a time for editing or ensure frequent syncs.
  * We could implement a locking mechanism: e.g. using a specific file on GitHub as a lock or using GitHub Issues API to signal a lock. This seems overkill; likely not needed if user is sole editor.

* **Cloze deletion cards:** RemNote supports cloze deletion (text like `[[...]]` that generates multiple cards). The plugin should handle these as multiple `Card` objects linking to the same Rem. Our current plan can accommodate it since we treat each card separately. The markdown for each cloze card would be similar, possibly with an indication of which cloze (maybe include in question text “\[...]-1” etc.). There might be a risk of duplicate file content; using cardId as filename solves conflicts. If the user edits the base Rem text with cloze, it affects all cloze cards’ content. Our event handler on RemChanged would then trigger updates for all associated card files. That means the same Q text (with a different blank) gets updated in multiple files. This duplication is unfortunate but necessary to keep each card file standalone. We could consider one file per Rem (with multiple Q-A pairs inside), but that complicates mapping and two-way editing (harder to edit just one card via file). So we stick to one file per card.

* **Hierarchical decks or context:** The plugin does not explicitly preserve which document or folder a Rem was in, except via tags if the user uses tags for categories. All cards go to GitHub in one flat structure. This means the “deck” organization is partially lost in the repo, unless tags or filenames encode it. If needed, we could treat top-level document names as categories and prefix file names or place files in folders named after the document. That could be a future enhancement (and would require mapping doc hierarchy to folder structure).

* **Large knowledge bases:** If the user has thousands of cards, initial sync will produce thousands of files and commits. We should optimize by using a single initial commit if possible. Perhaps the plugin can detect an empty repo and do a bulk export. Bulk export approach:

  * Generate all markdown files locally (in memory or in a zip) and then either push via Git (requires client-side git library or asking user to clone manually). GitHub API doesn’t support multi-file create in one request except through Git data API (we could create blobs for each and then create a tree and commit – doable but complex).
  * Alternatively, for first sync, do it sequentially but it might be slow (but one-time).
  * We can gradually refine performance as needed.

* **Rate limiting/backpressure:** Already discussed, ensure not to flood GitHub. The plugin might implement minimal delays between calls if a rapid burst is detected. e.g., after 20 commits in a minute, pause for a few seconds.

* **Error handling:** All network operations will be wrapped in try/catch. On error, show a non-intrusive indicator (like a red icon in the sidebar or a console log if available to user).

  * Possibly integrate with RemNote’s UI: We could register a sidebar widget or status bar widget that shows “✅ Synced” or “⚠️ Error” with tooltip details. The plugin API allows adding a sidebar button with an icon. We can use this for manual sync (“Sync Now” button) and color it based on sync status.
  * For critical failures (like invalid token or 401 Unauthorized), notify the user to check their token in settings.

* **Security & Privacy:** Emphasize to user that their flashcard content (and schedule) will be stored in GitHub. If it’s a private repo, fine; if public, be mindful that any sensitive notes are exposed. The plugin will not push anything the user didn’t explicitly put into a flashcard. The PAT is stored locally (and on RemNote’s servers as part of settings sync). If the user logs out or uses a different account, the token should be re-entered (since settings are per KB).

* **RemNote updates compatibility:** As RemNote updates its API or scheduling, we should ensure the plugin remains compatible. For instance, if RemNote changes how FSRS parameters are stored, we might need to adjust which fields to sync. The plan uses what’s currently known: difficulty \~ ease, stability \~ interval.

* **Testing for edge cases:** We should test scenarios:

  * Create a card in RemNote, edit in GitHub, sync.
  * Edit concurrently (simulate by editing file without pulling first).
  * Add tags in GitHub that don’t exist in RemNote.
  * Delete a tag or card in one side and see effect.
  * Switch scheduler algorithm (ensure that if user switches from FSRS to SM2, the plugin now should handle ease/interval instead of difficulty/stability).
  * Ensure that content with special characters (quotes, newlines) is properly escaped in YAML or markdown.
  * Use of multiline answers: ensure our Q/A parsing splits correctly (maybe the answer can have multiple paragraphs – our parser should capture everything after `**A:**` as answer text).

* **Logging and debugging:** For development, we’ll use `console.log` for events to verify triggers (RemNote plugin environment provides a dev console accessible via browser if using RemNote web or developer tools in desktop app). Once stable, consider removing or gating logs.

## Developer Setup and Testing

This section outlines how a developer (or technically inclined user) can build, install, and test the plugin locally using the RemNote Plugin API.

1. **Project Initialization:** Use the official RemNote plugin template to start. The RemNote team provides a template repository. You can create a new GitHub repository from this template or use the `remnote-plugin-template`. For example, navigate to the template repo and click “Use this template”, then clone it locally. The project is a Node.js setup with TypeScript and webpack configured for the RemNote environment.

2. **Project Structure:** Familiarize yourself with the template’s structure:

   * `public/manifest.json`: Metadata about the plugin (name, id, description, required permissions, etc.). Update this:

     * Give your plugin a unique `"id"` (reverse domain style, e.g. `"com.yourname.remnote.githubsync"`).
     * Name and description as desired.
     * Most importantly, set the `"requiredScopes"` to allow access to Rems. For full functionality, include:

       ```json
       "requiredScopes": [
         { "type": "All", "level": "ReadCreateModifyDelete" }
       ],
       "requestNative": true
       ```

       This requests permission to read/write all Rem. During plugin installation, RemNote will ask the user to grant these scopes. (If you prefer a sandbox approach without `requestNative`, you can omit it; the plugin should still work for the most part if external fetches are allowed. If fetch is disallowed in sandbox, `requestNative` is needed.)
   * `src/`: Contains the TypeScript source. The `widgets/index.tsx` is the entrypoint (the “index widget”).
   * In `index.tsx`, you’ll have something like `declareIndexPlugin(onActivate, onDeactivate);` at the bottom, and the two lifecycle functions defined. This is where you’ll implement most logic (since our plugin is primarily background and doesn’t necessarily need multiple UI widgets, we can do a lot in onActivate).
   * You can also create UI components if needed (for settings UI beyond the default Settings page, or a status widget).

3. **Implementing onActivate:**

   * Within `async function onActivate(plugin: ReactRNPlugin)`, perform setup:

     * Register settings for the PAT and repo info:

       ```ts
       await plugin.settings.registerStringSetting({
         id: "github-token",
         title: "GitHub Personal Access Token",
         description: "Create a token with repo scope and paste it here.",
         defaultValue: ""
       });
       await plugin.settings.registerStringSetting({
         id: "github-repo",
         title: "GitHub Repository (owner/name)",
         description: "Format: username/repo. Must have write access.",
         defaultValue: ""
       });
       await plugin.settings.registerStringSetting({
         id: "github-branch",
         title: "GitHub Branch",
         defaultValue: "main"
       });
       // Possibly other settings for sync options...
       ```

     * Use `plugin.event.addListener` to subscribe to events:

       ```ts
       await plugin.event.addListener("RemChanged", "github-sync-rem", async ({ remId }) => {
           // callback logic for when a Rem changes
       });
       await plugin.event.addListener("queue.complete-card", "github-sync-queue", async () => {
           // callback logic for when a card is reviewed
       });
       // Possibly listeners for QueueLoadCard, QueueExit if needed, and maybe Storage change if multiple devices.
       ```

       (The exact signature of the callbacks depends on RemNote’s implementation; some events might pass an object with details. We’ll consult RemNote plugin docs or test to see what `RemChanged` supplies – likely it provides the changed Rem’s id.)
       We also add a listener for plugin settings change if we want to react to token input (RemNote triggers a `SettingChanged` event when a setting is modified). This could be useful to automatically attempt connecting once the token is entered.
     * If we want a manual sync control, we can register a **sidebar button** or a **slash command**:

       * Sidebar Button:

         ```ts
         await plugin.app.registerSidebarButton({
           id: "github-sync-button",
           name: "Sync with GitHub",
           onClick: async () => { await performFullSync(plugin); }
         });
         ```

         This puts a button in RemNote’s sidebar (probably under Plugins section) that the user can click to trigger a sync.
       * Slash Command:

         ```ts
         await plugin.app.registerCommand({
           id: "github-pull",
           name: "GitHub Sync Pull",
           action: async () => { await pullFromGitHub(plugin); }
         });
         ```

         Then the user can press `/github sync pull` in the Omnibar.
       * We could also register a periodic timer. There’s no direct API for background intervals, but we can use `setInterval` in our code since it runs in an environment akin to a webpage. For example:

         ```ts
         setInterval(() => { performPullCheck(plugin); }, 5 * 60 * 1000);
         ```

         to check every 5 minutes. (We’ll ensure to clear it on deactivate).
     * Initialize any in-memory structures: e.g. a cache for card SHA mapping. We might load an existing mapping from `plugin.storage.synced` if we stored it in a previous session.
     * Possibly perform an initial sync: e.g. on plugin load, either automatically pull latest (to update any changes that happened while plugin was off) and/or push any unsynced local changes. We must be cautious doing heavy sync on startup as it might slow RemNote; maybe do it after a short delay or only on user action initially.
   * Implement the `onDeactivate` to clean up:

     ```ts
     async function onDeactivate(plugin: ReactRNPlugin) {
       await plugin.event.removeListener("RemChanged", "github-sync-rem");
       await plugin.event.removeListener("queue.complete-card", "github-sync-queue");
       // clear intervals if any (clearInterval storedIntervalId)
     }
     ```

     This avoids duplicate listeners if the plugin reloads.

4. **Testing locally:**

   * Install dependencies with `npm install`.
   * Start the development server with `npm run dev`. This will compile the plugin and serve it at `http://localhost:8080` by default.
   * Open RemNote (web or desktop). Go to Settings → Plugins → **Build** tab. Use the **“Develop from localhost”** feature: input `http://localhost:8080` and click Connect. RemNote will load your plugin from the local server. You should see a notification that the plugin is installed.
   * Grant the requested permissions (RemNote should prompt that the plugin wants access to all Rem – approve it).
   * Once running, open the RemNote **Plugins** settings page and find your plugin. You should see the settings (the fields for GitHub token, repo, etc., as we registered). Try entering your token and repo info.
   * Open the developer console (in a web app, using browser dev tools; in desktop, there is usually an option to toggle dev tools). Watch for any `console.log` outputs or errors from the plugin.
   * Create a test flashcard in RemNote (e.g. a Rem with `Q:: A`). See if the plugin logs or triggers a push (you might log “RemChanged event for Rem …” in your code to verify).
   * Check the GitHub repository to see if the file got created and committed. If not, debug the fetch call: maybe token is wrong or something. The console might show a failed network request (CORS issues or 401).
   * Try editing the file on GitHub and then triggering a pull (using your sidebar button or slash command). Verify that the Rem in RemNote updates.
   * Do thorough tests: edit both sides, add tags, delete cards, etc. Use a small test KB for this, as recommended by RemNote (don’t risk your main notes during development).
   * Once it’s working, you can bundle the plugin for distribution using `npm run build` which outputs a production bundle. You could then distribute it (for personal use, you can keep using develop from localhost, or host the built files somewhere and use “Install plugin from URL” in RemNote).
   * If publishing to RemNote’s marketplace, follow their guidelines (increase version, etc.).

In summary, the developer will implement the above logic in TypeScript using RemNote’s plugin API and test it step by step. The RemNote plugin environment provides the needed hooks for reacting to flashcard changes and the ability to perform network requests to GitHub. Careful testing should be done to ensure data integrity. By following this plan, we will achieve a robust two-way synchronization between RemNote and GitHub, enabling automatic version-controlled backups of flashcards (with scheduling data) and collaborative editing via GitHub, all while maintaining compatibility with RemNote’s FSRS scheduling algorithm and data structures.
</context>
