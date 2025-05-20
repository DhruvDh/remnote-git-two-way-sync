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
  timestamp: number;
}
export let fileShaMap: Record<string, ShaEntry> = {};

const FILE_SHA_MAP_KEY = 'file-sha-map';
const FAILED_QUEUE_KEY = 'github-failed-queue';

export async function loadShaMap(plugin: ReactRNPlugin): Promise<void> {
  const data = await plugin.storage.getSynced<Record<string, ShaEntry>>(FILE_SHA_MAP_KEY);
  fileShaMap = data || {};
  for (const id of Object.keys(fileShaMap)) {
    fileShaMap[id].timestamp = fileShaMap[id].timestamp || Date.now();
  }
}

export async function saveShaMap(plugin: ReactRNPlugin): Promise<void> {
  await plugin.storage.setSynced(FILE_SHA_MAP_KEY, fileShaMap);
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
    textRich: rem.text,
    backRich: rem.backText,
  };

  const content = await serializeCard(plugin, simpleCard, simpleRem);
  const path = getPath(subdir, cardId);

  const shaEntry = fileShaMap[cardId];
  const res = await createOrUpdateFile(plugin, path, content, shaEntry?.sha);
  if (res.ok && res.sha) {
    fileShaMap[cardId] = { sha: res.sha, remId: rem._id, timestamp: Date.now() };
    const queue = await loadFailedQueue(plugin);
    const idx = queue.indexOf(cardId);
    if (idx !== -1) {
      queue.splice(idx, 1);
      await saveFailedQueue(plugin, queue);
    }
  } else if (res.status === 409 && shaEntry) {
    const remote = await getFile(plugin, path);
    if (remote.ok && remote.data) {
      const parsed = await parseCardMarkdown(plugin, remote.data.content);
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
        fileShaMap[cardId] = {
          sha: remote.data.sha,
          remId: rem._id,
          timestamp: Date.now(),
        };
      } else {
        const retry = await createOrUpdateFile(plugin, path, content, remote.data.sha);
        if (retry.ok && retry.sha) {
          fileShaMap[cardId] = {
            sha: retry.sha,
            remId: rem._id,
            timestamp: Date.now(),
          };
        } else {
          const queue = await loadFailedQueue(plugin);
          if (!queue.includes(cardId)) {
            queue.push(cardId);
            await saveFailedQueue(plugin, queue);
          }
        }
      }
    }
  } else {
    const queue = await loadFailedQueue(plugin);
    if (!queue.includes(cardId)) {
      queue.push(cardId);
      await saveFailedQueue(plugin, queue);
    }
  }
}

export async function deleteCardFile(plugin: ReactRNPlugin, cardId: string) {
  const entry = fileShaMap[cardId];
  if (!entry) return;
  const subdir = (await plugin.settings.getSetting<string>('github-subdir')) || '';
  const path = getPath(subdir, cardId);
  const res = await deleteFile(plugin, path, entry.sha);
  if (res.ok) {
    delete fileShaMap[cardId];
  }
}

export async function processFailedQueue(plugin: ReactRNPlugin) {
  const queue = await loadFailedQueue(plugin);
  if (queue.length === 0) return;
  for (const cardId of [...queue]) {
    await pushCardById(plugin, cardId);
  }
}

export async function pullUpdates(plugin: ReactRNPlugin) {
  const subdir = (await plugin.settings.getSetting<string>('github-subdir')) || '';

  const { ok, files } = await listFiles(plugin, subdir);
  if (!ok || !files) {
    console.error('Failed to list files from GitHub');
    return;
  }

  const seen = new Set<string>();

  for (const file of files) {
    const id = file.path.split('/').pop()?.replace(/\.md$/, '');
    if (!id) continue;
    seen.add(id);
    const entry = fileShaMap[id];
    if (!entry || entry.sha !== file.sha) {
      const res = await getFile(plugin, file.path);
      if (!res.ok || !res.data) continue;
      const parsed = await parseCardMarkdown(plugin, res.data.content);

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
              textRich: rem.text,
              backRich: rem.backText,
            };
            const localContent = await serializeCard(plugin, simpleCard, simpleRem);
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

      fileShaMap[id] = { sha: file.sha, remId: rem._id, timestamp: Date.now() };
    }
  }

  for (const id of Object.keys(fileShaMap)) {
    if (!seen.has(id)) {
      const card = await plugin.card.findOne(id);
      if (!card) {
        delete fileShaMap[id];
        continue;
      }
      const rem = await card.getRem();
      if (!rem) {
        delete fileShaMap[id];
        continue;
      }

      const remove = window.confirm(`File for card ${id} deleted on GitHub. Remove locally?`);
      if (remove) {
        await rem.remove();
        delete fileShaMap[id];
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
        delete fileShaMap[id];
      }
    }
  }

}

export async function pushAllCards(plugin: ReactRNPlugin) {
  const cards = await plugin.card.getAll();
  for (const c of cards) {
    await pushCardById(plugin, c._id);
  }
}

export async function syncNow(plugin: ReactRNPlugin): Promise<boolean> {
  try {
    await pullUpdates(plugin);
    await pushAllCards(plugin);
    return true;
  } catch (err) {
    console.error('Sync failed', err);
    return false;
  }
}
