// Builds dist/esm (ES modules) and dist/cjs (CommonJS), each with its own .d.ts files and a
// package.json marker so Node and TypeScript pick the right format for each directory.
// Run through `npm run build` so node_modules/.bin is on PATH.
import { execSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
execSync('tsc -p tsconfig.json', { stdio: 'inherit' });
execSync('tsc -p tsconfig.cjs.json', { stdio: 'inherit' });
writeFileSync('dist/esm/package.json', '{ "type": "module" }\n');
writeFileSync('dist/cjs/package.json', '{ "type": "commonjs" }\n');

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const src = readFileSync('src/client.ts', 'utf8');
if (!src.includes(`VERSION = '${pkg.version}'`)) {
  throw new Error(`src/client.ts VERSION does not match package.json version ${pkg.version}`);
}
