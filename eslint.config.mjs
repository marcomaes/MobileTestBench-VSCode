import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'test/fixtures/**', 'scripts/**', 'sync/**', '*.mjs'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      '@typescript-eslint/no-unused-expressions': ['error', { allowShortCircuit: true, allowTernary: true }],
      // Ported Kotlin `object X` + companion members use namespaces, and `this` aliases mirror Kotlin lambdas.
      '@typescript-eslint/no-namespace': 'off',
      '@typescript-eslint/no-this-alias': 'off',
      // Ported code keeps the Kotlin error semantics; the cause is not attached.
      'preserve-caught-error': 'off',
      // Defensive initialisers before try/catch mirror the Kotlin code.
      'no-useless-assignment': 'off',
    },
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
)
