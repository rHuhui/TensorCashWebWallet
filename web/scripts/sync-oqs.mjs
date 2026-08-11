import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const webDirectory = resolve(scriptDirectory, '..');
const source = resolve(
  webDirectory,
  '..',
  'node_modules',
  '@oqs',
  'liboqs-js',
  'dist',
  'ml-dsa-65.min.js',
);
const destinationDirectory = resolve(webDirectory, 'public', 'vendor');
const destination = resolve(destinationDirectory, 'ml-dsa-65.min.js');
const EXPECTED_SHA256 = '7b13b733ba96c1a36d79e4f31175b53d6a962bf8119452ab5ef48dae2db11b83';

const sourceBytes = await readFile(source);
const actualSha256 = createHash('sha256').update(sourceBytes).digest('hex');
if (actualSha256 !== EXPECTED_SHA256) {
  throw new Error(`Refusing unverified ML-DSA runtime: expected ${EXPECTED_SHA256}, received ${actualSha256}`);
}

await mkdir(destinationDirectory, { recursive: true });
await copyFile(source, destination);
console.log(`Copied verified ML-DSA-65 runtime (${EXPECTED_SHA256}).`);
