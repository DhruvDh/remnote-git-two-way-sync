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
  question: string;
  answer: string;
}

/**
 * Serialize a card/rem pair to a markdown string with YAML frontmatter.
 */
export function serializeCard(card: SimpleCard, rem: SimpleRem): string {
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
  };

  const yaml = require('yaml');
  const front = yaml.stringify(frontmatter).trimEnd();
  const question = rem.text ?? '';
  const answer = rem.backText ?? '';
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
  return {
    cardId: front.cardId,
    remId: front.remId,
    tags: front.tags ?? [],
    scheduler: front.scheduler,
    difficulty: front.difficulty ?? null,
    stability: front.stability ?? null,
    lastReviewed: front.lastReviewed ?? null,
    nextDue: front.nextDue ?? null,
    question,
    answer,
  };
}
