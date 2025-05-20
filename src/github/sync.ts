import { ReactRNPlugin, BuiltInPowerupCodes } from '@remnote/plugin-sdk';
import {
  serializeCard,
  SimpleCard,
  SimpleRem,
  parseCardMarkdown,
  ParsedCard,
} from './markdown';
import { createOrUpdateFile, deleteFile, getFile, listFiles } from './api';

interface ShaEntry {
  sha: string;
  remId: string;
}

const SHA_MAP_KEY = 'github-sha-map';
const FAILED_QUEUE_KEY = 'github-failed-queue';
const STATUS_KEY = 'github-sync-status';

export async function setSyncStatus(
  plugin: ReactRNPlugin,
  status: string
): Promise<void> {
  await plugin.storage.setSynced(STATUS_KEY, status);
}

export async function getSyncStatus(
  plugin: ReactRNPlugin
): Promise<string> {
  return (await plugin.storage.getSynced<string>(STATUS_KEY)) || 'Idle';
}

export async function loadShaMap(plugin: ReactRNPlugin): Promise<Record<string, ShaEntry>> {
  return (await plugin.storage.getSynced<Record<string, ShaEntry>>(SHA_MAP_KEY)) || {};
}

export async function saveShaMap(plugin: ReactRNPlugin, map: Record<string, ShaEntry>): Promise<void> {
  await plugin.storage.setSynced(SHA_MAP_KEY, map);
}

export async function loadFailedQueue(plugin: ReactRNPlugin): Promise<string[]> {
  return (await plugin.storage.getSynced<string[]>(FAILED_QUEUE_KEY)) || [];
}

export async function saveFailedQueue(plugin: ReactRNPlugin, queue: string[]): Promise<void> {
  await plugin.storage.setSynced(FAILED_QUEUE_KEY, queue);
}

function getPath(subdir: string, cardId: string) {
  return subdir ? `${subdir}/${cardId}.md` : `${cardId}.md`;
}

async function createConflictFile(
  plugin: ReactRNPlugin,
  subdir: string,
  cardId: string,
  localContent: string,
  remoteContent: string
) {
  const conflictDir = subdir ? `${subdir}/conflicts` : 'conflicts';
  const path = `${conflictDir}/${cardId}.md`;
  const body = `# Conflict for ${cardId}\n\n## Local Version\n\n${localContent}\n\n## Remote Version\n\n${remoteContent}\n`;
  await createOrUpdateFile(plugin, path, body, undefined);
}

async function applyParsedToRem(
  plugin: ReactRNPlugin,
  parsed: ParsedCard,
  rem: any,
  card: any
) {
  await rem.setText(await plugin.richText.parseFromMarkdown(parsed.question));
  await rem.setBackText(await plugin.richText.parseFromMarkdown(parsed.answer));

  const currentTags = await rem.getTagRems();
  const currentNames = await Promise.all(
    currentTags.map(async (t: any) =>
      t.text ? await plugin.richText.toString(t.text) : ''
    )
  );
  for (const tagName of parsed.tags) {
    if (!currentNames.includes(tagName)) {
      const tagText = await plugin.richText.parseFromMarkdown(tagName);
      let tagRem = await plugin.rem.findByName(tagText, null);
      if (!tagRem) {
        tagRem = await plugin.rem.createRem();
        if (tagRem) {
          await tagRem.addPowerup(BuiltInPowerupCodes.UsedAsTag);
          await tagRem.setText(tagText);
        }
      }
      if (tagRem) {
        await rem.addTag(tagRem);
      }
    }
  }
  for (let i = 0; i < currentTags.length; i++) {
    if (!parsed.tags.includes(currentNames[i])) {
      await rem.removeTag(currentTags[i]._id);
    }
  }
  if (parsed.nextDue) {
    try {
      (card as any).nextRepetitionTime = Date.parse(parsed.nextDue);
    } catch {
      /* ignore */
    }
  }
  if (parsed.lastReviewed) {
    try {
      (card as any).lastRepetitionTime = Date.parse(parsed.lastReviewed);
    } catch {
      /* ignore */
    }
  }
  if (parsed.difficulty !== null && parsed.difficulty !== undefined) {
    (card as any).difficulty = parsed.difficulty;
  }
  if (parsed.stability !== null && parsed.stability !== undefined) {
    (card as any).stability = parsed.stability;
  }
}

export async function pushCardById(plugin: ReactRNPlugin, cardId: string) {
  const card = await plugin.card.findOne(cardId);
  if (!card) return;
  const rem = await card.getRem();
  if (!rem) return;

  await setSyncStatus(plugin, 'Syncing');

  const subdir = (await plugin.settings.getSetting<string>('github-subdir')) || '';

  const simpleCard: SimpleCard = {
    _id: card._id,
    remId: card.remId,
    nextRepetitionTime: card.nextRepetitionTime,
    lastRepetitionTime: card.lastRepetitionTime,
    difficulty: (card as any).difficulty,
    stability: (card as any).stability,
  };

  const text = rem.text ? await plugin.richText.toString(rem.text) : undefined;
  const backText = rem.backText ? await plugin.richText.toString(rem.backText) : undefined;
  const tagRems = await rem.getTagRems();
  const tags = await Promise.all(
    tagRems.map(async (t: any) => (t.text ? await plugin.richText.toString(t.text) : ''))
  );
  const simpleRem: SimpleRem = {
    _id: rem._id,
    text,
    backText,
    tags,
    updatedAt: rem.updatedAt,
  };

  const content = serializeCard(simpleCard, simpleRem);
  const path = getPath(subdir, cardId);

  const shaMap = await loadShaMap(plugin);
  const shaEntry = shaMap[cardId];
  const res = await createOrUpdateFile(plugin, path, content, shaEntry?.sha);
  if (res.ok && res.sha) {
    shaMap[cardId] = { sha: res.sha, remId: rem._id };
    await saveShaMap(plugin, shaMap);
    const queue = await loadFailedQueue(plugin);
    const idx = queue.indexOf(cardId);
    if (idx !== -1) {
      queue.splice(idx, 1);
      await saveFailedQueue(plugin, queue);
    }
    await setSyncStatus(plugin, 'Synced');
  } else if (res.status === 409 && shaEntry) {
    const remote = await getFile(plugin, path);
    if (remote.ok && remote.data) {
      const parsed = parseCardMarkdown(remote.data.content);
      const remoteUpdated = parsed.updated ? Date.parse(parsed.updated) : 0;
      const localUpdated = rem.updatedAt;
      const policy =
        (await plugin.settings.getSetting<string>('conflict-policy')) || 'newer';
      let useRemote = false;
      if (policy === 'prefer-github') {
        useRemote = true;
      } else if (policy === 'prefer-remnote') {
        useRemote = false;
      } else {
        if (remoteUpdated > localUpdated) useRemote = true;
        else if (remoteUpdated < localUpdated) useRemote = false;
        else {
          await createConflictFile(
            plugin,
            subdir,
            cardId,
            content,
            remote.data.content
          );
          console.warn(`Conflict for card ${cardId} requires manual resolution.`);
          return;
        }
      }
      if (useRemote) {
        await applyParsedToRem(plugin, parsed, rem, card);
        shaMap[cardId] = { sha: remote.data.sha, remId: rem._id };
        await saveShaMap(plugin, shaMap);
        await setSyncStatus(plugin, 'Synced');
      } else {
        const retry = await createOrUpdateFile(plugin, path, content, remote.data.sha);
        if (retry.ok && retry.sha) {
          shaMap[cardId] = { sha: retry.sha, remId: rem._id };
          await saveShaMap(plugin, shaMap);
          await setSyncStatus(plugin, 'Synced');
        } else {
          const queue = await loadFailedQueue(plugin);
          if (!queue.includes(cardId)) {
            queue.push(cardId);
            await saveFailedQueue(plugin, queue);
          }
          await setSyncStatus(plugin, 'Error');
        }
      }
    }
  } else {
    const queue = await loadFailedQueue(plugin);
    if (!queue.includes(cardId)) {
      queue.push(cardId);
      await saveFailedQueue(plugin, queue);
    }
    await setSyncStatus(plugin, 'Error');
  }
}

export async function deleteCardFile(plugin: ReactRNPlugin, cardId: string) {
  const shaMap = await loadShaMap(plugin);
  const entry = shaMap[cardId];
  if (!entry) return;
  const subdir = (await plugin.settings.getSetting<string>('github-subdir')) || '';
  const path = getPath(subdir, cardId);
  const res = await deleteFile(plugin, path, entry.sha);
  if (res.ok) {
    delete shaMap[cardId];
    await saveShaMap(plugin, shaMap);
    await setSyncStatus(plugin, 'Synced');
  } else {
    await setSyncStatus(plugin, 'Error');
  }
}

export async function processFailedQueue(plugin: ReactRNPlugin) {
  const queue = await loadFailedQueue(plugin);
  if (queue.length === 0) return;
  for (const cardId of [...queue]) {
    await pushCardById(plugin, cardId);
  }
  await setSyncStatus(plugin, 'Synced');
}

export async function pushAllCards(plugin: ReactRNPlugin) {
  const cards = await plugin.card.getAll();
  for (const c of cards) {
    await pushCardById(plugin, c._id);
  }
  await setSyncStatus(plugin, 'Synced');
}

export async function pullUpdates(plugin: ReactRNPlugin) {
  await setSyncStatus(plugin, 'Syncing');
  const subdir = (await plugin.settings.getSetting<string>('github-subdir')) || '';
  const shaMap = await loadShaMap(plugin);

  const { ok, files } = await listFiles(plugin, subdir);
  if (!ok || !files) {
    console.error('Failed to list files from GitHub');
    await setSyncStatus(plugin, 'Error');
    return;
  }

  const seen = new Set<string>();

  for (const file of files) {
    const id = file.path.split('/').pop()?.replace(/\.md$/, '');
    if (!id) continue;
    seen.add(id);
    const entry = shaMap[id];
    if (!entry || entry.sha !== file.sha) {
      const res = await getFile(plugin, file.path);
      if (!res.ok || !res.data) continue;
      const parsed = parseCardMarkdown(res.data.content);

      const policy =
        (await plugin.settings.getSetting<string>('conflict-policy')) || 'newer';

      let card = await plugin.card.findOne(parsed.cardId);
      let rem = card ? await card.getRem() : undefined;

      const remoteUpdated = parsed.updated ? Date.parse(parsed.updated) : 0;
      const localUpdated = rem ? rem.updatedAt : 0;
      let applyRemote = true;
      if (rem) {
        if (policy === 'prefer-remnote') {
          applyRemote = false;
        } else if (policy === 'prefer-github') {
          applyRemote = true;
        } else {
          if (remoteUpdated > localUpdated) applyRemote = true;
          else if (remoteUpdated < localUpdated) applyRemote = false;
          else {
            const simpleCard: SimpleCard = {
              _id: card!._id,
              remId: card!.remId,
              nextRepetitionTime: card!.nextRepetitionTime,
              lastRepetitionTime: card!.lastRepetitionTime,
              difficulty: (card as any).difficulty,
              stability: (card as any).stability,
            };
            const text = rem.text
              ? await plugin.richText.toString(rem.text)
              : undefined;
            const backText = rem.backText
              ? await plugin.richText.toString(rem.backText)
              : undefined;
            const tagRems = await rem.getTagRems();
            const tags = await Promise.all(
              tagRems.map(async (t: any) =>
                t.text ? await plugin.richText.toString(t.text) : ''
              )
            );
            const simpleRem: SimpleRem = {
              _id: rem._id,
              text,
              backText,
              tags,
              updatedAt: rem.updatedAt,
            };
            const localContent = serializeCard(simpleCard, simpleRem);
            await createConflictFile(
              plugin,
              subdir,
              id,
              localContent,
              res.data.content
            );
            console.warn(`Conflict for card ${id} requires manual resolution.`);
            continue;
          }
        }
      }

      if (!applyRemote) {
        continue;
      }

      if (!rem) {
        rem = await plugin.rem.createRem();
        if (!rem) continue;
        await rem.setText(await plugin.richText.parseFromMarkdown(parsed.question));
        await rem.setBackText(await plugin.richText.parseFromMarkdown(parsed.answer));

        for (const tagName of parsed.tags) {
          const tagText = await plugin.richText.parseFromMarkdown(tagName);
          let tagRem = await plugin.rem.findByName(tagText, null);
          if (!tagRem) {
            tagRem = await plugin.rem.createRem();
            if (tagRem) {
              await tagRem.addPowerup(BuiltInPowerupCodes.UsedAsTag);
              await tagRem.setText(tagText);
            }
          }
          if (tagRem) {
            await rem.addTag(tagRem);
          }
        }

        const cards = await rem.getCards();
        card = cards.find((c) => c._id === parsed.cardId) || cards[0];
      } else {
        await rem.setText(await plugin.richText.parseFromMarkdown(parsed.question));
        await rem.setBackText(await plugin.richText.parseFromMarkdown(parsed.answer));

        const currentTags = await rem.getTagRems();
        const currentNames = await Promise.all(
          currentTags.map(async (t: any) =>
            t.text ? await plugin.richText.toString(t.text) : ''
          )
        );

        for (const tagName of parsed.tags) {
          if (!currentNames.includes(tagName)) {
            const tagText = await plugin.richText.parseFromMarkdown(tagName);
            let tagRem = await plugin.rem.findByName(tagText, null);
            if (!tagRem) {
              tagRem = await plugin.rem.createRem();
              if (tagRem) {
                await tagRem.addPowerup(BuiltInPowerupCodes.UsedAsTag);
                await tagRem.setText(tagText);
              }
            }
            if (tagRem) {
              await rem.addTag(tagRem);
            }
          }
        }

        for (let i = 0; i < currentTags.length; i++) {
          if (!parsed.tags.includes(currentNames[i])) {
            await rem.removeTag(currentTags[i]._id);
          }
        }
      }

      if (card) {
        if (parsed.nextDue) {
          try {
            (card as any).nextRepetitionTime = Date.parse(parsed.nextDue);
          } catch {
            /* ignored */
          }
        }
        if (parsed.lastReviewed) {
          try {
            (card as any).lastRepetitionTime = Date.parse(parsed.lastReviewed);
          } catch {
            /* ignored */
          }
        }
        if (parsed.difficulty !== null && parsed.difficulty !== undefined) {
          (card as any).difficulty = parsed.difficulty;
        }
        if (parsed.stability !== null && parsed.stability !== undefined) {
          (card as any).stability = parsed.stability;
        }
      }

      shaMap[id] = { sha: file.sha, remId: rem._id };
    }
  }

  for (const id of Object.keys(shaMap)) {
    if (!seen.has(id)) {
      const card = await plugin.card.findOne(id);
      if (!card) {
        delete shaMap[id];
        continue;
      }
      const rem = await card.getRem();
      if (!rem) {
        delete shaMap[id];
        continue;
      }

      const remove = window.confirm(`File for card ${id} deleted on GitHub. Remove locally?`);
      if (remove) {
        await rem.remove();
        delete shaMap[id];
      } else {
        const tagText = await plugin.richText.parseFromMarkdown('Archived');
        let tagRem = await plugin.rem.findByName(tagText, null);
        if (!tagRem) {
          tagRem = await plugin.rem.createRem();
          if (tagRem) {
            await tagRem.addPowerup(BuiltInPowerupCodes.UsedAsTag);
            await tagRem.setText(tagText);
          }
        }
        if (tagRem) {
          await rem.addTag(tagRem);
        }
        delete shaMap[id];
      }
    }
  }

  await saveShaMap(plugin, shaMap);
  await setSyncStatus(plugin, 'Synced');
}
