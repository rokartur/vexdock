import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import svgr from 'vite-plugin-svgr'

export default defineConfig(({ command }) => ({
	resolve: {
		alias: {
			'@': fileURLToPath(new URL('src', import.meta.url)),
		},
	},
	ssr: {
		// The shell is prerendered once at build time. Dependencies left external
		// would be loaded as CJS and pick up a second React instance, which fails
		// the moment a component calls a hook. The dev server needs the opposite:
		// its module runner cannot evaluate a bundled-in CJS React at all.
		noExternal: command === 'build' || undefined,
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
		proxy: {
			// Nginx from the local stack, which is the only thing that splits /api
			// between the auth service and the manager the way production does.
			'/api': {
				target: process.env.API_TARGET ?? 'http://127.0.0.1:3000',
				// The Host header has to survive: the manager rejects a mutation whose
				// Origin does not match it, and that is the CSRF defence for cookies.
				changeOrigin: false,
				ws: true,
			},
		},
	},
}))
