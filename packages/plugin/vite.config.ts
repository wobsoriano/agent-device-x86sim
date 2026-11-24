import { defineConfig } from 'vite-plus';

export default defineConfig({
  pack: {
    entry: ['src/index.ts'],
    format: 'esm',
    fixedExtension: false,
    dts: true,
  },
});
