jest.mock('@remnote/plugin-sdk', () => ({}));
import { pushCardById, pullUpdates, fileShaMap } from '../src/github/sync';
import { serializeCard } from '../src/github/markdown';
import * as api from '../src/github/api';

jest.mock('../src/github/api');

const createOrUpdateFile = api.createOrUpdateFile as jest.Mock;
const getFile = api.getFile as jest.Mock;
const listFiles = api.listFiles as jest.Mock;

function createPlugin() {
  const settings: Record<string, any> = {
    'github-subdir': 'cards',
    'conflict-policy': 'newer',
  };
  return {
    settings: { getSetting: jest.fn((k: string) => settings[k]) },
    card: { findOne: jest.fn(), getAll: jest.fn() },
    richText: {
      toString: jest.fn(async (t: any) => (typeof t === 'string' ? t : t.text)),
      toMarkdown: jest.fn(async (t: any) => (typeof t === 'string' ? t : t.text)),
      parseFromMarkdown: jest.fn(async (t: any) => t),
    },
    rem: {
      createRem: jest.fn(),
      findByName: jest.fn(),
    },
    storage: {
      getSynced: jest.fn().mockResolvedValue([]),
      setSynced: jest.fn(),
    },
    app: { toast: jest.fn() },
  } as any;
}

function createMockRem() {
  return {
    _id: 'rem1',
    text: 'Q',
    backText: 'A',
    updatedAt: 100,
    getTagRems: jest.fn().mockResolvedValue([{ text: 'tag1', _id: 't1' }]),
    setText: jest.fn(),
    setBackText: jest.fn(),
    addTag: jest.fn(),
    removeTag: jest.fn(),
    getCards: jest.fn().mockResolvedValue([]),
  } as any;
}

function createMockCard(rem: any) {
  return {
    _id: 'card1',
    remId: rem._id,
    nextRepetitionTime: 200,
    lastRepetitionTime: 50,
    getRem: jest.fn(async () => rem),
  } as any;
}

beforeEach(() => {
  jest.resetAllMocks();
  for (const k of Object.keys(fileShaMap)) delete fileShaMap[k];
});

describe('pushCardById', () => {
  it('uploads card and updates sha map', async () => {
    const plugin = createPlugin();
    const rem = createMockRem();
    const card = createMockCard(rem);
    plugin.card.findOne.mockResolvedValue(card);
    createOrUpdateFile.mockResolvedValue({ ok: true, status: 200, sha: 'newsha' });

    await pushCardById(plugin, 'card1');

    const simpleCard = {
      _id: 'card1',
      remId: 'rem1',
      nextRepetitionTime: 200,
      lastRepetitionTime: 50,
      difficulty: undefined,
      stability: undefined,
      scheduler: 'FSRS',
    };
    const simpleRem = {
      _id: 'rem1',
      text: 'Q',
      backText: 'A',
      tags: ['tag1'],
      updatedAt: 100,
    };
    const content = await serializeCard(plugin as any, simpleCard as any, simpleRem as any);
    expect(createOrUpdateFile).toHaveBeenCalledWith(plugin, 'cards/card1.md', content, undefined);
    expect(fileShaMap['card1'].sha).toBe('newsha');
  });

  it('uses remote version when conflict and remote newer', async () => {
    const plugin = createPlugin();
    const rem = createMockRem();
    rem.updatedAt = 100;
    const card = createMockCard(rem);
    plugin.card.findOne.mockResolvedValue(card);
    fileShaMap['card1'] = { sha: 'old', remId: 'rem1', timestamp: 0 } as any;

    createOrUpdateFile.mockResolvedValueOnce({ ok: false, status: 409 });
    const remoteCard = { ...card, nextRepetitionTime: 300, lastRepetitionTime: 70 };
    const remoteRem = { ...rem, text: 'Q2', backText: 'A2', updatedAt: 200 };
    const remoteContent = await serializeCard(plugin as any, remoteCard as any, remoteRem as any);
    getFile.mockResolvedValue({ ok: true, status: 200, data: { content: remoteContent, sha: 'remotesha' } });

    await pushCardById(plugin, 'card1');

    expect(rem.setText).toHaveBeenCalledWith('Q2');
    expect(rem.setBackText).toHaveBeenCalledWith('A2');
    expect(fileShaMap['card1'].sha).toBe('remotesha');
    expect(createOrUpdateFile).toHaveBeenCalledTimes(1);
  });
});

describe('pullUpdates', () => {
  it('creates conflict file when timestamps equal', async () => {
    const plugin = createPlugin();
    const rem = createMockRem();
    const card = createMockCard(rem);
    plugin.card.findOne.mockResolvedValue(card);
    fileShaMap['card1'] = { sha: 'old', remId: 'rem1', timestamp: 0 } as any;

    listFiles.mockResolvedValue({ ok: true, files: [{ path: 'cards/card1.md', sha: 'new' }] });
    const remoteCard = { ...card };
    const remoteRem = { ...rem };
    const remoteContent = await serializeCard(plugin as any, remoteCard as any, remoteRem as any);
    getFile.mockResolvedValue({ ok: true, status: 200, data: { content: remoteContent, sha: 'new' } });
    createOrUpdateFile.mockResolvedValue({ ok: true, status: 200, sha: 'confsha' });

    await pullUpdates(plugin);

    expect(createOrUpdateFile).toHaveBeenCalledWith(
      plugin,
      'cards/conflicts/card1.md',
      expect.any(String),
      undefined
    );
  });
});
