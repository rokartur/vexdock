import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import svgr from 'vite-plugin-svgr'

export default defineConfig({
	resolve: {
		alias: {
			'@': fileURLToPath(new URL('src', import.meta.url)),
		},
	},
	ssr: {
		// The shell is prerendered once at build time. Dependencies left external
		// would be loaded as CJS and pick up a second React instance, which fails
		// the moment a component calls a hook.
		noExternal: true,
	},
	plugins: [
		// SPA mode: the build emits a static shell plus client assets. Production
		// has no JavaScript runtime, Nginx serves the files directly.
		tanstackStart({
			spa: { enabled: true, prerender: { outputPath: '/index.html' } },
		}),
		viteReact(),
		tailwindcss(),
		// The ui primitives import a few icons as SVG files, same as rarv.
		svgr({ svgrOptions: { memo: true, icon: true, exportType: 'named' }, include: '**/*.svg' }),
	],
	server: {
		// In development the Go manager runs on :8080 and owns every /api route.
		proxy: {
			'/api': {
				target: 'http://127.0.0.1:8080',
				changeOrigin: true,
				ws: true,
			},
		},
	},
})
