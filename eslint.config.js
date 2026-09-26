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
    // The design system's rules, where a slip is easy and nobody would see it
    // in review: each of these drifted across dozens of files before it was
    // written down (see src/components/primitives/buttons.ts, styles.css).
    // CI lints the files a change touches, so they hold for new code and
    // tighten as old files are edited.
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          // An icon's stroke follows its size: 1.7 at 18px and up, 2 at
          // 13–17px, 2.4 at 12px and under; chevrons, ✕, ✓, + and − one step
          // heavier (2.2 / 2). Any other value is a one-off weight.
          selector:
            'JSXOpeningElement:has(JSXAttribute[name.name="size"]) > JSXAttribute[name.name="strokeWidth"] > JSXExpressionContainer > Literal:not([value=1.7]):not([value=2]):not([value=2.2]):not([value=2.4])',
          message:
            'Icon strokeWidth must be 1.7 (18px+), 2 (13–17px), 2.2 (chevron/✕/✓/± at 13–17px) or 2.4 (12px and under).',
        },
        {
          selector: 'Literal[value=/(^|\\s)text-\\[(13|15)px\\](\\s|$)/]',
          message:
            'Use text-caption (13px) or text-body (15px), not an arbitrary size.',
        },
        {
          selector:
            'TemplateElement[value.raw=/(^|\\s)text-\\[(13|15)px\\](\\s|$)/]',
          message:
            'Use text-caption (13px) or text-body (15px), not an arbitrary size.',
        },
        {
          selector:
            'Literal[value=/(^|\\s)bg-red(\\s|$)/][value=/(^|\\s)text-white(\\s|$)/]',
          message:
            'White text on the brand red is 3.5:1. Use bg-red-fill, or PRIMARY_BUTTON from components/primitives/buttons.',
        },
        {
          selector:
            'TemplateElement[value.raw=/(^|\\s)bg-red(\\s|$)/][value.raw=/(^|\\s)text-white(\\s|$)/]',
          message:
            'White text on the brand red is 3.5:1. Use bg-red-fill, or PRIMARY_BUTTON from components/primitives/buttons.',
        },
        {
          selector:
            'Literal[value=/(^|\\s)rounded-xl(\\s|$)/][value=/(^|\\s)bg-(red|red-fill|blue|ink)(\\s|$)/][value=/(^|\\s)h-1[0-2](\\s|$)/]',
          message:
            'A filled button: use PRIMARY_BUTTON / NEUTRAL_BUTTON (or the _COMPACT sizes) from components/primitives/buttons.',
        },
      ],
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
