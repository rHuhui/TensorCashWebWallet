import { HDKey } from '@scure/bip32';
import { base58check, bech32, bech32m } from '@scure/base';
import { secp256k1, schnorr } from '@noble/curves/secp256k1.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js/dist/sql-asm.js';
import {
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  bytesToNumberBE,
  compactSize,
  concatBytes,
  encoder,
  hexToBytes,
  numberToBytesBE,
  wipe,
} from './bytes';
import type { CoreDescriptorMaterial, CoreWalletMaterial, WalletMaterial } from './types';
import type { SpendKey } from './transaction';

const CORE_SQLITE_APPLICATION_ID = 4_242_726_452;
const CORE_EXT_PUBLIC_VERSION = 0x04544350;
const CORE_EXT_PRIVATE_VERSION = 0x04544358;
const CORE_WALLET_VERSION = 299_900;
const CORE_WALLET_MIN_VERSION = 169_900;
const CORE_WALLET_KDF_ITERATIONS = 250_000;
const sqlPromise: Promise<SqlJsStatic> = initSqlJs();

function vector(value: Uint8Array): Uint8Array { return concatBytes(compactSize(value.length), value); }

function string(value: string): Uint8Array { return vector(encoder.encode(value)); }

function uint32LittleEndian(value: number): Uint8Array {
  return Uint8Array.of(value, value >>> 8, value >>> 16, value >>> 24);
}

function uint32BigEndianBytes(value: number): Uint8Array {
  return Uint8Array.of(value >>> 24, value >>> 16, value >>> 8, value);
}

function serializeCachedExtendedPublicKey(key: HDKey): Uint8Array {
  if (!key.publicKey || !key.chainCode) throw new Error('Unable to serialize TensorCash descriptor cache');
  return concatBytes(
    Uint8Array.of(key.depth),
    uint32BigEndianBytes(key.parentFingerprint),
    uint32BigEndianBytes(key.index),
    key.chainCode,
    key.publicKey,
  );
}

function uint64LittleEndian(value: number): Uint8Array {
  return concatBytes(uint32LittleEndian(value), uint32LittleEndian(Math.floor(value / 0x1_0000_0000)));
}

function descriptorChecksum(descriptor: string): string {
  const input = "0123456789()[],'/*abcdefgh@:$%{}IJKLMNOPQRSTUVWXYZ&+-.;<=>?!^_|~ijklmnopqrstuvwxyzABCDEFGH`#\"\\ ";
  const output = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const polymod = (checksum: bigint, value: number): bigint => {
    const top = checksum >> 35n;
    let next = ((checksum & 0x7ffffffffn) << 5n) ^ BigInt(value);
    const generators = [0xf5dee51989n, 0xa9fdca3312n, 0x1bab10e32dn, 0x3706b1677an, 0x644d626ffdn];
    generators.forEach((generator, index) => { if ((top & (1n << BigInt(index))) !== 0n) next ^= generator; });
    return next;
  };
  let checksum = 1n;
  let group = 0;
  let groupLength = 0;
  for (const character of descriptor) {
    const position = input.indexOf(character);
    if (position < 0) throw new Error('Unable to encode TensorCash descriptor');
    checksum = polymod(checksum, position & 31);
    group = group * 3 + (position >> 5);
    if (++groupLength === 3) { checksum = polymod(checksum, group); group = 0; groupLength = 0; }
  }
  if (groupLength) checksum = polymod(checksum, group);
  for (let index = 0; index < 8; index += 1) checksum = polymod(checksum, 0);
  checksum ^= 1n;
  return Array.from({ length: 8 }, (_, index) => output[Number((checksum >> BigInt(5 * (7 - index))) & 31n)]).join('');
}

class Reader {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  get remaining(): number { return this.bytes.length - this.offset; }

  readBytes(length: number): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.remaining) {
      throw new Error('Damaged TensorCash wallet record');
    }
    const value = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  readUint8(): number { return this.readBytes(1)[0]; }

  readUint16(): number {
    const value = this.readBytes(2);
    return value[0] | (value[1] << 8);
  }

  readUint32(): number {
    const value = this.readBytes(4);
    return (value[0] | (value[1] << 8) | (value[2] << 16) | (value[3] << 24)) >>> 0;
  }

  readInt32(): number { return this.readUint32() | 0; }

  readUint64(): number {
    const low = this.readUint32();
    const high = this.readUint32();
    const value = high * 0x1_0000_0000 + low;
    if (!Number.isSafeInteger(value)) throw new Error('Unsupported 64-bit wallet value');
    return value;
  }

  readCompactSize(): number {
    const marker = this.readUint8();
    if (marker < 253) return marker;
    if (marker === 253) {
      const value = this.readUint16();
      if (value < 253) throw new Error('Non-canonical wallet length');
      return value;
    }
    if (marker === 254) {
      const value = this.readUint32();
      if (value < 0x1_0000) throw new Error('Non-canonical wallet length');
      return value;
    }
    const value = this.readUint64();
    if (value < 0x1_0000_0000) throw new Error('Non-canonical wallet length');
    return value;
  }

  readVector(): Uint8Array { return this.readBytes(this.readCompactSize()); }

  readString(): string { return new TextDecoder('utf-8', { fatal: true }).decode(this.readVector()); }
}

interface RecordRow { key: Uint8Array; value: Uint8Array; type: string }
interface DescriptorRow {
  id: Uint8Array;
  idHex: string;
  descriptor: string;
  creationTime: number;
  nextIndex: number;
  rangeEnd: number;
}
interface DescriptorSecret { publicKey: Uint8Array; privateKey: Uint8Array }
interface MasterKeyRecord {
  encryptedKey: Uint8Array;
  salt: Uint8Array;
  method: number;
  iterations: number;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

function hash256(value: Uint8Array): Uint8Array { return sha256(sha256(value)); }

function rowsFromDatabase(database: Database): RecordRow[] {
  const tables = database.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='main'");
  if (!tables.length || !tables[0].values.length) throw new Error('Not a TensorCash Qt wallet database');
  const statement = database.prepare('SELECT key, value FROM main');
  const rows: RecordRow[] = [];
  try {
    while (statement.step()) {
      const row = statement.get();
      if (!(row[0] instanceof Uint8Array) || !(row[1] instanceof Uint8Array)) {
        throw new Error('Invalid TensorCash wallet row');
      }
      const key = Uint8Array.from(row[0]);
      const value = Uint8Array.from(row[1]);
      const type = new Reader(key).readString();
      rows.push({ key, value, type });
    }
  } finally {
    statement.free();
  }
  return rows;
}

async function readRows(file: Uint8Array): Promise<RecordRow[]> {
  if (file.length < 100 || new TextDecoder().decode(file.slice(0, 16)) !== 'SQLite format 3\u0000') {
    throw new Error('Qt backup must be a SQLite wallet.dat file');
  }
  const SQL = await sqlPromise;
  const database = new SQL.Database(file);
  try {
    const appId = database.exec('PRAGMA application_id')[0]?.values[0]?.[0];
    if (typeof appId === 'number' && (appId >>> 0) !== CORE_SQLITE_APPLICATION_ID) {
      throw new Error('SQLite file is not a TensorCash Core wallet');
    }
    return rowsFromDatabase(database);
  } finally {
    database.close();
  }
}

function parseDescriptor(row: RecordRow): DescriptorRow {
  const key = new Reader(row.key);
  key.readString();
  const id = key.readBytes(32);
  const value = new Reader(row.value);
  const descriptor = value.readString();
  const creationTime = value.readUint64();
  const nextIndex = value.readInt32();
  value.readInt32();
  const rangeEnd = value.readInt32();
  return { id, idHex: bytesToHex(id), descriptor, creationTime, nextIndex, rangeEnd };
}

function parseMasterKey(row: RecordRow): MasterKeyRecord {
  const value = new Reader(row.value);
  return {
    encryptedKey: value.readVector(),
    salt: value.readVector(),
    method: value.readUint32(),
    iterations: value.readUint32(),
  };
}

function parseDescriptorKey(row: RecordRow, masterKey: Uint8Array | null): Promise<[string, DescriptorSecret]> {
  const key = new Reader(row.key);
  key.readString();
  const descriptorId = bytesToHex(key.readBytes(32));
  const publicKey = key.readVector();
  const value = new Reader(row.value);
  if (row.type === 'walletdescriptorkey') {
    const der = value.readVector();
    const checksum = value.readBytes(32);
    const calculatedChecksum = hash256(concatBytes(publicKey, der));
    if (!sameBytes(calculatedChecksum, checksum) || der.length < 40 || der[6] !== 0x04 || der[7] !== 0x20) {
      throw new Error('Qt wallet descriptor key checksum is invalid');
    }
    const privateKey = der.slice(8, 40);
    if (!sameBytes(secp256k1.getPublicKey(privateKey, true), publicKey)) {
      wipe(privateKey);
      throw new Error('Qt wallet descriptor key does not match its public key');
    }
    return Promise.resolve([descriptorId, { publicKey, privateKey }]);
  }
  if (!masterKey) throw new Error('Qt wallet is encrypted and requires its wallet password');
  const encryptedSecret = value.readVector();
  return decryptAesCbc(masterKey, hash256(publicKey).slice(0, 16), encryptedSecret).then((privateKey) => {
    if (privateKey.length !== 32 || !sameBytes(secp256k1.getPublicKey(privateKey, true), publicKey)) {
      wipe(privateKey);
      throw new Error('Incorrect Qt wallet password or damaged descriptor key');
    }
    return [descriptorId, { publicKey, privateKey }];
  });
}

async function decryptAesCbc(keyBytes: Uint8Array, iv: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array> {
  try {
    const key = await crypto.subtle.importKey('raw', Uint8Array.from(keyBytes), 'AES-CBC', false, ['decrypt']);
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: Uint8Array.from(iv) }, key, Uint8Array.from(ciphertext)));
  } catch {
    throw new Error('Incorrect Qt wallet password or damaged encrypted wallet');
  }
}

async function encryptAesCbc(keyBytes: Uint8Array, iv: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', Uint8Array.from(keyBytes), 'AES-CBC', false, ['encrypt']);
  return new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-CBC', iv: Uint8Array.from(iv) },
    key,
    Uint8Array.from(plaintext),
  ));
}

async function deriveQtPassphraseKey(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  let derived = sha512(concatBytes(encoder.encode(password), salt));
  for (let index = 1; index < iterations; index += 1) {
    derived = sha512(derived);
    // TensorCash Core uses a deliberately expensive passphrase derivation.
    // Yield between bounded chunks so password actions keep their progress
    // indicator animated instead of freezing the browser's main thread.
    if (index % 8_192 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return derived;
}

async function unlockMasterKey(record: MasterKeyRecord, password: string): Promise<Uint8Array> {
  if (record.method !== 0 || record.salt.length !== 8 || record.iterations < 1 || record.iterations > 100_000_000) {
    throw new Error('Unsupported Qt wallet encryption parameters');
  }
  const derived = await deriveQtPassphraseKey(password, record.salt, record.iterations);
  try {
    const masterKey = await decryptAesCbc(derived.slice(0, 32), derived.slice(32, 48), record.encryptedKey);
    if (masterKey.length !== 32) {
      wipe(masterKey);
      throw new Error('Incorrect Qt wallet password');
    }
    return masterKey;
  } finally {
    wipe(derived);
  }
}

function descriptorKind(descriptor: string): CoreDescriptorMaterial['outputType'] | null {
  if (descriptor.startsWith('wpkh(')) return 'bech32';
  if (descriptor.startsWith('sh(wpkh(')) return 'p2sh-segwit';
  if (descriptor.startsWith('pkh(')) return 'legacy';
  // v1.0.1 supports key-path-only tr(KEY) descriptors. A comma denotes a
  // tapscript tree whose Merkle root must be part of TapTweak; do not silently
  // derive it with key-path-only semantics. rawtr() is deliberately excluded.
  const body = descriptor.split('#', 1)[0];
  if (body.startsWith('tr(') && !body.includes(',')) return 'bech32m';
  return null;
}

function taggedHash(tag: string, message: Uint8Array): Uint8Array {
  const tagHash = sha256(encoder.encode(tag));
  return sha256(concatBytes(tagHash, tagHash, message));
}

/**
 * Applies the BIP341 key-path TapTweak used by Core's `tr()` descriptors.
 * `rawtr()` deliberately does not apply this tweak and is not accepted by the
 * descriptor parser in this wallet.
 */
export function bip341OutputKey(internalPublicKey: Uint8Array, merkleRoot?: Uint8Array): Uint8Array {
  if (internalPublicKey.length !== 32) throw new Error('Taproot internal key must be 32 bytes');
  if (merkleRoot && merkleRoot.length !== 32) throw new Error('Taproot Merkle root must be 32 bytes');
  const tweak = bytesToNumberBE(taggedHash(
    'TapTweak',
    merkleRoot ? concatBytes(internalPublicKey, merkleRoot) : internalPublicKey,
  ));
  if (tweak >= secp256k1.Point.Fn.ORDER) throw new Error('Invalid Taproot tweak');
  const internalPoint = schnorr.utils.lift_x(bytesToNumberBE(internalPublicKey));
  const outputPoint = tweak === 0n
    ? internalPoint
    : internalPoint.add(secp256k1.Point.BASE.multiply(tweak));
  outputPoint.assertValidity();
  return numberToBytesBE(outputPoint.x, 32);
}

function descriptorPublicHdKey(descriptor: string): { publicRoot: HDKey; suffix: string; publicVersion: number } {
  const withoutChecksum = descriptor.split('#', 1)[0];
  const match = withoutChecksum.match(/([1-9A-HJ-NP-Za-km-z]{80,120})((?:\/(?:\d+)(?:h|')?)*\/\*)/);
  if (!match) throw new Error('Unsupported Qt wallet descriptor');
  const extendedKeyBytes = base58check(sha256).decode(match[1]);
  if (extendedKeyBytes.length !== 78) throw new Error('Invalid TensorCash extended public key');
  const publicVersion = (
    extendedKeyBytes[0] * 0x1_0000_00 +
    extendedKeyBytes[1] * 0x1_0000 +
    extendedKeyBytes[2] * 0x100 +
    extendedKeyBytes[3]
  ) >>> 0;
  const versions = { public: publicVersion, private: 0x0488ade4 };
  const publicRoot = HDKey.fromExtendedKey(match[1], versions);
  if (!publicRoot.chainCode) throw new Error('Qt descriptor is missing its BIP32 chain code');
  return { publicRoot, suffix: match[2], publicVersion };
}

function uint32BigEndian(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] * 0x1_0000_00 +
    bytes[offset + 1] * 0x1_0000 +
    bytes[offset + 2] * 0x100 +
    bytes[offset + 3]
  ) >>> 0;
}

function descriptorLastHardenedRoots(rows: RecordRow[]): Map<string, HDKey> {
  const roots = new Map<string, HDKey>();
  for (const row of rows.filter((candidate) => candidate.type === 'walletdescriptorlhcache')) {
    const key = new Reader(row.key);
    key.readString();
    const descriptorId = bytesToHex(key.readBytes(32));
    key.readUint32();
    const encoded = new Reader(row.value).readVector();
    if (encoded.length !== 74 || (encoded[41] !== 0x02 && encoded[41] !== 0x03)) continue;
    roots.set(descriptorId, new HDKey({
      versions: { public: 0x0488b21e, private: 0x0488ade4 },
      depth: encoded[0],
      parentFingerprint: uint32BigEndian(encoded, 1),
      index: uint32BigEndian(encoded, 5),
      chainCode: encoded.slice(9, 41),
      publicKey: encoded.slice(41, 74),
    }));
  }
  return roots;
}

function suffixAfterLastHardened(suffix: string): string {
  const components = suffix.split('/').filter(Boolean);
  let lastHardened = -1;
  components.forEach((component, index) => {
    if (/[h']$/.test(component)) lastHardened = index;
  });
  return `/${components.slice(lastHardened + 1).join('/')}`;
}

function descriptorHdKey(descriptor: string, privateKey: Uint8Array): { root: HDKey; suffix: string } {
  const { publicRoot, suffix, publicVersion } = descriptorPublicHdKey(descriptor);
  const versions = { public: publicVersion, private: 0x0488ade4 };
  const root = new HDKey({
    versions,
    depth: publicRoot.depth,
    index: publicRoot.index,
    parentFingerprint: publicRoot.parentFingerprint,
    chainCode: publicRoot.chainCode!,
    privateKey,
  });
  if (!sameBytes(root.publicKey ?? new Uint8Array(), publicRoot.publicKey ?? new Uint8Array())) {
    throw new Error('Qt descriptor private key does not match its xpub');
  }
  return { root, suffix };
}

function deriveAddressFromRoot(descriptor: string, root: HDKey, suffix: string, index: number): string {
  const type = descriptorKind(descriptor);
  const path = `m${suffix.replace(/h/g, "'").replace('*', String(index))}`;
  const child = root.derive(path);
  try {
    if (!child.publicKey) throw new Error('Unable to derive Qt wallet address');
    if (type === 'bech32') {
      const program = ripemd160(sha256(child.publicKey));
      return bech32.encode('tc', [0, ...bech32.toWords(program)]);
    }
    if (type === 'bech32m') {
      const outputKey = bip341OutputKey(child.publicKey.slice(1, 33));
      return bech32m.encode('tc', [1, ...bech32m.toWords(outputKey)]);
    }
    throw new Error(`Qt ${type ?? 'unknown'} addresses are not yet selectable in the web wallet`);
  } finally {
    child.wipePrivateData();
  }
}

function deriveAddress(descriptor: string, privateKey: Uint8Array, index: number): string {
  const { root, suffix } = descriptorHdKey(descriptor, privateKey);
  return deriveAddressFromRoot(descriptor, root, suffix, index);
}

function activeDescriptorIds(rows: RecordRow[], type: 'activeexternalspk' | 'activeinternalspk'): Set<string> {
  const ids = new Set<string>();
  for (const row of rows.filter((candidate) => candidate.type === type)) {
    if (row.value.length === 32) ids.add(bytesToHex(row.value));
  }
  return ids;
}

function addressBookAddresses(rows: RecordRow[]): string[] {
  const addresses: string[] = [];
  for (const row of rows.filter((candidate) => candidate.type === 'name')) {
    const key = new Reader(row.key);
    key.readString();
    const address = key.readString();
    if (/^tc1[02-9ac-hj-np-z]{20,100}$/i.test(address)) addresses.push(address);
  }
  return addresses;
}

interface NewQtDescriptor {
  id: Uint8Array;
  descriptor: string;
  internal: boolean;
  nextIndex: number;
  parentCache: Uint8Array;
  lastHardenedCache: Uint8Array;
  material: CoreDescriptorMaterial;
}

function newQtDescriptor(root: HDKey, branch: 0 | 1, creationTime: number, privateKeyHex: string): NewQtDescriptor {
  if (!root.publicKey || !root.chainCode) throw new Error('Unable to create TensorCash descriptor');
  const body = `wpkh(${root.publicExtendedKey}/${branch}/*)`;
  const descriptor = `${body}#${descriptorChecksum(body)}`;
  const id = sha256(encoder.encode(descriptor));
  // Address zero is displayed immediately by the Web Wallet, so it is already
  // exposed and Core's next unused receive index is one.
  const nextIndex = branch === 0 ? 1 : 0;
  const branchRoot = root.deriveChild(branch);
  if (!branchRoot.publicKey || !branchRoot.chainCode) throw new Error('Unable to cache TensorCash descriptor branch');
  return {
    id,
    descriptor,
    internal: branch === 1,
    nextIndex,
    // Core's parent cache is the xpub immediately before the wildcard. The
    // last-hardened cache remains the descriptor root because /0 and /1 are
    // non-hardened. Storing the root in both records makes Core derive the
    // wrong scripts even though listdescriptors still looks correct.
    parentCache: serializeCachedExtendedPublicKey(branchRoot),
    lastHardenedCache: serializeCachedExtendedPublicKey(root),
    material: {
      descriptorIdHex: bytesToHex(id),
      descriptor,
      internal: branch === 1,
      active: true,
      outputType: 'bech32',
      nextIndex,
      rangeEnd: 1_000,
      masterPrivateKeyHex: privateKeyHex,
    },
  };
}

/**
 * Repairs backups created by the first Web Wallet Qt exporter. That exporter
 * put the descriptor root in Core's parent-xpub cache for both /0/* and /1/*.
 * Core could list the descriptors, but resolved their scripts through the
 * incorrect cache and therefore did not recognise the Web receive address.
 *
 * Official/imported Qt files are returned byte-for-byte. The repair is only
 * applied to the exact two-descriptor shape emitted by the legacy exporter.
 */
export async function repairLegacyQtBackup(file: Uint8Array, expectedAddress: string): Promise<Uint8Array> {
  const rows = await readRows(file);
  const descriptors = rows.filter((row) => row.type === 'walletdescriptor').map((row) => ({ row, ...parseDescriptor(row) }));
  if (descriptors.length !== 2) return file;
  const externalIds = activeDescriptorIds(rows, 'activeexternalspk');
  const cacheRows = new Map<string, { parent?: RecordRow; lastHardened?: RecordRow }>();
  for (const row of rows) {
    if (row.type !== 'walletdescriptorcache' && row.type !== 'walletdescriptorlhcache') continue;
    const key = new Reader(row.key);
    key.readString();
    const idHex = bytesToHex(key.readBytes(32));
    const entry = cacheRows.get(idHex) ?? {};
    if (row.type === 'walletdescriptorcache') entry.parent = row;
    else entry.lastHardened = row;
    cacheRows.set(idHex, entry);
  }

  const parsed = descriptors.map((descriptor) => {
    const { publicRoot, suffix } = descriptorPublicHdKey(descriptor.descriptor);
    const branchMatch = suffix.match(/^\/([01])\/\*$/);
    const cache = cacheRows.get(descriptor.idHex);
    if (!branchMatch || !cache?.parent || !cache.lastHardened) return null;
    return {
      ...descriptor,
      publicRoot,
      branch: Number(branchMatch[1]) as 0 | 1,
      parentRow: cache.parent,
      lastHardenedRow: cache.lastHardened,
      parentCache: new Reader(cache.parent.value).readVector(),
      lastHardenedCache: new Reader(cache.lastHardened.value).readVector(),
    };
  });
  if (parsed.some((entry) => !entry)) return file;
  const complete = parsed.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
  if (new Set(complete.map((entry) => entry.branch)).size !== 2) return file;
  if (!complete.every((entry) => sameBytes(entry.parentCache, entry.lastHardenedCache))) return file;

  const external = complete.find((entry) => entry.branch === 0 && externalIds.has(entry.idHex));
  if (!external) return file;
  const firstReceive = deriveAddressFromRoot(external.descriptor, external.publicRoot, '/0/*', 0);
  if (firstReceive !== expectedAddress) return file;

  const SQL = await sqlPromise;
  const database = new SQL.Database(file);
  try {
    const update = database.prepare('UPDATE main SET value = ? WHERE key = ?');
    try {
      for (const entry of complete) {
        const branchRoot = entry.publicRoot.deriveChild(entry.branch);
        update.run([vector(serializeCachedExtendedPublicKey(branchRoot)), entry.parentRow.key]);
      }
    } finally {
      update.free();
    }
    return Uint8Array.from(database.export());
  } finally {
    database.close();
  }
}

const RECEIVE_LOOKAHEAD = 20;
const MAX_DERIVED_ADDRESSES = 200;

interface IssuedReceiveAddress {
  address: string;
  createdAt: number;
}

function receiveRequestValue(address: string, id: number, createdAt: number): Uint8Array {
  // RecentRequestEntry followed by SendCoinsRecipient, matching the exact
  // Core/Qt serialization in recentrequeststablemodel.h and
  // sendcoinsrecipient.h. The request has no amount, label or message: its
  // purpose is to make an already-issued Web receive address visible in Qt's
  // "Recent requests" table after a restore.
  return vector(concatBytes(
    uint32LittleEndian(1),
    uint64LittleEndian(id),
    uint32LittleEndian(createdAt),
    uint32LittleEndian(1),
    string(address),
    string(''),
    uint64LittleEndian(0),
    string(''),
    string(''),
    string(''),
    Uint8Array.of(0),
    uint64LittleEndian(0),
    Uint8Array.of(8),
    string(''),
  ));
}

function addressMetadata(rows: RecordRow[]): {
  names: Set<string>;
  purposes: Set<string>;
  requestAddresses: Set<string>;
  maxRequestId: number;
} {
  const names = new Set<string>();
  const purposes = new Set<string>();
  const requestAddresses = new Set<string>();
  let maxRequestId = 0;
  for (const row of rows) {
    if (row.type !== 'name' && row.type !== 'purpose' && row.type !== 'destdata') continue;
    try {
      const key = new Reader(row.key);
      key.readString();
      const address = key.readString();
      if (row.type === 'name') names.add(address);
      if (row.type === 'purpose') purposes.add(address);
      if (row.type === 'destdata') {
        const match = key.readString().match(/^rr(\d+)$/);
        if (!match) continue;
        requestAddresses.add(address);
        const id = Number(match[1]);
        if (Number.isSafeInteger(id)) maxRequestId = Math.max(maxRequestId, id);
      }
    } catch {
      // Unknown destination metadata is preserved byte-for-byte.
    }
  }
  return { names, purposes, requestAddresses, maxRequestId };
}

function issuedReceiveAddresses(rows: RecordRow[]): IssuedReceiveAddress[] {
  const externalIds = activeDescriptorIds(rows, 'activeexternalspk');
  const cachedRoots = descriptorLastHardenedRoots(rows);
  const result: IssuedReceiveAddress[] = [];
  for (const row of rows.filter((candidate) => candidate.type === 'walletdescriptor')) {
    const descriptor = parseDescriptor(row);
    const type = descriptorKind(descriptor.descriptor);
    if (!externalIds.has(descriptor.idHex) || (type !== 'bech32' && type !== 'bech32m')) continue;
    const cachedRoot = cachedRoots.get(descriptor.idHex);
    if (!cachedRoot) continue;
    const { suffix } = descriptorPublicHdKey(descriptor.descriptor);
    const count = Math.max(1, Math.min(MAX_DERIVED_ADDRESSES, descriptor.nextIndex));
    for (let index = 0; index < count; index += 1) {
      result.push({
        address: deriveAddressFromRoot(
          descriptor.descriptor,
          cachedRoot,
          suffixAfterLastHardened(suffix),
          index,
        ),
        createdAt: Math.max(0, Math.min(0xffff_ffff, descriptor.creationTime || Math.floor(Date.now() / 1_000))),
      });
    }
  }
  return result;
}

/**
 * Core owns descriptor-derived addresses independently from Qt's receive
 * request history. Qt's Receive screen only lists addresses with a `destdata
 * / rr#` record, so merely writing name/purpose makes the key spendable but
 * leaves it invisible from that screen. Add the standard metadata for every
 * issued external address while preserving all existing labels and requests.
 */
export async function ensureQtReceiveRequestRecords(file: Uint8Array): Promise<Uint8Array> {
  const rows = await readRows(file);
  const issued = issuedReceiveAddresses(rows);
  const metadata = addressMetadata(rows);
  const needsUpdate = issued.some(({ address }) => (
    !metadata.names.has(address) ||
    !metadata.purposes.has(address) ||
    !metadata.requestAddresses.has(address)
  ));
  if (!needsUpdate) return file;

  const SQL = await sqlPromise;
  const database = new SQL.Database(file);
  let nextRequestId = metadata.maxRequestId;
  try {
    for (const { address, createdAt } of issued) {
      if (!metadata.names.has(address)) {
        database.run('INSERT OR REPLACE INTO main(key, value) VALUES(?, ?)', [
          concatBytes(string('name'), string(address)),
          string(''),
        ]);
      }
      if (!metadata.purposes.has(address)) {
        database.run('INSERT OR REPLACE INTO main(key, value) VALUES(?, ?)', [
          concatBytes(string('purpose'), string(address)),
          string('receive'),
        ]);
      }
      if (!metadata.requestAddresses.has(address)) {
        nextRequestId += 1;
        database.run('INSERT OR REPLACE INTO main(key, value) VALUES(?, ?)', [
          concatBytes(string('destdata'), string(address), string(`rr${nextRequestId}`)),
          receiveRequestValue(address, nextRequestId, createdAt),
        ]);
      }
    }
    return Uint8Array.from(database.export());
  } finally {
    database.close();
  }
}

export async function prepareQtBackup(file: Uint8Array, expectedAddress: string): Promise<Uint8Array> {
  return ensureQtReceiveRequestRecords(await repairLegacyQtBackup(file, expectedAddress));
}

function activeReceiveDescriptor(material: CoreWalletMaterial): CoreDescriptorMaterial | null {
  const external = material.key.descriptors.filter((descriptor) => !descriptor.internal);
  return external.find((descriptor) => descriptor.active && descriptor.outputType === 'bech32')
    ?? external.find((descriptor) => descriptor.outputType === 'bech32')
    ?? external.find((descriptor) => descriptor.active && descriptor.outputType === 'bech32m')
    ?? external.find((descriptor) => descriptor.outputType === 'bech32m')
    ?? null;
}

function activeChangeDescriptor(material: CoreWalletMaterial): CoreDescriptorMaterial | null {
  const internal = material.key.descriptors.filter((descriptor) => descriptor.internal);
  return internal.find((descriptor) => descriptor.active && descriptor.outputType === 'bech32')
    ?? internal.find((descriptor) => descriptor.outputType === 'bech32')
    ?? null;
}

/**
 * Resolves one standard Core descriptor P2WPKH key in transient memory. The
 * returned arrays are owned by the caller and must be wiped after signing.
 */
export function resolveQtP2wpkhSpendKey(material: CoreWalletMaterial, address: string): SpendKey {
  const resolver = createQtP2wpkhSpendKeyResolver(material, [address]);
  try {
    return resolver.resolve(address);
  } finally {
    resolver.destroy();
  }
}

export interface QtP2wpkhSpendKeyResolver {
  resolve(address: string): SpendKey;
  destroy(): void;
}

/**
 * Builds one transient address-to-key map for all inputs in a transaction.
 * This avoids repeating descriptor derivation for every UTXO. `resolve()`
 * returns caller-owned copies; `destroy()` wipes the resolver's cached keys.
 */
export function createQtP2wpkhSpendKeyResolver(
  material: CoreWalletMaterial,
  requestedAddresses: string[],
): QtP2wpkhSpendKeyResolver {
  const requested = new Set(requestedAddresses.map((address) => address.toLowerCase()));
  const cached = new Map<string, SpendKey>();
  for (const descriptor of material.key.descriptors) {
    if (descriptor.outputType !== 'bech32' || cached.size === requested.size) continue;
    const masterPrivateKey = hexToBytes(descriptor.masterPrivateKeyHex);
    let root: HDKey | null = null;
    try {
      const resolved = descriptorHdKey(descriptor.descriptor, masterPrivateKey);
      root = resolved.root;
      const maximum = Math.min(
        MAX_DERIVED_ADDRESSES,
        Math.max(0, descriptor.rangeEnd + 1),
        Math.max(1, descriptor.nextIndex + RECEIVE_LOOKAHEAD),
      );
      for (let index = 0; index < maximum; index += 1) {
        if (cached.size === requested.size) break;
        const path = `m${resolved.suffix.replace(/h/g, "'").replace('*', String(index))}`;
        const child = root.derive(path);
        try {
          if (!child.publicKey || !child.privateKey) continue;
          const program = ripemd160(sha256(child.publicKey));
          const candidate = bech32.encode('tc', [0, ...bech32.toWords(program)]);
          if (requested.has(candidate) && !cached.has(candidate)) {
            cached.set(candidate, {
              privateKey: Uint8Array.from(child.privateKey),
              publicKey: Uint8Array.from(child.publicKey),
            });
          }
        } finally {
          child.wipePrivateData();
        }
      }
    } finally {
      wipe(masterPrivateKey);
      root?.wipePrivateData();
    }
  }
  const missing = [...requested].filter((address) => !cached.has(address));
  if (missing.length) {
    cached.forEach((key) => { wipe(key.privateKey); wipe(key.publicKey); });
    throw new Error('The wallet does not control a selected transaction input');
  }
  let destroyed = false;
  return {
    resolve(address: string): SpendKey {
      if (destroyed) throw new Error('The transaction key resolver has been destroyed');
      const key = cached.get(address.toLowerCase());
      if (!key) throw new Error('The wallet does not control a selected transaction input');
      return {
        privateKey: Uint8Array.from(key.privateKey),
        publicKey: Uint8Array.from(key.publicKey),
      };
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      cached.forEach((key) => { wipe(key.privateKey); wipe(key.publicKey); });
      cached.clear();
    },
  };
}

function derivePublicDescriptorAddress(descriptor: CoreDescriptorMaterial, index: number): string {
  const { publicRoot, suffix } = descriptorPublicHdKey(descriptor.descriptor);
  // Standard Qt descriptors commonly keep a master xpub in the descriptor
  // and append BIP44/49/84/86 hardened account components. An xpub cannot
  // derive those components, even though the imported wallet material also
  // contains the matching private descriptor key. Use that private key only
  // in transient unlocked memory for hardened paths; public-only paths keep
  // the cheaper xpub derivation.
  if (!/\/(?:\d+)(?:h|')/.test(suffix)) {
    return deriveAddressFromRoot(descriptor.descriptor, publicRoot, suffix, index);
  }
  const privateKey = hexToBytes(descriptor.masterPrivateKeyHex);
  try {
    return deriveAddress(descriptor.descriptor, privateKey, index);
  } finally {
    wipe(privateKey);
  }
}

export function hydrateQtAddressState(material: CoreWalletMaterial): CoreWalletMaterial {
  const receive = activeReceiveDescriptor(material);
  if (!receive) return material;
  const exposedCount = Math.max(1, Math.min(MAX_DERIVED_ADDRESSES, receive.nextIndex));
  const descriptorLimit = Math.max(1, Math.min(MAX_DERIVED_ADDRESSES, receive.rangeEnd + 1));
  const monitoredCount = Math.min(descriptorLimit, exposedCount + RECEIVE_LOOKAHEAD);
  const receiveAddresses = Array.from(
    { length: monitoredCount },
    (_, index) => derivePublicDescriptorAddress(receive, index),
  );
  // Reconstruct the watch set exclusively from spendable descriptors. Qt's
  // address book can contain contacts, which must never be counted as owned.
  // Both the external receive chain and internal change chain need lookahead;
  // otherwise a Qt spend can move funds to change that the Web UI misses.
  const addresses = new Set<string>(receiveAddresses);
  addresses.add(material.address);
  const orderedDescriptors = [
    receive,
    ...material.key.descriptors.filter((descriptor) => descriptor.descriptorIdHex !== receive.descriptorIdHex),
  ];
  for (const descriptor of orderedDescriptors) {
    if (!['bech32', 'bech32m'].includes(descriptor.outputType)) continue;
    const descriptorLimit = Math.max(0, Math.min(MAX_DERIVED_ADDRESSES, descriptor.rangeEnd + 1));
    const issuedCount = descriptor.descriptorIdHex === receive.descriptorIdHex
      ? exposedCount
      : Math.max(0, Math.min(MAX_DERIVED_ADDRESSES, descriptor.nextIndex));
    const watchCount = Math.min(descriptorLimit, issuedCount + RECEIVE_LOOKAHEAD);
    for (let index = 0; index < watchCount && addresses.size < MAX_DERIVED_ADDRESSES; index += 1) {
      try { addresses.add(derivePublicDescriptorAddress(descriptor, index)); } catch { break; }
    }
    if (addresses.size >= MAX_DERIVED_ADDRESSES) break;
  }
  return {
    ...material,
    qt: {
      ...material.qt,
      addresses: [...addresses],
      receiveAddresses,
      receiveAddressCount: exposedCount,
      activeReceiveDescriptorIdHex: receive.descriptorIdHex,
    },
  };
}

function descriptorNextIndexOffset(descriptor: string): number {
  const descriptorLength = encoder.encode(descriptor).length;
  return compactSize(descriptorLength).length + descriptorLength + 8;
}

/**
 * Reserves a fresh internal P2WPKH change address and advances the same
 * descriptor counter inside the Qt wallet.dat. Callers must persist the
 * returned encrypted wallet before broadcasting a transaction that uses it.
 */
export async function reserveQtChangeAddress(material: CoreWalletMaterial): Promise<{
  material: CoreWalletMaterial;
  address: string;
}> {
  const hydrated = hydrateQtAddressState(material);
  const change = activeChangeDescriptor(hydrated);
  if (!change) throw new Error('This Qt wallet has no supported internal change descriptor');
  const index = Math.max(0, change.nextIndex);
  if (!Number.isSafeInteger(index) || index > change.rangeEnd || index >= MAX_DERIVED_ADDRESSES) {
    throw new Error('The wallet change-address range is exhausted');
  }
  const address = derivePublicDescriptorAddress(change, index);
  const nextIndex = index + 1;
  const original = base64ToBytes(hydrated.qt.originalFileBase64);
  const repaired = await repairLegacyQtBackup(original, hydrated.address);
  const rows = await readRows(repaired);
  const target = rows.find((row) => {
    if (row.type !== 'walletdescriptor') return false;
    const key = new Reader(row.key);
    key.readString();
    return bytesToHex(key.readBytes(32)) === change.descriptorIdHex;
  });
  if (!target) throw new Error('The active change descriptor is missing from the Qt backup');
  const descriptorValue = Uint8Array.from(target.value);
  descriptorValue.set(uint32LittleEndian(nextIndex), descriptorNextIndexOffset(change.descriptor));
  const SQL = await sqlPromise;
  const database = new SQL.Database(repaired);
  let updatedFile: Uint8Array;
  try {
    database.run('UPDATE main SET value = ? WHERE key = ?', [descriptorValue, target.key]);
    updatedFile = Uint8Array.from(database.export());
  } finally {
    database.close();
  }
  return {
    address,
    material: hydrateQtAddressState({
      ...hydrated,
      key: {
        algorithm: 'CORE-DESCRIPTOR',
        descriptors: hydrated.key.descriptors.map((descriptor) => descriptor.descriptorIdHex === change.descriptorIdHex
          ? { ...descriptor, nextIndex }
          : descriptor),
      },
      qt: { ...hydrated.qt, originalFileBase64: bytesToBase64(updatedFile) },
    }),
  };
}

export async function advanceQtReceiveAddressCount(
  material: CoreWalletMaterial,
  requestedCount: number,
): Promise<{
  material: CoreWalletMaterial;
  address: string;
}> {
  const hydrated = hydrateQtAddressState(material);
  const receive = activeReceiveDescriptor(hydrated);
  if (!receive) throw new Error('This Qt wallet has no supported active receive descriptor');
  const currentCount = Math.max(1, receive.nextIndex);
  const nextIndex = Math.max(currentCount, requestedCount);
  if (!Number.isSafeInteger(nextIndex) || nextIndex < 1 || nextIndex - 1 > receive.rangeEnd || nextIndex > MAX_DERIVED_ADDRESSES) {
    throw new Error(`This Web Wallet currently supports up to ${MAX_DERIVED_ADDRESSES} derived receive addresses`);
  }
  const address = derivePublicDescriptorAddress(receive, nextIndex - 1);
  if (nextIndex === currentCount) return { material: hydrated, address };
  const original = base64ToBytes(hydrated.qt.originalFileBase64);
  const repaired = await repairLegacyQtBackup(original, hydrated.address);
  const rows = await readRows(repaired);
  const target = rows.find((row) => {
    if (row.type !== 'walletdescriptor') return false;
    const key = new Reader(row.key);
    key.readString();
    return bytesToHex(key.readBytes(32)) === receive.descriptorIdHex;
  });
  if (!target) throw new Error('The active receive descriptor is missing from the Qt backup');

  const descriptorValue = Uint8Array.from(target.value);
  descriptorValue.set(uint32LittleEndian(nextIndex), descriptorNextIndexOffset(receive.descriptor));
  const SQL = await sqlPromise;
  const database = new SQL.Database(repaired);
  let updatedFile: Uint8Array;
  try {
    database.run('UPDATE main SET value = ? WHERE key = ?', [descriptorValue, target.key]);
    // Core records issued receive destinations in the address book as well as
    // advancing the descriptor. This makes a Web-issued address visible in
    // Qt's receive/address views after restoring the exported wallet.dat.
    database.run('INSERT OR REPLACE INTO main(key, value) VALUES(?, ?)', [
      concatBytes(string('name'), string(address)),
      string(''),
    ]);
    database.run('INSERT OR REPLACE INTO main(key, value) VALUES(?, ?)', [
      concatBytes(string('purpose'), string(address)),
      string('receive'),
    ]);
    updatedFile = Uint8Array.from(database.export());
  } finally {
    database.close();
  }
  updatedFile = await ensureQtReceiveRequestRecords(updatedFile);
  const updated = hydrateQtAddressState({
    ...hydrated,
    key: {
      algorithm: 'CORE-DESCRIPTOR',
      descriptors: hydrated.key.descriptors.map((descriptor) => descriptor.descriptorIdHex === receive.descriptorIdHex
        ? { ...descriptor, nextIndex }
        : descriptor),
    },
    qt: { ...hydrated.qt, originalFileBase64: bytesToBase64(updatedFile) },
  });
  return { material: updated, address };
}

export async function advanceQtReceiveAddress(material: CoreWalletMaterial): Promise<{
  material: CoreWalletMaterial;
  address: string;
}> {
  const receive = activeReceiveDescriptor(hydrateQtAddressState(material));
  if (!receive) throw new Error('This Qt wallet has no supported active receive descriptor');
  return advanceQtReceiveAddressCount(material, Math.max(1, receive.nextIndex) + 1);
}

export async function createQtWalletMaterial(walletPassword: string): Promise<CoreWalletMaterial> {
  if (!walletPassword) throw new Error('A wallet password is required');
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const root = HDKey.fromMasterSeed(seed, {
    public: CORE_EXT_PUBLIC_VERSION,
    private: CORE_EXT_PRIVATE_VERSION,
  });
  wipe(seed);
  if (!root.publicKey || !root.privateKey || !root.chainCode) throw new Error('Unable to create TensorCash wallet key');
  const privateKey = Uint8Array.from(root.privateKey);
  const publicKey = Uint8Array.from(root.publicKey);
  const privateKeyHex = bytesToHex(privateKey);
  const creationTime = Math.floor(Date.now() / 1_000);
  const descriptors = [
    newQtDescriptor(root, 0, creationTime, privateKeyHex),
    newQtDescriptor(root, 1, creationTime, privateKeyHex),
  ];
  const primaryAddress = deriveAddressFromRoot(descriptors[0].descriptor, root, '/0/*', 0);
  const salt = crypto.getRandomValues(new Uint8Array(8));
  const masterKey = crypto.getRandomValues(new Uint8Array(32));
  const derived = await deriveQtPassphraseKey(walletPassword, salt, CORE_WALLET_KDF_ITERATIONS);
  try {
    const encryptedMaster = await encryptAesCbc(derived.slice(0, 32), derived.slice(32, 48), masterKey);
    const encryptedSecret = await encryptAesCbc(masterKey, hash256(publicKey).slice(0, 16), privateKey);
    const rows: Array<[Uint8Array, Uint8Array]> = [
      [string('flags'), Uint8Array.of(0, 0, 0, 0, 4, 0, 0, 0)],
      [string('version'), uint32LittleEndian(CORE_WALLET_VERSION)],
      [string('minversion'), uint32LittleEndian(CORE_WALLET_MIN_VERSION)],
      [concatBytes(string('mkey'), uint32LittleEndian(1)), concatBytes(
        vector(encryptedMaster),
        vector(salt),
        uint32LittleEndian(0),
        uint32LittleEndian(CORE_WALLET_KDF_ITERATIONS),
        Uint8Array.of(0),
      )],
      [concatBytes(string('name'), string(primaryAddress)), string('')],
      [concatBytes(string('purpose'), string(primaryAddress)), string('receive')],
    ];
    for (const item of descriptors) {
      rows.push(
        [concatBytes(string('walletdescriptor'), item.id), concatBytes(
          string(item.descriptor),
          uint64LittleEndian(creationTime),
          uint32LittleEndian(item.nextIndex),
          uint32LittleEndian(0),
          uint32LittleEndian(1_000),
        )],
        [concatBytes(string(item.internal ? 'activeinternalspk' : 'activeexternalspk'), Uint8Array.of(2)), item.id],
        [concatBytes(string('walletdescriptorcache'), item.id, uint32LittleEndian(0)), vector(item.parentCache)],
        [concatBytes(string('walletdescriptorlhcache'), item.id, uint32LittleEndian(0)), vector(item.lastHardenedCache)],
        [concatBytes(string('walletdescriptorckey'), item.id, vector(publicKey)), vector(encryptedSecret)],
      );
    }
    const SQL = await sqlPromise;
    const database = new SQL.Database();
    let file: Uint8Array;
    try {
      database.run('PRAGMA application_id = -52240844');
      database.run('CREATE TABLE main (key BLOB PRIMARY KEY, value BLOB NOT NULL) WITHOUT ROWID');
      const insert = database.prepare('INSERT INTO main (key, value) VALUES (?, ?)');
      try { rows.forEach(([key, value]) => insert.run([key, value])); } finally { insert.free(); }
      file = Uint8Array.from(database.export());
    } finally {
      database.close();
    }
    file = await ensureQtReceiveRequestRecords(file);
    return hydrateQtAddressState({
      schema: 'org.tensorcash.webwallet.material',
      version: 1,
      walletId: crypto.randomUUID(),
      network: 'mainnet',
      address: primaryAddress,
      createdAt: new Date(creationTime * 1_000).toISOString(),
      key: { algorithm: 'CORE-DESCRIPTOR', descriptors: descriptors.map((item) => item.material) },
      qt: {
        format: 'sqlite-wallet-dat',
        encrypted: true,
        originalFileBase64: bytesToBase64(file),
        addresses: [primaryAddress],
      },
    });
  } finally {
    wipe(privateKey);
    wipe(masterKey);
    wipe(derived);
    root.wipePrivateData();
  }
}

export async function inspectQtWallet(file: Uint8Array): Promise<{
  encrypted: boolean;
  addresses: string[];
  primaryAddress: string | null;
  recentReceiveAddresses: string[];
}> {
  const rows = await readRows(file);
  const internalIds = activeDescriptorIds(rows, 'activeinternalspk');
  const externalIds = activeDescriptorIds(rows, 'activeexternalspk');
  const cachedRoots = descriptorLastHardenedRoots(rows);
  const addresses = new Set(addressBookAddresses(rows));
  let primaryAddress: string | null = null;
  for (const row of rows.filter((candidate) => candidate.type === 'walletdescriptor')) {
    const descriptor = parseDescriptor(row);
    const type = descriptorKind(descriptor.descriptor);
    const internal = internalIds.has(descriptor.idHex) || /\/1\/\*\)?(?:#|$)/.test(descriptor.descriptor);
    if (internal || (type !== 'bech32' && type !== 'bech32m')) continue;
    const cachedRoot = cachedRoots.get(descriptor.idHex);
    if (!cachedRoot) continue;
    const { suffix } = descriptorPublicHdKey(descriptor.descriptor);
    const count = Math.max(1, descriptor.nextIndex);
    for (let index = 0; index < count; index += 1) {
      addresses.add(deriveAddressFromRoot(descriptor.descriptor, cachedRoot, suffixAfterLastHardened(suffix), index));
    }
    if (type === 'bech32' && externalIds.has(descriptor.idHex)) {
      primaryAddress = deriveAddressFromRoot(
        descriptor.descriptor,
        cachedRoot,
        suffixAfterLastHardened(suffix),
        Math.max(0, descriptor.nextIndex - 1),
      );
    }
  }
  return {
    encrypted: rows.some((row) => row.type === 'mkey' || row.type === 'walletdescriptorckey'),
    addresses: [...addresses],
    primaryAddress,
    recentReceiveAddresses: [...addressMetadata(rows).requestAddresses],
  };
}

export async function importQtWallet(file: Uint8Array, walletPassword = ''): Promise<WalletMaterial> {
  const rows = await readRows(file);
  const descriptors = rows.filter((row) => row.type === 'walletdescriptor').map(parseDescriptor);
  if (!descriptors.length) throw new Error('Qt wallet contains no descriptors');
  const masterRecord = rows.find((row) => row.type === 'mkey');
  const encrypted = Boolean(masterRecord || rows.some((row) => row.type === 'walletdescriptorckey'));
  let masterKey: Uint8Array | null = null;
  if (masterRecord) {
    if (!walletPassword) throw new Error('Enter the password used to encrypt this Qt wallet');
    masterKey = await unlockMasterKey(parseMasterKey(masterRecord), walletPassword);
  }
  const secretRows = rows.filter((row) => row.type === 'walletdescriptorkey' || row.type === 'walletdescriptorckey');
  const secrets = new Map<string, DescriptorSecret>();
  try {
    for (const row of secretRows) {
      const [id, secret] = await parseDescriptorKey(row, masterKey);
      secrets.set(id, secret);
    }
    const internalIds = activeDescriptorIds(rows, 'activeinternalspk');
    const externalIds = activeDescriptorIds(rows, 'activeexternalspk');
    const materialDescriptors: CoreDescriptorMaterial[] = [];
    // The Qt address book may contain arbitrary contacts. Only descriptor-
    // derived addresses are wallet-owned and may contribute to wallet totals.
    const addresses = new Set<string>();
    for (const descriptor of descriptors) {
      const secret = secrets.get(descriptor.idHex);
      const type = descriptorKind(descriptor.descriptor);
      if (!secret || !type) continue;
      const internal = internalIds.has(descriptor.idHex) || /\/1\/\*\)?(?:#|$)/.test(descriptor.descriptor);
      materialDescriptors.push({
        descriptorIdHex: descriptor.idHex,
        descriptor: descriptor.descriptor,
        internal,
        active: internal ? internalIds.has(descriptor.idHex) : externalIds.has(descriptor.idHex),
        outputType: type,
        nextIndex: descriptor.nextIndex,
        rangeEnd: descriptor.rangeEnd,
        masterPrivateKeyHex: bytesToHex(secret.privateKey),
      });
      if (!internal && (type === 'bech32' || type === 'bech32m')) {
        const count = Math.max(1, descriptor.nextIndex);
        for (let index = 0; index < count; index += 1) {
          addresses.add(deriveAddress(descriptor.descriptor, secret.privateKey, index));
        }
      }
    }
    const addressList = [...addresses];
    const preferred = materialDescriptors.find((item) =>
      !item.internal && item.outputType === 'bech32' && externalIds.has(item.descriptorIdHex),
    ) ?? materialDescriptors.find((item) => !item.internal && item.outputType === 'bech32');
    const primaryAddress = preferred
      ? deriveAddress(preferred.descriptor, hexToBytes(preferred.masterPrivateKeyHex), Math.max(0, preferred.nextIndex - 1))
      : addressList[0];
    if (!primaryAddress || !materialDescriptors.length) {
      throw new Error('Qt wallet has no supported spendable descriptor address');
    }
    addresses.add(primaryAddress);
    const createdAtSeconds = Math.min(...descriptors.map((item) => item.creationTime).filter((value) => value > 0));
    return hydrateQtAddressState({
      schema: 'org.tensorcash.webwallet.material',
      version: 1,
      walletId: crypto.randomUUID(),
      network: 'mainnet',
      address: primaryAddress,
      createdAt: Number.isFinite(createdAtSeconds) ? new Date(createdAtSeconds * 1_000).toISOString() : new Date().toISOString(),
      key: { algorithm: 'CORE-DESCRIPTOR', descriptors: materialDescriptors },
      qt: {
        format: 'sqlite-wallet-dat',
        encrypted,
        originalFileBase64: bytesToBase64(file),
        addresses: [...addresses],
      },
    });
  } finally {
    if (masterKey) wipe(masterKey);
    for (const secret of secrets.values()) wipe(secret.privateKey);
  }
}
