import { serializeCard, parseCardMarkdown, SimpleCard, SimpleRem } from '../src/github/markdown';
import { createOrUpdateBinaryFile, getBinaryFile } from '../src/github/api';

jest.mock('../src/github/api', () => {
  const original = jest.requireActual('../src/github/api');
  return {
    ...original,
    createOrUpdateBinaryFile: jest.fn(async () => ({ ok: true, status: 200, sha: 'sha1' })),
    getBinaryFile: jest.fn(async () => ({ ok: true, status: 200, data: { content: 'aW1n' , sha: 'sha1' } })),
  };
});

const plugin: any = {
  richText: {
    toMarkdown: jest.fn(async (rt: any) => rt),
    parseFromMarkdown: jest.fn(async (md: string) => md),
  },
  settings: {
    getSetting: jest.fn(async () => ''),
  },
};

describe('markdown serialization', () => {
  it('serializes and parses a card', async () => {
    const card: SimpleCard = {
      _id: 'card-efgh5678',
      remId: 'rem-abcd1234',
      difficulty: 5.6,
      stability: 15.2,
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

    const md = await serializeCard(plugin, card, rem);
    const parsed = await parseCardMarkdown(plugin, md);

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

  it('handles images', async () => {
    const card: SimpleCard = { _id: 'c1', remId: 'r1' };
    const imgData = 'data:image/png;base64,aW1n';
    const rem: SimpleRem = {
      _id: 'r1',
      textRich: [{ i: 'i', url: imgData }],
      backRich: [{ i: 'i', url: imgData }],
    } as any;

    plugin.richText.toMarkdown.mockImplementation(async (rt: any) => {
      return rt.map((e: any) => `![img](${e.url})`).join('');
    });

    const md = await serializeCard(plugin, card, rem);
    expect(createOrUpdateBinaryFile).toHaveBeenCalled();
    expect(md).toContain('media/');

    const parsed = await parseCardMarkdown(plugin, md);
    expect(parsed.question).toContain('data:image/png;base64');
    expect(parsed.answer).toContain('data:image/png;base64');
  });
});
