import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
const rootRequire = createRequire(new URL('../package.json', import.meta.url));
const backendRequire = createRequire(new URL('../packages/backend/package.json', import.meta.url));

function packageVersion(requireFrom, name) {
  try { return requireFrom(name + '/package.json').version; }
  catch (error) { if (error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error; }
  let directory = dirname(requireFrom.resolve(name));
  while (true) {
    const candidate = join(directory, 'package.json');
    if (existsSync(candidate)) {
      const metadata = JSON.parse(readFileSync(candidate, 'utf8'));
      if (metadata.name === name) return metadata.version;
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error('Cannot locate resolved package metadata: ' + name);
    directory = parent;
  }
}
const versions = {
  prisma: packageVersion(rootRequire, 'prisma'),
  '@prisma/client': packageVersion(backendRequire, '@prisma/client'),
  '@prisma/adapter-pg': packageVersion(backendRequire, '@prisma/adapter-pg')
};
if (new Set(Object.values(versions)).size !== 1 || !Object.values(versions).every(version => /^7\.\d+\.\d+$/.test(version))) {
  throw new Error('Prisma CLI/Client/adapter must resolve to matching stable 7.x patches.');
}
const lockfile = readFileSync(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8');
if (/@prisma\/(?:client|adapter-pg)@8\.|(?:^|\n)\s+prisma@8\./.test(lockfile)) throw new Error('Unexpected Prisma8 in the lockfile.');
console.log('Verified resolved matching Prisma7 packages: ' + JSON.stringify(versions));
