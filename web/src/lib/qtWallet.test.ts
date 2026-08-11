import { HDKey } from '@scure/bip32';
import { bech32 } from '@scure/base';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { sha256 } from '@noble/hashes/sha2.js';
import initSqlJs from 'sql.js/dist/sql-asm.js';
import { describe, expect, it } from 'vitest';
import { base64ToBytes, bytesToHex } from './bytes';
import {
  advanceQtReceiveAddress,
  advanceQtReceiveAddressCount,
  createQtWalletMaterial,
  ensureQtReceiveRequestRecords,
  inspectQtWallet,
  importQtWallet,
  repairLegacyQtBackup,
  reserveQtChangeAddress,
  resolveQtP2wpkhSpendKey,
} from './qtWallet';

const encoder = new TextEncoder();
const versions = { public: 0x04544350, private: 0x04544358 };

function concat(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}

function vector(value: Uint8Array): Uint8Array {
  if (value.length >= 253) throw new Error('Test fixture vector is too large');
  return concat(Uint8Array.of(value.length), value);
}

function string(value: string): Uint8Array { return vector(encoder.encode(value)); }

function uint32(value: number): Uint8Array {
  return Uint8Array.of(value, value >>> 8, value >>> 16, value >>> 24);
}

function uint32BigEndian(value: number): Uint8Array {
  return Uint8Array.of(value >>> 24, value >>> 16, value >>> 8, value);
}

function uint64(value: number): Uint8Array { return concat(uint32(value), uint32(0)); }

function hash256(value: Uint8Array): Uint8Array { return sha256(sha256(value)); }

function readVector(value: Uint8Array, offset = 0): [Uint8Array, number] {
  const length = value[offset];
  if (length >= 253) throw new Error('Test wallet vector is unexpectedly large');
  return [value.slice(offset + 1, offset + 1 + length), offset + 1 + length];
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function uint32FromBigEndian(value: Uint8Array, offset: number): number {
  return (
    value[offset] * 0x1_0000_00 +
    value[offset + 1] * 0x1_0000 +
    value[offset + 2] * 0x100 +
    value[offset + 3]
  ) >>> 0;
}

function hdKeyFromCache(value: Uint8Array): HDKey {
  return new HDKey({
    versions,
    depth: value[0],
    parentFingerprint: uint32FromBigEndian(value, 1),
    index: uint32FromBigEndian(value, 5),
    chainCode: value.slice(9, 41),
    publicKey: value.slice(41, 74),
  });
}

function serializeCache(key: HDKey): Uint8Array {
  if (!key.publicKey || !key.chainCode) throw new Error('Unable to serialize fixture cache');
  return concat(
    Uint8Array.of(key.depth),
    uint32BigEndian(key.parentFingerprint),
    uint32BigEndian(key.index),
    key.chainCode,
    key.publicKey,
  );
}

function addressFromPublicKey(publicKey: Uint8Array): string {
  return bech32.encode('tc', [0, ...bech32.toWords(ripemd160(sha256(publicKey)))]);
}

function corePrivateKeyDer(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  const begin = Uint8Array.of(0x30, 0x81, 0xd3, 0x02, 0x01, 0x01, 0x04, 0x20);
  const middle = Uint8Array.of(
    0xa0, 0x81, 0x85, 0x30, 0x81, 0x82, 0x02, 0x01, 0x01, 0x30, 0x2c, 0x06, 0x07, 0x2a, 0x86, 0x48,
    0xce, 0x3d, 0x01, 0x01, 0x02, 0x21, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xfe, 0xff, 0xff, 0xfc, 0x2f, 0x30, 0x06, 0x04, 0x01, 0x00, 0x04, 0x01, 0x07, 0x04,
    0x21, 0x02, 0x79, 0xbe, 0x66, 0x7e, 0xf9, 0xdc, 0xbb, 0xac, 0x55, 0xa0, 0x62, 0x95, 0xce, 0x87,
    0x0b, 0x07, 0x02, 0x9b, 0xfc, 0xdb, 0x2d, 0xce, 0x28, 0xd9, 0x59, 0xf2, 0x81, 0x5b, 0x16, 0xf8,
    0x17, 0x98, 0x02, 0x21, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xfe, 0xba, 0xae, 0xdc, 0xe6, 0xaf, 0x48, 0xa0, 0x3b, 0xbf, 0xd2, 0x5e,
    0x8c, 0xd0, 0x36, 0x41, 0x41, 0x02, 0x01, 0x01, 0xa1, 0x24, 0x03, 0x22, 0x00,
  );
  return concat(begin, privateKey, middle, publicKey);
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
    if (position < 0) throw new Error('Unsupported descriptor test character');
    checksum = polymod(checksum, position & 31);
    group = group * 3 + (position >> 5);
    if (++groupLength === 3) { checksum = polymod(checksum, group); group = 0; groupLength = 0; }
  }
  if (groupLength) checksum = polymod(checksum, group);
  for (let index = 0; index < 8; index += 1) checksum = polymod(checksum, 0);
  checksum ^= 1n;
  return Array.from({ length: 8 }, (_, index) => output[Number((checksum >> BigInt(5 * (7 - index))) & 31n)]).join('');
}

async function unencryptedFixture(): Promise<{ file: Uint8Array; address: string }> {
  const root = HDKey.fromMasterSeed(Uint8Array.from({ length: 32 }, (_, index) => index + 1), versions);
  if (!root.publicKey || !root.privateKey || !root.chainCode) throw new Error('Unable to make test key');
  const descriptorBody = `wpkh(${root.publicExtendedKey}/0/*)`;
  const descriptor = `${descriptorBody}#${descriptorChecksum(descriptorBody)}`;
  const descriptorId = sha256(encoder.encode(descriptor));
  const child = root.derive('m/0/0');
  if (!child.publicKey) throw new Error('Unable to derive fixture address');
  const address = bech32.encode('tc', [0, ...bech32.toWords(ripemd160(sha256(child.publicKey)))]);
  const descriptorKey = concat(string('walletdescriptor'), descriptorId);
  const descriptorValue = concat(string(descriptor), uint64(1_700_000_000), uint32(1), uint32(0), uint32(1_000));
  const secretKey = concat(string('walletdescriptorkey'), descriptorId, vector(root.publicKey));
  const der = corePrivateKeyDer(root.privateKey, root.publicKey);
  const cachedRoot = concat(
    Uint8Array.of(root.depth),
    uint32BigEndian(root.parentFingerprint),
    uint32BigEndian(root.index),
    root.chainCode,
    root.publicKey,
  );
  const rows: Array<[Uint8Array, Uint8Array]> = [
    [string('flags'), Uint8Array.of(0, 0, 0, 0, 4, 0, 0, 0)],
    [string('version'), uint32(299_900)],
    [string('minversion'), uint32(169_900)],
    [descriptorKey, descriptorValue],
    [concat(string('activeexternalspk'), Uint8Array.of(2)), descriptorId],
    [concat(string('walletdescriptorcache'), descriptorId, uint32(0)), vector(cachedRoot)],
    [concat(string('walletdescriptorlhcache'), descriptorId, uint32(0)), vector(cachedRoot)],
    [concat(string('name'), string(address)), string('fixture address')],
  ];
  rows.push([secretKey, concat(vector(der), hash256(concat(root.publicKey, der)))]);

  const SQL = await initSqlJs();
  const database = new SQL.Database();
  try {
    database.run('PRAGMA application_id = -52240844');
    database.run('CREATE TABLE main (key BLOB PRIMARY KEY, value BLOB NOT NULL) WITHOUT ROWID');
    const insert = database.prepare('INSERT INTO main (key, value) VALUES (?, ?)');
    try { rows.forEach(([key, value]) => insert.run([key, value])); } finally { insert.free(); }
    return { file: Uint8Array.from(database.export()), address };
  } finally {
    database.close();
  }
}

async function hardenedQtFixture(): Promise<{ file: Uint8Array; address: string }> {
  const root = HDKey.fromMasterSeed(Uint8Array.from({ length: 32 }, (_, index) => 255 - index), versions);
  if (!root.publicKey || !root.privateKey) throw new Error('Unable to make hardened test key');
  const account = root.derive("m/84'/1'/0'");
  const branch = account.deriveChild(0);
  const child = branch.deriveChild(0);
  if (!child.publicKey) throw new Error('Unable to derive hardened fixture address');
  const address = addressFromPublicKey(child.publicKey);
  const body = `wpkh(${root.publicExtendedKey}/84h/1h/0h/0/*)`;
  const descriptor = `${body}#${descriptorChecksum(body)}`;
  const descriptorId = sha256(encoder.encode(descriptor));
  const der = corePrivateKeyDer(root.privateKey, root.publicKey);
  const rows: Array<[Uint8Array, Uint8Array]> = [
    [string('flags'), Uint8Array.of(0, 0, 0, 0, 4, 0, 0, 0)],
    [string('version'), uint32(299_900)],
    [string('minversion'), uint32(169_900)],
    [concat(string('walletdescriptor'), descriptorId), concat(
      string(descriptor),
      uint64(1_700_000_000),
      uint32(0),
      uint32(0),
      uint32(1_000),
    )],
    [concat(string('activeexternalspk'), Uint8Array.of(2)), descriptorId],
    [concat(string('walletdescriptorcache'), descriptorId, uint32(0)), vector(serializeCache(branch))],
    [concat(string('walletdescriptorlhcache'), descriptorId, uint32(0)), vector(serializeCache(account))],
    [
      concat(string('walletdescriptorkey'), descriptorId, vector(root.publicKey)),
      concat(vector(der), hash256(concat(root.publicKey, der))),
    ],
  ];
  const SQL = await initSqlJs();
  const database = new SQL.Database();
  try {
    database.run('PRAGMA application_id = -52240844');
    database.run('CREATE TABLE main (key BLOB PRIMARY KEY, value BLOB NOT NULL) WITHOUT ROWID');
    const insert = database.prepare('INSERT INTO main (key, value) VALUES (?, ?)');
    try { rows.forEach(([key, value]) => insert.run([key, value])); } finally { insert.free(); }
    return { file: Uint8Array.from(database.export()), address };
  } finally {
    database.close();
    root.wipePrivateData();
  }
}

describe('TensorCash Qt descriptor wallet compatibility', () => {
  it('detects, imports and preserves an unencrypted Qt wallet byte-for-byte', async () => {
    const sample = await unencryptedFixture();
    const inspection = await inspectQtWallet(sample.file);
    expect(inspection).toMatchObject({ encrypted: false, primaryAddress: sample.address });
    const material = await importQtWallet(sample.file);
    expect(material.address).toBe(sample.address);
    expect(material.key.algorithm).toBe('CORE-DESCRIPTOR');
    if (!('qt' in material)) throw new Error('Expected Qt wallet material');
    expect(base64ToBytes(material.qt.originalFileBase64)).toEqual(sample.file);
  });

  it('imports standard Qt descriptors with hardened account paths', async () => {
    const sample = await hardenedQtFixture();
    expect(await inspectQtWallet(sample.file)).toMatchObject({
      encrypted: false,
      primaryAddress: sample.address,
    });
    const material = await importQtWallet(sample.file);
    expect(material.address).toBe(sample.address);
    if (!('qt' in material)) throw new Error('Expected Qt wallet material');
    expect(material.qt.receiveAddresses?.[0]).toBe(sample.address);
    expect(material.qt.receiveAddressCount).toBe(1);
  });

  it('requires the original password and decrypts an encrypted Qt wallet', async () => {
    const password = 'official-qt-test-password';
    const created = await createQtWalletMaterial(password);
    const file = base64ToBytes(created.qt.originalFileBase64);
    const inspection = await inspectQtWallet(file);
    expect(inspection).toMatchObject({ encrypted: true, primaryAddress: created.address });
    expect(inspection.recentReceiveAddresses).toEqual([created.address]);
    await expect(importQtWallet(file, 'wrong-password')).rejects.toThrow(/password|damaged/i);
    const material = await importQtWallet(file, password);
    expect(material.address).toBe(created.address);
    expect(material.key.algorithm).toBe('CORE-DESCRIPTOR');
    if (material.key.algorithm !== 'CORE-DESCRIPTOR') throw new Error('Expected Core descriptor material');
    expect(material.key.descriptors).toHaveLength(2);
    if (!('qt' in material)) throw new Error('Expected Qt wallet material');
    expect(base64ToBytes(material.qt.originalFileBase64)).toEqual(file);
  });

  it('writes Core descriptor caches that resolve the same first receive address', async () => {
    const created = await createQtWalletMaterial('core-cache-test-password');
    const file = base64ToBytes(created.qt.originalFileBase64);
    const SQL = await initSqlJs();
    const database = new SQL.Database(file);
    try {
      const statement = database.prepare('SELECT key, value FROM main');
      const rows: Array<[Uint8Array, Uint8Array]> = [];
      try {
        while (statement.step()) {
          const [key, value] = statement.get();
          if (key instanceof Uint8Array && value instanceof Uint8Array) rows.push([key, value]);
        }
      } finally {
        statement.free();
      }
      let externalId: Uint8Array | null = null;
      for (const [key, value] of rows) {
        const [type, offset] = readVector(key);
        if (new TextDecoder().decode(type) === 'activeexternalspk' && key[offset] === 2) externalId = value;
      }
      expect(externalId).not.toBeNull();
      if (!externalId) throw new Error('Generated wallet has no active bech32 receive descriptor');

      let parentCache: Uint8Array | null = null;
      let lastHardenedCache: Uint8Array | null = null;
      let nextIndex: number | null = null;
      for (const [key, value] of rows) {
        const [typeBytes, offset] = readVector(key);
        const type = new TextDecoder().decode(typeBytes);
        if (!bytesEqual(key.slice(offset, offset + 32), externalId)) continue;
        if (type === 'walletdescriptorcache') [parentCache] = readVector(value);
        if (type === 'walletdescriptorlhcache') [lastHardenedCache] = readVector(value);
        if (type === 'walletdescriptor') {
          const [, descriptorEnd] = readVector(value);
          nextIndex = value[descriptorEnd + 8] |
            (value[descriptorEnd + 9] << 8) |
            (value[descriptorEnd + 10] << 16) |
            (value[descriptorEnd + 11] << 24);
        }
      }
      expect(nextIndex).toBe(1);
      expect(parentCache).not.toBeNull();
      expect(lastHardenedCache).not.toBeNull();
      if (!parentCache || !lastHardenedCache) throw new Error('Generated wallet descriptor cache is incomplete');
      expect(parentCache[0]).toBe(1);
      expect(uint32FromBigEndian(parentCache, 5)).toBe(0);
      expect(lastHardenedCache[0]).toBe(0);

      const firstReceive = hdKeyFromCache(parentCache).deriveChild(0);
      if (!firstReceive.publicKey) throw new Error('Unable to derive cached receive key');
      expect(addressFromPublicKey(firstReceive.publicKey)).toBe(created.address);

      const firstReceiveFromRoot = hdKeyFromCache(lastHardenedCache).derive('m/0/0');
      if (!firstReceiveFromRoot.publicKey) throw new Error('Unable to derive receive key from last hardened cache');
      expect(addressFromPublicKey(firstReceiveFromRoot.publicKey)).toBe(created.address);
    } finally {
      database.close();
    }
  });

  it('advances one shared receive chain and persists the next index into wallet.dat', async () => {
    const password = 'shared-receive-chain-password';
    const created = await createQtWalletMaterial(password);
    expect(created.qt.receiveAddressCount).toBe(1);
    expect(created.qt.receiveAddresses?.[0]).toBe(created.address);
    expect(created.qt.receiveAddresses?.length).toBe(21);
    expect(created.qt.addresses).toHaveLength(41);

    const expectedSecond = created.qt.receiveAddresses?.[1];
    const expectedThird = created.qt.receiveAddresses?.[2];
    const second = await advanceQtReceiveAddress(created);
    expect(second.address).toBe(expectedSecond);
    expect(second.material.qt.receiveAddressCount).toBe(2);
    expect(second.material.qt.receiveAddresses?.slice(0, 2)).toEqual([created.address, expectedSecond]);

    const third = await advanceQtReceiveAddress(second.material);
    expect(third.address).toBe(expectedThird);
    expect(third.material.qt.receiveAddressCount).toBe(3);
    expect(third.material.qt.receiveAddresses?.slice(0, 3)).toEqual([
      created.address,
      expectedSecond,
      expectedThird,
    ]);

    const reimported = await importQtWallet(base64ToBytes(third.material.qt.originalFileBase64), password);
    if (!('qt' in reimported)) throw new Error('Expected Qt wallet material');
    expect(reimported.address).toBe(expectedThird);
    expect(reimported.qt.receiveAddressCount).toBe(3);
    expect(reimported.qt.receiveAddresses?.slice(0, 3)).toEqual([
      created.address,
      expectedSecond,
      expectedThird,
    ]);
    const inspection = await inspectQtWallet(base64ToBytes(third.material.qt.originalFileBase64));
    expect(inspection.addresses).toEqual(expect.arrayContaining([created.address, expectedSecond, expectedThird]));
    expect(inspection.recentReceiveAddresses).toEqual(expect.arrayContaining([
      created.address,
      expectedSecond,
      expectedThird,
    ]));
  });

  it('reconciles several publicly issued receive addresses in one encrypted update', async () => {
    const password = 'bulk-receive-chain-password';
    const created = await createQtWalletMaterial(password);
    const expected = created.qt.receiveAddresses?.slice(0, 6) ?? [];
    const advanced = await advanceQtReceiveAddressCount(created, 6);

    expect(advanced.address).toBe(expected[5]);
    expect(advanced.material.qt.receiveAddressCount).toBe(6);
    expect(advanced.material.qt.receiveAddresses?.slice(0, 6)).toEqual(expected);

    const backup = base64ToBytes(advanced.material.qt.originalFileBase64);
    const reimported = await importQtWallet(backup, password);
    if (!('qt' in reimported)) throw new Error('Expected Qt wallet material');
    expect(reimported.qt.receiveAddressCount).toBe(6);
    expect(reimported.qt.receiveAddresses?.slice(0, 6)).toEqual(expected);

    const inspection = await inspectQtWallet(backup);
    expect(inspection.recentReceiveAddresses).toEqual(expect.arrayContaining(expected));
  });

  it('adds Qt recent-request metadata to old Web exports without changing it twice', async () => {
    const created = await createQtWalletMaterial('receive-request-repair-password');
    const SQL = await initSqlJs();
    const database = new SQL.Database(base64ToBytes(created.qt.originalFileBase64));
    let withoutRequest: Uint8Array;
    try {
      database.run("DELETE FROM main WHERE hex(key) LIKE '086465737464617461%'");
      withoutRequest = Uint8Array.from(database.export());
    } finally {
      database.close();
    }
    expect((await inspectQtWallet(withoutRequest)).recentReceiveAddresses).toEqual([]);
    const repaired = await ensureQtReceiveRequestRecords(withoutRequest);
    expect((await inspectQtWallet(repaired)).recentReceiveAddresses).toEqual([created.address]);
    expect(await ensureQtReceiveRequestRecords(repaired)).toEqual(repaired);
  });

  it('repairs legacy Web exports while leaving corrected backups stable', async () => {
    const created = await createQtWalletMaterial('legacy-repair-test-password');
    const fixedFile = base64ToBytes(created.qt.originalFileBase64);
    const SQL = await initSqlJs();
    const database = new SQL.Database(fixedFile);
    let legacyFile: Uint8Array;
    try {
      const rows = database.exec('SELECT key, value FROM main')[0].values
        .map(([key, value]) => [Uint8Array.from(key as Uint8Array), Uint8Array.from(value as Uint8Array)] as const);
      const lastHardened = new Map<string, Uint8Array>();
      let externalId = '';
      const hex = (value: Uint8Array) => Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('');
      for (const [key, value] of rows) {
        const [typeBytes, offset] = readVector(key);
        const type = new TextDecoder().decode(typeBytes);
        const id = hex(key.slice(offset, offset + 32));
        if (type === 'walletdescriptorlhcache') lastHardened.set(id, value);
        if (type === 'activeexternalspk' && key[offset] === 2) externalId = hex(value);
      }
      const update = database.prepare('UPDATE main SET value = ? WHERE key = ?');
      try {
        for (const [key, value] of rows) {
          const [typeBytes, offset] = readVector(key);
          const type = new TextDecoder().decode(typeBytes);
          const id = hex(key.slice(offset, offset + 32));
          if (type === 'walletdescriptorcache') {
            const brokenCache = lastHardened.get(id);
            if (brokenCache) update.run([brokenCache, key]);
          }
          if (type === 'walletdescriptor' && id === externalId) {
            const [, descriptorEnd] = readVector(value);
            const brokenDescriptor = Uint8Array.from(value);
            brokenDescriptor.set(uint32(1), descriptorEnd + 8);
            update.run([brokenDescriptor, key]);
          }
        }
      } finally {
        update.free();
      }
      legacyFile = Uint8Array.from(database.export());
    } finally {
      database.close();
    }

    const repaired = await repairLegacyQtBackup(legacyFile, created.address);
    expect(repaired).not.toEqual(legacyFile);
    expect(await inspectQtWallet(repaired)).toMatchObject({ primaryAddress: created.address, encrypted: true });
    expect(await repairLegacyQtBackup(repaired, created.address)).toEqual(repaired);
  });

  it('resolves spend keys and persists a fresh internal change index', async () => {
    const password = 'change-reservation-password';
    const created = await createQtWalletMaterial(password);
    const spendKey = resolveQtP2wpkhSpendKey(created, created.address);
    try {
      const program = ripemd160(sha256(spendKey.publicKey));
      expect(bech32.encode('tc', [0, ...bech32.toWords(program)])).toBe(created.address);
      expect(bytesToHex(spendKey.privateKey)).toHaveLength(64);
    } finally {
      spendKey.privateKey.fill(0);
      spendKey.publicKey.fill(0);
    }

    const before = created.key.descriptors.find((descriptor) => descriptor.internal && descriptor.outputType === 'bech32');
    const reserved = await reserveQtChangeAddress(created);
    const after = reserved.material.key.descriptors.find((descriptor) => descriptor.descriptorIdHex === before?.descriptorIdHex);
    expect(after?.nextIndex).toBe((before?.nextIndex ?? 0) + 1);
    expect(reserved.material.qt.addresses).toContain(reserved.address);

    const reimported = await importQtWallet(base64ToBytes(reserved.material.qt.originalFileBase64), password);
    if (!('qt' in reimported)) throw new Error('Expected Qt wallet material');
    const imported = reimported.key.descriptors.find((descriptor) => descriptor.descriptorIdHex === before?.descriptorIdHex);
    expect(imported?.nextIndex).toBe(after?.nextIndex);
  });
});
