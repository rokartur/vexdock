import { defineConfig } from 'oxlint'
import core from 'ultracite/oxlint/core'
import react from 'ultracite/oxlint/react'
import tanstack from 'ultracite/oxlint/tanstack'

// Ultracite presets provide the baseline; the rules below are the ones carried
// over from the rarv repo so both codebases lint the same way.
export default defineConfig({
	extends: [core, react, tanstack],
	ignorePatterns: [
		...(core.ignorePatterns ?? []),
		'node_modules/**/*',
		'dist/**/*',
		'build/**/*',
		'*.md',
		'*.gen.ts',
		'*.svg',
		'*.conf',
		'*.lock',
		// Synced verbatim from rarv; lint them there, not here.
		'apps/web/src/components/ui/**',
		'apps/web/src/components/icons/**',
		'apps/web/src/utils/**',
	],
	plugins: ['react', 'jsx-a11y', 'typescript', 'import', 'unicorn', 'eslint'],
	categories: {
		correctness: 'error',
	},
	env: {
		builtin: true,
	},
	rules: {
		'jsx-a11y/prefer-tag-over-role': 'off',
		'jsx-a11y/no-redundant-roles': 'off',
		// Ultracite's stylistic defaults that this codebase and rarv both go against:
		// function declarations for components, interfaces where they read better,
		// grouped object keys, and helpers defined below their use.
		'sort-keys': 'off',
		'func-style': 'off',
		'react/function-component-definition': 'off',
		'no-use-before-define': 'off',
		'no-nested-ternary': 'off',
		'unicorn/no-nested-ternary': 'off',
		'typescript/consistent-type-definitions': 'off',
		'import/consistent-type-specifier-style': 'off',
		// Rules that demand a refactor rather than a fix, and that rarv does not run:
		// route components are long by nature, xterm and EventSource only expose
		// on<event> handlers, and constructor parameter properties are idiomatic TS.
		complexity: 'off',
		'react/react-compiler': 'off',
		'unicorn/prefer-add-event-listener': 'off',
		'typescript/parameter-properties': 'off',
	},
	overrides: [
		{
			files: ['**/*.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
			env: {
				browser: true,
				commonjs: true,
				node: true,
				'shared-node-browser': true,
			},
		},
		{
			files: ['**/*.{ts,tsx,cts,mts}'],
			plugins: ['typescript'],
			rules: {
				'typescript/no-explicit-any': 'warn',
				'typescript/consistent-type-imports': 'error',
				'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
			},
		},
		{
			files: ['apps/web/**/*.{ts,tsx}'],
			plugins: ['react', 'jsx-a11y', 'typescript', 'import'],
			env: {
				browser: true,
				'shared-node-browser': true,
			},
			rules: {
				'react/jsx-key': 'warn',
				'react/jsx-no-comment-textnodes': 'warn',
				'react/jsx-no-duplicate-props': 'warn',
				'react/jsx-no-target-blank': 'warn',
				'react/jsx-no-undef': 'warn',
				'react/no-children-prop': 'warn',
				'react/no-danger-with-children': 'warn',
				'react/no-direct-mutation-state': 'warn',
				'react/no-find-dom-node': 'warn',
				'react/no-is-mounted': 'warn',
				'react/no-render-return-value': 'warn',
				'react/no-string-refs': 'warn',
				'react/no-unescaped-entities': 'warn',
				'react/no-unknown-property': 'warn',
				'react/react-in-jsx-scope': 'off',
				'jsx-a11y/alt-text': 'error',
				'jsx-a11y/anchor-ambiguous-text': 'off',
				'jsx-a11y/anchor-has-content': 'error',
				'jsx-a11y/anchor-is-valid': 'error',
				'jsx-a11y/aria-activedescendant-has-tabindex': 'error',
				'jsx-a11y/aria-props': 'error',
				'jsx-a11y/aria-role': 'error',
				'jsx-a11y/aria-unsupported-elements': 'error',
				'jsx-a11y/autocomplete-valid': 'error',
				'jsx-a11y/click-events-have-key-events': 'error',
				'jsx-a11y/heading-has-content': 'error',
				'jsx-a11y/html-has-lang': 'error',
				'jsx-a11y/iframe-has-title': 'error',
				'jsx-a11y/img-redundant-alt': 'error',
				'jsx-a11y/label-has-associated-control': 'error',
				'jsx-a11y/media-has-caption': 'error',
				'jsx-a11y/prefer-tag-over-role': 'off',
				'jsx-a11y/mouse-events-have-key-events': 'error',
				'jsx-a11y/no-access-key': 'error',
				'jsx-a11y/no-distracting-elements': 'error',
				'jsx-a11y/no-noninteractive-tabindex': [
					'error',
					{ tags: [], roles: ['tabpanel'], allowExpressionValues: true },
				],
				'jsx-a11y/no-static-element-interactions': 'off',
				'jsx-a11y/no-redundant-roles': 'off',
				'jsx-a11y/role-has-required-aria-props': 'error',
				'jsx-a11y/role-supports-aria-props': 'error',
				'jsx-a11y/scope': 'error',
				'jsx-a11y/tabindex-no-positive': 'error',
				'typescript/no-explicit-any': 'warn',
				'typescript/no-inferrable-types': 'warn',
				'typescript/consistent-type-imports': [
					'error',
					{ prefer: 'type-imports', fixStyle: 'separate-type-imports', disallowTypeAnnotations: true },
				],
				'import/extensions': 'error',
				'import/no-namespace': 'error',
				'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
			},
		},
		{
			files: ['**/*.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
			plugins: ['unicorn'],
			rules: {
				curly: 'off',
				'no-unexpected-multiline': 'off',
				'unicorn/empty-brace-spaces': 'off',
				'unicorn/no-nested-ternary': 'off',
				'unicorn/number-literal-case': 'off',
			},
		},
	],
})
