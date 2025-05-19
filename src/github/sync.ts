import { ReactRNPlugin } from '@remnote/plugin-sdk';
import { serializeCard, SimpleCard, SimpleRem } from './markdown';
import { createOrUpdateFile, deleteFile } from './api';

interface ShaEntry {
  sha: string;
  remId: string;
}

const SHA_MAP_KEY = 'github-sha-map';
const FAILED_QUEUE_KEY = 'github-failed-queue';

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
    tagRems.map(async (t) => (t.text ? await plugin.richText.toString(t.text) : ''))
  );
  const simpleRem: SimpleRem = { _id: rem._id, text, backText, tags };

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
  } else {
    const queue = await loadFailedQueue(plugin);
    if (!queue.includes(cardId)) {
      queue.push(cardId);
      await saveFailedQueue(plugin, queue);
    }
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
  }
}

export async function processFailedQueue(plugin: ReactRNPlugin) {
  const queue = await loadFailedQueue(plugin);
  if (queue.length === 0) return;
  for (const cardId of [...queue]) {
    await pushCardById(plugin, cardId);
  }
}
