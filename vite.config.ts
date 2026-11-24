import { defineConfig } from 'vite-plus';

export default defineConfig({
  run: {
    cache: true,
    tasks: {
      e2e: {
        command: 'node scripts/e2e.ts',
        dependsOn: ['agent-device-x86sim#build'],
        cache: false,
      },
    },
  },
});
