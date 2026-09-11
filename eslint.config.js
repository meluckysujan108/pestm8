//  @ts-check

import { tanstackConfig } from '@tanstack/eslint-config'

export default [
  ...tanstackConfig,
  {
    rules: {
      'import/no-cycle': 'off',
      'import/order': 'off',
      'sort-imports': 'off',
      '@typescript-eslint/array-type': 'off',
      '@typescript-eslint/require-await': 'off',
      'pnpm/json-enforce-catalog': 'off',
    },
  },
  {
    // `.output` is Nitro's build directory. Without it here, `npm run lint`
    // reports dozens of errors in generated bundles the moment anyone runs
    // `npm run build` — which is the other half of the same verification step.
    ignores: ['eslint.config.js', 'prettier.config.js', '.output/**'],
  },
]
