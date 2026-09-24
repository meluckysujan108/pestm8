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
    // The other two are generated as well, and CI never lints them either:
    // `convex/_generated` is written by `npx convex codegen`, and
    // `public/pdfjs` is pdf.js's own runtime files, copied out of node_modules
    // by scripts/copy-pdfjs-assets.mjs before every dev server and build.
    ignores: [
      'eslint.config.js',
      'prettier.config.js',
      '.output/**',
      'convex/_generated/**',
      'public/pdfjs/**',
    ],
  },
]
