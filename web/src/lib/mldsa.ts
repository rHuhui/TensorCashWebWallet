import { sha256 } from '@noble/hashes/sha2.js';
import { secp256k1, schnorr } from '@noble/curves/secp256k1.js';
import { bech32m } from '@scure/base';
import {
  bytesToHex,
  bytesToNumberBE,
  compactSize,
  concatBytes,
  encoder,
  hexToBytes,
  numberToBytesBE,
  wipe,
} from './bytes';
import { createTensorCashMLDSA65 } from './oqs';
import type { MLDSAWalletMaterial, WalletMaterial } from './types';

const ML_DSA_ALGORITHM = 0x01;
const ML_DSA_65 = 0x41;
const OP_2 = 0x52;
const OP_CHECKMLSIGVERIFY = 0xbc;
const OP_TRUE = 0x51;
const LEAF_VERSION = 0xc0;

function taggedHash(tag: string, message: Uint8Array): Uint8Array {
  const tagHash = sha256(encoder.encode(tag));
  return sha256(concatBytes(tagHash, tagHash, message));
}

function pushData(data: Uint8Array): Uint8Array {
  if (data.length <= 0xffff) {
    return concatBytes(
      Uint8Array.of(0x4d, data.length & 0xff, (data.length >>> 8) & 0xff),
      data,
    );
  }
  throw new Error('ML-DSA public key is unexpectedly large');
}

function deriveTaproot(publicKey: Uint8Array, internalPublicKey: Uint8Array) {
  if (publicKey.length !== 1952) throw new Error('ML-DSA-65 public key must be 1,952 bytes');
  if (internalPublicKey.length !== 32) throw new Error('Internal key must be 32 bytes');

  const encodedPublicKey = concatBytes(
    Uint8Array.of(ML_DSA_ALGORITHM, ML_DSA_65),
    compactSize(publicKey.length),
    publicKey,
  );
  const tapScript = concatBytes(
    pushData(encodedPublicKey),
    Uint8Array.of(OP_CHECKMLSIGVERIFY, OP_TRUE),
  );
  const leafHash = taggedHash(
    'TapLeaf',
    concatBytes(Uint8Array.of(LEAF_VERSION), compactSize(tapScript.length), tapScript),
  );
  const tweak = taggedHash('TapTweak', concatBytes(internalPublicKey, leafHash));
  const tweakScalar = bytesToNumberBE(tweak);
  const order = secp256k1.Point.Fn.ORDER;
  if (tweakScalar === 0n || tweakScalar >= order) throw new Error('Invalid Taproot tweak');
  const internalPoint = schnorr.utils.lift_x(bytesToNumberBE(internalPublicKey));
  const outputPoint = internalPoint.add(secp256k1.Point.BASE.multiply(tweakScalar));
  outputPoint.assertValidity();
  const outputPublicKey = numberToBytesBE(outputPoint.x, 32);
  const parity = (outputPoint.y & 1n) === 1n;
  const scriptPubKey = concatBytes(Uint8Array.of(OP_2, 0x20), outputPublicKey);
  const address = bech32m.encode('tc', [2, ...bech32m.toWords(outputPublicKey)], 90);
  return {
    address,
    encodedPublicKey,
    tapScript,
    leafHash,
    outputPublicKey,
    scriptPubKey,
    parity,
  };
}

async function verifyKeyPair(publicKey: Uint8Array, secretKey: Uint8Array): Promise<void> {
  const signer = await createTensorCashMLDSA65();
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  try {
    const signature = signer.sign(challenge, secretKey);
    if (!signer.verify(challenge, signature, publicKey)) {
      throw new Error('The ML-DSA public and secret keys do not match');
    }
    wipe(signature);
  } finally {
    signer.destroy();
    wipe(challenge);
  }
}

function materialFromParts(
  publicKey: Uint8Array,
  secretKey: Uint8Array,
  internalPublicKey: Uint8Array,
  createdAt = new Date().toISOString(),
): MLDSAWalletMaterial {
  const taproot = deriveTaproot(publicKey, internalPublicKey);
  return {
    schema: 'org.tensorcash.webwallet.material',
    version: 1,
    walletId: crypto.randomUUID(),
    network: 'mainnet',
    address: taproot.address,
    createdAt,
    key: {
      algorithm: 'ML-DSA-65',
      publicKeyHex: bytesToHex(publicKey),
      secretKeyHex: bytesToHex(secretKey),
    },
    taproot: {
      encodedPublicKeyHex: bytesToHex(taproot.encodedPublicKey),
      tapScriptHex: bytesToHex(taproot.tapScript),
      scriptPubKeyHex: bytesToHex(taproot.scriptPubKey),
      internalPublicKeyHex: bytesToHex(internalPublicKey),
      outputPublicKeyHex: bytesToHex(taproot.outputPublicKey),
      leafHashHex: bytesToHex(taproot.leafHash),
      parity: taproot.parity,
    },
  };
}

export async function createWalletMaterial(): Promise<MLDSAWalletMaterial> {
  const signer = await createTensorCashMLDSA65();
  let publicKey: Uint8Array | undefined;
  let secretKey: Uint8Array | undefined;
  const internal = schnorr.keygen();
  try {
    ({ publicKey, secretKey } = signer.generateKeyPair());
    return materialFromParts(publicKey, secretKey, internal.publicKey);
  } finally {
    signer.destroy();
    wipe(internal.secretKey);
    if (publicKey) wipe(publicKey);
    if (secretKey) wipe(secretKey);
  }
}

interface OfficialMLDSAExport {
  address: string;
  pubkey: string;
  seckey: string;
  level: number;
  tapscript: string;
  scriptPubKey: string;
  encoded_pubkey: string;
  internal_pubkey: string;
  output_pubkey: string;
  parity: boolean;
}

export async function importOfficialWalletExport(value: unknown): Promise<MLDSAWalletMaterial> {
  if (!value || typeof value !== 'object') throw new Error('Invalid official wallet export');
  const input = value as Partial<OfficialMLDSAExport>;
  if (
    input.level !== 65 ||
    typeof input.address !== 'string' ||
    typeof input.pubkey !== 'string' ||
    typeof input.seckey !== 'string' ||
    typeof input.internal_pubkey !== 'string' ||
    typeof input.parity !== 'boolean'
  ) {
    throw new Error('Import requires a complete ML-DSA-65 generatemldsaaddress export');
  }
  const publicKey = hexToBytes(input.pubkey.toLowerCase());
  const secretKey = hexToBytes(input.seckey.toLowerCase());
  const internalPublicKey = hexToBytes(input.internal_pubkey.toLowerCase());
  try {
    if (publicKey.length !== 1952 || secretKey.length !== 4032) {
      throw new Error('Invalid ML-DSA-65 key size');
    }
    await verifyKeyPair(publicKey, secretKey);
    const material = materialFromParts(publicKey, secretKey, internalPublicKey);
    const checks: Array<[string | undefined, string, string]> = [
      [input.address, material.address, 'address'],
      [input.tapscript?.toLowerCase(), material.taproot.tapScriptHex, 'tapscript'],
      [input.scriptPubKey?.toLowerCase(), material.taproot.scriptPubKeyHex, 'scriptPubKey'],
      [input.encoded_pubkey?.toLowerCase(), material.taproot.encodedPublicKeyHex, 'encoded pubkey'],
      [input.output_pubkey?.toLowerCase(), material.taproot.outputPublicKeyHex, 'output pubkey'],
    ];
    for (const [provided, derived, label] of checks) {
      if (provided !== undefined && provided !== derived) {
        throw new Error(`Official wallet ${label} does not match the supplied key`);
      }
    }
    if (input.parity !== material.taproot.parity) {
      throw new Error('Official wallet parity does not match the supplied key');
    }
    return material;
  } finally {
    wipe(publicKey);
    wipe(secretKey);
    wipe(internalPublicKey);
  }
}

export function validateMaterialDerivation(material: WalletMaterial): boolean {
  if (material.key.algorithm !== 'ML-DSA-65' || !('taproot' in material)) return false;
  try {
    const derived = deriveTaproot(
      hexToBytes(material.key.publicKeyHex),
      hexToBytes(material.taproot.internalPublicKeyHex),
    );
    return (
      derived.address === material.address &&
      bytesToHex(derived.tapScript) === material.taproot.tapScriptHex &&
      bytesToHex(derived.scriptPubKey) === material.taproot.scriptPubKeyHex &&
      derived.parity === material.taproot.parity
    );
  } catch {
    return false;
  }
}
