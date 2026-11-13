import { globalIgnores } from 'eslint/config'
import babelParser from '@babel/eslint-parser'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'

export default [
  globalIgnores(['dist', 'source_package', '**/components/ui/**']),
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: babelParser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
        requireConfigFile: false,
        babelOptions: { parserOpts: { plugins: ['typescript', 'jsx'] } },
      },
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'no-redeclare': 'error',
    },
  },
]
