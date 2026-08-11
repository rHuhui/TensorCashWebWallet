import {
  createMLDSA65 as createNodeMLDSA65,
  MLDSA65,
  type MLDSA65Module,
} from '@oqs/liboqs-js';

type OqsModuleFactory = () => Promise<MLDSA65Module>;

interface RuntimeModule {
  default: OqsModuleFactory;
}

/**
 * The upstream package locates its generated runtime with a variable relative
 * import. Bundlers cannot discover that file, so browser builds load the
 * pinned copy emitted by scripts/sync-oqs.mjs. Tests keep the upstream Node
 * loader to exercise the same liboqs implementation without a web server.
 */
export async function createTensorCashMLDSA65(): Promise<MLDSA65> {
  if (typeof document === 'undefined') return createNodeMLDSA65();

  const runtimeUrl = `${import.meta.env.BASE_URL}vendor/ml-dsa-65.min.js`;
  const imported = await import(/* @vite-ignore */ runtimeUrl) as RuntimeModule;
  if (typeof imported.default !== 'function') {
    throw new Error('ML-DSA-65 runtime is unavailable');
  }

  const wasmModule = await imported.default();
  wasmModule._OQS_init();
  const algorithm = 'ML-DSA-65';
  const nameLength = wasmModule.lengthBytesUTF8(algorithm);
  const namePointer = wasmModule._malloc(nameLength + 1);
  let signaturePointer = 0;

  try {
    wasmModule.stringToUTF8(algorithm, namePointer, nameLength + 1);
    // liboqs-js calls this generated Emscripten export with a UTF-8 pointer;
    // its published declaration incorrectly describes the argument as string.
    const createSignature = wasmModule._OQS_SIG_new as unknown as (pointer: number) => number;
    signaturePointer = createSignature(namePointer);
  } finally {
    wasmModule._free(namePointer);
  }

  if (!signaturePointer) throw new Error('Failed to initialize ML-DSA-65');
  return new MLDSA65(wasmModule, signaturePointer);
}
