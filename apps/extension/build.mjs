import { build, context } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const dist = resolve(root, 'dist');
const watch = process.argv.includes('--watch');

await rm(dist, { recursive: true, force: true });
await mkdir(resolve(dist, 'icons'), { recursive: true });
await mkdir(resolve(dist, 'chain-icons'), { recursive: true });
await Promise.all([
  cp(resolve(root, 'manifest.json'), resolve(dist, 'manifest.json')),
  cp(resolve(root, 'popup.html'), resolve(dist, 'popup.html')),
  cp(resolve(root, 'approval.html'), resolve(dist, 'approval.html')),
  cp(resolve(root, 'src/ui/styles.css'), resolve(dist, 'styles.css')),
  cp(resolve(root, '../desktop/src-tauri/icons/32x32.png'), resolve(dist, 'icons/32.png')),
  cp(resolve(root, '../desktop/src-tauri/icons/128x128.png'), resolve(dist, 'icons/128.png')),
  cp(resolve(root, '../desktop/public/chain-icons'), resolve(dist, 'chain-icons'), { recursive: true }),
]);

const options = {
  entryPoints: {
    background: resolve(root, 'src/background.ts'),
    content: resolve(root, 'src/content.ts'),
    inpage: resolve(root, 'src/inpage.ts'),
    popup: resolve(root, 'src/ui/popup.tsx'),
    approval: resolve(root, 'src/ui/approval.tsx'),
  },
  outdir: dist,
  bundle: true,
  format: 'esm',
  target: 'chrome111',
  sourcemap: watch,
  define: {
    'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production'),
  },
  logLevel: 'info',
};

if (watch) {
  const buildContext = await context(options);
  await buildContext.watch();
  console.log(`FnzSafe extension watching ${dist}`);
} else {
  await build(options);
}
