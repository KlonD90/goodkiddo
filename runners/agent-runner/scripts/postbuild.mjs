import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runnerRoot = path.resolve(__dirname, '..');
const distDir = path.join(runnerRoot, 'dist');
const sdkRoot = path.join(
  runnerRoot,
  'node_modules',
  '@anthropic-ai',
  'claude-agent-sdk',
);

const runtimeAssets = [
  'cli.js',
  'extractFromBunfs.js',
  'manifest.json',
  'manifest.zst.json',
  'vendor',
];

fs.mkdirSync(distDir, { recursive: true });

for (const asset of runtimeAssets) {
  const sourcePath = path.join(sdkRoot, asset);
  const destinationPath = path.join(distDir, asset);

  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Missing Claude SDK runtime asset: ${sourcePath}`);
  }

  fs.rmSync(destinationPath, { recursive: true, force: true });
  fs.cpSync(sourcePath, destinationPath, { recursive: true });
}
