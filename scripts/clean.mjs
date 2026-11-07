// Removes build output. Deliberately narrow: only the project's own dist folder.
import { rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, '..', 'dist');
rmSync(dist, { recursive: true, force: true });
console.log(`removed ${dist}`);
