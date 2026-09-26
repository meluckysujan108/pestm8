# PestM8 design system

These are the rules for building UI in this app. They are written for whoever builds it next, a person or an agent. Read them before touching anything under `src/`, and follow them over habit. Where they disagree with what you would normally do, it is because this app is used on a phone, outdoors, by someone with one free hand.

**What is authoritative:**

- The code is the source of truth; this guide says how to use it.
- `src/styles.css` owns every colour, size and radius.
- `src/components/primitives/`, `forms/` and `shell/` own the shared pieces.
- `ARCHITECTURE.md` Part 2 is the history: why a token is what it is, which screens exist, and the product decisions behind them. Where it and this guide differ on _how to build something_, this guide wins.

**It is checked:**

- `src/lib/designSystem.test.ts` fails when:
  - this guide's token tables stop matching `styles.css`;
  - a shared component is exported without being listed here;
  - a z-index appears that is not in the [stacking order](#27-stacking-order).
- ESLint (`eslint.config.js`, over `src/**`) refuses the mechanical mistakes marked **(lint)** in [Don'ts](#11-donts).

Change this guide in the same commit as the thing it describes.

**Seeing your change:**

- `pnpm ui:harness` renders the real components with sample data and no backend.
- `pnpm ui:shots` screenshots them at phone width in both themes.
- `tools/ui-harness/README.md` explains how to set it up and add to it.

Use it for every visual change, and look at the shots before you call the change done.

---

## 1. Principles

1. **Built for a doorstep, not a desk.** Expect sun on the screen, a glove on the hand, and the phone held in one hand. So:
   - text clears contrast in sunlight;
   - every control is at least 44px to a thumb;
   - nothing irreversible happens on one tap;
   - nothing important hides behind hover.
2. **It looks like iOS.** Grouped lists on a grey canvas, white cards, the system font, sheets that rise from the bottom, segmented controls, a bottom tab bar. When you're unsure how something should look, do what iOS Settings or Calendar does.
3. **Tokens, never values.** A colour, a text size or a radius comes from `styles.css` by name (`text-ink`, `text-body`, `rounded-xl`). Nothing under `src/` names a hex colour. That is what lets dark mode be one block of CSS.
4. **One meaning per colour.**
   - Red is the brand and the action that commits.
   - Blue is a link.
   - Amber is a warning.
   - A tinted pill with a word is a status.
   - A solid dot is a person.

   Never borrow a colour for its looks.

5. **Reuse before you write.** A button is a constant from `buttons.ts`, a sheet is `Sheet`, a confirm is `ConfirmDialog`, a failed save is `FormAlert`. Seven screens once hand-rolled the same sheet; don't be the eighth.
6. **Every state is designed:** loading, empty, no matches, failed, saving and saved. A screen that only looks right with data is not finished.
7. **Say what happened and what to do next,** in plain words and the user's own words. No blame, no codes.

---

## 2. Tokens

All tokens live in `src/styles.css`.

- Light is `:root, [data-theme='light']` and dark is `[data-theme='dark']`.
- The theme is an attribute on `<html>`, and it can pin a subtree: `<article data-theme="light">` keeps the report preview on paper.
- Each raw token is mapped to a Tailwind colour of the same name, so `--ink` gives `text-ink`, `bg-ink` and `border-ink`.

### 2.1 Colour

| Token                  | Light                       | Dark                        | Use for                                                                                                                            |
| ---------------------- | --------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `--ink`                | `#1c1c1e`                   | `#ffffff`                   | Titles, primary text, the neutral button's fill                                                                                    |
| `--ink-2`              | `#3a3a3c`                   | `#e5e5ea`                   | Body text that must be read; grey glyphs                                                                                           |
| `--muted`              | `#8e8e93`                   | `#98989f`                   | Metadata that can be skipped: times, counts, captions, group footers. Only 2.8–3.3:1, so not for anything that must be read in sun |
| `--muted-2`            | `#9b9ba1`                   | `#8e8e93`                   | Section labels (`section-label`), chevrons, tertiary glyphs                                                                        |
| `--hairline`           | `rgba(60, 60, 67, 0.1)`     | `rgba(235, 235, 245, 0.14)` | Card borders and row dividers. The default border colour                                                                           |
| `--hairline-2`         | `rgba(60, 60, 67, 0.07)`    | `rgba(235, 235, 245, 0.08)` | A fainter divider inside a card                                                                                                    |
| `--surface`            | `#ffffff`                   | `#1c1c1e`                   | Cards, rows in a sheet, popovers                                                                                                   |
| `--surface-2`          | `#f2f2f7`                   | `#2c2c2e`                   | Inset blocks inside a card: locked boilerplate, a note, a quiet chip, a thumbnail                                                  |
| `--surface-3`          | `#f4f4f8`                   | `#2a2a2c`                   | Input wells: every field's fill, and read-only values shown as fields                                                              |
| `--canvas`             | `#ededf1`                   | `#000000`                   | The app background, and a sheet's background                                                                                       |
| `--fill-track`         | `rgba(118, 118, 128, 0.08)` | `rgba(120, 120, 128, 0.28)` | A segmented control's track                                                                                                        |
| `--fill-secondary`     | `rgba(118, 118, 128, 0.12)` | `rgba(118, 118, 128, 0.24)` | Grey buttons (`SECONDARY_BUTTON`, `LINK_BUTTON`)                                                                                   |
| `--red`                | `#ff3b30`                   | `#ff453a`                   | Brand as a word or glyph: today, the current tab, a destructive text row, an invalid field's ring                                  |
| `--red-fill`           | `#dc2a1f`                   | `#dc2a1f`                   | Red **behind white text**: the primary button, the header's +, the selected day (4.8:1)                                            |
| `--blue`               | `#0a84ff`                   | `#0a84ff`                   | Links and text buttons, the focus ring, a selected tick, an active filter, info glyphs, mention badges                             |
| `--green`              | `#34c759`                   | `#30d158`                   | A success glyph (a tick, a done step). Never text                                                                                  |
| `--amber`              | `#ff9f0a`                   | `#ff9f0a`                   | A warning glyph or bar. Never text                                                                                                 |
| `--amber-ink`          | `#985b00`                   | `#ffb340`                   | Warning and failure **text**, on any surface (4.5:1, checked)                                                                      |
| `--amber-bg`           | `#fff8ec`                   | `#2a1e0a`                   | A warning box's fill                                                                                                               |
| `--amber-line`         | `#ffe2b8`                   | `#4d3712`                   | A warning box's border                                                                                                             |
| `--chrome`             | `rgba(255, 255, 255, 0.92)` | `rgba(28, 28, 30, 0.86)`    | Glass bars: the tint over a blurred backdrop. Use `chrome-bar`, `chrome-dock` or `chrome-blur`, never the colour alone             |
| `--scrim`              | `rgba(0, 0, 0, 0.3)`        | `rgba(0, 0, 0, 0.6)`        | Behind sheets and dialogs                                                                                                          |
| `--paper`              | `#ffffff`                   | `#ffffff`                   | Anything drawn for print: a signature pad, a PDF page                                                                              |
| `--viewer-backdrop`    | `#f2f2f7`                   | `#0c0c0d`                   | Behind the pages in the document viewer                                                                                            |
| `--on-tint`            | `#ffffff`                   | `#ffffff`                   | Text on a solid saturated tint (a blue count badge)                                                                                |
| `--search-hit`         | `rgba(255, 214, 10, 0.5)`   | `rgba(255, 214, 10, 0.5)`   | Find in a PDF: every match                                                                                                         |
| `--search-hit-current` | `rgba(255, 149, 0, 0.7)`    | `rgba(255, 149, 0, 0.7)`    | Find in a PDF: the match being looked at                                                                                           |

The palette blocks also hold values you don't pick directly:

- `--block-tint`: how much of a technician's colour fills a Week View block.
- `--elevation`, `--elevation-red` and `--paper-shadow`: see [Elevation](#25-elevation).
- `--chrome-filter`: the blur behind the glass bars, which the `chrome-*` utilities apply.

**Readable text.** A sentence someone must read uses `ink`, `ink-2` or an `-ink` token.

- For a short caption that must survive sun, use `text-grey-ink` rather than `text-muted`.
- `text-red` (3.5:1) is for a bold control word ("Delete account", today's date), never a sentence. An error sentence is `text-red-ink`.
- `text-green` is a glyph colour; "Saved" in words is `text-green-ink`.

**White text on colour** only ever sits on `bg-red-fill`, on `bg-ink` (as `text-surface`), or on `bg-blue` (a badge, `text-on-tint`). Never `bg-red text-white` **(lint)**.

**Raw black and white** (`bg-black/40`, `bg-white`) belong only:

- over a photo (a scrim behind a control on an image);
- on something that must stay those colours in both themes (a QR code, a switch thumb).

### 2.2 Status, person, overdue, warning

A job card can carry all four at once, so each keeps its own **form** as well as its colour. Never give one of them another's form.

| Signal              | Form                                                                       | Where it is decided                                                                                       |
| ------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Person (technician) | A solid dot or rail with no text, in their colour (set in Settings → Team) | `convex/lib/colours.ts`. Drawn with `style={{ backgroundColor }}`, the one place a colour comes from data |
| Status              | A bordered, tinted **pill that always says its word**                      | `src/lib/statusColours.ts` → `StatusPill`, `TONE_PILL`, `REPORT_PILL`                                     |
| Overdue             | Ink on the surface, with **no hue**                                        | `OVERDUE_CHIP` (`--overdue`/`--overdue-ink`)                                                              |
| Warning             | Amber text in a pale amber box with a border                               | `FormAlert`, `FieldMessage tone="warning"`                                                                |

The status ramps are each a `-bg` / `-line` / `-ink` triple, in both themes:

| Ramp         | Status    | Light bg / line / ink             | Dark bg / line / ink              |
| ------------ | --------- | --------------------------------- | --------------------------------- |
| `--orange-*` | Recurring | `#ffe0c7` / `#d9560a` / `#7d2f00` | `#47260f` / `#ff8a3d` / `#ffb787` |
| `--red-*`    | Pending   | `#ffdcd9` / `#ff3b30` / `#930a05` | `#4a1b17` / `#ff453a` / `#ffa39c` |
| `--yellow-*` | Booked    | `#ffeb99` / `#a88100` / `#5c4500` | `#413507` / `#ffd60a` / `#ffe270` |
| `--green-*`  | Completed | `#d3f0dc` / `#22963f` / `#045620` | `#133b20` / `#30d158` / `#7de39a` |
| `--blue-*`   | Invoiced  | `#d6e8ff` / `#0a84ff` / `#024596` | `#0d3160` / `#0a84ff` / `#99cbff` |
| `--grey-*`   | Cancelled | `#ebebf0` / `#8e8e93` / `#545458` | `#2c2c2e` / `#8e8e93` / `#aeaeb2` |

- `statusColours.test.ts` checks that every `-ink` clears 7:1 on its `-bg` (grey 6:1) and every `-line` clears 3:1 on the card.
- A draft report stays amber; finalised is green and sent is blue.
- A new status goes in `statusColours.ts`, never as a pill written out in a component.

A **pill** is `rounded-full px-2.5 py-0.5 text-[12px] font-semibold` plus one colour class from `statusColours.ts` (`TONE_PILL`, `REPORT_PILL`, `OVERDUE_CHIP`). A **count badge** is `rounded-full px-1.5 text-[11px] font-bold`.

### 2.3 Type

The font is the system font (`-apple-system`, SF Pro), with tabular numerals everywhere (set on `body`). Use the named sizes: each carries its own line height, tracking and weight.

| Class                | Size | Weight | Use for                                                                     |
| -------------------- | ---- | ------ | --------------------------------------------------------------------------- |
| `text-metric-lg`     | 36px | 700    | The one big number on a dashboard card                                      |
| `text-metric`        | 32px | 700    | A headline figure                                                           |
| `text-metric-sm`     | 26px | 700    | A figure in a row of figures                                                |
| `text-page-title`    | 28px | 700    | The page's `<h1>`: `PageHeader`, or an entry screen's title                 |
| `text-sheet-title`   | 21px | 700    | A sheet's title                                                             |
| `text-row-title`     | 17px | 600    | A card's or a row's title; an empty state's title; a dialog's title         |
| `text-body`          | 15px | 400    | Body text, row text, compact button labels                                  |
| `text-caption`       | 13px | 400    | Secondary lines, help text, field messages, warnings                        |
| `text-section-label` | 11px | 700    | Through the `section-label` utility: grey capitals above a group or a field |
| `text-tab-label`     | 10px | 600    | The mobile dock's tab words                                                 |

Three sizes may be written as literals, because each belongs to a component rather than to a reading level:

- **`text-[16px]`: every text input.** Below 16px, iOS zooms the page on focus. `FIELD` and `fieldInputClass` already set it, as does the empty state's button.
- **`text-[17px]`:** a full-size (48px) button's label. The button constants set it.
- **`text-[12px]` / `text-[11px]`:** a pill's word and a count badge's number (see 2.2), and the small day labels in the calendars.

Anything else is off the scale:

- `text-[13px]` and `text-[15px]` **(lint)**;
- `text-[14px]`, `text-[21px]`, `text-xs`, `text-sm`.

**Weight:**

- `font-semibold` for anything tappable, and for a title where the token doesn't set it.
- `font-bold` only where a token already sets it.
- `font-medium` only for a field label inside a card (`FIELD_LABEL`).

### 2.4 Radius

| Class               | Radius | Use for                                                            |
| ------------------- | ------ | ------------------------------------------------------------------ |
| `rounded-sm`        | 8px    | A thumbnail, an icon tile, a small inset chip                      |
| `rounded-md`        | 9px    | Small controls in dense toolbars (the PDF viewer's)                |
| `rounded-lg`        | 12px   | A tile inside a card, a small menu item                            |
| `rounded-xl`        | 18px   | Buttons, fields, a row-card in a sheet, a warning box. The default |
| `rounded-2xl`       | 22px   | A card on the canvas, a popover, an empty state, a dialog          |
| `rounded-t-sheet`   | 22px   | A sheet's top corners (`SheetShell` sets it)                       |
| `rounded-segmented` | 9px    | A segmented control's track                                        |
| `rounded-segment`   | 7px    | Its selected segment                                               |
| `rounded-full`      | —      | Pills, badges, dots, circular icon buttons                         |

`rounded-[Npx]` is for a one-off drawn shape, such as a colour swatch's corner or a scrollbar thumb. It is never for a control, and never to spell a token (`rounded-[8px]` is `rounded-sm`).

### 2.5 Elevation

**Light:** white cards lift off a grey canvas with a soft shadow.
**Dark:** elevation is lightness. The canvas is black, cards sit above it at `#1c1c1e`, and a hairline ring does the shadow's work.

Components don't change for this; the tokens do.

| Class              | Use for                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------ |
| `shadow-elevation` | A card or popover that sits directly on the canvas. Not a card inside a card, and not a row in a sheet |
| `shadow-red`       | The primary button and the header's + only (`PRIMARY_BUTTON` includes it)                              |
| `shadow-paper`     | A PDF page or a printed surface in the viewer                                                          |

Don't use any other shadow (`shadow-sm`, `shadow-md`) outside `src/components/ui/`.

**The card** is `rounded-2xl border border-hairline bg-surface shadow-elevation`, with `p-3.5` or `p-4` padding.

- A grouped list uses the same card with `divide-y divide-hairline overflow-hidden` and no padding.
- Inside a sheet, whose background is the canvas, a row-card is `rounded-xl border border-hairline bg-surface px-3 py-2.5`, with no shadow.

### 2.6 Spacing

Spacing uses Tailwind's 4px scale. These are the recurring values; use them before inventing one.

| Where                                                | Value                                                                               |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Page gutter, inside the shell                        | `px-4` (entry screens `px-6`)                                                       |
| A toolbar row under the header (search, `Segmented`) | `px-4 pt-3`                                                                         |
| A page's content                                     | `<section className="px-4 pt-4 pb-6">` (`pt-3` straight under a toolbar)            |
| A list of cards                                      | `flex flex-col gap-2.5 md:grid md:grid-cols-2` (`xl:grid-cols-3` for job lists)     |
| A form's fields                                      | `flex flex-col gap-3`                                                               |
| A label and its field                                | `flex flex-col gap-1.5`                                                             |
| A row in a card                                      | `px-3.5 py-3`; a settings row `ROW_CLASS` (`min-h-[52px] px-3.5 py-2.5`)            |
| Inside a row                                         | `items-center gap-2`, or `gap-3` with a leading tile; an icon to its word `gap-1.5` |
| Between sections or groups                           | `mt-6`; before a final call to action or the `DangerGroup`, `mt-8`                  |
| A `section-label` heading to its content             | `mb-2`                                                                              |
| A sheet's scrolling body                             | `SHEET_BODY`: `px-4`, bottom `24px + env(safe-area-inset-bottom)`                   |

**Safe areas** are part of the layout:

- a sticky header pads `pt-[calc(12px+env(safe-area-inset-top))]`;
- a sheet's last element clears the home indicator;
- the dock pads its own bottom;
- `main` pads `pb-[calc(68px+env(safe-area-inset-bottom))]` above the dock.

A bar fixed or pinned to the bottom of a phone screen sits directly on the dock at `ABOVE_DOCK` (`shell/dock.ts`), which counts both the dock and the safe area.

### 2.7 Stacking order

The layers are fixed. Pick from these and never invent one: the drift test fails on any other z-index under `src/`.

| z                   | What                                                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `z-10`              | Overlays within a page or card, the desktop sidebar, a viewer's own bars and toasts                                           |
| `z-20`              | Sticky bars inside content: `SaveBar`, the schedule's week strip                                                              |
| `z-30`              | The sticky `PageHeader` and its placeholder; fixed bottom action bars (the builder's); the update banner; address suggestions |
| `z-40`              | The mobile dock; a sheet's scrim; the note format bar                                                                         |
| `z-50`              | Sheets, popovers, dropdown menus, comboboxes, tooltips, the photo annotator                                                   |
| `z-[60]` / `z-[70]` | `ConfirmDialog`'s scrim / panel; `NavProgress` at 60                                                                          |
| `z-[80]`            | Full-screen viewers (document, image)                                                                                         |
| `z-[90]`            | A viewer's own menus and status                                                                                               |

The consequence: nothing inside a viewer (z-80) may open a `ConfirmDialog` (z-60), because it would open behind. The viewer asks in place instead (`pdf/clearConfirm.ts`: "Tap again to clear").

### 2.8 Motion

Motion is quiet and quick.

**Sheets** rise on Vaul's own curve, `cubic-bezier(.32,.72,0,1)`. The `ease-sheet` token names that curve for anything else that should move like a sheet; use the token rather than writing the curve out.

**Transitions** use `transition` at Tailwind's default 150ms.

**Press feedback** is a scale. Match it to what is pressed:

| Pressed                                         | Class                                  |
| ----------------------------------------------- | -------------------------------------- |
| A button (in the constants)                     | `active:scale-[.975]`                  |
| A round icon button, a chip                     | `active:scale-[.95]`                   |
| A small secondary control (a tile, a thumbnail) | `active:scale-[.97]`                   |
| A whole card or row                             | `active:scale-[.99]`                   |
| A text button in chrome                         | `active:opacity-50`                    |
| A settings row                                  | `active:bg-surface-2` (in `ROW_CLASS`) |

**Reduced motion:**

- Anything that moves on its own goes behind `motion-safe:` (`motion-safe:animate-pulse` for placeholders), or is stopped with `motion-reduce:`.
- A spinner (`animate-spin`) is exempt: stopped, it would look like a hang.

**Entrances:** content does not animate in. The one-off celebrations in onboarding are behind `motion-safe:`.

---

## 3. Layout

**The shell** (`shell/AppShell.tsx`):

- On a phone, a full-bleed column over the bottom dock (`MobileDock`), clamped to `max-w-[460px]`, `md:max-w-[760px]` and `lg:max-w-[1280px]`.
- From `lg:` up, a collapsible sidebar beside an inset panel.
- Both navs are always in the DOM and switched with CSS, never with a conditional render: a nav that unmounts cannot be found by a keyboard, a screen reader or a test.

**Navigation** is Schedule, Clients, Reports and Notes, plus **More**.

- The items live in `shell/navItems.ts` (`PRIMARY_NAV`, `MORE_NAV`, `SETTINGS_ITEM`).
- More is active on any of its routes.
- Badges are keyed by route (`NOTES_TO`, `JOB_TO`) and cap at "9+".
- Tab names are plural nouns.

**A business page** is built like this:

1. `PageHeader` (sticky, `chrome-bar`, `z-30`): a `section-label` kicker over a truncated `text-page-title` `<h1>`, with actions on the right. Its hairline shows only once something has scrolled under it.
   - The kicker is context: the business, a count, or the month. On the schedule it is a blue control that opens the month.
   - A page nested inside another passes `back={<BackLink>}` ("‹ Settings") instead of a kicker.
2. Optional toolbar rows: search, then `Segmented`, each `px-4 pt-3`.
3. The content section: `px-4 pt-4 pb-6`.

**Glass bars.** Anything that floats over content is glass: a tint over a blurred backdrop, turning opaque for anyone who asks for less transparency.

- **A bar at the top edge** (the header, the schedule's week strip) is `chrome-bar`.
- **A bar at the bottom edge** (the dock) is `chrome-dock`.
- Both need a position and a z-index, plus a 1px border on the edge facing the content. Keep that border transparent until something scrolls under it: `useScrolledUnder` sets `data-scrolled`, and `data-scrolled:border-hairline` shows the line.
- **Glass anywhere else** (a viewer's bars, a floating notice, a builder's bottom bar) is `chrome-blur`.

**The page's create action** is the round red + in the header: `HEADER_ADD_BUTTON`, with `Plus` at size 20 and an `aria-label` naming what it adds.

**A Settings page** is `PageHeader back=…` then `SettingsBody`, a column of `SettingsGroup`s, the `DangerGroup` last, and a `SaveBar` if anything is edited (see 4.7).

**An entry screen** (sign-in, invitation, two-step, not found) has no shell:

- `<main className="mx-auto flex min-h-dvh w-full max-w-[460px] flex-col justify-center px-6">`;
- a `section-label` kicker ("PestM8"), then a `text-page-title` `<h1>`;
- a `mt-2 text-body text-muted` lede;
- an in-flow `PRIMARY_BUTTON w-full`.

**Column widths.** On a wide screen, cap the reading column:

- a sheet: `max-w-[460px]`;
- a Settings page: `max-w-[640px]` (`SettingsBody`);
- the report builder's section: `lg:max-w-[720px]` beside its rail.

Don't let a form stretch across 1280px.

**Breakpoints** are mobile-first.

- `md:` re-flows lists into two columns.
- `lg:` brings the sidebar, split panes, and fixed bars becoming static.
- `xl:` adds a third column.
- Switch layouts in CSS, not with `useMediaQuery`. Hover is never the only way to reach something.

**Sheets or pages?**

- A sheet is for something done and dismissed without losing the list behind it: a job's detail, a picker, a quick form, a read-back before an irreversible act.
- A page is somewhere you go and stay: a report, a Settings page.
- The URL carries views, filters and the open report section, so the back gesture does what a person expects.

---

## 4. Components: which to use

Look here before writing markup. The drift test fails if any export of these modules is missing from this section.

### 4.1 Buttons: `primitives/buttons.ts`

These are class strings. Put them on a `<button>` or a `<Link>`, plus layout classes (`w-full`, `flex-1`, `px-4`).

| Constant                   | Looks                                     | Use for                                                                                                              |
| -------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `PRIMARY_BUTTON`           | Red fill, white, 48px, 17px               | The action that **commits**: Save, Book job, Send, Finalise & lock. One per view                                     |
| `PRIMARY_BUTTON_COMPACT`   | Same, 44px, 15px                          | That action in a dialog, a sheet footer beside another, an edit-in-place pair                                        |
| `NEUTRAL_BUTTON`           | Ink fill, 48px                            | The main action when nothing is saved: Continue, Next, Open                                                          |
| `NEUTRAL_BUTTON_COMPACT`   | Same, 44px                                | The same, compact                                                                                                    |
| `SECONDARY_BUTTON`         | Grey fill, ink word, 48px                 | The alternative beside a primary: Cancel, Back, Clear, Skip                                                          |
| `SECONDARY_BUTTON_COMPACT` | Same, 44px                                | A dialog's way out                                                                                                   |
| `LINK_BUTTON`              | Grey fill, blue word, 48px                | Goes somewhere or opens something: Open PDF, Add a contact                                                           |
| `LINK_BUTTON_COMPACT`      | Same, 44px                                | The same, compact                                                                                                    |
| `HEADER_ADD_BUTTON`        | Round red +, 36px drawn, 44px to a finger | The page's create action in `PageHeader`: New job, New client, New report. With an `aria-label` and a size-20 `Plus` |

**Rules:**

- **Red means commit.** One red button per view (`HEADER_ADD_BUTTON` aside). A destructive confirm is red too, but only inside `ConfirmDialog`. No button is ever filled blue.
- **A button's words are the verb it performs:**
  - A create commits with the verb and the noun ("Book job", "Add product").
  - An edit form commits with "Save".
  - While it runs, it says so and waits: `disabled` and "Saving…".
  - With save warnings open, it reads "{its words} anyway".
- **Text buttons** (a blue word, no fill) are for inline links and header actions. They still need a 44px hit area: add `tap-target` and `relative` if they are drawn smaller.
- **Never hand-roll a filled button** (`rounded-xl h-10–12` red, ink or blue) **(lint)**.

### 4.2 Fields: `forms/`

| Export                                                                                                       | Use for                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FormField`                                                                                                  | A labelled field: its label, the control, and its hint, error or warning line, wired with `aria-describedby`. Children may be a render function that receives `id`, `aria-*` and `className`        |
| `FIELD`                                                                                                      | The class for a 48px input, select or textarea outside `FormField`                                                                                                                                  |
| `FIELD_COMPACT`                                                                                              | 44px, for dense rows (a repeater cell, a filter)                                                                                                                                                    |
| `FIELD_SURFACE`                                                                                              | The well without a height, for a `<textarea>`                                                                                                                                                       |
| `FIELD_SIZES`                                                                                                | `lg` → `h-12`, `md` → `h-11`                                                                                                                                                                        |
| `fieldInputClass(size, invalid)`                                                                             | The class `FormField` hands its control. It shows a red ring when invalid                                                                                                                           |
| `fieldMessageId`, `describedBy`, `fieldLabelText`                                                            | Wiring helpers for a custom control inside `FormField`                                                                                                                                              |
| `FieldMessage`                                                                                               | The line under a field, in one of four tones: `error` (red-ink, announced once), `warning` (amber-ink, may offer a one-tap fix), `status`, `ok`                                                     |
| `FixButton`                                                                                                  | That one-tap fix ("Use 0412 345 678"), 44px tall, for a message built by hand                                                                                                                       |
| `FormAlert`                                                                                                  | The amber box a form shows when a save fails. Pass it the error and `describeError` words it                                                                                                        |
| `EmailInput`, `PhoneInput`                                                                                   | Email and Australian phone, with their refuse, warn and fix rules. Never use a bare `<input type="email">` for a client's address                                                                   |
| `VerifiedAddressFields`                                                                                      | A street address checked against the address service                                                                                                                                                |
| `SaveWarnings` (`useSaveWarnings`, `SaveWarningsProvider`, `SaveWarningsPanel`, `useSaveCheck`, `useLatest`) | "2 things to check before saving": warnings collected at Save, which then reads "Save anyway". A field registers its check with `useSaveCheck`; `useLatest` keeps a fix from acting on stale values |

**Labels** depend on where the field sits:

- **A field on a sheet or a page** (on the canvas): its label is a `section-label` above it, wrapping the control, `<label className="flex flex-col gap-1.5"><span className="section-label">`. `FormField` does this.
- **A field inside a card** (a Settings group, an onboarding card): its label is `FIELD_LABEL`, in body weight, through `FieldRow`. The group's heading is the one in capitals, outside the card.
- **A composite control** (a segmented choice, a set of chips) is a `role="group"` with the same label style and `aria-labelledby`.

**Other rules:**

- **Every field has a visible label.** A placeholder is an example ("Who is signing"), never the label.
- **Required fields are not marked;** optional ones say "(optional)" in the label. Report forms are the exception: they mirror a paper form and may star what that form requires.
- **Use `FIELD` for the look:** 16px text, a `bg-surface-3` well, a blue focus ring. Don't style inputs by hand.
- **Refuse** only what can never work (an undeliverable email, letters in a phone number). **Warn** about what is probably wrong but may be right, and offer the fix as a tap. Never rewrite what was typed without a tap.
- **Show an error** once the field is left or a submit is refused, not while it is still being typed.
- **Name the keyboard:** `inputMode`, `autoComplete` and `enterKeyHint` on anything typed on a phone.
- **Choosing from a list:** a native `<select>` with `FIELD` is fine for a short list; a long or searchable list is `Combobox`.

### 4.3 Choosing: `primitives/`

| Export           | Use for                                                                                                                                                                           |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Segmented`      | Two to four options, all visible. `kind="tabs"` switches what shows below (Day/Week/Month); `kind="choice"` answers a form question (Person/Business). Never a dropdown for these |
| `Combobox`       | A searchable single choice from a long list (a property, a job type). `allowCustom` adds what was typed                                                                           |
| `FilterDropdown` | A compact single-select filter chip in a header row (status, staff)                                                                                                               |
| `SearchBox`      | A search field whose typing is instant and whose query follows after a pause                                                                                                      |

### 4.4 Sheets and dialogs

| Export                                         | Use for                                                                                                                      |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `Sheet`                                        | A bottom sheet with a title, an optional description, a scrolling body and an optional `footer` for its buttons. The default |
| `SheetShell`                                   | Just the sheet's frame, for a sheet with its own header. Pair it with `SHEET_BODY` and `Drawer.Title`                        |
| `SHEET_BODY`                                   | The class for a custom sheet's scrolling body. Use it rather than writing its padding out                                    |
| `SheetCloseButton`                             | The ✕ (`SheetShell` already renders one)                                                                                     |
| `ConfirmDialog` (`settings/ConfirmDialog.tsx`) | Asking before anything is taken away. The only alert dialog in the app                                                       |

**Rules:**

- `Drawer.Root`, `Drawer.Portal`, `Drawer.Overlay` and `Drawer.Content` appear only in `primitives/Sheet.tsx` **(lint)**.
- `AlertDialog` appears only in `ConfirmDialog.tsx` **(lint)**, and never `window.confirm` **(lint)**.
- A sheet closes three ways, all equivalent: dragged down, tapped outside, or ✕. A sheet that is only a list or a read-out ends with a "Done".
- **`ConfirmDialog` wording:**
  - The title is the question, naming the thing: "Archive Jane Smith?", "Cancel this job?".
  - The body says what will happen and whether it can be undone.
  - The red button repeats the title's verb: "Archive", "Cancel job".
  - The way out keeps the thing: "Keep client", "Keep it". Not "Cancel", which is ambiguous next to "Cancel job".
- **`ConfirmDialog` behaviour:**
  - Pass `returnFocus` when the confirm removes the row that opened it, or focus falls to the top of the page.
  - Pass `pending` and `pendingLabel` while it runs.
  - Pass `closeOnConfirm={false}` and `error` when the dialog must report a failure itself.

### 4.5 Status and display

| Export           | Use for                                                                                                                    |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `StatusPill`     | A job's status. `jobStatusLabel` gives the word without the pill                                                           |
| `BarMeter`       | Five ticks showing a value's intensity beside its number (wind, rain)                                                      |
| `HoldButton`     | Hold to act: a touch fills the button and it acts when lifted. For anything that leaves the app or reaches a client        |
| `ContactButtons` | Call, Text, Email and Map as holds, full-width in the sheets and compact on the job card. Always this, never a `tel:` link |
| `MapHoldButton`  | The job card's corner Map, as a hold                                                                                       |

### 4.6 Empty, loading, failed

| Export                                    | Use for                                                                                                                     |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `EmptyState`                              | A list with nothing in it yet: a title ("No clients yet"), one line saying what goes here, and the one action that fills it |
| `EmptyStateButton` / `EMPTY_ACTION_CLASS` | That action: quiet grey and blue, not red                                                                                   |
| `NoMatches`                               | A search or filter that found nothing: "No matches for “…”" and a way to clear it. Never `EmptyState` for this              |
| `PagePending`                             | The router's default: a page loading inside a shell that stays put                                                          |
| `ListPending`                             | A list loading inside a page that is already on screen (announced)                                                          |
| `CardRows`                                | The card-shaped placeholders `ListPending` draws, for a custom layout                                                       |
| `RowPending`                              | One row loading inside a card (a job's notes). Use it instead of a spinner row                                              |
| `TextPending`                             | A block of text loading (a note's body)                                                                                     |
| `SectionPending`                          | A page section loading (a Settings page's Suspense fallback)                                                                |
| `SheetPending`                            | A sheet's body loading, under its real title                                                                                |
| `MonthDaysPending`                        | The month grid's day cells loading                                                                                          |
| `Bone`                                    | One grey placeholder block, the unit the others are built from                                                              |
| `ErrorScreen` (`shell/ErrorScreen.tsx`)   | A route that threw: branded, offline-aware, with "Try again" and "Start from the top"                                       |

Placeholders are shaped like what they stand in for, so nothing jumps when the content lands. They contain **no** headings, buttons or visible text: the e2e suite takes a heading as the sign that a page has loaded.

### 4.7 Settings pages: `settings/ui.tsx`

Build every Settings page from these, so the hub and its pages read as one grouped list. Hand-roll nothing.

| Export                             | Use for                                                                                        |
| ---------------------------------- | ---------------------------------------------------------------------------------------------- |
| `SettingsBody`                     | The page's column                                                                              |
| `SettingsGroup`                    | A titled card of rows. The title sits outside the card; the `footer` is one line of help below |
| `SettingsRow`                      | A row that isn't a link: a switch, a read-only value                                           |
| `SettingsLinkRow`                  | A row that opens a page                                                                        |
| `RowBody`                          | What a row shows: a tile, a title, a value, a badge, a chevron                                 |
| `ROW_CLASS`                        | A row's class, for a custom row                                                                |
| `IconTile` / `Tint`                | The coloured square a row leads with                                                           |
| `RowBadge`                         | Only for something that needs doing                                                            |
| `FieldRow` / `FIELD_LABEL`         | A field inside a group                                                                         |
| `SaveBar`                          | A sticky Save, shown only while there is something to save                                     |
| `DangerGroup` / `DANGER_ROW_CLASS` | The last group on the page, with its actions in red words                                      |
| `BackLink`                         | The "‹ Settings" link in the header                                                            |

`useJustSaved` and `useSavedFlash` (`settings/useJustSaved.ts`) keep "Saved" on the button long enough to read.

### 4.8 Vendored shadcn: `components/ui/`

The shell uses `sidebar` and `tooltip`; the rest are there for the sidebar's sake. Don't reach for `components/ui/button`, `input` or `select` in app code: they are not the app's look. Use the constants above.

---

## 5. Patterns

### States

| State                        | What to show                                                                                                                                                                                    |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Loading a page               | Nothing to do: `useSuspenseQuery` plus the router's `PagePending`                                                                                                                               |
| Loading inside a page        | A placeholder from `Pending.tsx`, shaped like the content. Never blank the page, and never a centred spinner for a whole screen. A spinner belongs inside the one button or row that is waiting |
| Empty                        | `EmptyState` with one verb-first action ("Add a client")                                                                                                                                        |
| No matches                   | `NoMatches` with the term quoted back and "Clear search" / "Clear filters"                                                                                                                      |
| Owner only                   | `EmptyState` titled "Owners only" and a body saying who can change it                                                                                                                           |
| A page failed to load        | `ErrorScreen`, via the route's error boundary                                                                                                                                                   |
| A query failed inside a page | If the page still works without it, say so in a line; otherwise let it throw to the boundary. Don't sit on a placeholder forever                                                                |
| Offline                      | Show what is kept on the phone and say so ("No signal — showing the copy kept on this phone."). An edit that needs signal says "Editing needs signal."                                          |

### Saving

1. **Before hydration, it can't be tapped.** Every control that needs JavaScript has `disabled={!hydrated || …}` (`useHydrated`), so a tap is never swallowed by inert markup.
2. **The button carries the state:** "Save", then "Saving…" (disabled), then "Saved" for two seconds (`useJustSaved` / `useSavedFlash`), or the sheet closes, or the page moves on.
3. **Failures are amber, not red.** A save that failed is a `FormAlert` just above the button, worded by `describeError`, with nothing typed lost. One control's failed action (an upload, a toggle) is an amber line beside it: `role="alert" text-caption text-amber-ink`. Red is for a field that can't be accepted, not for a request that didn't go through.
4. **Where a Save goes:**
   - Settings: a sticky `SaveBar`.
   - Sheets: a footer, or a Cancel and Save pair for editing in place.
   - The report builder and the template editor save automatically (`useAutosave`) and show the state in their own bar.
   - A switch or a colour saves the moment it changes.
5. **No toasts.** The app has none. Say it where the eye already is: the button, the row, the sheet closing. A copy button says "Copied" with a tick for two seconds.

### Destructive actions

Never on one tap.

- **Remove or delete** opens `ConfirmDialog`.
- **On a Settings page**, the destructive rows sit in the last `DangerGroup`.
- **A small, easily undone act on your own work** may ask in place instead ("Tap again to clear"), or offer Undo.
- **Words:**
  - "Delete" is for records (a note, a product, a draft).
  - "Remove" is for attachments and memberships (a photo, a file, a contact, a team member).
  - "Archive" is for what can come back (clients, templates).
- **Recovery** is a place, not a toast: Recently Deleted (30 days), Archived, "Offer again".

### Hold to act

Call, Text, Email and Map are holds (`HoldButton`), so a pocket or a brushing thumb cannot dial a client or leave the app.

- Hold or click is decided per pointer: a mouse, a keyboard or a screen reader acts at once.
- A hold's element carries `hold-target`, so the browser can't take the touch to scroll or select text.
- In a scrolling list it carries `hold-target-scroll` instead: that allows vertical panning, and a scroll cancels the hold.
- Neither utility is general touch hygiene; use them only on holds.
- Map opens in a new tab and never navigates the app away.

### Lists and cards

- **A tappable card** has `active:scale-[.99]`; a tappable row has a chevron.
- **A card lists only the suburb.** The full street address appears only in detail and on the report, and Map carries the street.
- **What a job card offers depends on its status.** Committed work gets the contact holds; a due recurring visit gets "… to book"; future or cancelled work gets nothing.
- **Recurring projections are shown but never counted** in totals.

### Filters and views

- **Two to four exclusive options** are a `Segmented`.
- **A longer single-select filter** in a header row is a `FilterDropdown`.
- **An active filter** is blue (`border-blue/30 bg-blue/12 text-blue`).
- **Views and filters live in the URL.**

### Reports

- **Something the app worked out** (the forecast, the start time) is marked "Suggested" until it is confirmed. A fact read off a record is not marked.
- **Locking is two acts.** "Finalise & lock" opens a read-back sheet first.
- **Locked boilerplate** sits in a grey inset (`bg-surface-2`) with a `Lock` glyph.

---

## 6. Accessibility

This isn't a pass at the end. Each point below is how the shared pieces already work; keep them working.

**Targets are at least 44px.**

- Every control is at least 44 × 44 to a finger.
- If a control is drawn smaller, add `tap-target` to extend its hit area. It needs a `relative` element, with nothing `overflow-hidden` in between.
- Where neighbours are too close for that, make the controls really 44px (`size-11`), or move the rarer actions into a "⋯" menu.

**Focus is visible.**

- Keyboard focus shows a blue ring: `focus-visible:ring-2 focus-visible:ring-blue` on buttons, `focus:ring-2 focus:ring-blue` on fields.
- Never use `outline-none` without a replacement.
- Escape closes what it opened, and focus returns to what opened it.

**Every control has a name.**

- An icon-only control has an `aria-label` of the form "{verb} {the thing's name}": "Remove Jane Smith", "Open map of 12 Rose St". Never a bare verb repeated on every row, and never "item 3".
- An accessible name **starts with the visible words** (WCAG 2.5.3): "Finish setting up, 2 of 5 done".
- Lucide marks its icons `aria-hidden` itself.

**Headings.**

- The `<h1>` comes from `PageHeader`, or from the entry screen's title.
- An `<h2>` is a `SettingsGroup` title or a sheet's title.
- An `<h3>` is a section within a sheet.
- A `section-label` that heads a section is an `<h2>`/`<h3>` with that class, not a `<p>`.

**Live regions.**

- Loading placeholders are `role="status"` with an `sr-only` label.
- An error that appears is `role="alert"`, once: `FieldMessage` drops the role after announcing.
- Anything that updates in place (a count, "Saved") uses `aria-live="polite"`.

**Segmented** is a `tablist` or a `radiogroup`, with roving tabindex and arrow keys. Use the component, not buttons in a row.

**Contrast.** Text that must be read clears 4.5:1 (see 2.1). `statusColours.test.ts` checks every ratio the tokens decide.

**Colour is never the only signal:**

- a status says its word;
- an invalid field has a sentence as well as a red ring;
- a person's colour rail has their name for a screen reader.

**Motion** respects `prefers-reduced-motion` (2.8).

**Zoom.** Inputs are 16px so iOS doesn't zoom, and the viewport is never locked against pinch-zoom.

---

## 7. Voice and copy

### Tone

- **Plain, short, Australian English:** "colour", "licence", "finalise", "organise", "enrol". Talk to a technician on a job, not to an administrator.
- **Second person, and no "please" or "sorry"** in the app's own voice. (Words quoted verbatim from a report template are the template's.)
- **Say "signal", not "connection"** (a phone on a job has signal or it doesn't).
- **Use the product's nouns:** client, job, property, site, report, template, technician, team, licence. Don't introduce synonyms (customer, visit, worker).

### Case and labels

- **Sentence case everywhere:** titles, buttons, labels ("Report settings", "Add a client"). The capitals in a `section-label` come from CSS, so type its words in sentence case.
- **Buttons are verbs.** Use "Book a job", "Send this report", "Clear filters". Not "OK", "Submit", "Yes" or "Retry". Say "Try again" for a retry and "Done" to dismiss a sheet.
- **Icons, not typed symbols.** A leading "+" in a label is the `Plus` icon, and a trailing "›" is `ChevronRight`.

### In-progress and errors

- **In progress** reads "{Verb}ing…" with the single character `…`: "Saving…", "Checking…", "Uploading…". Not "Just a moment…".
- **Errors say what happened, then what to do:** "Could not save: this device is offline. What you typed is still here — try again when you have signal."
  - Write "Could not", not "Couldn't".
  - Never write "Something went wrong" on its own, a code, or a server's raw message.
  - Every message offers a next step, even if that is "Ask the business owner."
- **Error copy lives in maps, not in components.** It goes in `forms/describeError.ts` (`ERROR_COPY`, `describeError`, `errorCode`) or a form's own copy map passed to it. Never match on `error.message.includes(...)`.

### Punctuation

| Use                          | Write                                                 |
| ---------------------------- | ----------------------------------------------------- |
| Apostrophes                  | Curly `’` (don’t, client’s)                           |
| Quotes                       | Curly `“ ”`                                           |
| A sentence break             | A spaced em dash `—`                                  |
| A range                      | An en dash `–`: "9:30am – 10:15am", "21–27 September" |
| A withheld value             | `—` alone (a hidden price is "—", never "$0")         |
| Separating metadata          | `·` ("45 min · Fri 25 Sept")                          |
| A place in the app, in prose | `→` ("Settings → Team")                               |

### Numbers and dates

Always use `src/lib/format.ts`. Never hand-roll `Intl` or `toLocale*` in a component: that is how "9:30 am" in the device's time zone crept in beside "9:30am" in the business's.

| Helper                                  | Gives                                                                |
| --------------------------------------- | -------------------------------------------------------------------- |
| `formatMoney`, `formatJobMoney`         | "$1,250", "$12.50"; "—" when withheld                                |
| `formatTime`                            | "9:30am"                                                             |
| `formatJobDate`                         | "Fri 25 Sept" (with the year when it isn't this year). Never "Today" |
| `formatTimeRange`, `formatDuration`     | "9:30am – 10:15am · 45 min", "1 hr 30 min"                           |
| `formatDayLabel`, `formatShortDayLabel` | "Monday 21 September", "Mon 21"                                      |
| `formatWeekRange`, `formatMonthLabel`   | "21–27 September", "September 2026"                                  |
| `todayKey`                              | Today in the **business's** time zone, never the device clock        |

Counts are digits with their noun ("3 jobs"), singular or plural by count.

### Empty states and headings

- **Empty state titles** are "No {things} yet" or "Nothing {done}", with no full stop.
- **Empty state bodies** are one sentence saying what will appear here.

---

## 8. Icons

**Library.** Use `lucide-react` only, under its current names (`TriangleAlert`, not the deprecated `AlertTriangle`; `LoaderCircle`, not `Loader2`).

**Stroke weight** follows the drawn size, so glyphs read at one weight across the app **(lint)**:

| Drawn size | `strokeWidth` | Chevrons, ✕, ✓, +, − |
| ---------- | ------------- | -------------------- |
| ≥ 18px     | 1.7           | 2                    |
| 13–17px    | 2             | 2.2                  |
| ≤ 12px     | 2.4           | 2.4                  |

**Sizes:**

- 16 inline with body text;
- 15 in a compact button;
- 17–18 in a row;
- 20 in the header's + or the sidebar;
- 22 in the dock;
- 13 beside a caption.

**One concept, one glyph.** Use the glyph that already means the thing; don't give a glyph a second meaning.

| Concept                        | Icon                                                                              |
| ------------------------------ | --------------------------------------------------------------------------------- |
| Add                            | `Plus` (`ImagePlus` for a photo)                                                  |
| Edit                           | `Pencil`                                                                          |
| Sign, annotate, mark up        | `PenLine`                                                                         |
| Delete / remove                | `Trash2`                                                                          |
| Close, dismiss, clear a search | `X`                                                                               |
| Back / forward                 | `ChevronLeft` / `ChevronRight`                                                    |
| Open a menu of more            | `Ellipsis`                                                                        |
| Search                         | `Search`                                                                          |
| Share                          | `Share` (the iOS glyph)                                                           |
| Send                           | `Send`                                                                            |
| Call / Text / Email / Map      | `Phone` / `MessageSquareText` / `Mail` / `MapPin` (only through `ContactButtons`) |
| Warning                        | `TriangleAlert`                                                                   |
| Info                           | `Info`                                                                            |
| Done, selected                 | `Check`                                                                           |
| Finalised, locked              | `Lock`                                                                            |
| Undo, restore, try again       | `RotateCcw`                                                                       |
| Replace, regenerate, reload    | `RefreshCw`                                                                       |
| Recurring                      | `Repeat` (ink, not blue)                                                          |
| Photo                          | `Camera` (take), `ImageIcon` (library)                                            |
| Report, document               | `FileText`                                                                        |
| Offline                        | `WifiOff`                                                                         |
| Open elsewhere                 | `ExternalLink`                                                                    |
| Loading                        | `LoaderCircle` with `animate-spin`                                                |
| Client (a person / a business) | `User` / `Building2`                                                              |
| Primary, cover, "the usual"    | `Star`                                                                            |

---

## 9. Dark mode and printed surfaces

**Dark mode is the tokens' job.**

- Nothing under `src/` uses the `dark:` variant **(lint)**.
- A component that looks right in light with tokens looks right in dark.
- If it doesn't, a token is wrong. Fix it in `styles.css` for both themes, not in the component.

**Check both themes.** `pnpm ui:shots` renders every specimen light and dark.

**Printed things stay light:**

- The report preview pins `data-theme="light"` so it matches the PDF.
- A signature pad and a PDF page are `bg-paper` in both themes, because what is drawn on them is for paper.

**The PDF is its own design system.**

- `src/components/reports/pdf/` renders with `@react-pdf/renderer`, which can't read CSS variables. It keeps its own hex palette in `pdf/theme.ts`, mirroring the tokens.
- If you change a token that the PDF shows, change `theme.ts` with it.
- The report preview (`ReportDocument.tsx`, `onboarding/ReportPreview.tsx`) mirrors the PDF. Its lint exceptions carry a comment saying why.

**Canvas drawing** (a signature, an annotation, a markup pen) sets its stroke colour in code. Use the token's value and name the token in a comment.

---

## 10. Decisions already made

These were argued out and settled; `ARCHITECTURE.md` and the commit history hold the reasoning. Don't reopen them in passing: raise them with the product owner.

- **No hours, timesheets or rostering, ever,** and the UI says so.
- **Both themes ship.** The app follows the OS unless the person picks a theme, and the choice is saved per device.
- **Colour meanings are fixed:**
  - Brand red is for glyphs and words; white text sits only on `red-fill`.
  - Amber means warning.
  - Blue means links, plus the Invoiced status; no button is filled blue.
  - The technician palette never offers brand red or yellow.
- **Each status has exactly one hue** (the table in 2.2). A person is a mark, a status is a pill with a word, and overdue has no hue.
- **Controls are fixed sizes:** buttons are 48 or 44px, fields use 16px text, and every target is at least 44px.
- **Navigation:** Schedule, Clients, Reports and Notes, then More. Settings is an iOS grouped hub of drill-in pages, and Appearance lives there.
- **Views:** the schedule is cards or a week, and clients are cards. The table and list views are retired.
- **Hold to act** is used for anything that reaches a client or leaves the app.
- **Filters:** binary and ternary filters use `Segmented`, never a dropdown.
- **The report builder** opens on an overview and fills one section at a time, with the section in the URL. A list of more than 12 options opens a picker sheet.
- **Finalising** is a read-back sheet, not a hold. Its button is never greyed for an incomplete report, because pressing it is how you find out what is missing.
- **Dates** come from the business's day key, not the device's clock, and cards never say "Today" or "Tomorrow".
- **Hidden prices** show "—".
- **New Job opens with nothing chosen:** it asks rather than guesses.
- **Notes are personal by default,** and each one says who can see it.
- **PDFs** open in the in-app viewer, never in Safari and never as a forced download.
- **When behaviour departs from `ARCHITECTURE.md`,** amend it there with a dated _Amended_ note.

---

## 11. Don'ts

Lint refuses the rules marked **(lint)**; review catches the rest.

**Colour:**

- A hex, `rgb()` or `hsl()` colour in a class (`bg-[#…]`, `text-[rgb(…)]`) **(lint)**, or in a `style`, other than a person's colour from data.
- `bg-red text-white`: use `bg-red-fill` **(lint)**.
- The `dark:` variant in app code: fix the token instead **(lint)**.
- Amber for anything but a warning; blue for anything but a link, focus, a selection or an active filter; a hue for overdue.
- `text-red`, `text-green` or `text-muted` for a sentence that must be read.
- A pill without a word, or a person shown as a pill.
- A status pill written out in a component rather than taken from `statusColours.ts`.

**Type and icons:**

- `text-[13px]` or `text-[15px]`: use `text-caption` or `text-body` **(lint)**. Nor any other off-scale size (2.3).
- An icon `strokeWidth` off the scale for its `size` **(lint)**.

**Components:**

- A hand-rolled filled button: use a `buttons.ts` constant **(lint)**.
- `Drawer.Root`, `Portal`, `Overlay` or `Content` outside `Sheet.tsx`, or `AlertDialog` outside `ConfirmDialog.tsx` **(lint)**.
- `window.confirm`, `alert` or `prompt` **(lint)**.
- A hand-rolled amber error box: use `FormAlert`.
- A red button that doesn't commit, or two on one view.

**Layout:**

- A z-index outside the [stacking order](#27-stacking-order) (drift test).

**Touch and fields:**

- A control under 44px with no `tap-target`.
- An input under 16px, or a placeholder as the only label.

**States and copy:**

- A toast, a spinner for a whole page, or a blank page while loading.
- A raw server error on screen, or "Something went wrong" on its own.
- A hand-rolled date, time or money format.

---

## 12. Before you call it done

1. It uses the shared pieces from [section 4](#4-components-which-to-use). Anything new that other screens will want is added there, exported, and listed in this guide.
2. Every state is handled: loading, empty, no matches, failed, saving and saved. Controls are disabled until hydrated.
3. It works at 375px wide and at `lg:`, and nothing hides behind hover.
4. Every control is 44px to a finger, and every field is 16px and labelled.
5. It is right in **both themes**. Run `pnpm ui:shots` and look at the light and dark shots. For a new component, add a specimen in `tools/ui-harness/specimens.tsx`.
6. Keyboard: Tab reaches everything in order, focus is visible, and Escape closes what it opened.
7. The copy follows [section 7](#7-voice-and-copy): verbs on buttons, "{Verb}ing…" while running, an error that says what to do, curly apostrophes, and dates from `format.ts`.
8. `pnpm typecheck`, `pnpm test` (which includes this guide's drift test) and `pnpm lint` pass, and `prettier --check` passes on the files you changed.
9. If you changed a token, a text size, a radius or a shared component's exports, this guide changed in the same commit.
