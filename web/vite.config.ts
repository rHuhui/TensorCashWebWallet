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
  const connectOrigins = [exactOrigin(defaultGateway), ...configured];
  if (mode !== 'production') connectOrigins.push('http://127.0.0.1:9920');
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
