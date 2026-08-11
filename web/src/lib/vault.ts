import { argon2idAsync } from '@noble/hashes/argon2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  decoder,
  encoder,
  wipe,
} from './bytes';
import type { EncryptedVault, VaultKdf, WalletMaterial } from './types';

export interface VaultOptions {
  memoryKiB?: number;
  iterations?: number;
  parallelism?: number;
}

const DEFAULTS: Required<VaultOptions> = {
  memoryKiB: 65_536,
  iterations: 3,
  parallelism: 1,
};

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

function canonicalMetadata(vault: Omit<EncryptedVault, 'ciphertext'>): Uint8Array {
  return encoder.encode(
    JSON.stringify({
      schema: vault.schema,
      version: vault.version,
      walletId: vault.walletId,
      walletName: vault.walletName,
      network: vault.network,
      address: vault.address,
      addresses: vault.addresses,
      receiveAddresses: vault.receiveAddresses,
      receiveAddressCount: vault.receiveAddressCount,
      createdAt: vault.createdAt,
      kdf: vault.kdf,
      cipher: vault.cipher,
    }),
  );
}

function validatePassword(password: string): Uint8Array {
  const normalized = password.normalize('NFKC');
  if (normalized.length < 6) throw new Error('Use a password with at least 6 characters');
  return encoder.encode(normalized);
}

async function deriveKey(password: Uint8Array, kdf: VaultKdf): Promise<Uint8Array> {
  if (
    kdf.name !== 'argon2id' ||
    kdf.memoryKiB < 32_768 ||
    kdf.memoryKiB > 262_144 ||
    kdf.iterations < 2 ||
    kdf.iterations > 10 ||
    kdf.parallelism !== 1
  ) {
    throw new Error('Unsupported or unsafe vault KDF parameters');
  }
  return argon2idAsync(password, base64ToBytes(kdf.salt), {
    m: kdf.memoryKiB,
    t: kdf.iterations,
    p: kdf.parallelism,
    dkLen: 32,
    asyncTick: 8,
  });
}

function validateMaterial(material: WalletMaterial): void {
  const commonValid =
    material.schema !== 'org.tensorcash.webwallet.material' ||
    material.version !== 1 ||
    material.network !== 'mainnet' ||
    !/^tc1[02-9ac-hj-np-z]{20,100}$/i.test(material.address);
  const keyValid = material.key.algorithm === 'ML-DSA-65' && 'taproot' in material
    ? material.key.publicKeyHex.length === 1952 * 2 && material.key.secretKeyHex.length === 4032 * 2
    : material.key.algorithm === 'CORE-DESCRIPTOR' && 'qt' in material &&
      material.key.descriptors.length > 0 &&
      material.qt.addresses.length > 0 &&
      Boolean(material.qt.originalFileBase64);
  if (commonValid || !keyValid) {
    throw new Error('Unsupported or invalid TensorCash wallet material');
  }
}

export async function encryptWallet(
  material: WalletMaterial,
  password: string,
  options: VaultOptions = {},
  walletName?: string,
): Promise<EncryptedVault> {
  validateMaterial(material);
  const passwordBytes = validatePassword(password);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const kdf: VaultKdf = {
    name: 'argon2id',
    salt: bytesToBase64(salt),
    memoryKiB: options.memoryKiB ?? DEFAULTS.memoryKiB,
    iterations: options.iterations ?? DEFAULTS.iterations,
    parallelism: options.parallelism ?? DEFAULTS.parallelism,
  };
  const envelope: Omit<EncryptedVault, 'ciphertext'> = {
    schema: 'org.tensorcash.webwallet.vault',
    version: 1,
    walletId: material.walletId,
    walletName: walletName?.trim() || undefined,
    network: material.network,
    address: material.address,
    addresses: 'qt' in material ? material.qt.addresses : [material.address],
    receiveAddresses: 'qt' in material ? material.qt.receiveAddresses : [material.address],
    receiveAddressCount: 'qt' in material ? material.qt.receiveAddressCount : 1,
    createdAt: material.createdAt,
    kdf,
    cipher: { name: 'AES-256-GCM', iv: bytesToBase64(iv) },
  };
  const keyBytes = await deriveKey(passwordBytes, kdf);
  try {
    const key = await crypto.subtle.importKey('raw', ownedBuffer(keyBytes), 'AES-GCM', false, ['encrypt']);
    const plaintext = encoder.encode(JSON.stringify(material));
    try {
      const ciphertext = await crypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv: ownedBuffer(iv),
          additionalData: ownedBuffer(canonicalMetadata(envelope)),
          tagLength: 128,
        },
        key,
        ownedBuffer(plaintext),
      );
      return { ...envelope, ciphertext: bytesToBase64(new Uint8Array(ciphertext)) };
    } finally {
      wipe(plaintext);
    }
  } finally {
    wipe(passwordBytes);
    wipe(keyBytes);
    wipe(salt);
    wipe(iv);
  }
}

export async function decryptWallet(vault: EncryptedVault, password: string): Promise<WalletMaterial> {
  validateVault(vault);
  const passwordBytes = validatePassword(password);
  const keyBytes = await deriveKey(passwordBytes, vault.kdf);
  const iv = base64ToBytes(vault.cipher.iv);
  try {
    const key = await crypto.subtle.importKey('raw', ownedBuffer(keyBytes), 'AES-GCM', false, ['decrypt']);
    let plaintext: ArrayBuffer;
    try {
      plaintext = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: ownedBuffer(iv),
          additionalData: ownedBuffer(canonicalMetadata(vault)),
          tagLength: 128,
        },
        key,
        ownedBuffer(base64ToBytes(vault.ciphertext)),
      );
    } catch {
      throw new Error('Incorrect password or damaged wallet backup');
    }
    const plaintextBytes = new Uint8Array(plaintext);
    try {
      const material = JSON.parse(decoder.decode(plaintextBytes)) as WalletMaterial;
      validateMaterial(material);
      if (
        material.walletId !== vault.walletId ||
        material.address !== vault.address ||
        material.network !== vault.network
      ) {
        throw new Error('Wallet metadata integrity check failed');
      }
      return material;
    } finally {
      wipe(plaintextBytes);
    }
  } finally {
    wipe(passwordBytes);
    wipe(keyBytes);
    wipe(iv);
  }
}

export function validateVault(value: unknown): asserts value is EncryptedVault {
  if (!value || typeof value !== 'object') throw new Error('Invalid wallet backup');
  const vault = value as Partial<EncryptedVault>;
  const validAddress = (address: unknown) => typeof address === 'string' && /^tc1[02-9ac-hj-np-z]{20,100}$/i.test(address);
  const validAddresses = (addresses: unknown) => addresses === undefined || (
    Array.isArray(addresses) &&
    addresses.length > 0 &&
    addresses.length <= 200 &&
    addresses.every(validAddress)
  );
  if (
    vault.schema !== 'org.tensorcash.webwallet.vault' ||
    vault.version !== 1 ||
    vault.network !== 'mainnet' ||
    vault.cipher?.name !== 'AES-256-GCM' ||
    vault.kdf?.name !== 'argon2id' ||
    typeof vault.ciphertext !== 'string' ||
    typeof vault.walletId !== 'string' ||
    (vault.walletName !== undefined && (
      typeof vault.walletName !== 'string' ||
      vault.walletName.trim().length < 1 ||
      vault.walletName.trim().length > 40
    )) ||
    !validAddress(vault.address) ||
    !validAddresses(vault.addresses) ||
    !validAddresses(vault.receiveAddresses) ||
    (vault.receiveAddressCount !== undefined && (
      !Number.isSafeInteger(vault.receiveAddressCount) ||
      vault.receiveAddressCount < 1 ||
      vault.receiveAddressCount > (vault.receiveAddresses?.length ?? 0)
    ))
  ) {
    throw new Error('Unsupported or invalid wallet backup');
  }
}

export function vaultFingerprint(vault: EncryptedVault): string {
  return bytesToHex(sha256(canonicalMetadata(vault))).slice(0, 16).toUpperCase();
}
