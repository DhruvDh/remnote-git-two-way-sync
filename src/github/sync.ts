import { ReactRNPlugin, BuiltInPowerupCodes } from '@remnote/plugin-sdk';
import {
  serializeCard,
  SimpleCard,
  SimpleRem,
  parseCardMarkdown,
  ParsedCard,
} from './markdown';
import {
  createOrUpdateFile,
  deleteFile,
  getFile,
  listFiles,
  getBinaryFile,
} from './api';

interface ShaEntry {
  sha: string;
  remId: string;
  timestamp: number;
  slug?: string;
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

export async function saveFailedQueue(
  plugin: ReactRNPlugin,
  queue: string[]
): Promise<void> {
  await plugin.storage.setSynced(FAILED_QUEUE_KEY, queue);
}

function slugify(text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function getPath(subdir: string, cardId: string, slug?: string) {
  const file = slug ? `${slug}_${cardId}.md` : `${cardId}.md`;
  return subdir ? `${subdir}/${file}` : file;
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

async function logConflict(plugin: ReactRNPlugin, cardId: string) {
  const titleRT = await plugin.richText.parseFromMarkdown('Conflicts');
  let doc = await plugin.rem.findByName(titleRT, null);
  if (!doc) {
    doc = await plugin.rem.createRem();
    if (doc) {
      await doc.setText(titleRT);
    }
  }
  if (!doc) return;
  const children = await doc.getChildrenRem();
  const existing = await Promise.all(
    children.map(async (c: any) =>
      c.text ? await plugin.richText.toString(c.text) : ''
    )
  );
  if (!existing.includes(cardId)) {
    const child = await plugin.rem.createRem();
    if (child) {
      await child.setText(await plugin.richText.parseFromMarkdown(cardId));
      await child.setParent(doc._id);
    }
  }
}

async function confirmAction(
  plugin: ReactRNPlugin,
  message: string
): Promise<boolean> {
  const app: any = (plugin as any).app;
  if (app && typeof app.confirm === 'function') {
    try {
      return await app.confirm(message);
    } catch {}
  }
  const win: any = (plugin as any).window;
  if (win && typeof win.showConfirm === 'function') {
    try {
      return await win.showConfirm(message);
    } catch {}
  }
  if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
    return window.confirm(message);
  }
  if (app && typeof app.toast === 'function') {
    await app.toast(message);
  }
  return false;
}

async function applyParsedToRem(
  plugin: ReactRNPlugin,
  parsed: ParsedCard,
  rem: any,
  card: any
) {
  const replaceMedia = async (text: string) => {
    const regex = /!\[(.*?)\]\((media\/[^)]+)\)/g;
    let result = '';
    let last = 0;
    for (const match of text.matchAll(regex)) {
      result += text.slice(last, match.index);
      last = (match.index || 0) + match[0].length;
      const alt = match[1];
      const path = match[2];
      const file = await getBinaryFile(plugin, path);
      if (file.ok && file.data) {
        const ext = path.split('.').pop()?.toLowerCase() || 'png';
        const mime = ext === 'jpg' || ext === 'jpeg'
          ? 'image/jpeg'
          : ext === 'gif'
          ? 'image/gif'
          : ext === 'svg'
          ? 'image/svg+xml'
          : 'image/png';
        const base64 = Buffer.from(file.data.content).toString('base64');
        result += `![${alt}](data:${mime};base64,${base64})`;
      } else {
        result += match[0];
      }
    }
    result += text.slice(last);
    return result;
  };

  const q = await replaceMedia(parsed.question);
  const a = await replaceMedia(parsed.answer);
  await rem.setText(await plugin.richText.parseFromMarkdown(q));
  await rem.setBackText(await plugin.richText.parseFromMarkdown(a));

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
  if (parsed.ease !== null && parsed.ease !== undefined) {
    (card as any).ease = parsed.ease;
  }
  if (parsed.interval !== null && parsed.interval !== undefined) {
    (card as any).interval = parsed.interval;
  }
}

export async function pushCardById(plugin: ReactRNPlugin, cardId: string) {
  const card = await plugin.card.findOne(cardId);
  if (!card) return;
  const rem = await card.getRem();
  if (!rem) return;

  const subdir = (await plugin.settings.getSetting<string>('github-subdir')) || '';
  const useSlug = await plugin.settings.getSetting<boolean>('use-slug-filenames');

  let scheduler =
    (await plugin.settings.getSetting<string>('scheduler')) || undefined;
  if (!scheduler) {
    if ((card as any).difficulty !== undefined || (card as any).stability !== undefined) {
      scheduler = 'FSRS';
    } else if ((card as any).ease !== undefined || (card as any).interval !== undefined) {
      scheduler = 'SM2';
    } else {
      scheduler = 'FSRS';
    }
  }

  const simpleCard: SimpleCard = {
    _id: card._id,
    remId: card.remId,
    nextRepetitionTime: card.nextRepetitionTime,
    lastRepetitionTime: card.lastRepetitionTime,
    difficulty: (card as any).difficulty,
    stability: (card as any).stability,
    ease: (card as any).ease,
    interval: (card as any).interval,
    scheduler,
  };

  const text = rem.text ? await plugin.richText.toMarkdown(rem.text) : undefined;
  const backText = rem.backText ? await plugin.richText.toMarkdown(rem.backText) : undefined;
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

  const content = await serializeCard(plugin, simpleCard, simpleRem);
  let slug = fileShaMap[cardId]?.slug;
  if (useSlug && !slug && text) {
    slug = slugify(text);
  }
  const path = getPath(subdir, cardId, slug);

  const shaEntry = fileShaMap[cardId];
  const res = await createOrUpdateFile(plugin, path, content, shaEntry?.sha);
  if (res.ok && res.sha) {
    fileShaMap[cardId] = {
      sha: res.sha,
      remId: rem._id,
      timestamp: Date.now(),
      slug,
    };
    const queue = await loadFailedQueue(plugin);
    const idx = queue.indexOf(cardId);
    if (idx !== -1) {
      queue.splice(idx, 1);
      await saveFailedQueue(plugin, queue);
    }
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
          await logConflict(plugin, cardId);
          await plugin.app.toast(
            `Conflict for card ${cardId} requires manual resolution.`,
            'warning'
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
          slug,
        };
      } else {
        const retry = await createOrUpdateFile(plugin, path, content, remote.data.sha);
        if (retry.ok && retry.sha) {
          fileShaMap[cardId] = {
            sha: retry.sha,
            remId: rem._id,
            timestamp: Date.now(),
            slug,
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
  const path = getPath(subdir, cardId, entry.slug);
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
    const filename = file.path.split('/').pop() ?? '';
    const base = filename.replace(/\.md$/, '');
    const parts = base.split('_');
    const id = parts.pop();
    if (!id) continue;
    const slug = parts.length > 0 ? parts.join('_') : undefined;
    seen.add(id);
    const entry = fileShaMap[id];
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
              ease: (card as any).ease,
              interval: (card as any).interval,
              scheduler:
                (await plugin.settings.getSetting<string>('scheduler')) ||
                ((card as any).difficulty !== undefined ||
                (card as any).stability !== undefined
                  ? 'FSRS'
                  : 'SM2'),
            };
            const text = rem.text
              ? await plugin.richText.toMarkdown(rem.text)
              : undefined;
            const backText = rem.backText
              ? await plugin.richText.toMarkdown(rem.backText)
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
            const localContent = await serializeCard(plugin, simpleCard, simpleRem);
            await createConflictFile(
              plugin,
              subdir,
              id,
              localContent,
              res.data.content
            );
            await logConflict(plugin, id);
            await plugin.app.toast(
              `Conflict for card ${id} requires manual resolution.`,
              'warning'
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
        if (parsed.ease !== null && parsed.ease !== undefined) {
          (card as any).ease = parsed.ease;
        }
        if (parsed.interval !== null && parsed.interval !== undefined) {
          (card as any).interval = parsed.interval;
        }
      }

      fileShaMap[id] = {
        sha: file.sha,
        remId: rem._id,
        timestamp: Date.now(),
        slug,
      };
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

      const remove = await confirmAction(
        plugin,
        `File for card ${id} deleted on GitHub. Remove locally?`
      );
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
