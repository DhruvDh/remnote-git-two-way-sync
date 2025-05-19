export interface ShaMapEntry {
  path: string;
  sha: string;
}

import { ReactRNPlugin, QueueInteractionScore } from '@remnote/plugin-sdk';
import { listFiles, getFile } from './api';
import { parseCardMarkdown } from './markdown';

function richTextToPlain(rich: any): string {
  if (!rich) return '';
  return rich
    .map((el: any) => {
      if (typeof el === 'string') return el;
      if (el.i === 't') return el.text ?? '';
      return '';
    })
    .join('');
}

async function getOrCreateTag(plugin: ReactRNPlugin, name: string) {
  let tag = await plugin.rem.findByName(name, null);
  if (!tag) {
    tag = await plugin.rem.createRem();
    await tag.setText(await plugin.richText.text(name).value());
  }
  return tag;
}

export async function pullUpdates(plugin: ReactRNPlugin) {
  const subdir = (await plugin.settings.getSetting<string>('github-subdir')) || '';
  const dir = subdir ? `${subdir.replace(/\/$/, '')}/` : '';

  const listing = await listFiles(plugin, dir);
  if (!listing.ok || !listing.files) {
    await plugin.app.toast(`Failed to list files: ${listing.message ?? listing.status}`);
    return;
  }

  const stored =
    (await plugin.storage.getSynced<Record<string, ShaMapEntry>>('sha-map')) || {};
  const newMap: Record<string, ShaMapEntry> = { ...stored };
  const filesByPath = new Map(listing.files.map((f) => [f.path, f]));

  for (const file of listing.files) {
    const existingEntry = Object.entries(stored).find(([, info]) => info.path === file.path);
    const needsUpdate = !existingEntry || existingEntry[1].sha !== file.sha;
    if (!needsUpdate) {
      continue;
    }

    const res = await getFile(plugin, file.path);
    if (!res.ok || !res.data) {
      await plugin.app.toast(`Failed to fetch ${file.path}`);
      continue;
    }

    const parsed = parseCardMarkdown(res.data.content);
    const card = await plugin.card.findOne(parsed.cardId);
    if (card) {
      const rem = await card.getRem();
      if (rem) {
        const currentQ = richTextToPlain(rem.text);
        if (currentQ !== parsed.question) {
          await rem.setText(await plugin.richText.text(parsed.question).value());
        }
        const currentA = richTextToPlain(rem.backText);
        if (currentA !== parsed.answer) {
          await rem.setBackText(await plugin.richText.text(parsed.answer).value());
        }
      }
      if (parsed.nextDue && card.nextRepetitionTime !== new Date(parsed.nextDue).getTime()) {
        await card.updateCardRepetitionStatus(QueueInteractionScore.MANUAL_DATE);
      }
    } else {
      const rem = await plugin.rem.createRem();
      if (!rem) continue;
      await rem.setText(await plugin.richText.text(parsed.question).value());
      await rem.setBackText(await plugin.richText.text(parsed.answer).value());
    }
    newMap[parsed.cardId] = { path: file.path, sha: res.data.sha };
  }

  for (const [cardId, info] of Object.entries(stored)) {
    if (!filesByPath.has(info.path)) {
      const card = await plugin.card.findOne(cardId);
      if (card) {
        const rem = await card.getRem();
        if (rem) {
          const archiveTag = await getOrCreateTag(plugin, 'Archived');
          await rem.addTag(archiveTag);
          await plugin.app.toast(`Card ${cardId} archived (deleted on GitHub)`, 'info');
        }
      }
      delete newMap[cardId];
    }
  }

  await plugin.storage.setSynced('sha-map', newMap);
}

