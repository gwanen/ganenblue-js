import js from '@eslint/js';
import globals from 'globals';

/**
 * Flat config (ESLint v9+). Intentionally lean: this is an automation tool, not
 * a library, so the goal is to catch real defects (unused code, undeclared
 * globals, obvious mistakes) rather than enforce a full style guide — Prettier
 * owns formatting.
 */
export default [
    {
        ignores: ['dist/**', 'node_modules/**', 'logs/**'],
    },
    js.configs.recommended,
    {
        files: ['src/**/*.js', 'tests/**/*.js', 'scripts/**/*.js'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: {
                ...globals.node,
                ...globals.browser, // page.evaluate() callbacks reference document/window
                chrome: 'readonly', // Chromium global, referenced in stealth-test evaluate blocks
            },
        },
        rules: {
            'no-unused-vars': ['warn', {
                argsIgnorePattern: '^_',
                varsIgnorePattern: '^_',
                caughtErrors: 'none', // an unused catch binding is a common, harmless idiom here
            }],
            'no-empty': ['warn', { allowEmptyCatch: false }],
            'no-console': 'off',
            // v10 recommended adds these; they flag style, not defects, and are noisy
            // against this codebase's existing error-handling idioms. Keep as advisory.
            'preserve-caught-error': 'off',
            'no-useless-assignment': 'warn',
        },
    },
    {
        // Tests use Jest globals and browser-style fetch mocks.
        files: ['tests/**/*.js'],
        languageOptions: {
            globals: {
                ...globals.jest,
            },
        },
    },
];
