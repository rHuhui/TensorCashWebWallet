import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [distArgument = 'web/dist', outputArgument = 'verification-manifest.json'] = process.argv.slice(2);
const distDirectory = path.resolve(distArgument);
const outputPath = path.resolve(outputArgument);

async function filesBelow(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(absolute, relative));
    if (entry.isFile()) files.push({ absolute, relative });
  }
  return files;
}

const files = [];
for (const file of await filesBelow(distDirectory)) {
  const bytes = await readFile(file.absolute);
  files.push({
    path: file.relative,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.byteLength,
  });
}

if (!files.some((file) => file.path === 'index.html')) {
  throw new Error(`No index.html found below ${distDirectory}`);
}

const repository = process.env.GITHUB_REPOSITORY || 'rHuhui/TensorCashWebWallet';
const commit = process.env.GITHUB_SHA || 'local-build';
const version = JSON.parse(await readFile(path.resolve('package.json'), 'utf8')).version;
const manifest = {
  schema: 1,
  product: 'TensorCash Web Wallet',
  version,
  repository: `https://github.com/${repository}`,
  commit,
  source: commit === 'local-build'
    ? `https://github.com/${repository}`
    : `https://github.com/${repository}/tree/${commit}`,
  target: 'https://app.tscweb.xyz/wallet/',
  files,
};

await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`Wrote ${files.length} file hashes to ${outputPath}`);
