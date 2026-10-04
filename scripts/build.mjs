// Builds dist/esm (ES modules) and dist/cjs (CommonJS), each with its own .d.ts files and a
// package.json marker so Node and TypeScript pick the right format for each directory.
// Run through `npm run build` so node_modules/.bin is on PATH.
import { execSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';

// package.json is the one place the version lives: src/version.ts (VERSION, User-Agent) is
// regenerated from it before every build, so what npm publishes and what the client reports
// cannot drift apart.
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const versionSource =
  '// Generated from package.json by scripts/build.mjs on every build. Do not edit: change\n' +
  '// "version" in package.json instead.\n' +
  `export const VERSION = '${pkg.version}';\n`;
if (readFileSync('src/version.ts', 'utf8') !== versionSource) writeFileSync('src/version.ts', versionSource);

rmSync('dist', { recursive: true, force: true });
execSync('tsc -p tsconfig.json', { stdio: 'inherit' });
execSync('tsc -p tsconfig.cjs.json', { stdio: 'inherit' });
writeFileSync('dist/esm/package.json', '{ "type": "module" }\n');
writeFileSync('dist/cjs/package.json', '{ "type": "commonjs" }\n');
