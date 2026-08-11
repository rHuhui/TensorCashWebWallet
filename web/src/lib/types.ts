export type Network = 'mainnet';

export interface CoreDescriptorMaterial {
  descriptorIdHex: string;
  descriptor: string;
  internal: boolean;
  active?: boolean;
  outputType: 'legacy' | 'p2sh-segwit' | 'bech32' | 'bech32m';
  nextIndex: number;
  rangeEnd: number;
  masterPrivateKeyHex: string;
}

interface WalletMaterialBase {
  schema: 'org.tensorcash.webwallet.material';
  version: 1;
  walletId: string;
  network: Network;
  address: string;
  createdAt: string;
}

export interface MLDSAWalletMaterial extends WalletMaterialBase {
  key: {
    algorithm: 'ML-DSA-65';
    publicKeyHex: string;
    secretKeyHex: string;
  };
  taproot: {
    encodedPublicKeyHex: string;
    tapScriptHex: string;
    scriptPubKeyHex: string;
    internalPublicKeyHex: string;
    outputPublicKeyHex: string;
    leafHashHex: string;
    parity: boolean;
  };
}

export interface CoreWalletMaterial extends WalletMaterialBase {
  key: {
    algorithm: 'CORE-DESCRIPTOR';
    descriptors: CoreDescriptorMaterial[];
  };
  qt: {
    format: 'sqlite-wallet-dat';
    encrypted: boolean;
    originalFileBase64: string;
    /** Every issued address plus the active receive-chain lookahead. */
    addresses: string[];
    /** Active external descriptor addresses, including the lookahead window. */
    receiveAddresses?: string[];
    /** Number of receiveAddresses already exposed by either wallet UI. */
    receiveAddressCount?: number;
    activeReceiveDescriptorIdHex?: string;
  };
}

export type WalletMaterial = MLDSAWalletMaterial | CoreWalletMaterial;

export interface VaultKdf {
  name: 'argon2id';
  salt: string;
  memoryKiB: number;
  iterations: number;
  parallelism: number;
}

export interface EncryptedVault {
  schema: 'org.tensorcash.webwallet.vault';
  version: 1;
  walletId: string;
  /** User-supplied local label. It contains no key material. */
  walletName?: string;
  network: Network;
  address: string;
  /** Authenticated public watch set; no private material is stored here. */
  addresses?: string[];
  receiveAddresses?: string[];
  receiveAddressCount?: number;
  createdAt: string;
  kdf: VaultKdf;
  cipher: {
    name: 'AES-256-GCM';
    iv: string;
  };
  ciphertext: string;
}

export interface ChainStatus {
  network: string;
  core_height: number;
  header_height: number;
  indexed_height: number;
  lag: number;
  synced: boolean;
  observed_at: number;
}

export interface AddressSummary {
  address: string;
  balance_sats: number;
  unconfirmed_balance_sats?: number;
  pending_received_sats?: number;
  pending_sent_sats?: number;
  received_sats: number;
  sent_sats: number;
  tx_count: number;
  first_seen_height: number | null;
  last_seen_height: number | null;
}

export interface WalletAddressBalance {
  address: string;
  balance_sats: number;
  received_sats: number;
  sent_sats: number;
  tx_count: number;
  first_seen_height: number | null;
  last_seen_height: number | null;
}

export interface AddressTransaction {
  txid: string;
  status?: 'pending' | 'confirmed';
  locally_broadcast?: boolean;
  confirmations?: number;
  block_height: number | null;
  block_hash: string | null;
  timestamp: number;
  received_sats: number;
  sent_sats: number;
  delta_sats: number;
  /** User-facing recipient amount for a locally created outgoing transfer. */
  transfer_sats?: number;
  fee_sats: number | null;
  is_coinbase: number;
}
