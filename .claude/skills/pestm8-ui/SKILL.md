---
name: pestm8-ui
description: "Build or change PestM8's UI so it matches the app's design system. Use for any work under src/ that renders something: a new screen, sheet, form, card, button, empty or loading state, copy change, colour or spacing tweak, dark-mode fix, or a UI review. Covers which shared component to use, the tokens, the states every screen needs, the copy rules, and how to screenshot the result without a backend."
---

# Building UI in PestM8

The design system is `docs/design-system.md`. **Read it before writing UI**:
at least sections 1 (principles), 4 (components) and 5 (patterns), and
whichever others your change touches. It is short on purpose and it is
checked against the code, so it is current.

What follows is how to work with it, not a copy of it.

## Before you write markup

1. **Find the existing piece.** Check the guide's section 4, then
   `src/components/primitives/`, `forms/`, `shell/` and `settings/ui.tsx`.
   Look for the closest existing screen that does what yours does, and copy
   its structure rather than inventing one: a list page like
   `routes/$businessSlug/clients/index.tsx`, a Settings page like
   `routes/$businessSlug/settings/details.tsx`, a sheet like
   `components/clients/ClientSheet.tsx`.
2. **Decide the states now:** loading, empty, no matches, failed, saving,
   saved. Each has a component (guide section 4.6 and section 5).
3. **Write the copy with the guide's section 7 open:** verbs on buttons,
   "{Verb}ing…", "Could not … — {what to do}", curly apostrophes, dates from
   `src/lib/format.ts`.

## While you write it

- Colours, sizes, radii and shadows come from tokens by name. Never write a
  hex value, `text-[13px]`, `text-sm`, `rounded-[8px]`, `shadow-md` or a
  `dark:` class.
- Buttons are `buttons.ts` constants: red commits, ink goes forward, grey is
  the alternative, grey-with-blue goes somewhere.
- Fields use `FIELD` / `FormField` (16px text), and every field has a visible
  label.
- Controls are 44px to a finger: add `tap-target` (on a `relative` element)
  to anything drawn smaller.
- Sheets use `Sheet`/`SheetShell`. A confirm is `ConfirmDialog`, worded
  "{Verb} {thing}?" / "{Verb}" / "Keep {thing}".
- A failed save is `FormAlert` (amber). A field that can't be accepted is
  `FieldMessage tone="error"` (red-ink).
- Disable JavaScript-driven controls until hydrated (`useHydrated`).
- z-index comes only from the guide's stacking order (2.7).

## Before you call it done

1. **Look at it.** Render it with `pnpm ui:harness` and shoot it with
   `pnpm ui:shots` (see `tools/ui-harness/README.md`); in a cloud session,
   set `CHROMIUM_PATH=/opt/pw-browsers/chromium`. Open the light **and**
   dark shots at 375px and read them. For a new component, add a specimen
   and its fixtures first. For a change to an existing one, shoot the base
   branch too (the README's "Before and after") and compare.
2. **Check it:**
   - `pnpm typecheck`;
   - `pnpm test`, which includes `src/lib/designSystem.test.ts`, the guide's drift test;
   - `npx eslint` and `npx prettier --check` on the files you changed. Only format files that were already clean; don't reformat others.
3. **Keep the guide true.** If you added or renamed a shared component, a
   token, a text size or a radius, update `docs/design-system.md` in the same
   commit. The drift test fails until you do.
4. **Settled decisions.** If the change departs from one of the guide's
   "Decisions already made" (section 10), stop and ask rather than shipping it.

## When the guide and the code disagree

- **The code is wrong** if it is an outlier: something the guide's rules
  forbid, or one screen doing what others do another way. Fix it if it is in
  scope; otherwise mention it.
- **The guide is wrong** if the code's way is deliberate, commented and
  used widely. Fix the guide in the same change and say so.

Don't quietly follow either one.
