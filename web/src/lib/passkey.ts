import { base64ToBytes, bytesToBase64, decoder, encoder, wipe } from './bytes';
import type { EncryptedVault } from './types';

export interface WalletPasskeyState {
  schema: 'org.tensorcash.webwallet.passkey';
  version: 1;
  walletId: string;
  credentialId: string;
  transports?: string[];
  rpId: string;
  prfSalt: string;
  cipher: { name: 'AES-256-GCM'; iv: string };
  wrappedPassword: string;
  createdAt: string;
}

interface PrfExtensionResults {
  prf?: {
    enabled?: boolean;
    results?: { first?: ArrayBuffer };
  };
}

const PASSKEY_SCHEMA = 'org.tensorcash.webwallet.passkey';
const PASSKEY_VERSION = 1;
const PASSKEY_TIMEOUT = 120_000;
const FALLBACK_PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function base64UrlToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid Passkey credential data');
  const padded = `${value.replaceAll('-', '+').replaceAll('_', '/')}${'='.repeat((4 - value.length % 4) % 4)}`;
  return base64ToBytes(padded);
}

function canonicalPasskeyMetadata(state: Omit<WalletPasskeyState, 'wrappedPassword'>): Uint8Array {
  return encoder.encode(JSON.stringify({
    schema: state.schema,
    version: state.version,
    walletId: state.walletId,
    credentialId: state.credentialId,
    transports: state.transports,
    rpId: state.rpId,
    prfSalt: state.prfSalt,
    cipher: state.cipher,
    createdAt: state.createdAt,
  }));
}

function currentRpId(): string {
  if (typeof location === 'undefined' || !location.hostname) throw new Error('Passkey requires a browser origin');
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(location.hostname) || location.hostname.includes(':')) {
    throw new Error('Passkey cannot use an IP address as its site identity. Open this local wallet at http://localhost instead.');
  }
  return location.hostname;
}

function requirePasskeySupport(): void {
  const reason = passkeyUnavailableReason();
  if (reason) throw new Error(reason);
}

function readablePasskeyError(error: unknown): Error {
  if (error instanceof DOMException && error.name === 'NotAllowedError') {
    return new Error('Passkey was cancelled or is unavailable. Use your wallet password instead.');
  }
  if (error instanceof DOMException && (error.name === 'NotSupportedError' || error.name === 'SecurityError')) {
    return new Error('Passkey is not available for this page or device. Use your wallet password instead.');
  }
  return error instanceof Error ? error : new Error('Passkey failed. Use your wallet password instead.');
}

function prfOutput(credential: PublicKeyCredential): Uint8Array | null {
  const results = credential.getClientExtensionResults() as unknown as PrfExtensionResults;
  const first = results.prf?.results?.first;
  if (!first) return null;
  const bytes = new Uint8Array(first);
  return bytes.length === 32 ? Uint8Array.from(bytes) : null;
}

async function requestPrf(state: Pick<WalletPasskeyState, 'credentialId' | 'transports' | 'rpId' | 'prfSalt'>): Promise<Uint8Array> {
  requirePasskeySupport();
  if (state.rpId !== currentRpId()) {
    throw new Error('This Passkey belongs to a different wallet site. Use your wallet password instead.');
  }
  const credentialId = base64UrlToBytes(state.credentialId);
  const salt = base64ToBytes(state.prfSalt);
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  try {
    const credential = await navigator.credentials.get({
      publicKey: {
        challenge: ownedBuffer(challenge),
        rpId: state.rpId,
        allowCredentials: [{
          type: 'public-key',
          id: ownedBuffer(credentialId),
          transports: state.transports as AuthenticatorTransport[] | undefined,
        }],
        userVerification: 'required',
        timeout: PASSKEY_TIMEOUT,
        extensions: {
          prf: {
            evalByCredential: {
              [state.credentialId]: { first: ownedBuffer(salt) },
            },
          },
        } as unknown as AuthenticationExtensionsClientInputs,
      },
    }) as PublicKeyCredential | null;
    if (!credential) throw new Error('Passkey was not returned. Use your wallet password instead.');
    const output = prfOutput(credential);
    if (!output) throw new Error('This Passkey cannot unlock local wallet data. Use your wallet password instead.');
    return output;
  } catch (error) {
    throw readablePasskeyError(error);
  } finally {
    wipe(credentialId);
    wipe(salt);
    wipe(challenge);
  }
}

export function passkeySupported(): boolean {
  return passkeyUnavailableReason() === null;
}

export function passkeyUnavailableReason(): string | null {
  if (typeof window === 'undefined' || typeof location === 'undefined') return 'Passkey requires a browser origin.';
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(location.hostname) || location.hostname.includes(':')) {
    return 'Passkey cannot use an IP address as its site identity. Open this local wallet at http://localhost instead.';
  }
  if (!window.isSecureContext) return 'Passkey requires HTTPS, or http://localhost for local testing.';
  if (typeof PublicKeyCredential === 'undefined' || !navigator.credentials) {
    return 'Passkey is not supported by this browser or device.';
  }
  return null;
}

export function generateFallbackPassword(): string {
  const random = crypto.getRandomValues(new Uint8Array(32));
  try {
    const characters = Array.from(random, (value) => FALLBACK_PASSWORD_ALPHABET[value & 31]);
    return Array.from({ length: 8 }, (_, index) => characters.slice(index * 4, index * 4 + 4).join('')).join('-');
  } finally {
    wipe(random);
  }
}

export function validatePasskeyState(value: unknown): asserts value is WalletPasskeyState {
  if (!value || typeof value !== 'object') throw new Error('Invalid local Passkey data');
  const state = value as Partial<WalletPasskeyState>;
  const transportsValid = state.transports === undefined || (
    Array.isArray(state.transports) && state.transports.length <= 8 &&
    state.transports.every((transport) => typeof transport === 'string' && transport.length <= 32)
  );
  if (
    state.schema !== PASSKEY_SCHEMA || state.version !== PASSKEY_VERSION ||
    typeof state.walletId !== 'string' || state.walletId.length < 1 || state.walletId.length > 200 ||
    typeof state.credentialId !== 'string' || state.credentialId.length < 8 || state.credentialId.length > 2_000 ||
    typeof state.rpId !== 'string' || state.rpId.length < 1 || state.rpId.length > 253 ||
    typeof state.prfSalt !== 'string' || typeof state.wrappedPassword !== 'string' ||
    state.cipher?.name !== 'AES-256-GCM' || typeof state.cipher.iv !== 'string' ||
    typeof state.createdAt !== 'string' || !transportsValid
  ) throw new Error('Invalid local Passkey data');
  const credentialId = base64UrlToBytes(state.credentialId);
  const salt = base64ToBytes(state.prfSalt);
  const iv = base64ToBytes(state.cipher.iv);
  const ciphertext = base64ToBytes(state.wrappedPassword);
  try {
    if (credentialId.length < 8 || credentialId.length > 1_024 || salt.length !== 32 || iv.length !== 12 || ciphertext.length < 22 || ciphertext.length > 4_096) {
      throw new Error('Invalid local Passkey data');
    }
  } finally {
    wipe(credentialId);
    wipe(salt);
    wipe(iv);
    wipe(ciphertext);
  }
}

export async function wrapPasswordWithPrfKey(
  metadata: Omit<WalletPasskeyState, 'wrappedPassword'>,
  password: string,
  prfKey: Uint8Array,
): Promise<WalletPasskeyState> {
  if (prfKey.length !== 32) throw new Error('Invalid Passkey key material');
  const normalized = password.normalize('NFKC');
  if (normalized.length < 6) throw new Error('Wallet password is invalid');
  const passwordBytes = encoder.encode(normalized);
  try {
    const key = await crypto.subtle.importKey('raw', ownedBuffer(prfKey), 'AES-GCM', false, ['encrypt']);
    const ciphertext = await crypto.subtle.encrypt({
      name: 'AES-GCM',
      iv: ownedBuffer(base64ToBytes(metadata.cipher.iv)),
      additionalData: ownedBuffer(canonicalPasskeyMetadata(metadata)),
      tagLength: 128,
    }, key, ownedBuffer(passwordBytes));
    const state: WalletPasskeyState = { ...metadata, wrappedPassword: bytesToBase64(new Uint8Array(ciphertext)) };
    validatePasskeyState(state);
    return state;
  } finally {
    wipe(passwordBytes);
  }
}

export async function unwrapPasswordWithPrfKey(state: WalletPasskeyState, prfKey: Uint8Array): Promise<string> {
  validatePasskeyState(state);
  if (prfKey.length !== 32) throw new Error('Invalid Passkey key material');
  const iv = base64ToBytes(state.cipher.iv);
  const ciphertext = base64ToBytes(state.wrappedPassword);
  const { wrappedPassword: _wrappedPassword, ...metadata } = state;
  try {
    const key = await crypto.subtle.importKey('raw', ownedBuffer(prfKey), 'AES-GCM', false, ['decrypt']);
    let plaintext: ArrayBuffer;
    try {
      plaintext = await crypto.subtle.decrypt({
        name: 'AES-GCM',
        iv: ownedBuffer(iv),
        additionalData: ownedBuffer(canonicalPasskeyMetadata(metadata)),
        tagLength: 128,
      }, key, ownedBuffer(ciphertext));
    } catch {
      throw new Error('Passkey data could not be decrypted. Use your wallet password instead.');
    }
    const passwordBytes = new Uint8Array(plaintext);
    try {
      return decoder.decode(passwordBytes);
    } finally {
      wipe(passwordBytes);
    }
  } finally {
    wipe(iv);
    wipe(ciphertext);
  }
}

export async function createPasskeyState(vault: EncryptedVault, password: string): Promise<WalletPasskeyState> {
  requirePasskeySupport();
  const rpId = currentRpId();
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const userId = crypto.getRandomValues(new Uint8Array(32));
  const salt = crypto.getRandomValues(new Uint8Array(32));
  try {
    const credential = await navigator.credentials.create({
      publicKey: {
        challenge: ownedBuffer(challenge),
        rp: { id: rpId, name: 'TensorCash Wallet' },
        user: {
          id: ownedBuffer(userId),
          name: `wallet-${vault.walletId}`,
          displayName: vault.walletName?.trim() || 'TensorCash wallet',
        },
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 },
        ],
        authenticatorSelection: {
          residentKey: 'required',
          requireResidentKey: true,
          userVerification: 'required',
        },
        attestation: 'none',
        timeout: PASSKEY_TIMEOUT,
        extensions: { prf: { eval: { first: ownedBuffer(salt) } } } as unknown as AuthenticationExtensionsClientInputs,
      },
    }) as PublicKeyCredential | null;
    if (!credential) throw new Error('Passkey was not created. Your wallet was not saved.');
    const response = credential.response as AuthenticatorAttestationResponse;
    const credentialId = bytesToBase64Url(new Uint8Array(credential.rawId));
    const transports = typeof response.getTransports === 'function' ? response.getTransports() : undefined;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const metadata: Omit<WalletPasskeyState, 'wrappedPassword'> = {
      schema: PASSKEY_SCHEMA,
      version: PASSKEY_VERSION,
      walletId: vault.walletId,
      credentialId,
      transports,
      rpId,
      prfSalt: bytesToBase64(salt),
      cipher: { name: 'AES-256-GCM', iv: bytesToBase64(iv) },
      createdAt: new Date().toISOString(),
    };
    let output = prfOutput(credential);
    if (!output) output = await requestPrf(metadata);
    try {
      return await wrapPasswordWithPrfKey(metadata, password, output);
    } finally {
      wipe(output);
      wipe(iv);
    }
  } catch (error) {
    throw readablePasskeyError(error);
  } finally {
    wipe(challenge);
    wipe(userId);
    wipe(salt);
  }
}

export async function unlockPasswordWithPasskey(state: WalletPasskeyState): Promise<string> {
  validatePasskeyState(state);
  const output = await requestPrf(state);
  try {
    return await unwrapPasswordWithPrfKey(state, output);
  } finally {
    wipe(output);
  }
}

export async function rewrapPasskeyPassword(state: WalletPasskeyState, password: string): Promise<WalletPasskeyState> {
  validatePasskeyState(state);
  const output = await requestPrf(state);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const { wrappedPassword: _wrappedPassword, ...metadata } = state;
  metadata.cipher = { name: 'AES-256-GCM', iv: bytesToBase64(iv) };
  try {
    return await wrapPasswordWithPrfKey(metadata, password, output);
  } finally {
    wipe(output);
    wipe(iv);
  }
}
