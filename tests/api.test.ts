import { createOrUpdateFile } from '../src/github/api';

const mockSettings = {
  'github-repo': 'user/repo',
  'github-token': 'TOKEN',
  'github-branch': 'main',
};

const plugin: any = {
  settings: {
    getSetting: jest.fn((key: string) => mockSettings[key]),
  },
};

describe('createOrUpdateFile', () => {
  beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ content: { sha: 'newsha' } }),
    }) as any;
  });

  it('sends PUT request with encoded content', async () => {
    const result = await createOrUpdateFile(plugin, 'cards/card1.md', 'hello');

    expect(fetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/user/repo/contents/cards%2Fcard1.md',
      expect.objectContaining({
        method: 'PUT',
        headers: expect.objectContaining({ Authorization: 'token TOKEN' }),
      })
    );
    expect(result.ok).toBe(true);
    expect(result.sha).toBe('newsha');
  });
});
