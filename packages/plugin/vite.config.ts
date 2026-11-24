import { defineConfig } from 'vite-plus';

export default defineConfig({
  pack: {
    entry: ['src/index.ts', 'src/cli.ts'],
    format: 'esm',
    fixedExtension: false,
    tsconfig: '../../tsconfig.pack.json',
    dts: { entry: ['src/index.ts'] },
    copy: [{ from: '../ax-hook/prebuilt/libx86sim-ax.dylib', to: 'ax-hook' }],
  },
});
