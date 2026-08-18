// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { convertedTscPrice, formatCurrency, loadTscTicker, parseTicker } from './market';

const safeTrade = {
  id: 'tscusdt', name: 'TSC/USDT', base_unit: 'tsc', quote_unit: 'usdt',
  avg_price: '0.6103', high: '0.98', last: '0.65', low: '0.5', open: '0.5',
  price_change_percent: '+30.00%', volume: '6758.08', amount: '10932.59',
};

const stored = new Map<string, string>();
const testStorage: Storage = {
  get length() { return stored.size; },
  clear: () => stored.clear(),
  getItem: (key) => stored.get(key) ?? null,
  key: (index) => [...stored.keys()][index] ?? null,
  removeItem: (key) => { stored.delete(key); },
  setItem: (key, value) => { stored.set(key, String(value)); },
};

describe('market data', () => {
  beforeEach(() => {
    stored.clear();
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: testStorage });
    vi.restoreAllMocks();
  });

  it('strictly validates the SafeTrade market', () => {
    expect(parseTicker(safeTrade).last).toBe('0.65');
    expect(() => parseTicker({ ...safeTrade, id: 'other' })).toThrow('Unexpected market');
    expect(() => parseTicker({ ...safeTrade, last: '-1' })).toThrow('Invalid last price');
  });

  it('uses the independent market service after a direct request failure', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockRejectedValueOnce(new TypeError('CORS'));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      market: 'tscusdt', ticker: safeTrade, fetched_at_unix: 1_800_000_000,
      stale: false, last_refresh_error: null,
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const result = await loadTscTicker(1_800_000_100_000);
    expect(result?.source).toBe('market-service');
    expect(result?.ticker.last).toBe('0.65');
    expect(result?.stale).toBe(false);
  });

  it('marks a browser cache older than ten minutes as stale', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('offline'));
    localStorage.setItem('tensorcash-market-ticker-v1', JSON.stringify({
      ticker: parseTicker(safeTrade), fetchedAt: 1_800_000_000_000,
      source: 'safetrade-direct', stale: false,
    }));
    const result = await loadTscTicker(1_800_000_601_000);
    expect(result?.source).toBe('browser-cache');
    expect(result?.stale).toBe(true);
  });

  it('converts the USDT anchor through the selected USD currency rate', () => {
    const market = { ticker: parseTicker(safeTrade), fetchedAt: 1, source: 'safetrade-direct' as const, stale: false };
    const currencies = { base: 'usd' as const, date: '2026-08-18', rates: { usd: 1, cny: 7.2 }, fetchedAt: 1, source: 'market-service' as const, stale: false };
    expect(convertedTscPrice(market, currencies, 'cny')).toBeCloseTo(4.68);
    expect(formatCurrency(4.68, 'cny')).toContain('4.68');
  });
});
