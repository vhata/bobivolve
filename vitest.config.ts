import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['{sim,host,transport,ui,protocol,test}/**/*.{test,spec}.ts'],
    environment: 'node',
    globals: false,
    reporters: 'default',
    passWithNoTests: true,
  },
});
