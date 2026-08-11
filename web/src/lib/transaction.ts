import { secp256k1 } from '@noble/curves/secp256k1.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bech32 } from '@scure/base';
import { bytesToHex, compactSize, concatBytes, hexToBytes, wipe } from './bytes';

export const SATOSHIS_PER_TSC = 100_000_000;
export const COINBASE_MATURITY = 100;
export const P2WPKH_DUST_SATS = 294;
export const MIN_FEE_RATE_SAT_VB = 1;
export const MAX_FEE_RATE_SAT_VB = 100;

const SIGHASH_ALL = 0x01;
const SEQUENCE_RBF = 0xffff_fffd;
const MAX_ABSOLUTE_FEE_SATS = 1_000_000;

export interface WalletUtxo {
  address: string;
  txid: string;
  vout: number;
  value_sats: number;
  script_pubkey: string;
  height: number;
  confirmations: number;
  coinbase: boolean;
}

export interface SpendKey {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

export interface PlannedInput extends WalletUtxo {
  sequence: number;
}

export interface PlannedOutput {
  address: string;
  valueSats: number;
  scriptPubKey: Uint8Array;
  change: boolean;
}

export interface TransactionPlan {
  version: number;
  lockTime: number;
  recipient: string;
  amountSats: number;
  feeSats: number;
  feeRateSatVb: number;
  changeSats: number;
  estimatedVsize: number;
  inputs: PlannedInput[];
  outputs: PlannedOutput[];
}

export interface SignedTransaction {
  hex: string;
  txid: string;
  wtxid: string;
  vsize: number;
  feeSats: number;
}

interface SerializableInput {
  txid: string;
  vout: number;
  sequence: number;
  witness?: Uint8Array[];
}

function uint32LE(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) throw new Error('Invalid uint32 value');
  return Uint8Array.of(value, value >>> 8, value >>> 16, value >>> 24);
}

function int64LE(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid TSC amount');
  let remaining = BigInt(value);
  const output = new Uint8Array(8);
  for (let index = 0; index < output.length; index += 1) {
    output[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return output;
}

function reverse(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(bytes).reverse();
}

function hash256(bytes: Uint8Array): Uint8Array {
  return sha256(sha256(bytes));
}

function serializeVector(items: Uint8Array[]): Uint8Array {
  return concatBytes(compactSize(items.length), ...items.map((item) => concatBytes(compactSize(item.length), item)));
}

function serializeInput(input: SerializableInput): Uint8Array {
  const txid = hexToBytes(input.txid);
  if (txid.length !== 32) throw new Error('Invalid UTXO transaction id');
  return concatBytes(reverse(txid), uint32LE(input.vout), Uint8Array.of(0), uint32LE(input.sequence));
}

function serializeOutput(output: PlannedOutput): Uint8Array {
  return concatBytes(int64LE(output.valueSats), compactSize(output.scriptPubKey.length), output.scriptPubKey);
}

function serializeTransaction(
  version: number,
  inputs: SerializableInput[],
  outputs: PlannedOutput[],
  lockTime: number,
  includeWitness: boolean,
): Uint8Array {
  const hasWitness = includeWitness && inputs.some((input) => (input.witness?.length ?? 0) > 0);
  return concatBytes(
    uint32LE(version),
    ...(hasWitness ? [Uint8Array.of(0, 1)] : []),
    compactSize(inputs.length),
    ...inputs.map(serializeInput),
    compactSize(outputs.length),
    ...outputs.map(serializeOutput),
    ...(hasWitness ? inputs.map((input) => serializeVector(input.witness ?? [])) : []),
    uint32LE(lockTime),
  );
}

export function decodeP2wpkhAddress(address: string): Uint8Array {
  let decoded: ReturnType<typeof bech32.decode>;
  try {
    decoded = bech32.decode(address.toLowerCase() as `${string}1${string}`, 90);
  } catch {
    throw new Error('Enter a valid TensorCash tc1q address');
  }
  if (address !== address.toLowerCase() && address !== address.toUpperCase()) {
    throw new Error('TensorCash addresses cannot mix upper and lower case');
  }
  if (decoded.prefix !== 'tc' || decoded.words[0] !== 0) throw new Error('Only TensorCash tc1q addresses are supported');
  const program = Uint8Array.from(bech32.fromWords(decoded.words.slice(1)));
  if (program.length !== 20) throw new Error('Only TensorCash P2WPKH addresses are supported');
  return program;
}

export function checkedWalletChangeAddress(changeAddress: string, ownedAddresses: string[]): string {
  const normalized = changeAddress.trim().toLowerCase();
  const owned = new Set(ownedAddresses.map((address) => address.toLowerCase()));
  if (!owned.has(normalized)) throw new Error('Choose a change address owned by this wallet');
  // Decode the address as well as checking membership. This prevents an
  // authenticated but unsupported watch-only address from becoming change.
  p2wpkhScript(normalized);
  return normalized;
}

export function p2wpkhScript(address: string): Uint8Array {
  return concatBytes(Uint8Array.of(0x00, 0x14), decodeP2wpkhAddress(address));
}

export function parseTscAmount(value: string): number {
  const normalized = value.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/.test(normalized)) throw new Error('Enter a valid amount with no more than 8 decimals');
  const [whole, fraction = ''] = normalized.split('.');
  const satoshis = BigInt(whole) * BigInt(SATOSHIS_PER_TSC) + BigInt(fraction.padEnd(8, '0'));
  if (satoshis <= 0n || satoshis > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Amount is outside the supported range');
  return Number(satoshis);
}

export function feeRateFromTscPerKvb(value: string | null | undefined): number {
  if (!value) return 2;
  const normalized = value.trim();
  const rate = Number(normalized);
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(normalized) || !Number.isFinite(rate) || rate <= 0) {
    throw new Error('Gateway returned an invalid fee estimate');
  }
  // TSC/kvB × 1e8 sats/TSC ÷ 1,000 vB/kvB. Core commonly
  // serializes small estimates as scientific notation (for example 1e-05).
  const satVb = Math.ceil(rate * 100_000 - Number.EPSILON);
  if (!Number.isSafeInteger(satVb) || satVb < MIN_FEE_RATE_SAT_VB || satVb > MAX_FEE_RATE_SAT_VB) {
    throw new Error('Gateway fee estimate is outside the wallet safety range');
  }
  return satVb;
}

function estimatedP2wpkhVsize(inputs: number, outputs: number): number {
  // Maximum DER signature size is used so the signed transaction never pays
  // less than the reviewed fee rate.
  const stripped = 4 + compactSize(inputs).length + inputs * 41 + compactSize(outputs).length + outputs * 31 + 4;
  const witness = 2 + inputs * (1 + 1 + 73 + 1 + 33);
  return Math.ceil((stripped * 4 + witness) / 4);
}

export function maximumP2wpkhSendAmount(utxos: WalletUtxo[], feeRateSatVb: number): {
  amountSats: number;
  feeSats: number;
  inputCount: number;
} {
  if (!Number.isInteger(feeRateSatVb) || feeRateSatVb < MIN_FEE_RATE_SAT_VB || feeRateSatVb > MAX_FEE_RATE_SAT_VB) {
    throw new Error('Fee rate is outside the wallet safety range');
  }
  const available = checkedUtxos(utxos);
  const totalSats = available.reduce((sum, utxo) => sum + utxo.value_sats, 0);
  if (!Number.isSafeInteger(totalSats)) throw new Error('Spendable balance is outside the supported range');
  const feeSats = estimatedP2wpkhVsize(available.length, 1) * feeRateSatVb;
  const amountSats = totalSats - feeSats;
  if (!available.length || amountSats < P2WPKH_DUST_SATS) throw new Error('Spendable balance is too small after the network fee');
  if (feeSats <= 0 || feeSats > MAX_ABSOLUTE_FEE_SATS || feeSats > Math.max(10_000, Math.floor(amountSats / 100))) {
    throw new Error('Calculated network fee exceeds the wallet safety limit');
  }
  return { amountSats, feeSats, inputCount: available.length };
}

function checkedUtxos(utxos: WalletUtxo[]): WalletUtxo[] {
  const seen = new Set<string>();
  return utxos.map((utxo) => {
    const outpoint = `${utxo.txid}:${utxo.vout}`;
    if (seen.has(outpoint)) throw new Error('Gateway returned a duplicate UTXO');
    seen.add(outpoint);
    if (!/^[0-9a-f]{64}$/i.test(utxo.txid) || !Number.isInteger(utxo.vout) || utxo.vout < 0 || utxo.vout > 0xffff_ffff) {
      throw new Error('Gateway returned an invalid UTXO');
    }
    if (!Number.isSafeInteger(utxo.value_sats) || utxo.value_sats <= 0) throw new Error('Gateway returned an invalid UTXO value');
    if (utxo.coinbase && utxo.confirmations < COINBASE_MATURITY) throw new Error('Gateway returned an immature coinbase UTXO');
    const expectedScript = bytesToHex(p2wpkhScript(utxo.address));
    if (utxo.script_pubkey.toLowerCase() !== expectedScript) throw new Error('UTXO script does not match its wallet address');
    return { ...utxo, script_pubkey: expectedScript };
  });
}

export function planP2wpkhTransaction(
  utxos: WalletUtxo[],
  recipient: string,
  amountSats: number,
  changeAddress: string,
  feeRateSatVb: number,
  lockTime = 0,
): TransactionPlan {
  if (!Number.isSafeInteger(amountSats) || amountSats < P2WPKH_DUST_SATS) throw new Error('Amount is below the P2WPKH dust threshold');
  if (!Number.isInteger(feeRateSatVb) || feeRateSatVb < MIN_FEE_RATE_SAT_VB || feeRateSatVb > MAX_FEE_RATE_SAT_VB) {
    throw new Error('Fee rate is outside the wallet safety range');
  }
  const recipientScript = p2wpkhScript(recipient);
  const changeScript = p2wpkhScript(changeAddress);
  const available = checkedUtxos(utxos).sort((left, right) => right.value_sats - left.value_sats || left.txid.localeCompare(right.txid) || left.vout - right.vout);
  const selected: PlannedInput[] = [];
  let total = 0;
  let feeSats = 0;
  let changeSats = 0;
  let outputCount = 0;
  for (const utxo of available) {
    selected.push({ ...utxo, sequence: SEQUENCE_RBF });
    total += utxo.value_sats;
    const feeWithChange = estimatedP2wpkhVsize(selected.length, 2) * feeRateSatVb;
    const candidateChange = total - amountSats - feeWithChange;
    if (candidateChange >= P2WPKH_DUST_SATS) {
      feeSats = feeWithChange;
      changeSats = candidateChange;
      outputCount = 2;
      break;
    }
    const minimumNoChangeFee = estimatedP2wpkhVsize(selected.length, 1) * feeRateSatVb;
    const remainder = total - amountSats;
    if (remainder >= minimumNoChangeFee && remainder < feeWithChange + P2WPKH_DUST_SATS) {
      feeSats = remainder;
      changeSats = 0;
      outputCount = 1;
      break;
    }
  }
  if (!outputCount) throw new Error('Insufficient confirmed spendable balance');
  if (feeSats <= 0 || feeSats > MAX_ABSOLUTE_FEE_SATS || feeSats > Math.max(10_000, Math.floor(amountSats / 100))) {
    throw new Error('Calculated network fee exceeds the wallet safety limit');
  }
  const outputs: PlannedOutput[] = [{ address: recipient.toLowerCase(), valueSats: amountSats, scriptPubKey: recipientScript, change: false }];
  if (changeSats) outputs.push({ address: changeAddress.toLowerCase(), valueSats: changeSats, scriptPubKey: changeScript, change: true });
  return {
    version: 2,
    lockTime,
    recipient: recipient.toLowerCase(),
    amountSats,
    feeSats,
    feeRateSatVb,
    changeSats,
    estimatedVsize: estimatedP2wpkhVsize(selected.length, outputCount),
    inputs: selected,
    outputs,
  };
}

function p2wpkhSighash(plan: TransactionPlan, inputIndex: number): Uint8Array {
  const input = plan.inputs[inputIndex];
  const program = decodeP2wpkhAddress(input.address);
  const scriptCode = concatBytes(Uint8Array.of(0x76, 0xa9, 0x14), program, Uint8Array.of(0x88, 0xac));
  const hashPrevouts = hash256(concatBytes(...plan.inputs.map((candidate) => concatBytes(reverse(hexToBytes(candidate.txid)), uint32LE(candidate.vout)))));
  const hashSequence = hash256(concatBytes(...plan.inputs.map((candidate) => uint32LE(candidate.sequence))));
  const hashOutputs = hash256(concatBytes(...plan.outputs.map(serializeOutput)));
  return hash256(concatBytes(
    uint32LE(plan.version),
    hashPrevouts,
    hashSequence,
    reverse(hexToBytes(input.txid)),
    uint32LE(input.vout),
    compactSize(scriptCode.length),
    scriptCode,
    int64LE(input.value_sats),
    uint32LE(input.sequence),
    hashOutputs,
    uint32LE(plan.lockTime),
    uint32LE(SIGHASH_ALL),
  ));
}

export function signP2wpkhTransaction(plan: TransactionPlan, resolveKey: (address: string) => SpendKey): SignedTransaction {
  const inputs: SerializableInput[] = plan.inputs.map((input) => ({ ...input }));
  const ephemeral: Uint8Array[] = [];
  try {
    plan.inputs.forEach((input, index) => {
      const key = resolveKey(input.address);
      ephemeral.push(key.privateKey, key.publicKey);
      if (key.privateKey.length !== 32 || key.publicKey.length !== 33) throw new Error('Wallet returned an invalid spend key');
      const expectedProgram = decodeP2wpkhAddress(input.address);
      const actualProgram = ripemd160(sha256(key.publicKey));
      if (bytesToHex(actualProgram) !== bytesToHex(expectedProgram)) throw new Error('Wallet key does not control the selected UTXO');
      const signature = secp256k1.sign(p2wpkhSighash(plan, index), key.privateKey, {
        prehash: false,
        lowS: true,
        format: 'der',
      });
      inputs[index].witness = [concatBytes(signature, Uint8Array.of(SIGHASH_ALL)), Uint8Array.from(key.publicKey)];
    });
    const stripped = serializeTransaction(plan.version, inputs, plan.outputs, plan.lockTime, false);
    const signed = serializeTransaction(plan.version, inputs, plan.outputs, plan.lockTime, true);
    const weight = stripped.length * 3 + signed.length;
    const vsize = Math.ceil(weight / 4);
    if (plan.feeSats < vsize * plan.feeRateSatVb) throw new Error('Signed transaction fee is below the reviewed fee rate');
    return {
      hex: bytesToHex(signed),
      txid: bytesToHex(reverse(hash256(stripped))),
      wtxid: bytesToHex(reverse(hash256(signed))),
      vsize,
      feeSats: plan.feeSats,
    };
  } finally {
    ephemeral.forEach(wipe);
    inputs.forEach((input) => input.witness?.forEach(wipe));
  }
}
