import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'

// A portable protocol check when workerd cannot start locally. These tests run
// the actual Hono routes with SQLite and an in-memory R2 adapter; the normal
// Workers test configuration remains the deployment-runtime check.
export default defineConfig({
	root: fileURLToPath(new URL('.', import.meta.url)),
	resolve: {
		alias: {
			'cloudflare:test': fileURLToPath(
				new URL('./test-node-support/cloudflare-test.ts', import.meta.url)
			),
		},
	},
	test: {
		name: 'studio-node',
		environment: 'node',
		include: ['src/test/**/*.test.ts'],
		setupFiles: ['test-node-support/setup.ts'],
		maxWorkers: 1,
		fileParallelism: false,
	},
})
