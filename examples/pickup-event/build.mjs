import { build } from 'esbuild';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('./', import.meta.url));
const destination = resolve(process.argv[2] ?? 'tmp/pickup-event');
await mkdir(destination, {recursive:true});
await build({ entryPoints: [resolve(root, 'pickup.ts'), resolve(root, 'worker.ts')], bundle: true, format: 'esm', target: 'es2022',
    minify: true, outdir: destination, tsconfig: fileURLToPath(new URL('../../packages/shared-web/tsconfig.json', import.meta.url)) });
for (const asset of ['court.png','manifest.webmanifest','pickup.css']) await cp(resolve(root, asset), resolve(destination, asset));
await writeFile(resolve(destination, 'index.html'), (await readFile(resolve(root,'index.html'),'utf8')).replace('./pickup.ts','./pickup.js'));
