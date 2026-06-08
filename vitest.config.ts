import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		environment: 'node',
		include: ['tests/**/*.test.ts'],
		coverage: {
			provider: 'v8',
			include: ['src/**/*.ts'],
			exclude: ['src/main.ts', 'src/*-tab.ts', 'src/*-view.ts', 'src/*-modal.ts', 'src/*-extension.ts', 'src/gutter-manager.ts'],
		},
	},
	resolve: {
		alias: {
			obsidian: new URL('./tests/__mocks__/obsidian.ts', import.meta.url).pathname,
		},
	},
});
