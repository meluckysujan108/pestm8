//  @ts-check

import { tanstackConfig } from '@tanstack/eslint-config'

/**
 * A class-string rule, for both places a class is written: a plain string,
 * and a piece of a template literal.
 */
function classRule(pattern, message) {
  return [
    { selector: `Literal[value=${pattern}]`, message },
    { selector: `TemplateElement[value.raw=${pattern}]`, message },
  ]
}

/** Colours, sizes and strokes from the tokens, not written out. */
const TOKEN_RULES = [
  {
    // An icon's stroke follows its size: 1.7 at 18px and up, 2 at
    // 13–17px, 2.4 at 12px and under; chevrons, ✕, ✓, + and − one step
    // heavier (2.2 / 2). Any other value is a one-off weight.
    selector:
      'JSXOpeningElement:has(JSXAttribute[name.name="size"]) > JSXAttribute[name.name="strokeWidth"] > JSXExpressionContainer > Literal:not([value=1.7]):not([value=2]):not([value=2.2]):not([value=2.4])',
    message:
      'Icon strokeWidth must be 1.7 (18px+), 2 (13–17px), 2.2 (chevron/✕/✓/± at 13–17px) or 2.4 (12px and under).',
  },
  ...classRule(
    '/(^|\\s)text-\\[(13|15)px\\](\\s|$)/',
    'Use text-caption (13px) or text-body (15px), not an arbitrary size.',
  ),
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
  // A colour written into a class is a colour dark mode cannot reach.
  ...classRule(
    '/(^|[\\s:])(bg|text|border|ring|fill|stroke|outline|decoration|divide|accent|caret|placeholder|from|via|to|shadow)-\\[(#|rgba?\\(|hsla?\\(|oklch\\(|color:)/',
    'A colour in a class: use a token from styles.css (text-ink, bg-surface, border-hairline…). See docs/design-system.md §2.1.',
  ),
]

/** Dark mode is the palette's job: a token that is wrong in dark is fixed
 * in styles.css, for both themes, not patched in one component. */
const NO_DARK_VARIANT = classRule(
  '/(^|[\\s:])dark:/',
  'No dark: classes — the tokens carry the theme. If something is wrong in dark, fix the token in styles.css. See docs/design-system.md §9.',
)

/** Pieces with exactly one owner, so every sheet and every confirm behaves
 * the same way: the files that own them are exempted below. */
const OWNED_PRIMITIVES = [
  {
    selector:
      'JSXOpeningElement > JSXMemberExpression[object.name="Drawer"][property.name=/^(Root|NestedRoot|Portal|Overlay|Content)$/]',
    message:
      'Use Sheet or SheetShell from components/primitives/Sheet (Drawer.Title is fine inside SheetShell).',
  },
  {
    selector:
      'JSXOpeningElement > JSXMemberExpression[object.name="AlertDialog"]',
    message: 'Use ConfirmDialog from components/settings/ConfirmDialog.',
  },
]

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
    // The design system's rules (docs/design-system.md), where a slip is easy
    // and nobody would see it in review: each of these drifted across dozens
    // of files before it was written down. CI lints the files a change
    // touches, so they hold for new code and tighten as old files are edited.
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...TOKEN_RULES,
        ...NO_DARK_VARIANT,
        ...OWNED_PRIMITIVES,
      ],
      // An installed iPhone app draws these as a bare system box titled with
      // the page's address. Asking is ConfirmDialog's job.
      'no-alert': 'error',
    },
  },
  {
    // Vendored shadcn keeps its `dark:` classes: the `dark` variant is bound
    // to the app's own theme attribute in styles.css, so they obey the toggle.
    files: ['src/components/ui/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': ['error', ...TOKEN_RULES, ...OWNED_PRIMITIVES],
    },
  },
  {
    // The two files that own what OWNED_PRIMITIVES keeps everyone else from.
    files: [
      'src/components/primitives/Sheet.tsx',
      'src/components/settings/ConfirmDialog.tsx',
    ],
    rules: {
      'no-restricted-syntax': ['error', ...TOKEN_RULES, ...NO_DARK_VARIANT],
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
