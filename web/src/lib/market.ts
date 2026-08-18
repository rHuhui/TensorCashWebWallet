const SAFETRADE_TICKER_URL = import.meta.env.VITE_SAFETRADE_TICKER_URL
  || 'https://safe.trade/api/v2/trade/public/tickers/tscusdt';
const MARKET_SERVICE_URL = (import.meta.env.VITE_MARKET_DATA_URL
  || (import.meta.env.DEV ? 'http://127.0.0.1:9930/market/v1' : 'https://app.tscweb.xyz/market/v1')).replace(/\/$/, '');
const CURRENCY_URL = import.meta.env.VITE_CURRENCY_RATES_URL
  || 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json';

const TICKER_CACHE_KEY = 'tensorcash-market-ticker-v1';
const CURRENCY_CACHE_KEY = 'tensorcash-market-currencies-v1';
const DISPLAY_CURRENCY_KEY = 'tensorcash-display-currency';
const TICKER_STALE_MS = 10 * 60 * 1000;
const FX_CACHE_MS = 24 * 60 * 60 * 1000;

export type TickerSource = 'safetrade-direct' | 'market-service' | 'browser-cache';

export interface TscTicker {
  market: 'tscusdt';
  name: string;
  base_unit: 'tsc';
  quote_unit: 'usdt';
  avg_price: string;
  high: string;
  last: string;
  low: string;
  open: string;
  price_change_percent: string;
  volume: string;
  amount: string;
}

export interface MarketSnapshot {
  ticker: TscTicker;
  fetchedAt: number;
  source: TickerSource;
  stale: boolean;
  upstreamError?: string;
}

export interface CurrencySnapshot {
  base: 'usd';
  date: string;
  rates: Record<string, number>;
  fetchedAt: number;
  source: 'market-service' | 'currency-api-direct' | 'browser-cache';
  stale: boolean;
}

type ServiceTickerResponse = {
  market: string;
  ticker: unknown;
  fetched_at_unix: number;
  stale: boolean;
  last_refresh_error?: string | null;
};

type ServiceCurrenciesResponse = {
  base: string;
  date: string;
  rates: unknown;
  fetched_at_unix: number;
  stale: boolean;
};

function finiteNumber(value: unknown, field: string, positive = false): string {
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error(`Invalid ${field}`);
  const number = Number(value);
  if (!Number.isFinite(number) || (positive && number <= 0)) throw new Error(`Invalid ${field}`);
  return String(value);
}

export function parseTicker(value: unknown): TscTicker {
  if (!value || typeof value !== 'object') throw new Error('Invalid SafeTrade response');
  const ticker = value as Record<string, unknown>;
  if (String(ticker.id ?? ticker.market).toLowerCase() !== 'tscusdt') throw new Error('Unexpected market');
  if (String(ticker.base_unit).toLowerCase() !== 'tsc' || String(ticker.quote_unit).toLowerCase() !== 'usdt') {
    throw new Error('Unexpected market units');
  }
  return {
    market: 'tscusdt',
    name: String(ticker.name || 'TSC/USDT').slice(0, 32),
    base_unit: 'tsc',
    quote_unit: 'usdt',
    avg_price: finiteNumber(ticker.avg_price, 'average price', true),
    high: finiteNumber(ticker.high, 'high price', true),
    last: finiteNumber(ticker.last, 'last price', true),
    low: finiteNumber(ticker.low, 'low price', true),
    open: finiteNumber(ticker.open, 'open price', true),
    price_change_percent: String(ticker.price_change_percent ?? '').slice(0, 32),
    volume: finiteNumber(ticker.volume, 'volume'),
    amount: finiteNumber(ticker.amount, 'amount'),
  };
}

function parseRates(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object') throw new Error('Invalid currency rates');
  const rates: Record<string, number> = { usd: 1 };
  for (const [rawCode, rawRate] of Object.entries(value as Record<string, unknown>)) {
    const code = rawCode.toLowerCase();
    const rate = Number(rawRate);
    if (/^[a-z0-9]{2,12}$/.test(code) && Number.isFinite(rate) && rate > 0) rates[code] = rate;
  }
  if (Object.keys(rates).length < 2) throw new Error('Currency table is empty');
  return rates;
}

async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
      cache: 'no-store',
      credentials: 'omit',
      mode: 'cors',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    window.clearTimeout(timeout);
  }
}

function readCache<T>(key: string): T | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || 'null');
    return parsed && typeof parsed === 'object' ? parsed as T : null;
  } catch {
    return null;
  }
}

function writeCache(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Cache failure is non-fatal. */ }
}

export async function loadTscTicker(now = Date.now()): Promise<MarketSnapshot | null> {
  let directError = '';
  try {
    const ticker = parseTicker(await fetchJson(SAFETRADE_TICKER_URL, 5_000));
    const snapshot: MarketSnapshot = { ticker, fetchedAt: now, source: 'safetrade-direct', stale: false };
    writeCache(TICKER_CACHE_KEY, snapshot);
    return snapshot;
  } catch (error) {
    directError = error instanceof Error ? error.message : 'SafeTrade request failed';
  }

  try {
    const payload = await fetchJson(`${MARKET_SERVICE_URL}/ticker/tscusdt`, 5_000) as ServiceTickerResponse;
    const ticker = parseTicker({ ...(payload.ticker as object), id: payload.market });
    if (!Number.isSafeInteger(payload.fetched_at_unix) || payload.fetched_at_unix <= 0) throw new Error('Invalid market timestamp');
    const fetchedAt = payload.fetched_at_unix * 1_000;
    const snapshot: MarketSnapshot = {
      ticker,
      fetchedAt,
      source: 'market-service',
      stale: Boolean(payload.stale) || now - fetchedAt > TICKER_STALE_MS,
      upstreamError: payload.last_refresh_error || directError,
    };
    writeCache(TICKER_CACHE_KEY, snapshot);
    return snapshot;
  } catch {
    const cached = readCache<MarketSnapshot>(TICKER_CACHE_KEY);
    if (!cached) return null;
    try {
      const ticker = parseTicker({ ...cached.ticker, id: cached.ticker.market });
      if (!Number.isFinite(cached.fetchedAt) || cached.fetchedAt <= 0) return null;
      return {
        ticker,
        fetchedAt: cached.fetchedAt,
        source: 'browser-cache',
        stale: now - cached.fetchedAt > TICKER_STALE_MS,
        upstreamError: directError,
      };
    } catch {
      return null;
    }
  }
}

export async function loadCurrencyRates(now = Date.now()): Promise<CurrencySnapshot | null> {
  const cached = readCache<CurrencySnapshot>(CURRENCY_CACHE_KEY);
  if (cached && Number.isFinite(cached.fetchedAt) && now - cached.fetchedAt < FX_CACHE_MS) {
    try {
      return { ...cached, rates: parseRates(cached.rates), source: 'browser-cache', stale: false };
    } catch { /* Fetch a replacement. */ }
  }

  try {
    const payload = await fetchJson(`${MARKET_SERVICE_URL}/currencies`, 6_000) as ServiceCurrenciesResponse;
    if (payload.base !== 'usd' || !Number.isSafeInteger(payload.fetched_at_unix)) throw new Error('Invalid currency response');
    const snapshot: CurrencySnapshot = {
      base: 'usd',
      date: String(payload.date),
      rates: parseRates(payload.rates),
      fetchedAt: payload.fetched_at_unix * 1_000,
      source: 'market-service',
      stale: Boolean(payload.stale),
    };
    writeCache(CURRENCY_CACHE_KEY, snapshot);
    return snapshot;
  } catch {
    try {
      const payload = await fetchJson(CURRENCY_URL, 6_000) as { date?: unknown; usd?: unknown };
      const snapshot: CurrencySnapshot = {
        base: 'usd',
        date: String(payload.date || ''),
        rates: parseRates(payload.usd),
        fetchedAt: now,
        source: 'currency-api-direct',
        stale: false,
      };
      writeCache(CURRENCY_CACHE_KEY, snapshot);
      return snapshot;
    } catch {
      if (!cached) return null;
      try {
        return {
          ...cached,
          rates: parseRates(cached.rates),
          source: 'browser-cache',
          stale: now - cached.fetchedAt > FX_CACHE_MS * 2,
        };
      } catch {
        return null;
      }
    }
  }
}

export function getDisplayCurrency(): string {
  const saved = localStorage.getItem(DISPLAY_CURRENCY_KEY)?.toLowerCase() || 'usd';
  return /^[a-z0-9]{2,12}$/.test(saved) ? saved : 'usd';
}

export function setDisplayCurrency(code: string): string {
  const normalized = code.trim().toLowerCase();
  if (!/^[a-z0-9]{2,12}$/.test(normalized)) throw new Error('Invalid display currency');
  localStorage.setItem(DISPLAY_CURRENCY_KEY, normalized);
  return normalized;
}

export function convertedTscPrice(snapshot: MarketSnapshot | null, currencies: CurrencySnapshot | null, code: string): number | null {
  if (!snapshot) return null;
  const rate = code === 'usd' ? 1 : currencies?.rates[code];
  const usdPrice = Number(snapshot.ticker.last);
  return Number.isFinite(usdPrice) && Number.isFinite(rate) ? usdPrice * Number(rate) : null;
}

export function formatCurrency(value: number, code: string): string {
  if (!Number.isFinite(value)) return '—';
  const normalized = code.toUpperCase();
  const maximumFractionDigits = Math.abs(value) < 1 ? 4 : 2;
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: normalized,
      currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: 2,
      maximumFractionDigits,
    }).format(value);
  } catch {
    return `${normalized} ${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits })}`;
  }
}
