import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

function exactOrigin(value: string): string {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new Error(`Invalid wallet gateway origin: ${value}`);
  }
  return url.origin;
}

function cspPlugin(connectOrigins: string[]): Plugin {
  const directive = Array.from(new Set(connectOrigins)).join(' ');
  return {
    name: 'tensorcash-exact-csp',
    transformIndexHtml(html) {
      return html.replace('__TSC_CONNECT_SRC__', directive);
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const configured = String(env.VITE_ALLOWED_GATEWAY_ORIGINS || '')
    .split(',').map((value) => value.trim()).filter(Boolean).map(exactOrigin);
  const defaultGateway = env.VITE_WALLET_GATEWAY_URL || 'https://app.tscweb.xyz/wallet';
  const marketService = env.VITE_MARKET_DATA_URL
    || (mode === 'production' ? 'https://app.tscweb.xyz/market/v1' : 'http://127.0.0.1:9930/market/v1');
  const safeTrade = env.VITE_SAFETRADE_TICKER_URL
    || 'https://safe.trade/api/v2/trade/public/tickers/tscusdt';
  const currencyRates = env.VITE_CURRENCY_RATES_URL
    || 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json';
  const connectOrigins = [
    exactOrigin(defaultGateway),
    exactOrigin(marketService),
    exactOrigin(safeTrade),
    exactOrigin(currencyRates),
    ...configured,
  ];
  if (mode !== 'production') connectOrigins.push('http://127.0.0.1:9920', 'http://127.0.0.1:9930');
  return {
    base: '/wallet/',
    plugins: [react(), cspPlugin(connectOrigins)],
    build: {
      target: 'es2022',
      sourcemap: false,
    },
    server: {
      strictPort: true,
      port: 5173,
    },
  };
});
