import { copyFile, mkdir } from 'node:fs/promises';
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

await mkdir(destinationDirectory, { recursive: true });
await copyFile(source, destination);
console.log('Copied the pinned ML-DSA-65 WebAssembly runtime.');
