export interface SimpleCard {
  _id: string;
  remId: string;
  nextRepetitionTime?: number;
  lastRepetitionTime?: number;
  // FSRS fields
  difficulty?: number;
  stability?: number;
}

export interface SimpleRem {
  _id: string;
  text?: string;
  backText?: string;
  tags?: string[];
  updatedAt?: number;
  textRich?: any;
  backRich?: any;
}

export interface ParsedCard {
  cardId: string;
  remId: string;
  tags: string[];
  scheduler?: string | null;
  difficulty?: number | null;
  stability?: number | null;
  lastReviewed?: string | null;
  nextDue?: string | null;
  updated?: string | null;
  question: string;
  answer: string;
}

/**
 * Serialize a card/rem pair to a markdown string with YAML frontmatter.
 */
import { ReactRNPlugin } from '@remnote/plugin-sdk';
import { createOrUpdateBinaryFile, getBinaryFile } from './api';

export async function serializeCard(
  plugin: ReactRNPlugin,
  card: SimpleCard,
  rem: SimpleRem
): Promise<string> {
  const frontmatter: Record<string, any> = {
    remId: rem._id,
    cardId: card._id,
    tags: rem.tags ?? [],
    scheduler: 'FSRS',
    difficulty: card.difficulty ?? null,
    stability: card.stability ?? null,
    lastReviewed: card.lastRepetitionTime
      ? new Date(card.lastRepetitionTime).toISOString()
      : null,
    nextDue: card.nextRepetitionTime
      ? new Date(card.nextRepetitionTime).toISOString()
      : null,
    updated: rem.updatedAt ? new Date(rem.updatedAt).toISOString() : null,
  };

  const yaml = require('yaml');
  const front = yaml.stringify(frontmatter).trimEnd();

  let question = rem.text ?? '';
  let answer = rem.backText ?? '';

  if (rem.textRich) {
    question = await plugin.richText.toMarkdown(rem.textRich);
    question = await processImages(plugin, question);
  }
  if (rem.backRich) {
    answer = await plugin.richText.toMarkdown(rem.backRich);
    answer = await processImages(plugin, answer);
  }

  return `---\n${front}\n---\n**Q:** ${question}\n\n**A:** ${answer}\n`;
}

/**
 * Parse a markdown string created by `serializeCard` back into its components.
 */
export async function parseCardMarkdown(
  plugin: ReactRNPlugin,
  content: string
): Promise<ParsedCard> {
  const yaml = require('yaml');
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) {
    throw new Error('Invalid card markdown: missing frontmatter');
  }
  const front = yaml.parse(fmMatch[1]) as Record<string, any>;
  const body = fmMatch[2];
  const lines = body.split(/\r?\n/);
  const qIndex = lines.findIndex((l) => l.startsWith('**Q:**'));
  const aIndex = lines.findIndex((l) => l.startsWith('**A:**'));
  if (qIndex === -1 || aIndex === -1 || aIndex < qIndex) {
    throw new Error('Invalid card markdown: missing Q/A');
  }
  let question = lines
    .slice(qIndex, aIndex)
    .join('\n')
    .replace(/^\*\*Q:\*\*\s*/, '')
    .trim();
  let answer = lines
    .slice(aIndex)
    .join('\n')
    .replace(/^\*\*A:\*\*\s*/, '')
    .trim();

  question = await restoreImages(plugin, question);
  answer = await restoreImages(plugin, answer);
  return {
    cardId: front.cardId,
    remId: front.remId,
    tags: front.tags ?? [],
    scheduler: front.scheduler,
    difficulty: front.difficulty ?? null,
    stability: front.stability ?? null,
    lastReviewed: front.lastReviewed ?? null,
    nextDue: front.nextDue ?? null,
    updated: front.updated ?? null,
    question,
    answer,
  };
}

async function processImages(plugin: ReactRNPlugin, text: string): Promise<string> {
  const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
  const subdir = (await plugin.settings.getSetting<string>('github-subdir')) || '';
  const mediaDir = subdir ? `${subdir}/media` : 'media';
  let result = '';
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = imageRegex.exec(text))) {
    result += text.slice(last, match.index);
    const alt = match[1];
    let url = match[2];
    let base64: string | null = null;
    if (url.startsWith('data:')) {
      base64 = url.split(',')[1];
    } else {
      try {
        const res = await fetch(url);
        const buffer = await res.arrayBuffer();
        base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
      } catch {
        base64 = null;
      }
    }
    if (base64) {
      const extMatch = url.match(/\.([a-zA-Z0-9]+)(?:$|\?)/);
      const ext = extMatch ? extMatch[1] : 'png';
      const fileName = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
      const path = `${mediaDir}/${fileName}`;
      await createOrUpdateBinaryFile(plugin, path, base64);
      url = path;
    }
    result += `![${alt}](${url})`;
    last = imageRegex.lastIndex;
  }
  result += text.slice(last);
  return result;
}

async function restoreImages(plugin: ReactRNPlugin, text: string): Promise<string> {
  const imageRegex = /!\[([^\]]*)\]\((media\/[^)]+)\)/g;
  const subdir = (await plugin.settings.getSetting<string>('github-subdir')) || '';
  let result = '';
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = imageRegex.exec(text))) {
    result += text.slice(last, match.index);
    const alt = match[1];
    const relPath = match[2];
    const fullPath = subdir ? `${subdir}/${relPath}` : relPath;
    const file = await getBinaryFile(plugin, fullPath);
    let url = relPath;
    if (file.ok && file.data) {
      const ext = relPath.split('.').pop() || 'png';
      const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`;
      url = `data:${mime};base64,${file.data.content}`;
    }
    result += `![${alt}](${url})`;
    last = imageRegex.lastIndex;
  }
  result += text.slice(last);
  return result;
}
