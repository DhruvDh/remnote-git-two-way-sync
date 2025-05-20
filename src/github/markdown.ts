export interface SimpleCard {
  _id: string;
  remId: string;
  nextRepetitionTime?: number;
  lastRepetitionTime?: number;
  // FSRS fields
  difficulty?: number;
  stability?: number;
  // SM2 fields
  ease?: number;
  interval?: number;
  // Scheduler type
  scheduler?: string;
}

export interface SimpleRem {
  _id: string;
  text?: string;
  backText?: string;
  tags?: string[];
  updatedAt?: number;
}

export interface ParsedCard {
  cardId: string;
  remId: string;
  tags: string[];
  scheduler?: string | null;
  difficulty?: number | null;
  stability?: number | null;
  ease?: number | null;
  interval?: number | null;
  lastReviewed?: string | null;
  nextDue?: string | null;
  updated?: string | null;
  question: string;
  answer: string;
  mediaPaths: string[];
}

/**
 * Serialize a card/rem pair to a markdown string with YAML frontmatter.
 */
import { ReactRNPlugin } from '@remnote/plugin-sdk';
import { uploadMediaFile } from './api';
import path from 'path';

async function replaceImages(
  plugin: ReactRNPlugin,
  text: string
): Promise<string> {
  const regex = /!\[(.*?)\]\((.*?)\)/g;
  let result = '';
  let last = 0;
  for (const match of text.matchAll(regex)) {
    result += text.slice(last, match.index);
    last = (match.index || 0) + match[0].length;
    const alt = match[1];
    const url = match[2];
    if (url.startsWith('media/')) {
      result += match[0];
      continue;
    }
    try {
      const res = await fetch(url);
      const data = await res.arrayBuffer();
      const ext = path.extname(url) || '.png';
      const fname = `${Date.now()}_${Math.random().toString(16).slice(2)}${ext}`;
      await uploadMediaFile(plugin, `media/${fname}`, data);
      result += `![${alt}](media/${fname})`;
    } catch {
      result += match[0];
    }
  }
  result += text.slice(last);
  return result;
}

export async function serializeCard(
  plugin: ReactRNPlugin,
  card: SimpleCard,
  rem: SimpleRem
): Promise<string> {
  const scheduler = card.scheduler
    ? card.scheduler
    : card.difficulty !== undefined || card.stability !== undefined
    ? 'FSRS'
    : 'SM2';

  const frontmatter: Record<string, any> = {
    remId: rem._id,
    cardId: card._id,
    tags: rem.tags ?? [],
    scheduler,
    lastReviewed: card.lastRepetitionTime
      ? new Date(card.lastRepetitionTime).toISOString()
      : null,
    nextDue: card.nextRepetitionTime
      ? new Date(card.nextRepetitionTime).toISOString()
      : null,
    updated: rem.updatedAt ? new Date(rem.updatedAt).toISOString() : null,
  };

  if (scheduler === 'FSRS') {
    frontmatter.difficulty = card.difficulty ?? null;
    frontmatter.stability = card.stability ?? null;
  } else {
    frontmatter.ease = card.ease ?? null;
    frontmatter.interval = card.interval ?? null;
  }

  const yaml = require('yaml');
  const front = yaml.stringify(frontmatter).trimEnd();
  let question = rem.text ?? '';
  let answer = rem.backText ?? '';
  question = await replaceImages(plugin, question);
  answer = await replaceImages(plugin, answer);
  return `---\n${front}\n---\n**Q:** ${question}\n\n**A:** ${answer}\n`;
}

/**
 * Parse a markdown string created by `serializeCard` back into its components.
 */
export function parseCardMarkdown(content: string): ParsedCard {
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
  const question = lines
    .slice(qIndex, aIndex)
    .join('\n')
    .replace(/^\*\*Q:\*\*\s*/, '')
    .trim();
  const answer = lines
    .slice(aIndex)
    .join('\n')
    .replace(/^\*\*A:\*\*\s*/, '')
    .trim();
  const media: string[] = [];
  const regex = /!\[(.*?)\]\((media\/[^)]+)\)/g;
  for (const part of [question, answer]) {
    let m;
    while ((m = regex.exec(part)) !== null) {
      media.push(m[2]);
    }
  }
  return {
    cardId: front.cardId,
    remId: front.remId,
    tags: front.tags ?? [],
    scheduler: front.scheduler,
    difficulty: front.difficulty ?? null,
    stability: front.stability ?? null,
    ease: front.ease ?? null,
    interval: front.interval ?? null,
    lastReviewed: front.lastReviewed ?? null,
    nextDue: front.nextDue ?? null,
    updated: front.updated ?? null,
    question,
    answer,
    mediaPaths: media,
  };
}
