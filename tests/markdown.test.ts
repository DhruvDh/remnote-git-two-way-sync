import { serializeCard, parseCardMarkdown, SimpleCard, SimpleRem } from '../src/github/markdown';

describe('markdown serialization', () => {
  it('serializes and parses a FSRS card', () => {
    const card: SimpleCard = {
      _id: 'card-efgh5678',
      remId: 'rem-abcd1234',
      difficulty: 5.6,
      stability: 15.2,
      scheduler: 'FSRS',
      lastRepetitionTime: Date.parse('2025-04-10T09:30:00Z'),
      nextRepetitionTime: Date.parse('2025-05-10T09:30:00Z'),
    };

    const rem: SimpleRem = {
      _id: 'rem-abcd1234',
      text: 'Why does the sky appear blue during the day?',
      backText: 'Rayleigh scattering causes blue light to dominate the sky.',
      tags: ['Astronomy', 'LightScattering'],
      updatedAt: Date.parse('2025-04-11T10:00:00Z'),
    };

    const md = serializeCard(card, rem);
    const parsed = parseCardMarkdown(md);

    expect(parsed.cardId).toBe(card._id);
    expect(parsed.remId).toBe(rem._id);
    expect(parsed.tags).toEqual(rem.tags);
    expect(parsed.difficulty).toBe(card.difficulty);
    expect(parsed.stability).toBe(card.stability);
    expect(parsed.lastReviewed).toBe(new Date(card.lastRepetitionTime!).toISOString());
    expect(parsed.nextDue).toBe(new Date(card.nextRepetitionTime!).toISOString());
    expect(parsed.question).toBe(rem.text);
    expect(parsed.answer).toBe(rem.backText);
    expect(parsed.updated).toBe(new Date(rem.updatedAt!).toISOString());
  });

  it('serializes and parses an SM2 card', () => {
    const card: SimpleCard = {
      _id: 'card-sm2',
      remId: 'rem-sm2',
      ease: 2.5,
      interval: 10,
      scheduler: 'SM2',
      lastRepetitionTime: Date.parse('2025-01-01T00:00:00Z'),
      nextRepetitionTime: Date.parse('2025-01-11T00:00:00Z'),
    };

    const rem: SimpleRem = {
      _id: 'rem-sm2',
      text: 'Q?',
      backText: 'A',
      tags: ['Tag1'],
      updatedAt: Date.parse('2025-01-02T00:00:00Z'),
    };

    const md = serializeCard(card, rem);
    const parsed = parseCardMarkdown(md);

    expect(parsed.cardId).toBe(card._id);
    expect(parsed.scheduler).toBe('SM2');
    expect(parsed.ease).toBe(card.ease);
    expect(parsed.interval).toBe(card.interval);
    expect(parsed.question).toBe(rem.text);
    expect(parsed.answer).toBe(rem.backText);
  });
});
