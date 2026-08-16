import type { AddressSummary, AddressTransaction, ChainStatus, WalletAddressBalance } from './types';
import type { WalletUtxo } from './transaction';

const DEFAULT_GATEWAY = import.meta.env.VITE_WALLET_GATEWAY_URL || 'https://app.tscweb.xyz/wallet';
const SETTING = 'tensorcash-wallet-gateway';
const overviewRequests = new Map<string, Promise<WalletOverviewResponse>>();

type WalletOverviewResponse = {
  status: ChainStatus;
  address: AddressSummary;
  transactions: AddressTransaction[];
  pagination: { page: number; pages: number; total: number };
  address_count: number;
  funded_addresses: WalletAddressBalance[];
  pending_included: boolean;
  pending_status?: {
    available: boolean | null;
    stale: boolean;
    observed_at: number | null;
  };
  custody: 'none';
};

function permittedGatewayOrigins(): Set<string> {
  const configured = String(import.meta.env.VITE_ALLOWED_GATEWAY_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => new URL(value).origin);
  const defaults = [location.origin, new URL(DEFAULT_GATEWAY, location.href).origin];
  if (import.meta.env.DEV) defaults.push('http://127.0.0.1:9920');
  return new Set([...defaults, ...configured]);
}

function normalizeGatewayUrl(value: string): string {
  const url = new URL(value.trim(), location.href);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Gateway URL cannot contain credentials, query parameters, or fragments');
  }
  if (location.protocol === 'https:' && url.protocol !== 'https:') {
    throw new Error('An HTTPS wallet can only use an HTTPS gateway');
  }
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Unsupported gateway protocol');
  if (!permittedGatewayOrigins().has(url.origin)) {
    throw new Error('This gateway origin is not authorized by this wallet build. Self-hosters must add it to VITE_ALLOWED_GATEWAY_ORIGINS and rebuild.');
  }
  return url.toString().replace(/\/$/, '');
}

export function getGatewayUrl(): string {
  const saved = localStorage.getItem(SETTING);
  if (!saved) return normalizeGatewayUrl(DEFAULT_GATEWAY);
  try {
    return normalizeGatewayUrl(saved);
  } catch {
    localStorage.removeItem(SETTING);
    return normalizeGatewayUrl(DEFAULT_GATEWAY);
  }
}

export function setGatewayUrl(value: string): string {
  const normalized = normalizeGatewayUrl(value);
  localStorage.setItem(SETTING, normalized);
  overviewRequests.clear();
  return normalized;
}

async function gatewayRequest<T>(path: string, init?: RequestInit, timeoutMs = 10_000): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${getGatewayUrl()}${path}`, {
      ...init,
      signal: controller.signal,
      headers: { Accept: 'application/json', ...init?.headers },
      cache: 'no-store',
    });
    const payload = (await response.json()) as T & { error?: { message?: string } };
    if (!response.ok) throw new Error(payload.error?.message || `Gateway returned HTTP ${response.status}`);
    return payload;
  } finally {
    window.clearTimeout(timeout);
  }
}

export function getStatus() {
  return gatewayRequest<{ status: ChainStatus; custody: 'none' }>('/api/v1/status');
}

export function getSummary(address: string) {
  return gatewayRequest<{ status: ChainStatus; address: AddressSummary }>(
    `/api/v1/address/${encodeURIComponent(address)}/summary`,
  );
}

export function getTransactions(address: string, page = 1) {
  return gatewayRequest<{
    status: ChainStatus;
    transactions: AddressTransaction[];
    pagination: { page: number; pages: number; total: number };
  }>(`/api/v1/address/${encodeURIComponent(address)}/transactions?page=${page}&page_size=25`);
}

export function getWalletOverview(addresses: string[], page = 1, includePending = true) {
  const body = JSON.stringify({ addresses, page, page_size: 25, include_pending: includePending });
  const key = `${getGatewayUrl()}\n${body}`;
  const existing = overviewRequests.get(key);
  if (existing) return existing;
  const request = gatewayRequest<WalletOverviewResponse>('/api/v1/wallet/overview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  overviewRequests.set(key, request);
  void request.finally(() => {
    if (overviewRequests.get(key) === request) overviewRequests.delete(key);
  }).catch(() => { /* The original caller receives the request error. */ });
  return request;
}

export function getWalletUtxos(addresses: string[]) {
  return gatewayRequest<{ status: ChainStatus; utxos: WalletUtxo[]; address_count: number; custody: 'none' }>(
    '/api/v1/wallet/utxos',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ addresses }),
    },
    30_000,
  );
}

export function getFeeEstimate() {
  return gatewayRequest<{ target_blocks: number; fee_rate_tsc_per_kvb: string | null }>('/api/v1/fees', undefined, 20_000);
}

export function testSignedTransaction(signedTx: string) {
  return gatewayRequest<{ result: { txid?: string; wtxid?: string; allowed?: boolean; vsize?: number; fees?: { base?: number }; 'reject-reason'?: string } }>(
    '/api/v1/transactions/test',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signed_tx: signedTx }),
    },
    45_000,
  );
}

export function broadcastSignedTransaction(signedTx: string) {
  return gatewayRequest<{ txid: string }>('/api/v1/transactions/broadcast', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ signed_tx: signedTx }),
  }, 45_000);
}
