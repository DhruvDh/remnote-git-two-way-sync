jest.mock('@remnote/plugin-sdk', () => ({}));
import { pullUpdates, fileShaMap } from '../src/github/sync';
import * as api from '../src/github/api';

describe('pullUpdates deletion confirmation', () => {
  it('calls plugin confirm when deleting a card', async () => {
    jest.spyOn(api, 'listFiles').mockResolvedValue({ ok: true, files: [] } as any);
    const confirm = jest.fn().mockResolvedValue(true);
    const remove = jest.fn();
    const card = { _id: 'c1', getRem: jest.fn().mockResolvedValue({ remove }) };
    const plugin: any = {
      settings: { getSetting: jest.fn() },
      card: { findOne: jest.fn().mockResolvedValue(card) },
      app: { confirm, toast: jest.fn() },
      window: {}
    };
    fileShaMap['c1'] = { sha: 'sha1', remId: 'r1', timestamp: Date.now() } as any;

    await pullUpdates(plugin);

    expect(confirm).toHaveBeenCalled();
    expect(remove).toHaveBeenCalled();
  });
});
