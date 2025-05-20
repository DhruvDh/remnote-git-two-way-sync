import assert from 'assert';
import { serializeCard, parseCardMarkdown, SimpleCard, SimpleRem } from '../src/github/markdown';

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

const md = serializeCard(card, rem);
const parsed = parseCardMarkdown(md);

assert.strictEqual(parsed.cardId, card._id);
assert.strictEqual(parsed.remId, rem._id);
assert.deepStrictEqual(parsed.tags, rem.tags);
assert.strictEqual(parsed.difficulty, card.difficulty);
assert.strictEqual(parsed.stability, card.stability);
assert.strictEqual(parsed.lastReviewed, new Date(card.lastRepetitionTime!).toISOString());
assert.strictEqual(parsed.nextDue, new Date(card.nextRepetitionTime!).toISOString());
assert.strictEqual(parsed.question, rem.text);
assert.strictEqual(parsed.answer, rem.backText);
assert.strictEqual(parsed.updated, new Date(rem.updatedAt!).toISOString());

console.log('All tests passed.');
