// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getWalletOverview } from './gateway';

const ADDRESS = 'tc1qg83etpvnwl8jqrexs3zsnpvpcvepwg2xduejel';

const stored = new Map<string, string>();
const testStorage: Storage = {
  get length() { return stored.size; },
  clear: () => stored.clear(),
  getItem: (key) => stored.get(key) ?? null,
  key: (index) => [...stored.keys()][index] ?? null,
  removeItem: (key) => { stored.delete(key); },
  setItem: (key, value) => { stored.set(key, String(value)); },
};

function overviewPayload() {
  return {
    status: { synced: true, indexed_height: 1, core_height: 1, lag: 0 },
    address: { address: ADDRESS, balance_sats: 0, received_sats: 0, sent_sats: 0, tx_count: 0 },
    transactions: [],
    pagination: { page: 1, pages: 0, total: 0 },
    address_count: 1,
    funded_addresses: [],
    pending_included: true,
    custody: 'none',
  };
}

beforeEach(() => {
  stored.clear();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: testStorage });
});

afterEach(() => {
  vi.restoreAllMocks();
  stored.clear();
});

describe('wallet overview request coalescing', () => {
  it('shares one HTTP request between identical simultaneous callers', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      await gate;
      return new Response(JSON.stringify(overviewPayload()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const first = getWalletOverview([ADDRESS], 1, true);
    const second = getWalletOverview([ADDRESS], 1, true);
    expect(first).toBe(second);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    release();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  it('does not merge requests with different address sets', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(overviewPayload()), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    await Promise.all([
      getWalletOverview([ADDRESS], 1, true),
      getWalletOverview([ADDRESS, `${ADDRESS}x`], 1, true),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
