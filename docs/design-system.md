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

| Token                  | Light                       | Dark                        | Use for                                                                                                                             |
| ---------------------- | --------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `--ink`                | `#1c1c1e`                   | `#ffffff`                   | Titles, primary text, the neutral button's fill                                                                                     |
| `--ink-2`              | `#3a3a3c`                   | `#e5e5ea`                   | Body text that must be read; grey glyphs                                                                                            |
| `--muted`              | `#8e8e93`                   | `#98989f`                   | Metadata that can be skipped: times, counts, captions, group footers. Only 2.8–3.3:1, so not for anything that must be read in sun  |
| `--muted-2`            | `#9b9ba1`                   | `#8e8e93`                   | Section labels (`section-label`), chevrons, tertiary glyphs                                                                         |
| `--hairline`           | `rgba(60, 60, 67, 0.1)`     | `rgba(235, 235, 245, 0.14)` | Card borders and row dividers. The default border colour                                                                            |
| `--hairline-2`         | `rgba(60, 60, 67, 0.07)`    | `rgba(235, 235, 245, 0.08)` | A fainter divider inside a card                                                                                                     |
| `--surface`            | `#ffffff`                   | `#1c1c1e`                   | Cards, rows in a sheet, popovers                                                                                                    |
| `--surface-2`          | `#f2f2f7`                   | `#2c2c2e`                   | Inset blocks inside a card: locked boilerplate, a note, a quiet chip, a thumbnail                                                   |
| `--surface-3`          | `#f4f4f8`                   | `#2a2a2c`                   | Input wells: every field's fill, and read-only values shown as fields                                                               |
| `--field-edge`         | `#86868b`                   | `#76767b`                   | A field's edge, on `FIELD` and any field made by hand: 3:1 on the canvas, a card and an inset block, so it is found in sun          |
| `--canvas`             | `#ededf1`                   | `#000000`                   | The app background, a sheet's background, and the iOS launch screens (`pnpm icons` redraws them)                                    |
| `--fill-track`         | `rgba(118, 118, 128, 0.08)` | `rgba(120, 120, 128, 0.28)` | A segmented control's track                                                                                                         |
| `--fill-secondary`     | `rgba(118, 118, 128, 0.12)` | `rgba(118, 118, 128, 0.24)` | Grey buttons (`SECONDARY_BUTTON`, `LINK_BUTTON`)                                                                                    |
| `--red`                | `#ff3b30`                   | `#ff453a`                   | Brand as a word or glyph: today, the current tab, a destructive text row, an invalid field's ring                                   |
| `--red-fill`           | `#dc2a1f`                   | `#dc2a1f`                   | Red **behind white text**: the primary button, the header's +, the selected day, the printed report's band and table header (4.8:1) |
| `--blue`               | `#0a84ff`                   | `#0a84ff`                   | Links and text buttons, the focus ring, a selected tick, an active filter, info glyphs, mention badges                              |
| `--green`              | `#34c759`                   | `#30d158`                   | A success glyph (a tick, a done step). Never text                                                                                   |
| `--amber`              | `#ff9f0a`                   | `#ff9f0a`                   | A warning glyph or bar. Never text                                                                                                  |
| `--amber-ink`          | `#985b00`                   | `#ffb340`                   | Warning and failure **text**, on any surface (4.5:1, checked)                                                                       |
| `--amber-bg`           | `#fff8ec`                   | `#2a1e0a`                   | A warning box's fill                                                                                                                |
| `--amber-line`         | `#ffe2b8`                   | `#4d3712`                   | A warning box's border                                                                                                              |
| `--chrome`             | `rgba(255, 255, 255, 0.92)` | `rgba(28, 28, 30, 0.86)`    | Glass bars: the tint over a blurred backdrop. Use `chrome-bar`, `chrome-dock` or `chrome-blur`, never the colour alone              |
| `--scrim`              | `rgba(0, 0, 0, 0.3)`        | `rgba(0, 0, 0, 0.6)`        | Behind sheets and dialogs                                                                                                           |
| `--paper`              | `#ffffff`                   | `#ffffff`                   | Anything drawn for print: a signature pad, a PDF page                                                                               |
| `--viewer-backdrop`    | `#f2f2f7`                   | `#0c0c0d`                   | Behind the pages in the document viewer                                                                                             |
| `--on-tint`            | `#ffffff`                   | `#ffffff`                   | Text on a solid saturated tint (a blue count badge)                                                                                 |
| `--search-hit`         | `rgba(255, 214, 10, 0.5)`   | `rgba(255, 214, 10, 0.5)`   | Find in a PDF: every match                                                                                                          |
| `--search-hit-current` | `rgba(255, 149, 0, 0.7)`    | `rgba(255, 149, 0, 0.7)`    | Find in a PDF: the match being looked at                                                                                            |

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

| Signal              | Form                                                                                                                                                                                                                            | Where it is decided                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Person (technician) | A solid dot or rail with no text, in their colour (set in Settings → Team). A job for several people keeps its lead's colour on the rail and the week block, and gives each person their own dot (or initial) beside their name | `convex/lib/colours.ts`. Drawn with `style={{ backgroundColor }}`, the one place a colour comes from data        |
| Status              | A bordered, tinted **pill that always says its word**                                                                                                                                                                           | `src/lib/statusColours.ts` → `StatusPill`, `TONE_PILL`, `REPORT_PILL`, `CLIENT_STATUS`                           |
| Overdue             | Ink on the surface, with **no hue**                                                                                                                                                                                             | `OVERDUE_CHIP` (`--overdue`/`--overdue-ink`)                                                                     |
| Warning             | Amber text in a pale amber box with a border                                                                                                                                                                                    | `FormAlert`, `FieldMessage tone="warning"`                                                                       |
| Not sent yet        | A grey chip on `surface-2` with **no border, no hue and no dashes**, its word always and a glyph, where the job number and status pill are: "Not sent yet", "Sending…", "Sent". "Needs a look" is the amber, bordered badge     | `OUTBOX_CHIP`, `OUTBOX_LOOK_CHIP` → `OutboxChip`. A booking on the phone has no status until the server makes it |

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
- A client's status is a pill too, always shown, Active included (`CLIENT_STATUS`, drawn by `ClientStatusPill`): Active green, Lead blue, Inactive grey.
- A new status goes in `statusColours.ts`, never as a pill written out in a component.

A **pill** is `rounded-full px-2.5 py-0.5 text-[12px] font-semibold` plus one colour class from `statusColours.ts` (`TONE_PILL`, `REPORT_PILL`, `OVERDUE_CHIP`). A **count badge** is `rounded-full px-1.5 text-[11px] font-bold`.

A booking kept on the phone and not sent yet (`lib/outbox/`, behind `VITE_PESTM8_OUTBOX=on` until it is switched on) reads as none of the four above: its chip is a fifth form, sized as a pill so its row keeps its height, and it is drawn in a group of its own under the day's cards, never among them (Lists and cards, section 5).

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
- **`text-[12px]` / `text-[11px]`:** a pill's word and a count badge's number (see 2.2), and the small day labels in the calendars. The dock's badges, which sit on a glyph, are `text-[10px]`.

Anything else is off the scale:

- `text-[9px]`, `text-[13px]`, `text-[14px]`, `text-[15px]`, `text-[21px]`, `text-[22px]` **(lint)**;
- `text-xs`, `text-sm`.

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

| z                   | What                                                                                                                                                     |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `z-10`              | Overlays within a page or card, the desktop sidebar, a viewer's own bars and toasts                                                                      |
| `z-20`              | Sticky bars inside content: `SaveBar`, a sticky column header                                                                                            |
| `z-30`              | The sticky `PageHeader` and its placeholder; fixed bottom action bars (the builder's); the update banner and the can’t-reach notice; address suggestions |
| `z-40`              | The mobile dock; a sheet's scrim; the note format bar                                                                                                    |
| `z-50`              | Sheets, popovers, dropdown menus, comboboxes, tooltips, the photo annotator; the scrim of a sheet opened over another sheet                              |
| `z-[60]` / `z-[70]` | `ConfirmDialog`'s scrim / panel; `NavProgress` at 60                                                                                                     |
| `z-[80]`            | Full-screen viewers (document, image) and the signing screen                                                                                             |
| `z-[90]`            | A viewer's own menus and status                                                                                                                          |

The consequence: nothing inside a viewer (z-80) may open a `ConfirmDialog` (z-60), because it would open behind. The viewer asks in place instead (`pdf/clearConfirm.ts`: "Tap again to clear").

### 2.8 Motion

Motion is quiet and quick.

**Sheets** rise on Vaul's own curve, `cubic-bezier(.32,.72,0,1)`. The `ease-sheet` token names that curve for anything else that should move like a sheet; use the token rather than writing the curve out.

**Transitions** use `transition` at Tailwind's default 150ms.

**Press feedback** is a scale. Match it to what is pressed; any other value is refused **(lint)**:

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

- **A bar at the top edge** (the page header) is `chrome-bar`.
- **A band that scrolls away with the page** but should read as part of the header (the schedule's week strip) takes the header's tint, `bg-chrome`, with no blur: nothing passes beneath it.
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
- Something drawn in cards of many widths, whose height must not change as it loads (the job card's forecast, `schedule/WeatherStrip.tsx`), is laid out by its own width with a container query (`@container`, then `@lg:`), never by its words wrapping. Each line keeps its height when empty, and its placeholder is the same layout with blank lines, so the two are one height at every width.

**Sheets or pages?**

- A sheet is for something done and dismissed without losing the list behind it: a job's detail, a picker, a quick form, a read-back before an irreversible act.
- A page is somewhere you go and stay: a report, a Settings page.
- The URL carries views, filters and the open report section, so the back gesture does what a person expects.

---

## 4. Components: which to use

Look here before writing markup. The drift test fails if any export of these modules is missing from this section.

### 4.1 Buttons: `primitives/buttons.ts`

These are class strings. Put them on a `<button>` or a `<Link>`, plus layout classes (`w-full`, `flex-1`, `px-4`).

| Constant                   | Looks                                     | Use for                                                                                                                                                              |
| -------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PRIMARY_BUTTON`           | Red fill, white, 48px, 17px               | The action that **commits**: Save, Book job, Send, Finalise & lock. One per view                                                                                     |
| `PRIMARY_BUTTON_COMPACT`   | Same, 44px, 15px                          | That action in a dialog, a sheet footer beside another, an edit-in-place pair                                                                                        |
| `NEUTRAL_BUTTON`           | Ink fill, 48px                            | The main action when nothing is saved: Continue, Next, Open                                                                                                          |
| `NEUTRAL_BUTTON_COMPACT`   | Same, 44px                                | The same, compact; and a one-tap answer that can be taken back where the page's red is taken (Different customers)                                                   |
| `SECONDARY_BUTTON`         | Grey fill, ink word, 48px                 | The alternative beside a primary: Cancel, Back, Clear, Skip                                                                                                          |
| `SECONDARY_BUTTON_COMPACT` | Same, 44px                                | A dialog's way out                                                                                                                                                   |
| `LINK_BUTTON`              | Grey fill, blue word, 48px                | Goes somewhere or opens something: Open PDF, Add a contact                                                                                                           |
| `LINK_BUTTON_COMPACT`      | Same, 44px                                | The same, compact                                                                                                                                                    |
| `HEADER_ADD_BUTTON`        | Round red +, 36px drawn, 44px to a finger | The page's create action in `PageHeader`: New job, New client, New report. With an `aria-label` and a size-20 `Plus`                                                 |
| `HELD_BUTTON`              | Stays pressed in while `aria-disabled`    | Beside the commit button of a form made with `useSaveWarnings({ arm: true })`: the half-second it takes no press reads as the last press still landing, never greyed |

`DeleteButton` (`primitives/DeleteButton.tsx`) is the Delete at the foot of a sheet or below an edit form: a red word and a `Trash2` on the grey fill, full width, 44px ("Delete client", "Delete product"). It only opens the `ConfirmDialog`; the red fill is the dialog's.

**Rules:**

- **Red means commit.** One red button per view (`HEADER_ADD_BUTTON` aside). A destructive confirm is red too, but only inside `ConfirmDialog`. No button is ever filled blue.
- **A button's words are the verb it performs:**
  - A create commits with the verb and the noun ("Book job", "Add product").
  - An edit form commits with "Save".
  - While it runs, it says so and waits: `disabled` and "Saving…". The one exception is "Show more" at the end of a long list, which says "Loading…" and stays focusable (Long lists, in section 5).
  - With save warnings open, it reads "{its words} anyway". In a form that can say the caller is already a client (New Job, Clients → New client, Add property: `useSaveWarnings({ arm: true })`), it takes no press for half a second after the list comes in or changes under a press, or after one of its fixes is taken, `aria-disabled` meanwhile (`armed`) and held pressed in (`HELD_BUTTON`), so a double tap books nothing. A list that only shrinks as a field is edited holds nothing.
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
| `FieldMessage`                                                                                               | The line under a field, in one of four tones: `error` (red-ink, announced once), `warning` (amber-ink, may offer a one-tap fix), `status` (may offer two: `fix2`; a fix `held` takes no tap), `ok`  |
| `FixButton`                                                                                                  | That one-tap fix ("Use 0412 345 678"), 44px tall, for a message built by hand                                                                                                                       |
| `FormAlert`                                                                                                  | The amber box a form shows when a save fails. Pass it the error and `describeError` words it                                                                                                        |
| `EmailInput`, `PhoneInput`                                                                                   | Email and Australian phone, with their refuse, warn and fix rules. Never use a bare `<input type="email">` for a client's address                                                                   |
| `VerifiedAddressFields`                                                                                      | A street address checked against the address service                                                                                                                                                |
| `SaveWarnings` (`useSaveWarnings`, `SaveWarningsProvider`, `SaveWarningsPanel`, `useSaveCheck`, `useLatest`) | "2 things to check before saving": warnings collected at Save, which then reads "Save anyway". A field registers its check with `useSaveCheck`; `useLatest` keeps a fix from acting on stale values |

**Labels** depend on where the field sits:

- **A field on a sheet or a page** (on the canvas): its label is a `section-label` above it, wrapping the control, `<label className="flex flex-col gap-1.5"><span className="section-label">`. `FormField` does this.
- **A field inside a card** (a Settings group, an onboarding card): its label is `FIELD_LABEL`, in body weight, through `FieldRow`. The group's heading is the one in capitals, outside the card.
- **A composite control** (a segmented choice, a set of chips) is a `role="group"` with the same label style and `aria-labelledby`, never inside a `<label>`. A label names only its first control, so New Job's "Existing client" was called "Client Client", and a tap on the caption chose it. A `Segmented` is its own group: give the caption an id and pass it as `labelledBy` **(lint)**.

**Other rules:**

- **Every field has a visible label.** A placeholder is an example ("Who is signing"), never the label.
- **Required fields are not marked;** optional ones say "(optional)" in the label. Report forms are the exception: they mirror a paper form and may star what that form requires.
- **Use `FIELD` for the look:** 16px text, a `bg-surface-3` well with a `--field-edge` border, a blue focus ring. Don't style inputs by hand; where one must be (a search box, a code box, a picker's trigger), it has the same `border-field-edge` border: a well alone is all but invisible on the canvas, and in sun. A read-only value shown as a field has the well and no edge: the edge says it can be typed in.
- **Refuse** only what can never work (an undeliverable email, letters in a phone number). **Warn** about what is probably wrong but may be right, and offer the fix as a tap. Never rewrite what was typed without a tap.
- **Show an error** once the field is left or a submit is refused, not while it is still being typed.
- **Name the keyboard:** `inputMode`, `autoComplete` and `enterKeyHint` on anything typed on a phone.
- **Choosing from a list:** a native `<select>` with `FIELD` is fine for a short list; a long or searchable list is `Combobox`.
- **A save warning** may carry a second fix (`fix2`), and say where focus goes once a fix is applied (`focusAfter`), where the fix changed what the form shows. A client the caller may already be is a row of `kind: 'match'`: listed after the fields' own warnings, with the form's own foot when nothing else is listed (`matchFooter`), and a `note` on where it was found (Is the caller already a client?, section 5). In a form made with `arm` (where the list can say the caller is already a client), a fix takes no tap for `FIX_ARM_MS` (400 ms), and the button no press for `SUBMIT_ARM_MS` (500 ms), after the list comes in or changes under a press, or after a fix: `aria-disabled` meanwhile (`fixArmed`, `armed`), the button held pressed in (`HELD_BUTTON`), never dimmed: half a second of grey would flash. Every other form takes a fix and a press at once, as it always has. A fix that takes the booking to another client mode leaves the warnings of a field drawn again there (the same address) as they were shown and confirmed, and their own fixes put right the fields now shown, never the ones gone: Use NT puts NT in New site for's State (`useFixOnScreen`, by the block's `idPrefix`).

### 4.3 Choosing: `primitives/`

| Export           | Use for                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Segmented`      | Two to four options, all visible. `kind="tabs"` switches what shows below (Day/Week/Month); `kind="choice"` answers a form question (Residential/Commercial). Never a dropdown for these                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `Combobox`       | A searchable choice from a long list (a property, a job's services), picked in a sheet of its own. `allowCustom` adds what was typed; `multiple` ticks several, up to `max` if given, when the rest greys out and `fullLabel` says why. An option's `group` heads it while nothing is typed ("Added recently", then "Everyone, A–Z"); its `detail` is a quieter second line. Typed, it is one list, labels that start with the text first, and the list follows the typing a moment behind (`useDeferredValue`), filtered only while open, on search keys its options worked out once (`withSearchKeys`). Closed, it keeps what it last showed for the half second the sheet slides away (`usePickerList`), so a picker closed by a pick leaves with its rows, never shrunk to its search, nor with an "Add …" row it didn't have. `lookup` puts rows first that the words would miss (a number's holders, from the match index) and may end the list with a row of its own ("New site for Jane Nguyen"); `noMatchAction` is the row under `noMatchLabel` when nothing matches ("New client, phone “0412 345 678”"), with a hint under it that decides its words once as it shows. An action row closes the sheet and puts focus where it goes. `detailOf` adds a line a row is given as it first shows and keeps while the sheet is open, before its own `detail`, joined with " · " ("Booked Thu 30 Oct · Added Tue 29 Sept"). `handleRef`'s `openWith(query)` opens it with a query typed, the keyboard down as for any open; `onDismiss` is told when ✕, Done or a swipe shuts it, not a row (for one choice, closed with nothing chosen) |
| `FilterDropdown` | A compact single-select filter chip in a header row (status, staff)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `SearchBox`      | A search field whose typing is instant and whose query follows after a pause                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

### 4.4 Sheets and dialogs

| Export                                         | Use for                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Sheet`                                        | A bottom sheet with a title, an optional description, a scrolling body and an optional `footer` for its buttons. The default                                                                                                                                                                                                                            |
| `SheetShell`                                   | Just the sheet's frame, for a sheet with its own header. Pair it with `SHEET_BODY` and `Drawer.Title`                                                                                                                                                                                                                                                   |
| `SHEET_BODY`                                   | The class for a custom sheet's scrolling body. Use it rather than writing its padding out                                                                                                                                                                                                                                                               |
| `SHEET_BODY_ABOVE_FOOTER` / `SHEET_FOOTER`     | A custom sheet's scrolling body with a footer pinned below it: an edit form's Cancel and Save (`form=` names the form)                                                                                                                                                                                                                                  |
| `useSheetLock` / `SheetLock`                   | A form in a sheet: locks the sheet against a swipe or a tap outside while it is open, and asks "Discard your changes?" before ✕, Escape or Back throw a change away. `onDiscard` hears a confirmed Discard as it is confirmed (after a Back, before the move lands). `SheetLock` is the same as an element, for a sheet whose form state lives above it |
| `SheetCloseButton`                             | The ✕ (`SheetShell` already renders one)                                                                                                                                                                                                                                                                                                                |
| `ConfirmDialog` (`settings/ConfirmDialog.tsx`) | Asking before anything is taken away. The only alert dialog in the app                                                                                                                                                                                                                                                                                  |

**Rules:**

- `Drawer.Root`, `Drawer.Portal`, `Drawer.Overlay` and `Drawer.Content` appear only in `primitives/Sheet.tsx` **(lint)**.
- **A sheet opened from inside another** (a picker over New Job, Make recurring over a job) dims the one under it: `SheetShell` knows it is nested and lifts its scrim to `z-50`.
- **Focus stays put when a sheet opens,** so a phone's keyboard never rises on its own over what the person opened it to see. `initialFocusRef` puts it in a search field on a computer (a fine pointer) only.
- **Never anchor a popover to a field inside a sheet.** The sheet locks scrolling to itself, so a portalled list cannot be scrolled with a finger, and the keyboard covers it. Choose in a sheet of its own (`Combobox`).
- `AlertDialog` appears only in `ConfirmDialog.tsx` **(lint)**, and never `window.confirm` **(lint)**.
- A sheet closes three ways, all equivalent: dragged down, tapped outside, or ✕. A sheet that is only a list or a read-out ends with a "Done".
- **A sheet being edited does not swipe away.** An edit mode, or a form with something typed in, calls `useSheetLock`: the grab handle goes, a swipe and a tap outside do nothing, and ✕, Escape and the phone's Back ask "Discard your changes?" (Keep editing / Discard) when something has changed, or just close when nothing has. Back is caught only as Back, so the sheet's own close and a save's navigation go through. A Back the dialog is still asking about when nothing is left to lose (the lock lifted under it: New Job's booking kept on the phone meanwhile, or the sheet closed on its job) goes on, as the person asked. The lock goes on and off in the same commit as the form that says so (layout effects), so a tap is never decided against a lock the screen no longer shows. Notes that save as they are typed need no lock.
- **Signing is never in a sheet.** A sheet is something a downward swipe closes, and a signature's strokes go downward: signing has a full-screen layer of its own (`SigningScreen`, 4.10).
- **An edit mode is the form and nothing else:** the rest of the sheet steps aside, and Cancel and Save are pinned below the fields (`SHEET_FOOTER`), within reach with the keyboard up.
- **`ConfirmDialog` wording:**
  - The title is the question, naming the thing: "Archive Jane Smith?", "Cancel this job?".
  - The body says what will happen and whether it can be undone.
  - The red button repeats the title's verb: "Archive", "Cancel job".
  - The way out keeps the thing: "Keep client", "Keep it". Not "Cancel", which is ambiguous next to "Cancel job".
- **`ConfirmDialog` behaviour:**
  - Pass `returnFocus` when the confirm removes the row that opened it, or focus falls to the top of the page. When it removes only the button — a row that changes state once it has gone through, a bar that goes — render the confirm beside what goes, not inside it, so it closes rather than being torn out, and return focus to something that stays (a `DetailRow`'s `focusRef`, the line above the list).
  - Pass `pending` and `pendingLabel` while it runs.
  - Pass `closeOnConfirm={false}` and `error` when the dialog must report a failure itself.

### 4.5 Status and display

| Export                                                 | Use for                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `StatusPill`                                           | A job's status. `jobStatusLabel` gives the word without the pill                                                                                                                                                                                                                                                                                                                                              |
| `StatusPillButton`                                     | A status pill that can be changed: the pill and a chevron, one 44px button, which opens a `StatusPicker`                                                                                                                                                                                                                                                                                                      |
| `StatusPicker`                                         | Choosing a status, a job's or a client's, in a sheet of its own: each as its pill with what it means, the current one ticked. A tap chooses and saves; Cancelled still asks first                                                                                                                                                                                                                             |
| `BarMeter`                                             | Five ticks showing a value's intensity beside its number (wind, rain)                                                                                                                                                                                                                                                                                                                                         |
| `HoldButton`                                           | Hold to act: a touch fills the button and it acts when lifted. For anything that leaves the app or reaches a client, but not a hand-over to another service’s sign-in (see Hold to act)                                                                                                                                                                                                                       |
| `ContactButtons`                                       | Call, Text, Email and Map as holds, full-width in the sheets and compact on the job card. Always this, never a `tel:` link                                                                                                                                                                                                                                                                                    |
| `MapHoldButton`                                        | The job card's corner Map, as a hold                                                                                                                                                                                                                                                                                                                                                                          |
| `DetailRows` / `DetailRow`                             | A card of facts, one row each: the name on the left, the value on the right, and a warning or an action under both (a job's Details, a client's Details). A description list, so each value is read with its name. `focusRef` makes a row somewhere a confirm can return focus to (not a tab stop)                                                                                                            |
| `ReportLine` / `ReportChip` (`reports/ReportRows.tsx`) | A report as a row in a list (its form, date and standard, and Draft, Finalised or Sent), and as a chip under the visit it came from. Carries no report templates, so a sheet on the Schedule can show one                                                                                                                                                                                                     |
| `VisitRow` (`schedule/VisitRow.tsx`)                   | A visit in a list (a job's History, a client's Jobs tab), opening it on the Schedule, with each report it produced as a chip under it. Headed by the service, or by the day where every row is the same service                                                                                                                                                                                               |
| `OutboxChip` (`schedule/OutboxChip.tsx`)               | A booking on the phone, not sent yet, where its card and sheet put the job number and status: "Not sent yet" (`Smartphone`), "Sending…" (`LoaderCircle` spinning while the line is live, `Clock` while it isn't), "Sent" (`Check`), all `OUTBOX_CHIP`; "Needs a look" (`TriangleAlert`), `OUTBOX_LOOK_CHIP`. Never wraps                                                                                      |
| `OutboxGroup` (`schedule/OutboxGroup.tsx`)             | A day's bookings on the phone, not sent yet, in a group of their own under the day's cards (a sibling of the grid, never cells in it), headed by a `section-label` counting what might be booked again by mistake: "2 jobs not sent yet", "2 jobs not sent yet, 1 sending", "1 job sending", then "Sent". Each is a `JobCard` with its `outbox` chip, keeping its slot until the next redraw (`useOutboxDay`) |

### 4.6 Empty, loading, failed

| Export                                            | Use for                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EmptyState`                                      | A list with nothing in it yet: a title ("No clients yet"), one line saying what goes here, and the one action that fills it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `EmptyStateButton` / `EMPTY_ACTION_CLASS`         | That action: quiet grey and blue, not red                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `NoMatches`                                       | A search or filter that found nothing: "No matches for “…”" and a way to clear it. Never `EmptyState` for this                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `LoadFailed`                                      | Something inside a page that could not load — a sheet's detail, a section's notes, a list in Settings: “Could not load … Check your signal.” with Try again. Never leave a placeholder waiting for good                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `PagePending`                                     | The router's default: a page loading inside a shell that stays put                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `ListPending`                                     | A list loading inside a page that is already on screen (announced). `columns={3} size="job"` for the Job tab's grid                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `CardRows`                                        | The card-shaped placeholders `ListPending` draws, for a custom layout                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `CardCells`                                       | The next page loading under a list already drawn: bare bones dropped into the list's own grid after its last card, silent (`LoadMore` speaks). `size="job"` for job cards                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `LoadMore` (`primitives/LoadMore.tsx`)            | The end of a long list: the next page loads as it comes near, up to `AUTO_LOAD_PAGES` (8) by itself, with "Show more {things}" always below. `auto={false}` is the button alone. See Long lists (5)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `RowPending`                                      | One row loading inside a card (a job's notes). Use it instead of a spinner row                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `TextPending`                                     | A block of text loading (a note's body)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `SectionPending`                                  | A page section loading (a Settings page's Suspense fallback)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `SheetPending`                                    | A sheet's body loading, under its real title                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `MonthDaysPending`                                | The month grid's day cells loading                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `Bone`                                            | One grey placeholder block, the unit the others are built from                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `ErrorScreen` (`shell/ErrorScreen.tsx`)           | A route that threw: branded, offline-aware, with "Try again" and "Start from the top"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `ConnectionNotice` (`shell/ConnectionNotice.tsx`) | Mounted once, at the root: says “Could not reach PestM8” (or “No signal”) when the socket has been down, a save unanswered or something on screen without data for a while (`lib/reach.ts` has the timings), with Try again, then Reload. An open sheet shows the same at its top (`ReachNotice`, `placement="sheet"`), since it covers the banner. It is the app-wide word on reach; a screen showing a copy kept on the phone still says so itself (States, below), and where that line says the line is down, on the page (`KeptCopyNote`) or in the sheet (`KeptJobView`, `KeptClientView`), the notice gives way to it there unless a change is waiting to save (`noticeOverKept`, `lib/offline/keptOnScreen.ts`)                                                                                                        |
| `KeptCopyNote` (`shell/KeptCopyNote.tsx`)         | A page showing the copy kept on the phone: “No signal — showing the copy kept on this phone.” (or “Could not reach PestM8 — showing the kept copy.”) over “Updated 9:42am” (`formatUpdated`), under the Schedule's strip, a desktop's month or the Clients page's search box. Decided once by `useKeptNote`, never put in later, and never taller or shorter than it first painted (States, below). While it says the line is down, `ConnectionNotice` gives way to it, unless a change is waiting to save; where the notice does show, it says “What’s on screen was last updated 9:42am.”                                                                                                                                                                                                                                   |
| `NotKeptDay` (`schedule/NotKeptDay.tsx`)          | A day or week the phone keeps no copy of, asked for with the line down: “Not on this phone”, “This phone keeps this week and next. {Monday 9 November} shows when you have signal.”, and Go to today, in the list's place under the heading naming it. With nothing of this week on the phone, the whole page is `ScheduleNotKept` (`schedule/ScheduleNotKept.tsx`)                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `KeptJobView` (`schedule/KeptJobView.tsx`)        | A job opened with no answer from PestM8 (`useKeptJob`: the line down, or 3 s with nothing while its day isn't live), read-only from the day that lists it, with “No signal — showing the copy kept on this phone, updated 9:42am. Editing needs signal.” under the property. Laid out as the live sheet down to the property's Call, Edit's row and the status menu's chevron held unseen where the live sheet has them (`UnseenEdit`, `UnseenMenu`, which `KeptClientView` uses too), and drawn in the sheet's own body, which the live sheet lands in at the same scroll and height (`useHandOverBody`), so nothing moves when PestM8 answers (States says where the phone can't tell). With the line down and no day on the phone listing it, `NotKeptJob`: “This job isn’t on this phone. It opens when you have signal.” |
| `KeptClientView` (`clients/KeptClientView.tsx`)   | A client opened with no answer from PestM8 (`useKeptClient`: the job sheet's rule, with the client list in the day's place), read-only from the phone's client list: who they are, their number and tags, and Call, Text and Email (the client list's email, or for a copy kept before the list carried emails, a day the phone holds) where the live sheet has them, held there across the hand-over as the job's are, then the job sheet's line, then each site with Map and its site contact; Jobs, Notes, a business's Contacts and, where the live sheet has a row for it, Xero say “Opens when you have signal.” One the list doesn't have is `NotKeptClient`: “This client isn’t on this phone. It opens when you have signal.”                                                                                        |

Placeholders are shaped like what they stand in for, so nothing jumps when the content lands. Where the content's height would depend on its words, lay it out by width instead (Breakpoints, in 3). They contain **no** headings, buttons or visible text: the e2e suite takes a heading as the sign that a page has loaded.

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

### 4.9 Installing the app: `install/`

Which steps a device is shown is decided in one place, `lib/installMethod.ts`, from the browser's user agent. Never write install instructions anywhere else.

| Export                                                  | Use for                                                                                                                                         |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `InstallGuide`                                          | This device's steps, detected: numbered steps, one tap where Chrome offers its prompt, or the way out of an app's browser                       |
| `InstallSteps`, `IphoneSteps`, `Step`                   | The same, for a given method, drawn without detecting anything (set-up's Home Screen card, tests, the harness)                                  |
| `InstallSettings`                                       | Settings → Install app, under its header                                                                                                        |
| `InstallSheet`                                          | The guide in a sheet, where there is no page for it                                                                                             |
| `InstallLink`                                           | "Put PestM8 on your Home Screen" under Sign in, on a phone or tablet in its browser. Its row is always rendered, so nothing moves when it fills |
| `InstallCard`, `InstallCardView`, `useInstallCardOffer` | The schedule's card for a phone using PestM8 in its browser; ✕ (or set-up having just shown the steps) puts it away for 30 days on that phone   |

Never say "not installed": a browser can't tell whether a Home Screen copy exists. "Installed" is only for the installed app itself.

### 4.10 Signing: `signature/`

A signature is drawn on a screen of its own and kept as the pen's strokes (`lib/signature/ink.ts`), never as the screen's pixels.

| Export          | Use for                                                                                                                                                                                                                                                                                               |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SigningScreen` | Signing anything: the title, the words being agreed to, the pad, Clear, Undo and Done, and a slot beside Done for what else the signer may choose. Full screen at `z-[80]`; on a phone held upright it is laid out a quarter turn round, so the signature gets the long side once the phone is turned |
| `SignaturePad`  | The pad inside it: ink whose width follows the pen's speed, drawn at the screen's resolution, refitted as the pad changes shape, and saved (`save`) as a PNG cut to the ink, at least 1,200 pixels across, with the strokes it was drawn from                                                         |

**Rules:**

- **A screen asking the signer's name stays upright,** where the keyboard rises along the phone's own bottom edge.
- **Nothing beside the pad comes or goes as the first stroke lands:** the slot beside Done is one size, whatever is in it, so the pad never moves under the pen.
- **It asks before throwing a signature away,** on ✕, Escape and the phone's Back, in place ("Discard this signature?" / Keep signing / Discard): it sits above `ConfirmDialog`'s layer.
- **The pad is `bg-paper`, and its ink is `--ink` (light) in both themes:** what is drawn there is printed on white.
- **A drawing is kept on the phone until the report has it** (`lib/signature/kept.ts`), where the browser allows. A Done that cannot save says whether it was kept; once it is, closing asks nothing while the pad still holds just that drawing. The report shows it as "Not saved yet", with Save it and Discard, to the person who drew it alone, until one is tapped or the report holds a signature at least as new. It is signed when Done was first tapped on it, however late it arrives, and a report on a new version of its form, or locked, can only discard it.
- **A saved signature goes on a report only by a tap,** on the signer's own slot: "Sign with my saved signature", with "Draw instead" under it. A first drawing offers "Keep for next time", ticked; a later one "Replace my saved signature", unticked. Settings → My signature shows it, draws a new one or removes it, and neither changes a report already signed.

---

## 5. Patterns

### States

| State                        | What to show                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Loading a page               | Nothing to do: `useSuspenseQuery` plus the router's `PagePending`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Loading inside a page        | A placeholder from `Pending.tsx`, shaped like the content. Never blank the page, and never a centred spinner for a whole screen. A spinner belongs inside the one button or row that is waiting                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Empty                        | `EmptyState` with one verb-first action ("Add a client")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| No matches                   | `NoMatches` with the term quoted back and "Clear search" / "Clear filters"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Owner only                   | `EmptyState` titled "Owners only" and a body saying who can change it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| A page failed to load        | `ErrorScreen`, via the route's error boundary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| A query failed inside a page | `LoadFailed` where its placeholder was, with `onRetry` set to the query's `refetch`. A suspending query throws to the route's `ErrorScreen` instead                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Offline                      | Show what is kept on the phone and say so (`KeptCopyNote`). A day it has no copy of says "Not on this phone" (`NotKeptDay`). A job or client opened shows read-only from the copy (`KeptJobView`, `KeptClientView`). An edit that needs signal says "Editing needs signal." A save that waits for signal says so above its button (below). A booking kept on the phone shows in its day's "Not sent yet" group (`OutboxGroup`), and opens read-only, saying where it is (`KeptJobView` with `outbox`). New Job with nothing of it on the phone says "New Job isn’t on this phone yet" (below).                                          |
| Can’t reach PestM8           | Nothing to build: `ConnectionNotice` says so for the whole app once a wait has gone on, in a sheet as well as on the page, and goes when PestM8 answers. Where a line already says the screen is the kept copy because the line is down (`KeptCopyNote`'s “No signal — …” or “Could not reach PestM8 — …” on the page, while it is on screen, a kept job's or client's in a sheet), it gives way to that line, there only, unless a change is waiting to save, and offers Try again first once it shows (The copy kept on the phone, below). A placeholder stays a placeholder; a query refused by the server says so with `LoadFailed` |

**Waiting for signal.** A save the Convex client holds until the line is back, rather than failing at once (Book job, Save client, Add property; Saving, rule 6), keeps its button and its words. While the line is down (`useLineDown`, `lib/offline/useLineDown.ts`: the phone has no network, or the socket to PestM8 has been down for 8 s on screen), a `text-caption text-ink-2` line just above the button says what will happen, in that sheet's words, and describes the button:

- "No signal — the booking goes when you have signal. Keep PestM8 open until then."
- "Could not reach PestM8 — the booking goes once it can. Keep PestM8 open until then."

Book job says otherwise where the booking is kept on the phone first (`lib/outbox/book.ts`, `bookingCaption`): with keeping switched on (`VITE_PESTM8_OUTBOX=on`), Web Locks, the phone's bookings read, localStorage taking the page's notes (`localNotesWork`: a keep given up is noted there, for every tab and the next page load), the person signed in and in their own account, and a draft that hasn't fallen back to sending straight (a keep of it that took too long, or a press of it discarded):

- "No signal — the booking is kept on this phone and goes when PestM8 is open with signal."
- "Could not reach PestM8 — the booking is kept on this phone and goes once PestM8 answers."

Kept, with the line down, the sheet closes as soon as it shows the booking kept. With the line up, the booking is sent, and with no answer within 4 s of the send (`ANSWER_WAIT_MS`; the sender's `sendHeld` owns that wait) the sheet closes with it kept. An answer in that time is acted on once the phone has written what it says, however long its storage takes ("Booking…" till then): a job closes the sheet; a refusal that made nothing, or the kill switch, then waits for the phone to have really taken the booking off, or failed to (below); anything else closes the sheet with it kept. From the moment it shows kept, ✕, Escape and Back close it without "Discard your changes?", since nothing is lost, until it isn't on the phone any more (refused, or sent straight after all), when they ask again. A close is decided on what the screen showed, the sheet's lock moving in the same commit (`useBooking`'s `shown`; `useNewJobBooking` pairs the two), and the phone sends the booking, closes on it, or takes it off only once the screen shows that. A refusal is shown only once the phone has really taken the booking off, and the kill switch's booking goes straight only then; if it couldn't, the sheet closes with the booking kept, needing a look or held, as the phone has it. Discard, when they ask, means it, from the moment it is confirmed (after a Back, before the move lands): while the booking is still being kept, going straight or being taken off, nothing of it is kept or sent from then on, and whatever the phone kept of it comes off again, unless the phone's storage really fails to delete it, which leaves it needing a look, shown and never sent by itself (`LEFT_ON_PHONE`); only a call already out can still make the job, as one always could. The draft keeps nothing more after a Discard: on a sheet that stays up (a Back whose move never landed), Book again goes straight, as below, never kept again while what the phone kept of it may still be coming off. Not kept within 1.5 s, it goes straight, as above, saying whose it is (`asMembership`), and stays straight, every later press of that draft saying so too, so one refused because PestM8 is now working in someone else's account (`NOT_OWN_ACCOUNT`) is refused again until the person switches back, never booked there: what the sheet shows is that call's answer alone, and a keep that lands late is taken off the phone again, never sent; until it is off no tab shows or sends it, and the next page load deletes it, and only a delete the phone's storage really fails leaves it, needing a look, never sent by itself (`lib/outbox/book.ts`). While it goes straight the line above the button says to keep PestM8 open, whatever the phone could do by then (`saysKept`). Either way it carries the draft's request id, so a send repeated after a lost answer books once.

**New Job with nothing on the phone** (the line down, and the client list, the team or the job types neither in memory nor kept) says so in the sheet's body instead of a placeholder that would wait for good: an `EmptyState`, "New Job isn’t on this phone yet" / "It needs the client list and the team, which this phone doesn’t have yet. It opens when you have signal." The form opens by itself once they can be read, and once it is up it stays up, whatever the line does then, so nothing typed is taken away (`newJobBody`).

**The copy kept on the phone** (`lib/offline/`: this week and next of the Schedule, Monday to Sunday, and what New Job is made of: the clients, the team and the job types) is shown without ever putting something in under a thumb:

- **What the note says.** Its first line says what the line is doing: "No signal — showing the copy kept on this phone.", "Could not reach PestM8 — showing the kept copy." or "Showing the copy kept on this phone." The second is kept about as short as the first, so neither leaves the other a line to spare. Under it, "Updated 9:42am" (`formatUpdated`, from the loader's today, so the server and the hydration render word it alike): when the oldest answer under it was last known to be right.
- **The note is decided once** (`useKeptNote`). The server always draws `KeptCopyNote`, hidden: `hidden kept:flex`. A page the service worker served from its own copy, more than two minutes after the server drew it, is marked `data-kept` on `<html>` by a head script (`keptInitScript`, after the theme's), and the `kept:` variant (`styles.css`) shows the note from the first paint; with the phone saying it has no network then, the script writes `data-kept="no-signal"` and the `kept-offline:` variant shows the no-signal words from that same paint. Reached by a tap within the app, it shows from the first frame if the line is down then. Otherwise it never shows: a line that drops during a visit is `ConnectionNotice`'s to say, and an answer from the copy counts there as waiting until PestM8 confirms it.
- **Its height never changes** (What only the device knows: reserve its space). Every first line it can say is laid in the same place, all but the one shown unseen, so it is as tall as the wordiest of them at that width from its first paint, and the "Updated" line is always there.
- **Once shown, its words follow the line,** and once everything under it is live it says "Up to date." with a tick, over when it came live, and goes with the next change of day, view, search, order or filter, which redraws the list anyway. Over a list that could not load (`LoadFailed`, nothing from the copy under it) it is never drawn, or goes for good once that is known; but on the Clients page a search, A–Z or filter over the newest clients that could not load only leaves it out while it says so, since clearing it brings the newest clients back, still the copy the note is about (`clientsListView`).
- **Where it sits.** On a phone, under the strip, clear of the no-signal notice's band; the can't-reach notice, taller for Try again and a waiting save, can cover its first line where it shows over it (a change waiting to save, or the note's "Showing the copy kept on this phone."), and says when the screen was last updated itself. On a desktop, under the month, below the band at the top right where that notice floats. On the Clients page, under the search box, where the notice's band can cover it where it shows over it; the notice says when the screen was last updated itself.
- **The can't-reach notice gives way to it** (`lib/offline/keptOnScreen.ts`). While the note says the line is down ("No signal — …", "Could not reach PestM8 — …") and is on screen, `ConnectionNotice`'s banner isn't drawn, nor read out: the two said the same, one over the other. Nor is a sheet's own notice while that sheet shows a kept job or client (`KeptJobView`, `KeptClientView`), whose line says it too: even on a line that looks up, where that line says "Could not reach PestM8 — …" itself, so Try again is then on the page's banner behind the sheet. Each is decided where it shows: SheetShell gives every sheet a place of its own (`KeptPlace`), so a note on the page behind a sheet leaves the sheet's notice up, and a kept view says nothing about a sheet opened over it. Never while a change is waiting to save (`noticeOverKept`): only the notice says so, and that a reload loses it. "Showing the copy kept on this phone." holds nothing back on its own, since it doesn't say PestM8 can't be reached (a socket that looks open and never answers), nor does "Up to date."; but straight after the note said the line was down it does, for up to 12 s (`nextNoteHold`, `KEPT_AFTER_DOWN_MS`, as long as a fresh page's answers are given): the socket is open again, the first answer on it carries every query on screen and can take a while on one bar, and the notice, counting the kept answers as waiting since the page drew, would otherwise show for the first time just as the signal came back. The page's note counts only while half of it or more is on screen below where the band shows under the header (`useOnScreen`): scrolled up out of sight, the band, fixed under the header, is back to say the line is down. A sheet's kept view counts wherever it is in the sheet: the sheet's notice is in its flow, and one that came and went with the scroll would move what is under a thumb. Once the note goes (the line back, "Up to date.", the page left) or scrolls away, or the live sheet takes the kept view's place, the notice is back by the usual rules, but not for 1.5 s (`KEPT_GONE_MS`): over ConnectionNotice's second between looks, so a notice the line coming back has just made stale goes before it can show. It comes back offering Try again, as a notice does when it first shows: the wait before Reload is offered runs only while the notice is drawn somewhere (`reloadClockSince`, `useDrawsNotice`). A line says it shows in a layout effect, and a notice reads it in one, so a notice and the line that holds it back drawn in the same commit never paint together; nothing shows on the server or while hydrating. What ConnectionNotice decides is still published as it was: the new-version banner still waits, and each time the page's banner is held back or let through while it is up, the phone's connection notes say so (`notice-held`).
- **A day not kept is said in the list's place** (`NotKeptDay`), under a heading naming the day asked for, with the strip left on the week it has: "Not on this phone", "This phone keeps this week and next. Monday 9 November shows when you have signal." and Go to today. Nothing kept of this week at all is `ScheduleNotKept`: "This phone has no copy of this week yet. It shows when you have signal."
- **Decide it when the page draws,** never by a placeholder waiting on a fetch: with the line down, a fetch can wait for good. A screen that draws kept answers asks `useReadable` (or `useReadableAll`, `lib/offline/useKept.ts`), which says yes on the server and while hydrating, so the page hydrates as the server drew it, and says "Not on this phone" where the answer is no.
- **A day kept from before it arrived** has none of its recurring visits on it, so `RecurringDueNote kept` says how many the week counts: "2 recurring visits due — they show when you have signal."
- **The Clients page with the line down** reads every client from the copy, as it does for a search, and counts and filters what it holds; so too on a line that looks up, when the newest clients are 3 s late and every client is in memory. The 3 s count from the tap that opened the page (`openingWaitSince`), never from a tap on an earlier visit whose page the router kept and opens again at once. With every client on the phone (`keeper.onPhone`), the loader holds that tap no longer than those 3 s, and not at all on a line PestM8 hasn't spoken on lately (`keeper.lineLive`), so the page draws them on time either way (`loaderHoldMs`). Decided as the page first draws, or later while the list is still on its placeholder, and never once the newest clients are on screen (`useKeptMode`, `keptClientsMode`), so the list never changes source under a thumb: what the hydration render drew stays, and a guess made while the phone's copy is still being read never takes the newest clients off. Reached by lateness, on a line that looked up as the page drew, it has no "Updated" note: put in then, it would push the sort and filter rows down under a thumb, and `ConnectionNotice`'s band says it once its wait has gone on, as for a line that drops during a visit. With no copy, the list's `LoadFailed` says so at once. A search with no match adds “Newer clients show when you have signal.” to `NoMatches`' hint where the list it searched may be behind (`useBehindOnce`, `mayBeBehind`: not live, and the line down, the phone's copy, the HTML of a page the service worker kept, or an answer PestM8 hasn't pushed again on a line gone quiet), whichever way the page reads, since a client added since isn't in it. That is decided as `NoMatches` shows, and kept until the search or filters change, so the hint never changes length over Clear search, nor is announced again. New Job's pickers say the same under their way in to a new client where nothing matches (`useNewerClientsHint`), decided as it shows and kept while it does (Finding the caller, below). With the line down, the newest clients' Show more gives way to “More clients show when you have signal — search finds every client on this phone.” (the second half only where the phone has every client), centred in `text-caption text-muted`: a page asked for then would never come. The newest clients wait for the filter row's choices (`clients.overview`, `newestDrawn`), so the row never lands above cards already there; with the line down the choices won't come, and they don't wait. A first page that came back empty with more behind it shows only the placeholder, so it decides nothing until cards are drawn. What goes around the list (`NoMatches`, the next page's bones, its end, whether the note stays) is `clientsListView`'s.
- **A job opened with no answer** (the line down, or 3 s with nothing from PestM8 while the day that lists it isn't live: a live day means PestM8 is answering, and the job is on its way) shows read-only from the day that lists it (`KeptJobView`, typed from `jobs.listDay`'s row): its status, time and who is going; the property with its site contact, contact person and the client's own Call, Text and Email, as the live sheet lists them, and Map under them where the card has one; then the Products sheet's line, "No signal — showing the copy kept on this phone, updated 9:42am. Editing needs signal."; then its note and work order. With no day the phone holds listing it, and the line down: "This job isn’t on this phone. It opens when you have signal." Once shown it stays until PestM8 answers, even with the line back, and the live sheet then takes its place.
- **Nothing moves when the live sheet takes its place.** The kept view is laid out as the live sheet is down to the end of the property, line for line: Edit's row and the status menu's chevron held unseen where the live sheet would have them (`UnseenEdit`, `UnseenMenu`); its notes that the job is invoiced or someone else's (`keptJobReadOnly`, for the account being worked in, from the access and the roster); and the client's number beside their name, from the client list. What the day's row doesn't say is read as the job first shows, from memory or the phone's copy, and kept while it does (`useKeptJob`). It is drawn in the sheet's own scrolling body, which the live sheet then lands in, scrolled where it was, and held at the kept view's height for as long as the sheet is open (`useHandOverBody`): a bottom sheet is as tall as what is in it, so a live sheet taller or shorter would move its top edge, and every Call with it. Only what the phone can't tell still moves: someone else's job with no roster on the phone, or one from before the team changed (the amber line, about 50–68 px tall, comes in above the property); a client number the client list doesn't have (a long name wraps a line earlier); and, while the sheet is at its full height, the sheet's own can't-reach notice above it (`ConnectionNotice`) where a change is waiting to save (with only reads waiting it gives way to the kept view's line), which changes its words as the line comes back and goes once the socket connects, usually a moment before the answer (once the body is held, a notice that goes moves only the sheet's top edge).
- **A client opened with no answer** (as for a job: the line down, or 3 s with nothing while the client list isn't live) shows read-only from the phone's client list (`KeptClientView`, typed from `clients.directory`'s row): their name, type, status, tags and client number, Call and Text, and Email from the client list (which carries each client's email since 28 Oct 2026; for a copy kept before then, where a day the phone holds has a visit of theirs, from `jobs.listDay`'s row), then the job sheet's line, then each site with Map and its site contact. Down to Call, Text and Email it is laid out as the live sheet is, with Edit's row and the status menu's chevron held unseen, in the sheet's own body, held across the hand-over as the job's is: so Call stays put when the live sheet takes its place. Only what the phone can't tell still moves: Email joining Call and Text for a client whose email the phone's copy doesn't have (one kept before the list carried emails, with no visit on the phone), which narrows all three; the sheet's can't-reach notice at full height with a change waiting to save, as for a job; and an inactive client's line about services still running, which comes with its own answer on the live sheet too. Jobs, Notes and a business's Contacts say "Opens when you have signal.", and so does Xero where memory shows the live sheet would have a row for it (`xeroKnown`); where Xero isn't set up the live sheet has none, and nor does this. Nothing on it edits, and there is no Add a site. One the list doesn't have: "This client isn’t on this phone. It opens when you have signal." Once shown it stays until PestM8 answers, even with the line back, and the live sheet then takes its place.

Switching business with the line down goes only to a business the phone already holds enough of to open. Any other is refused, with an amber line under the list (`role="alert" text-caption text-amber-ink`): "Switching business needs signal."

Settings → Sign out and the business switcher ask `confirmLeave` first (`lib/offline/leaveGuard.ts`), so anything kept on the phone that leaving would lose can ask the person before it goes. The other ways to sign out (the two-step screen, the join and start pages, set-up's and the no-business screen's) don't ask yet. A new way to sign out or switch from inside a business asks it too.

### What only the device knows

The server can't know which phone this is, so anything decided by the device (the install link and card, "Installed") is unknown until hydration. That is also the moment controls start to work, so **never insert content during hydration**: it would push what a thumb is already reaching for.

- **Reserve its space** when it must show on the first load: the sign-in link's row is always 44px, empty or not.
- **Or decide on first render**, and keep the answer: `useInstallCardOffer` reads a hydrating render as "no", so the schedule's card never appears on a full page load, and shows from the first frame when the schedule is reached from another tab. Not after Back or Forward either (`cameByHistory`): the router puts the scroll back where it was, and something new above it would land the page off by its height.
- A value in a row that already exists (the Settings row's "Installed") may fill in late: nothing moves.

**Bookings on the phone, not sent yet** are something only the device knows too:

- A hydrating render draws none of them (`useOutboxItems` is null while hydrating, and until the phone's bookings have been read), and a booking's sheet (`?outboxId=`) opens only after both.
- Their group goes under the day's last card, so it may come at any time once hydrated: below everything, it moves nothing.
- A day drawn with "This day is clear." or "No matches" keeps it unless the group comes within 500 ms of the list first drawing (`ADD_AFTER_DRAW_MS`), or the person booked it just now in this tab; otherwise the next redraw shows it. A day with bookings on the phone and no jobs draws no "This day is clear.".
- A booking keeps its slot as it goes, and once sent the slot draws the real job, kept out of the day's ordered list, until the day, view, filter, staff or mode changes (`latchSlots`). Counts are the server's throughout.
- A booking is never drawn beside the job it made: the job counts as its from the moment the server's answer is heard (`answeredView`), before the phone's storage says sent, and a job carrying its request id is its whatever the phone has heard. A slot whose job hasn't reached the day's list yet says "Sent" and waits for it (`ROW_WAIT_MS`), rather than go and let the job drop in mid-list.
- None comes into the group while its New Job sheet is still waiting on it (`OutboxModel.deciding`), nor once that sheet closed on its job (`answeredOnScreen`): booked with signal, it lands in the day's list as it always did. One the sheet closed on still kept comes in as the sheet goes.
- A booking shows on its own day. Needs-a-look bookings of other days join today's group with the booking's own sheet (plan D13, 2c-E).

### Saving

1. **Before hydration, it can't be tapped.** Every control that needs JavaScript has `disabled={!hydrated || …}` (`useHydrated`), so a tap is never swallowed by inert markup.
2. **The button carries the state:** "Save", then "Saving…" (disabled), then "Saved" for two seconds (`useJustSaved` / `useSavedFlash`), or the sheet closes, or the page moves on.
3. **Failures are amber, not red.** A save that failed is a `FormAlert` just above the button, worded by `describeError`, with nothing typed lost. One control's failed action (an upload, a toggle) is an amber line beside it: `role="alert" text-caption text-amber-ink`. Red is for a field that can't be accepted, not for a request that didn't go through.
4. **Where a Save goes:**
   - Settings: a sticky `SaveBar`.
   - Sheets: a footer, or a Cancel and Save pair for editing in place. A whole-record edit mode pins its pair below the fields (`SHEET_FOOTER`) and locks the sheet (`useSheetLock`).
   - The report builder and the template editor save automatically (`useAutosave`) and show the state in their own bar.
   - A switch or a colour saves the moment it changes.
5. **No toasts.** The app has none. Say it where the eye already is: the button, the row, the sheet closing. A copy button says "Copied" with a tick for two seconds.
6. **A save that reaches someone else, or can't be undone, never waits for signal.** An email, a lock, an invitation link, a delete for good: its `mutationFn` checks `isOffline()` first and throws `Error('offline')`, and its copy map's `offline` words say so at once ("Could not send: this device is offline. Nothing was sent — try again when you have signal."). Otherwise it says "Sending…" until the signal comes back, then goes through after the person has given up. An autosave, or a save that only keeps the person's own work, may wait, and a create that waits says so above its button while the line is down (States). `ARCHITECTURE.md` §5.5 lists which do which.

### Destructive actions

Never on one tap.

- **Remove or delete** opens `ConfirmDialog`.
- **On a Settings page**, the destructive rows sit in the last `DangerGroup`.
- **A small, easily undone act on your own work** may ask in place instead ("Tap again to clear"), or offer Undo.
- **Words:**
  - "Delete" is for records (a note, a product, a draft).
  - "Remove" is for attachments and memberships (a photo, a file, a contact, a team member).
  - "Archive" is for what can come back into use (templates).
- **Recovery** is a place, not a toast: the Recycle bin (Settings → Recycle bin, 30 days: clients, properties, jobs and recurring services, with everything that went with them), Recently Deleted (reports and notes, 30 days), Archived, "Offer again". A delete's confirm says where it can be got back from. A client merged into another waits there too, as "Merged into {A}", but can't be restored, which the merge's confirm says first (Xero, below).

### Hold to act

Call, Text, Email and Map are holds (`HoldButton`), so a pocket or a brushing thumb cannot dial a client or leave the app.

- Hold or click is decided per pointer: a mouse, a keyboard or a screen reader acts at once.
- A hold's element carries `hold-target`, so the browser can't take the touch to scroll or select text.
- In a scrolling list it carries `hold-target-scroll` instead: that allows vertical panning, and a scroll cancels the hold.
- Neither utility is general touch hygiene; use them only on holds.
- Map opens in a new tab and never navigates the app away.

_Amended 6 Oct 2026:_ a deliberate hand-over to another service’s sign-in on a Settings page — Connect Xero — is a tap; Open in Xero stays a hold. A hold guards against an act nobody meant: a thumb brushing a card in a list being scrolled, a phone in a pocket. Connect Xero is the one button at the foot of a page someone opened on purpose, under the words saying what connecting shares; it reaches no client, and it comes back, because Xero's sign-in opens in the same window and sends the browser back to the page. Open in Xero (Release 3) sits on a client's sheet and opens a new tab, like Map, so it is a hold.

### Lists and cards

- **A tappable card** has `active:scale-[.99]`; a tappable row has a chevron.
- **A card lists only the suburb.** The full street address appears only in detail and on the report, and Map carries the street.
- **A card's Service and Note rows run to two lines,** so a job for three services names them all, and "ring first" is seen on the day's list.
- **What a job card offers depends on its status.** Committed work gets the contact holds; a due recurring visit gets "… to book"; future or cancelled work gets nothing.
- **A job card says who to ask for,** on the price's line, above Call, Text and Email where the card has them: "Contact Jan Morris". It names a business client's site contact when Call rings the site, else its contact person, whose own number Call rings when they have one (`contactToCall` in `convex/lib/siteContact.ts`). A card without contact holds (a future visit, the Recurring Job view) still names them, as who to ring to book. Nobody is named who is already the heading — a person client, a sole trader under their own name — and the card never names someone its Call does not reach. The job sheet shows the contact person under the property. _Added 2 Oct 2026._
- **Recurring projections are shown but never counted** in totals.
- **A booking on the phone, not sent yet,** is drawn by `JobCard` itself, from a row made like the day's (`outboxRow`), so it is the card its job will be: Call, Text, Email and Map as a Pending job has them, and its `OutboxChip` where the number and pill go. Only under the status filter "All" (it has no status yet); the staff filter and "Just my jobs" let it through for its lead or someone also going. Shown, never counted: no strip dot, no header count.

### Finding the caller

Someone rings, and the technician books them from New Job. The pickers find them by what the caller gives first, their number or email, not only by the words of a row. _Added 28 Oct 2026._

- **What is searched.** The Property picker finds a site by its client's name, phone (in both forms) and email, the street, suburb and postcode, and for a business its sites' contacts and its contact people's names, numbers and emails. New site for's picker finds a client the same ways, and lists every client: one with no site yet is "Sam Wu — No sites", there to add one for. The Clients page's search finds a client by their own phone and email and a business's contact people too; a client number typed bare ("2041") that is a client's finds that client alone (`searchClientRows`), though its four digits are in many a phone. Placeholders say so: "Search by name, address, phone or email", "Search by name, phone, email or suburb", "Search by name, address, phone, email or #number"; the Clients page's box is named "Search clients by name, address, phone or email" for a screen reader.
- **A whole number or an email is looked up by its key** (`lib/clientSearch.ts`, through the match index, `convex/lib/clientMatch.ts`): "08 5550 4321" finds a client saved as "5550 4321", and a contact person's mobile finds their business. Those holders' sites come first, then the rows the words find. The business's own number and email, and the person's own, bring no one first; so do the team's, on the phone of someone who manages the team (anyone else's roster has no team numbers to leave out). A number is one a key can be made of: an ABN's eleven digits, or a number a digit short, is not ("51 824 753 556" is "New client", nothing filled).
- **One holder ends the list with "New site for {client}":** the client chosen in New site for, focus on its field, as "New site for an existing client" does. Finding is not matching: a number six clients hold lists all six, and none is said to be the caller. An archived client is named as their rows name them: "New site for Sam Wu (archived)" (`pickerName`). So does a client's name typed in full, when one client has it ("Jane Nguyen": her sites, then New site for Jane Nguyen; `namedClient`), not part of a name, a placeholder, or a name two clients have; unless a client with no site yet has each of its words in their own name ("Sam Wu" for "Sam"; never "Lee Tomkins" for "Tom Lee", nor a business found by a contact person's name; `siteLessNamed`), who ends the list instead (below): the end row is the only way to them there, while the one named has their sites listed above it.
- **A client with no site yet is found in the Property picker too,** though it lists sites: by name (the words of their row in New site for) or by the number or email they hold, it ends the list with "New site for Sam Wu", in place of "New client named “Sam Wu”", which would make him twice (`siteLessFound`, `propertyListEnd`). Several such clients end it with "New site for one of 2 clients with no sites", which opens New site for with what was typed, so they come first there. "New client" is offered only when neither the sites nor the clients have a match. With no site in the book at all, "Existing client" goes to New site for, and "Choose an existing site instead" isn't there.
- **Nothing matching is the way in,** never a dead end: under "No client or address matches.", one row names the field it fills — "New client, phone “0412 345 678”", "New client, email “sam@example.com”", "New client at “12 Wattle St”", "New client named “Sam Wu”", or just "New client" for anything else ("6014"). It opens the New client tab with what was typed there, and focus on that field. Where the list searched may be behind, "Newer clients show when you have signal." sits under it, decided once (`useNewerClientsHint`).
- **Nothing moves under a thumb.** A row's extra line (`detailOf`) is decided as it first shows and kept while the picker is open; the hint is decided as it shows; the list follows the typing a moment behind, never ahead of it.

### Is the caller already a client?

Someone rings, the technician types them in as a new client, and they are one already: under a new number, at a new address, or as a contact at an agency. New Job says so before Book, from the client list on the phone, with or without signal, and offers the fix that books it on them, keeping what the caller said (`lib/clientMatchRows.ts`, over the match index, `convex/lib/clientMatch.ts`). A matching number or email is evidence, not identity: agencies, strata managers and families share them, so nothing is decided without a tap. _Added 1 Nov 2026._

- **The order of New client** is the order a caller gives it: Client type, Name, ABN (a business), Phone, Email, Contact person (a business), then the address and the site contact (`NewClientFields`, in New Job and Clients → New client alike). The number comes first, and the match needs no address.
- **A line under Name, Phone or Email** (`FieldMessage tone="status"`, where the field's own messages go) says who already has what was typed, once focus moves on **to another field**, and stays while that field holds the same number, email or name, however it is written: PhoneInput's own "Use 0491 570 156" keeps it, said again as the number now reads (`matchKeyOf`). The lines under Phone and Email rest on the Name too, as whether it agrees is what makes their fix one tap: the Name changed to another, they are decided again, so "Book at 12 Wattle St" under her mobile becomes Show them once the caller is Tom Nguyen, a changed fix held as a new one is, and a fix whose words stay does what it would now (Open Jane Nguyen opens her Details once the caller is Tom); a line no name can change, for a number or email that is no one client's alone, isn't decided again (`nameFree`). A tap on Book or a fix moves focus nowhere on iOS, so nothing is put in above a button being pressed; the panel says it instead. The field focus is in stays where it was on screen as a line goes in above it, or goes, and the line's fixes take no tap for 400 ms after it comes in (`held`), so the thumb that tapped that field lands in it again. Once a line's or the panel's fix is taken, the rest of the form takes no tap for 400 ms (`useLineFixHold`): what it changed moves up under the thumb at once, so the second tap of a double tap opens no picker and moves no segment. Book is left to its own hold, which shows (below): a line's fix leaves it far below, where a press is meant, never a silent no-op. "Jane Nguyen, of Bayswater, has this mobile." with **Book at 12 Wattle St** (one site), **Choose Jane Nguyen’s site** (several: the Property picker with the number typed) or **New site for Jane Nguyen** (none); "08 9272 1234 is Tom Lee’s number." with **Show them** only; "08 9272 1234 is on 6 clients — Ray White Bayswater and 5 others." with **Show them** and **New site for Ray White Bayswater**; "Jane Nguyen, of Bayswater, is already a client." with **Choose Jane Nguyen’s site** while no address is typed, the usual case as the address comes last (the Property picker with the name: her sites, ending in New site for Jane Nguyen, so the caller's own site is chosen, never typed again beside it), **Use Jane Nguyen** once one is, Use as at Book (a name says nothing about where the caller is, so it never books one of their sites outright), and **New site for Jane Nguyen** when she has none; "2 clients are called Jane Nguyen." with **Show them**.
- **At Book**, in New client and New site for (never at an existing site, chosen from the book), the panel lists who the caller may be, synchronously, as rows of `kind: 'match'` after the fields' own warnings, one row a client and three at most, then "And 2 more" with Show them. Its foot names the fix that is there: "Use it, or press Book anyway to add a new client." ("Use one, …" for several that can be used; "…to add a new site." in New site for), and where no row has a fix that books, each only showing who it may be, "Check who it is, or press Book anyway to add a new client." (`matchFooter`); mixed with field warnings, the usual line. Where the client list may be behind it ends "From the clients on this phone, updated 9:42am." (decided as the rows appear), and where it is cut short "Only the newest 8,000 clients are on this phone." or "Not every contact person is on this phone.": a copy that may be behind never claims there's no match. Until the online sheet sends its check with the booking (the matching plan's M7), this is the only check: the server doesn't look for the caller among the clients yet.
- **The rows:** "Already a client" (the same name, and an address, mobile, email or landline of theirs: "12 Wattle St, Bayswater is Jane Nguyen’s. Same name and address." with Book at 12 Wattle St; "Jane Nguyen, of Bayswater, has the same name and mobile." with Use Jane Nguyen; "Sarah Lee is a contact at Ray White Bayswater (14 sites). Same name and mobile.", or at its own site, "1 King William St, Bayswater is Ray White Bayswater’s, and Sarah Lee is a contact there. Same name, address and mobile.", the contact named, as it is her name that agrees; an address like theirs with Book at 12 Wattle St and Add 12 Watle St), "Already a site" (the address under another name: Book on Ray White Bayswater), "Same mobile" or "Same email" (theirs, under another name: Show them, never a one-tap Use, as agency and family numbers sit on one owner's record too), "Same name" (the name alone, only when nothing stronger shows and at most two clients have it), and "Shared number" or "Shared email", only ever beside another row: a shared number alone books on the first press. In New site for, "Already has this site" for an address the chosen client has, or one like it; another client holding it is not a row.
- **The words:** names, never pronouns; "mobile" for an 04 number, else "number"; "(archived)" or "(inactive)" after a name ("Use Sam Wu (inactive)"), and never by a possessive, where it would read as the number's or the site's: a sentence of its own after the line instead, "08 9272 1234 is Amy Lo’s number. Amy Lo is archived." (`tagSentence`), and a fix's label leaves it to its line ("Choose Sam Wu’s site"); "different name" or "different address" only for what was typed.
- **Each fix keeps what the caller said:** Book at or Book on chooses that site; Use {client} or New site for {client} makes a new site for them at the address typed (or books at theirs, if it is one); Add books the address as typed, and isn't asked about again; Show them opens the Property picker with the number typed, keyboard down, and the site or New site for chosen there is taken as Book at or New site for would be, only while that picker is open: shut with nothing chosen, or the client mode changed by hand, and a client chosen later is the person's own choice, with the address as they typed it there (`carryAfter`). What the caller gave that isn't the client's goes with the booking, visible and editable before Book: a business's new site gets them as its site contact (not its own name or one like it, nor its main number or a contact person's), and anything else gets a first line in Notes, "Caller: Tom Nguyen, 0499 888 777" (or "Caller’s number: …" when the name agrees), only where Notes have room. A later fix replaces that line rather than adding a second, and going back to the New client tab takes it off: the booking is the caller's own again. No fix changes the client's own phone or email, and the New client tab still holds what was typed.
- **Nothing moves under a thumb:** the panel comes in above Book, with match rows last, so the rows nearest a thumb that pressed Book are the ones whose tap only puts the cursor in a field; its fixes take no tap for 400 ms, and Book no press for 500 ms (`aria-disabled`, held pressed in by `HELD_BUTTON`), after it comes in or changes under a press, or after a fix; and after a fix, the rest of the form no tap for 400 ms, as after a line's (`useLineFixHold`).
- **Clients → New client** runs the same check, from the client list without waiting for it: a field left before the list is read has its line once it is, and a Save pressed before then waits for it, up to the 3 s any check is given. Its panel ends with where the rows were found, as New Job's does. Every fix is **Open {client}**: the sheet closes and theirs opens on Details, with Add property open on the address typed by the time it is tapped (brought into view as the sheet stops, at the foot of Details, and not focused), unless no street is typed yet, it is theirs already (`openAddSite`), or the row or line only shows who the caller may be (what New Job offers Show them for: their mobile or email under another name, a landline agreeing only by an initial), a row and a line alike, once (back to Details later, it is closed). A business's Add property has the site contact typed, else the caller, as its site contact, as New site for does in New Job. What else was typed, a new mobile, an ABN or a contact person not theirs say, isn't put on the client: no fix changes a client's own details. So New client keeps what was typed, to be opened again as it was, unless all of it went with the open or is the client's already (`openFromNewClient`): the caller may well be someone else, and is still on the phone. With no signal it is kept whenever an address went with the open (`keepsDraftAfterOpen`): their sheet is then the copy kept on the phone, which adds no site, so the address would be nowhere once it is closed. A site contact on an address like one of theirs hasn't gone with it, as Add property's Use {their site} adds nothing. Opened again on it, it says so above the fields, "Still filled in from before you opened Jane Nguyen." with Clear (`KeptDraftNote`), until it is cleared, saved or discarded, so the next caller is never saved with the last one's email unseen. **Add property** on a client's sheet says "Already has this site" for an address that is one of theirs or like one, with Use 12 Wattle St, which adds nothing and goes to that site. Editing an existing client's phone or email checks nothing: two clients sharing a number is not a new duplicate.

### Long lists

A list that can run to hundreds (the Job tab, the Clients page) is paged, never drawn whole: every card is one the phone lays out and hydrates.

- **The first page is in the page itself.** The loader warms it as a plain query (`jobsFirstPage`, `clientsFirstPage` in `routeQueries.ts`), the server renders it, and `usePagedList` hands over to Convex's paginator once that has caught up. A list already here in full (one person's newest 200 jobs, a search over the client directory) is drawn a step at a time with `useRevealMore`.
- **The next page loads as the end comes near,** a screen and a half ahead (`LoadMore`, `observeNear`), and a "Show more {things}" button is always below it: the way that works from a keyboard, a screen reader, or a browser that can't watch. While a page comes, its bones are `CardCells` inside the list's own grid (Notes, whose next page may open a new date section, puts `CardRows` after its sections instead), and the button says "Loading…" with `aria-disabled`, not `disabled`, so whoever pressed it keeps their place: the one running button that isn't `disabled` (4.1).
- **It stops loading by itself after eight pages** (`AUTO_LOAD_PAGES`). The button carries on, and a tap starts another eight: past that, someone is looking for something, and search is the faster way to it.
- **No signal pauses loading by itself;** the button still asks, and the page comes with the signal. A list that needs every client (a search, A–Z, a filter) and cannot get them says so with `LoadFailed` and Try again, never a placeholder left waiting. The Clients page's newest clients ask for nothing with the line down: their Show more gives way to a line saying more show with signal, and that search finds every client on the phone (States).
- **It says what it is doing:** "Loading more jobs" while a page comes (`role="status"`; `announce={false}` in a sheet), then "54 jobs showing", in a polite live region, once a load someone asked for has landed — never on every live change. The count is never a `status` region.
- **Empty means the whole list is empty.** `EmptyState` or `NoMatches` only once the list is done (`usePagedList`'s `empty`). A page can come back empty with more behind it (who sees what is applied after paging): it is asked past a few at a time, then left to Show more, never a placeholder waiting for good.
- **Counts are the whole book's, from the server** ("148 jobs", "1000+ jobs", digits as every count in the app), never how many have loaded.
- **Search and filters never search only what has loaded.** They run on the server or over the whole directory, and while that loads they say so, never "No matches".
- **Reports and Notes use the button alone, for now** (`auto={false}`).

### Filters and views

- **Two to four exclusive options** are a `Segmented`.
- **A longer single-select filter** in a header row is a `FilterDropdown`.
- **An active filter** is blue (`border-blue/30 bg-blue/12 text-blue`).
- **A review's filters are chips with counts** (an import's review, Match your clients): a `role="group"` of `aria-pressed` buttons, drawn 36px with `tap-target`, each with its count beside its word. A chip at 0 is hidden unless it is the one chosen, so the choices shrink as the work gets done, where a `Segmented` would keep an empty option on screen.
- **Views and filters live in the URL.**

### Reports

- **Something the app worked out** (the forecast, the start time) is marked "Suggested" until it is confirmed. A fact read off a record is not marked.
- **Locking is two acts.** "Finalise & lock" opens a read-back sheet first.
- **Locking emails it,** so the read-back sheet says who to and where the business's copy goes, and the finished report says whether it went (its Email list, `ReportEmails`, on the page Finalise lands on).
- **Who it goes to is chosen on the read-back sheet, not on the form** (`askedAtLock` in `delivery.ts`): the form's send-copy question and its address boxes are not shown on the form. The sheet's "Email it to" lists the client, ticked when the form would send them their copy, then their contacts by name and role, then anyone typed in, with an Add box (`RecipientPicker.tsx`, shared with the Send sheet: a row per person, and one box with the same rules). A tick is written into the form's own answers (the send-copy question for the client, the first address box for anyone else), so locking sends what it always did. An address in the form's box that can never be delivered to holds the lock there, with the address meant one tap away, and so does a box the form requires with nobody in it; the client's own address, if it can't receive email, is left out and said so. One typed and not added goes with the lock, and a near miss in the box makes the button "Finalise & lock anyway". A form with no box can only send the client theirs, and says the rest go from the report once it's locked.
- **A finished report is one page** (`reports/FinishedReport.tsx`), built like a job's sheet:
  - the header: "Report #12" (the number a client quotes), "‹ Reports", and a "⋯" for the rare acts (Issue a correction; Delete report, for the owner);
  - what it is: the form, the address, its Finalised or Sent pill (`ReportStatusPill size="page"`), client and day; then any notice (replaced, being corrected, a follow-up due);
  - Document (`ReportCover`): one card with View PDF (a drawn likeness of its first page, never a download) and Answers, then Send this report and Share under it;
  - Email (`ReportEmails`: each send in a line or two, how it went, Send again on one that did not go, the business's copy said once; tapping a send shows the whole email in a sheet), Details, and Activity (`ReportActivity`: the report's own history; its emails are only under Email). Not emailed yet, it offers the client in one tap ("Send to Jane Nguyen"), which opens the Send sheet with them chosen; never for an address that can't be delivered to, nor on a replaced report.
  - Answers opens on a "Jump to" select of its sections when there are three or more: the phone's own picker, which scales to a Timber form's dozen sections where chips did not.

  No tabs: they held a document, an action and a record, and a segmented control is for views of one thing. A report a correction has replaced still offers Send, but grey: the current version is the one to send.

- **Send offers people, not an empty box** (`suggestedRecipients` in `SendSheet.tsx`, its rows and box from `RecipientPicker.tsx`): whoever the form asked for, then the client from their record as it is now, both chosen; then the client's contacts by name and role, primary first, and anyone it already went to, not chosen. Nobody this report already reached, or is on its way to, is chosen again ("Sent {day}", "Sending now"); nor the client when the form's "send a copy" was answered No ("The form said no copy for the client"); nor anyone on a report a correction has replaced. Unchosen rows are an empty tick on the grey fill, never faded text. With nobody on file the address field is already open (no keyboard until tapped), and an address typed for a client with none on their record that can be delivered to can also be saved to it — offered under that address, never ticked for them, and saved only if the email went.
- **Share on the page** hands the PDF to the share sheet in one tap (`useReportHandOver`), or counts it down ("Preparing… 40%") and asks for "Tap to share" when the download outlived the tap, as the Products page does. Where the browser can't share files it is a download. The file goes alone, with its title: words shared beside it are saved as a stray `.txt` by "Save to Files" and AirDrop.
- **A report too big to email** goes as a copy with smaller photos. The lock and Send sheets say so before (`LARGE_FOR_EMAIL` in `lockEmail.ts`), and each email's sheet in the report's Email list after ("Photos made smaller to fit an email"). The email itself does not, so it invites no "can I have the full size?".
- **Locked boilerplate** sits in a grey inset (`bg-surface-2`) with a `Lock` glyph.
- **While client signatures are switched off** (`CLIENT_SIGNATURES_SHOWN`), a report being filled in has no client's pad and no client acknowledgment section, unless the client has already signed it, and nothing on screen asks for one. A locked report keeps whatever it was locked with.

### Xero

Settings → Xero (the owner, the business's organisation) and Settings → My Xero (everyone else, their own) are one page, `xero/XeroPage.tsx`, and each has a Match your clients page under it, `xero/MatchReview.tsx`, where syncing is started. A client's sheet says where that client is in Xero (`xero/ClientXeroLines.tsx`). Every word is in `xero/xeroCopy.ts`. _Added 6 Oct 2026; matching and syncing 15 Oct 2026; a contact another client has, 16 Oct 2026._

- **Connect Xero is a tap,** `NEUTRAL_BUTTON` (nothing is saved by pressing it): "Opening Xero…" while it waits, and an offline phone is told at once, before anything is asked of Xero. It goes to Xero's sign-in in the same window, never a pop-up. "Reconnect Xero" is the same button.
- **Two-step sign-in is suggested, not required** (_Amended 1 Nov 2026_; it was required until then). Without it, Connect Xero is offered as usual, and under it a caption line says why it helps ("Two-step sign-in keeps your account, and the clients it sends to Xero, safer.") with an inline blue link, "Turn on two-step sign-in", to Settings → Two-step sign-in. A suggestion never stands where the button goes. Where the deployment requires it (`XERO_TWO_STEP_REQUIRED=on`), the button's place holds why ("Connecting Xero here needs two-step sign-in on your account…") and a `LINK_BUTTON` to turn it on — never a Connect button the server would refuse.
- **What connecting shares is said before it is shared:** the caption above the button says every client is copied into the organisation chosen, with every change after that, and, on My Xero, that the copies stay in their Xero if they leave. The group's footer, under the button: "By connecting, you agree to PestM8’s terms and privacy policy", with both linked.
- **Xero sends the browser back to the page,** which finishes the connect ("Connecting to Xero…") and clears the address. A refusal or a cancel comes back as an amber `FormAlert`, worded from `xeroCopy.ts` by its code, never in Xero's own words.
- **Every state is designed:** loading (`SectionPending`); "Owners only" (with the switched variant, as the Recycle bin has it); the owner on My Xero, pointed to Business → Xero; switched on My Xero, told to switch back; "Xero isn’t set up here" (a deployment with no Xero app, where the hub shows no Xero rows either); the demo business, which can't connect; not connected; connecting; connected (the organisation, "Connected", who connected it and when); and needs reconnecting, an amber line over Reconnect Xero. When Xero couldn't be told about a disconnect, a caption says to remove PestM8 in Xero → Settings → Connected apps.
- **Disconnect** is the last `DangerGroup` row, through `ConfirmDialog`: "Disconnect Xero?" / "PestM8 stops sending changes to {org}. Contacts already in Xero stay there." / "Disconnect" / "Keep Xero".
- **Team → a member** shows the owner that member's Xero, read-only: "Not connected", "{Org} · Connected" or an amber "Reconnect needed". Only the member connects or disconnects it. Removing a member who has one says it is disconnected and that what was copied stays in their Xero.
- **Connected, the page reads Xero's contacts first:** "Reading the contacts in {org}…", with "It carries on if you leave this page." under it and the spinner in its row as Connecting has it, until the match is ready. Then a group, "Your clients in Xero", of counts, one row per list on the match page with the same numbers as its chips: Matched, Shared contact (only when there are some), To check, New to Xero, Different (only when there are some), and Leads waiting with its caption, "Added once their first job is booked" (only when there are some). A `SettingsLinkRow`, "Match your clients", opens the page, carrying an amber `RowBadge`, "{n} to check", while there are any. Until syncing starts, the footer says why it is worth doing before anything is sent ("PestM8 doesn’t send anything to Xero yet. Checking these now means Xero is ready when it does."), and a quiet "Check Xero again" sits at its end.
- **A match that failed** is an amber line, `role="alert"`, worded by `matchProblemCopy` from its code, over what can help: Check Xero again (`NEUTRAL_BUTTON_COMPACT`: nothing is saved by it, and an offline phone is told at once); "Reconnect Xero" (a `LINK_BUTTON` to the Xero page) on the match page when the connection needs reconnecting first, since the server would refuse a check; or nothing, when trying again can't help (more than 50,000 contacts, or PestM8's Xero work paused). A read still "reading" after the time `xero.status` gives (`staleAfter`) belongs to a run that died, and is shown as stopped, with Check Xero again; a connection never read (connected before matching existed) is offered Check Xero again too.
- **Start syncing** is the match page's commit, the one `PRIMARY_BUTTON` on it, in a bar pinned to the foot of the list (`BottomBar`, from `clients/import/ui.tsx`, where an import's review has its Import button). Nothing reaches an organisation before it, and what it adds can't be taken out of Xero, so it asks first, in `ConfirmDialog`: "Start syncing with Xero?" / how many clients it adds to {org} and how many it matched get their blanks filled in, that those to check wait until they are decided, and "Contacts added to Xero stay there, even if you disconnect." (`startSyncingBody`) / "Start syncing" / "Not yet". An offline phone is told at once. A match more than 7 days old is refused (`MATCH_STALE`), so the bar offers Check Xero again first. Once started, the bar gives way to "Syncing since {when}", To check cards still answer (an answer is now sent, like any other change), and Check Xero again is gone: the server refuses it (`SYNC_STARTED`).
- **Syncing, the Xero page says where the organisation stands,** in "Your clients in Xero", a row a count, the server's own (`xeroSyncState.counts`): In Xero; To check, Different in Xero and Not sent, each amber while above 0, Different in Xero then with "Xero kept its own — open the client" under it (`DIFFERENT_CAPTION`, the client's sheet offering Send PestM8’s details) and Not sent with "Refused by Xero — see Recent problems" (`NOT_SENT_CAPTION`) — a row's caption is one line, cut rather than wrapped, so each fits a phone; Waiting to send (99+ past 99); and Last sent (`formatWhen`). Match your clients stays, with its "{n} to check" badge. While the first sync is adding the book, its first row is "Adding your clients…" with a `BarMeter`, and under it "{n} of {total} in Xero. It carries on if you leave this page." (`backfillCopy`: the matched ones are in Xero already, so the count starts with them). The footer says "Syncing since {when}. PestM8 sends each change to {org} as it’s made, and never deletes or archives anything there."
- **What holds sending up is an amber line at the top of that group,** saying when it carries on, with no button: nothing the person does would help, and nothing is lost. A pause or hold that has run out is cleared on the server the moment it ends (`xeroSync.clearLapsed`), so a full load never draws one only to remove it once hydrated. Xero's daily limit used up ("Xero’s daily limit for {org} is used up. PestM8 carries on {when}, and changes wait here till then."), Xero not answering properly, adding the rest of the book held to leave the day's calls for live changes ("Changes you make still go."), and the kill switch ("Sending to Xero is paused. Changes wait here."). A pause of a minute or so has no line. Every word is in `xeroCopy.ts` (`pauseCopy`, `backfillHeldCopy`, `SYNC_PAUSED`).
- **Recent problems** lists the newest five problems that still stand, one per client — one put right since (the client corrected and sent) goes by itself. Each row says "Could not add {client}", "Could not update {client}" for one in Xero already, or just the client's name for something only left off a contact Xero took (`problemHeading`), then why in amber, in words that say what to do (`syncProblemCopy`: "Xero refused the email address. Correct it on the client, and PestM8 sends it again."), never in Xero's own words. Someone who can't change clients (a subcontractor on My Xero) is told to ask the business owner instead (`syncProblemCopy`'s `canEdit`). A row opens the client's sheet over the page. With more than five, its footer says "The newest 5 of {n}." (`recentFooterCopy`). It is absent when there are none.
- **The hub's Xero row** carries one amber badge, the one that matters most: "Reconnect", else "{n} to check", else "{n} different" (syncing, when Xero holds something other than what PestM8 sent). One badge to a row.
- **Match your clients** is built like an import's review (`clients/import/ReviewStep.tsx`): it says when Xero was read, then chips "To check", "Matched", "Shared contact", "New to Xero" and "Different", each with its count, a chip at 0 hidden unless it is the one chosen; a line under them saying what the list is; 100 rows, then "Show {n} more" with "of {left}" muted beside it (`SECONDARY_BUTTON`). It has the Xero page's states — loading, "Owners only", the owner on My Xero and switched on My Xero, not set up here, the demo business, not connected — plus `LoadFailed` for a list that didn't load and a title for each empty chip ("Nothing to check").
  - **A card to check** puts the PestM8 client (name, number, phone, suburb) above the Xero contact (name, email, phone, place, account number), so the two read down the card. One line in `grey-ink` says why they were paired ("Same email, different name"), and a `Segmented kind="choice"` answers: "Same client" or "Different client", both in `ink-2` until one is chosen, and only a tap, Space or Enter chooses — the arrow keys just move between them. It saves the moment it is chosen, like a switch — no Save — disabled until hydrated and failing fast offline. A refusal is an amber `FormAlert` in the card, worded by its code (`DECIDE_ERROR_COPY`). Answered, the card stays where it was, saying what was saved ("Saved — {client} is “{contact}” in Xero.", or that PestM8 will add them as a new contact and that Match again is under Different), until the list is left: moving it would slide the next card's answer under the same thumb.
  - **A card whose contact is already another client's** (the item's `heldBy`; below, {B} is the card's client and {A} the one with the contact) is a question, not a dead end: Same could only be refused, so it isn't offered. Under the Xero contact, a grey inset (`rounded-xl bg-surface-2`, never amber: nothing is wrong yet) says who has it — "In PestM8, “{contact}” is already {A}" in `ink` — over {A}'s line in `ink-2` ("#12 · Nightcliff · jan@example.com · 0412 345 678"), so the two clients are compared without leaving the card. The reason line follows, as on any card. In the choice's place, a `role="group"` asking "Is {B} the same customer as {A}?": two buttons, side by side when both fit and one above the other when they don't (`flex-wrap`: at half a phone's width "Different customers" would wrap inside its button), **Different customers** (`NEUTRAL_BUTTON_COMPACT`: ink, since the page's one red is Start syncing — the one-tap answer §4.1 allows it for, taken back by Match again), which saves on one tap as Different client does, and **Same customer…** (`SECONDARY_BUTTON_COMPACT`), whose `…` says it asks more before anything is saved, opening the Same customer sheet; under them, full width, **Open {B}** (`LINK_BUTTON_COMPACT`, `openClientLabel`, for everyone: it opens the sheet's read view, whose own Edit is for whoever may change clients), which opens {B}'s client sheet over the page, for when {B}'s details are what made the two look alike (an agency's office email on a tenant). Editing answers nothing: the card waits. Answered, the buttons stay where they were, disabled, so the card keeps its height under the thumb, and the line under them says what was saved (`heldOutcomeCopy`): "Saved — {B} uses {A}’s contact in Xero, and its own changes aren’t sent. Unlink is under Shared contact.", "Saved — {B} is “{contact}” in Xero. PestM8 will add {A} as a contact of its own.", "Merged — {B}’s sites, jobs and notes are {A}’s now, and {B} is in the Recycle bin." (Open disabled with it: {B} is in the bin), or Different's own. A card without `heldBy` is as above; Same refused there (`CONTACT_TAKEN`) means another client took the contact after the page opened, and says to reload.
  - **The Same customer sheet** (`xero/SameCustomerSheet.tsx`, a `Sheet`) is titled "{B} and {A} are the same customer" and offers three ways. Each is a row-card, a bordered `bg-surface` button at least 56px tall: what it does in semibold `ink`, one line in `ink-2` under it saying what that means, and a chevron, as any row that leads on — a spinner in its place, and "Saving…" for its line, while it saves. Choosing is not a guess, as in `StatusPicker`:
    1. **Merge {B} into {A}** — "2 sites, 14 jobs, 3 notes and 1 contact move to {A}; {B} goes to the Recycle bin. Xero keeps {A}’s contact." (`mergeOptionCopy`, counted by `clientMerge.mergePreview`; "Its sites, jobs and notes move to {A}; …" until the count comes, so the row is never waiting on it), then a sentence for each organisation where {B} is a contact of its own (`mergeXeroLines`): "In {org}, {A} takes over {B}’s contact." where {A} has none there, or "{B}’s own contact in {org} stays in Xero." where {A} has its own. It asks first, in `ConfirmDialog`: "Merge {B} into {A}?" / what moves, that {B} goes to the Recycle bin, "This can’t be undone.", and what happens in Xero (`mergeConfirmBody`) / "Merge" / "Don’t merge" (`MERGE_CANCEL`: never "Keep both", which is the sheet's second answer and would read as choosing it). Only someone with `clients.manage` (`useCan`) is offered it: for anyone else (a subcontractor on My Xero) the same card, its words in `ink-2`, is not a button, and its line says "Only the owner or a contractor can merge clients." (`MERGE_NOT_YOURS`) — never a button the server would refuse. The same when the preview has already refused the merge for a reason that will stand (`mergeUnavailableCopy`): too big to move at once, a business into a person ("{B} is a business with contact people, an ABN or an office address, which {A} — a person — can’t show. Make {A} a business first."), or one of them changed since the page opened.
    2. **Keep both, use {A}’s Xero contact** — "{B} stays in PestM8; its changes aren’t sent to Xero." Saved on the tap, with no confirm, like Same and Different: Unlink under Shared contact takes it back.
    3. **{A} is the wrong match — give this contact to {B}** — "{A} gets a contact of its own." It asks first: "Give “{contact}” to {B}?" / "{A} is unlinked and PestM8 adds it as its own contact." / "Give it" / "Keep matched" — the buttons without the names, which ran to three lines in a dialog's shared row. It moves a match someone made.

    Each fails fast offline. A refusal is amber and worded by its code, never the server's words: Keep both's in a `FormAlert` in the sheet (`shareErrorCopy`), Merge's and Give's in their confirm, which stays open to say it (`mergeErrorCopy`, `giveErrorCopy`: too big to merge or a business into a person — each naming the sheet's "Keep both, use {A}’s Xero contact" as the way on, by that name — already merged, {A} no longer has the contact, another client took it meanwhile, not theirs to change, switched, offline). Done, the sheet closes, focus goes to the card, and the card says what was saved.

  - **Shared contact** lists the clients kept on another's contact, each a row: the name and number, then "Uses {A}’s contact, “{contact}”", and **Unlink** (`SECONDARY_BUTTON_COMPACT`), asked first, in `ConfirmDialog`: "Unlink {B}?" / "PestM8 will add {B} to Xero as a contact of its own, instead of using {A}’s. You can match them again from Different." (`unlinkSharedBody`) / "Unlink" / "Keep shared". A client whose {A} has since let the contact go isn't here: it is back under To check, its reason saying so (`matchReasonCopy`: "Shared {A}’s contact, which {A} no longer has" when the item names {A}, else "Shared another client’s contact, which that client no longer has").
  - **A matched row** says `Is “{Xero name}” in Xero`, with " · Matched by you" when the person looking chose it (" · Matched by hand" when whoever held the organisation before did), and " · Added by PestM8" for a contact PestM8 added once syncing — which has no Unlink: unlinking it would only add the client a second time. **Unlink** (`SECONDARY_BUTTON_COMPACT`) asks first, in `ConfirmDialog`: "Unlink {client}?" / "PestM8 will add {client} to Xero as a new contact instead. You can match them again from Different." / "Unlink" / "Keep matched".
  - **New to Xero** is a plain list, read-only: name, number, suburb. **Different** adds which contact it isn't ("Not “{contact}” in Xero") and **Match again** (`SECONDARY_BUTTON_COMPACT`, no confirm: it decides nothing), which puts the client back under To check against the same contact. Every answer on the page can be taken back from the list it went to, but Merge, whose confirm says it can't be undone.
  - **Until Start syncing, nothing on it reaches Xero:** its words say what an answer will mean when syncing starts, never that something was sent or changed in Xero. After it, an answer is sent like any other change (Same fills in blanks on that contact, Different adds a new one), and what a saved card says is what is happening, not what would. _Amended 15 Oct 2026._ Merge is the exception: it changes the client book at once, before Start syncing as after, so its words say what it does in PestM8 (what moves, and that {B} goes to the Recycle bin) and only then what happens in Xero.
- **A client's sheet has a Xero line** (`ClientXeroLines`, in Details after Company address): one `DetailRow` per organisation the person looking holds — the business's for the owner, their own for a member — labelled "Xero", or "Xero · {org}" when there are two; with one, the organisation goes in the line under the value. None at all where Xero isn't set up or nothing is connected, nor when the question can't be answered: a row that only says it couldn't load would be noise in someone's client. A warning goes in the row's `below`, in amber, with what can be done about it under it — or, for someone who can't change clients, who to ask. Before Start syncing, a client the match found in Xero already reads In Xero (no "sent"), and one to check To check. The states:

| State                       | Value                    | Under it                                                                                                                                                                                 |
| --------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| In Xero                     | In Xero                  | "sent {when}"; Open in Xero                                                                                                                                                              |
| Waiting                     | Waiting to send          | Open in Xero, once the contact exists                                                                                                                                                    |
| Lead                        | Lead                     | "Added to Xero when first booked"                                                                                                                                                        |
| To check                    | To check                 | Amber: "Xero already has “{contact}”. Decide in Settings → Xero." (or "Xero may already have {client}. …"), and Match your clients                                                       |
| Different                   | Different in Xero        | Amber: "Xero’s {email address} for {client} is different, so PestM8 left Xero’s alone." (`differentCopy`: "are" for several, or for contact people); Send PestM8’s details; Open in Xero |
| Archived in Xero            | Archived in Xero         | "PestM8 no longer sends its changes there"; Open in Xero                                                                                                                                 |
| Held for privacy            | Removed in Xero          | "For privacy, so PestM8 won’t send it again"                                                                                                                                             |
| Failed                      | Not sent                 | Amber: why, from `syncProblemCopy`; Open in Xero                                                                                                                                         |
| Shared                      | In Xero as {A}’s contact | "{org} · its own changes aren’t sent" ({A}'s are); Open in Xero. "another client’s" when the person looking can't see {A} (a contractor outside their team)                              |
| Not in Xero, nothing queued | Not in Xero yet          | —                                                                                                                                                                                        |

- **Send PestM8’s details** (`SECONDARY_BUTTON_COMPACT`) replaces what someone typed into the books, and nothing in PestM8 can put it back, so it asks first, in `ConfirmDialog`: "Send PestM8’s details to Xero?" / "{org} takes PestM8’s {email address} for {client} in place of its own. This can’t be undone from PestM8." / "Send" / "Keep Xero’s". It fails fast offline, and isn't offered while switched into someone else's account, or when a field on the row was cleared in PestM8 (nothing blank is sent to Xero, so the confirm couldn't be kept). Once sent, the row moves to Waiting by itself.
- **Open in Xero** is a hold, like Map (Hold to act): a `HoldButton` drawn as `LINK_BUTTON_COMPACT` with an `ExternalLink` glyph, hinting "Hold to open Xero", that opens the contact in a new tab, signed in to the right organisation — never this window, which would unload the installed app. Where the browser refuses the tab, it becomes a plain "Open" link for a few seconds, as Map's does. It opens only Xero's own pages, and only when PestM8 knows the contact and the organisation's short code.
- **An import's Undo says what stays in Xero:** when some of its clients are already in Xero, its `ConfirmDialog` adds "{n} of these clients are already in Xero and stay there." (`importNoteCopy`). Undo takes them out of PestM8, never out of Xero.
- **A client merged into another** (from the Same customer sheet) is in the Recycle bin as "Client · Merged into {A} — its sites and jobs are there now", and "Merged {when} by {who}" in place of who deleted it. It has no Restore: its sites and jobs are {A}'s now, and it would come back an empty duplicate of {A}. Nor has a site or contact person of it already in the bin, whose line names its client as "{B}, merged into {A}", nor a job or recurring service deleted on its own at such a site, whose line ends "its property went with a client merged into {A}" — never "restore the property first", which can't be done. A list opened before the merge that still offers Restore is refused in words ("Could not restore: it was merged into another client, and its sites and jobs are there now."). Delete now, and the 30 days, work as for anything else there. _Added 16 Oct 2026._

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
- Escape closes what it opened, and focus returns to what opened it. A sheet with unsaved changes asks first.

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

**Segmented** is a `tablist` or a `radiogroup`, with roving tabindex and arrow keys. Use the component, not buttons in a row. The caption above it names it (`labelledBy`); with none on screen, `label` does, and each segment is named by its own words. With nothing chosen yet, the arrows only move between the segments and Space, Enter or a tap chooses, so a question that saves on its answer is never answered by a key pressed to look.

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
- **Use the product's nouns:** client, job, property, site, report, template, technician, team, licence, insurance. Don't introduce synonyms (customer, visit, worker). A person's licences and insurance policies are one list, called "Licences & insurance". One exception: "customer" is the person or business behind a client record, used only where two records may be one of them — "Same customer", "Different customers" on a Xero card — since two clients can't be "the same client".

### Case and labels

- **Sentence case everywhere:** titles, buttons, labels ("Report settings", "Add a client"). The capitals in a `section-label` come from CSS, so type its words in sentence case.
- **Buttons are verbs.** Use "Book a job", "Send this report", "Clear filters". Not "OK", "Submit", "Yes" or "Retry". Say "Try again" for a retry and "Done" to dismiss a sheet.
- **Icons, not typed symbols.** A leading "+" in a label is the `Plus` icon, and a trailing "›" is `ChevronRight`.
- **A comparison is answered with what the two are,** not Yes and No: "Same client" / "Different client", or "Different customers" / "Same customer…" where the contact is another client's already. Its reason names what agreed and what didn't, in that order: "Same email, different name", "Same account number, different name", "Same name", "Same name — Xero has more than one contact by this name"; and for a caller who may be a client already, "Same name and mobile", "Similar name, same mobile", "Same address, different name" (a name agreeing only as an initial, or a business's shorter name, is "similar", never "same").

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
| `formatUpdated`                         | "9:42am", or "Sun 25 Oct, 9:42am" on another day                     |
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

| Concept                           | Icon                                                                              |
| --------------------------------- | --------------------------------------------------------------------------------- |
| Add                               | `Plus` (`ImagePlus` for a photo)                                                  |
| Edit                              | `Pencil`                                                                          |
| Sign, annotate, mark up           | `PenLine`                                                                         |
| Delete / remove                   | `Trash2`                                                                          |
| Close, dismiss, clear a search    | `X`                                                                               |
| Back / forward                    | `ChevronLeft` / `ChevronRight`                                                    |
| Open a menu of more               | `Ellipsis`                                                                        |
| Search                            | `Search`                                                                          |
| Share                             | `Share` (the iOS glyph)                                                           |
| Send                              | `Send`                                                                            |
| Call / Text / Email / Map         | `Phone` / `MessageSquareText` / `Mail` / `MapPin` (only through `ContactButtons`) |
| Warning                           | `TriangleAlert`                                                                   |
| Info                              | `Info`                                                                            |
| Done, selected                    | `Check`                                                                           |
| Finalised, locked                 | `Lock` (only this: a locked report, locked boilerplate, a password PDF)           |
| Undo, restore, try again          | `RotateCcw`                                                                       |
| A correction of a report          | `FilePenLine`                                                                     |
| Replace, regenerate, reload       | `RefreshCw`                                                                       |
| Recurring                         | `Repeat` (ink, not blue)                                                          |
| Photo                             | `Camera` (take), `ImageIcon` (library)                                            |
| Report, document                  | `FileText`                                                                        |
| Offline                           | `WifiOff`                                                                         |
| Open elsewhere                    | `ExternalLink`                                                                    |
| Loading                           | `LoaderCircle` with `animate-spin`                                                |
| Client (residential / commercial) | `House` / `Building2`; the Clients tab is `Contact`                               |
| Team, people in the business      | `Users`                                                                           |
| Personal (only you can see it)    | `EyeOff`                                                                          |
| Primary, cover, "the usual"       | `Star`                                                                            |

---

## 9. Dark mode and printed surfaces

**Dark mode is the tokens' job.**

- Nothing under `src/` uses the `dark:` variant **(lint)**.
- A component that looks right in light with tokens looks right in dark.
- If it doesn't, a token is wrong. Fix it in `styles.css` for both themes, not in the component.

**Check both themes.** `pnpm ui:shots` renders every specimen light and dark.

**Printed things stay light:**

- The report preview pins `data-theme="light"` so it matches the PDF.
- A finished report's **Answers** (`ReportDocument` with `variant="answers"`) is not a preview: it is what was recorded, in the app's type and theme, with its questions in sentence case rather than grey capitals. The PDF, a tap away, is the paper.
- A signature pad and a PDF page are `bg-paper` in both themes, because what is drawn on them is for paper.

**The PDF is its own design system.**

- `src/components/reports/pdf/` renders with `@react-pdf/renderer`, which can't read CSS variables. It keeps its own hex palette in `pdf/theme.ts`, mirroring the tokens: its red is `--red-fill` (`#DC2A1F`), because the band and table header put white text on it.
- If you change a token that the PDF shows, change `theme.ts` with it.
- The report preview (`ReportDocument.tsx`, `onboarding/ReportPreview.tsx`) mirrors the PDF. Its lint exceptions carry a comment saying why.

**Canvas drawing** (a signature, an annotation, a markup pen) sets its stroke colour in code. Use the token's value and name the token in a comment.

**A business's logo is shown on what it will be seen on.** In Settings (`settings/LetterheadLogos.tsx`) the logo sits on `bg-paper`, pinned light, and its optional light-lettered version on the dark email's card (`bg-surface`, pinned dark). Without that version, its tile shows what a dark email does instead: the logo on its white card.

**Emails have a dark mode of their own** (`convex/lib/emailTheme.ts`):

- Every colour is written inline, in light. That is the whole email wherever a `<style>` block is dropped.
- One `<style>` block overrides them where a mail app follows `prefers-color-scheme` (Apple Mail, Outlook for Mac and phones) or marks what it recolours (`[data-ogsb]`, Outlook.com). Its dark values mirror the dark tokens.
- The Gmail app and Outlook for Windows invert colours themselves and never images, so a logo travels on its own white card (`convex/lib/businessLogo.ts`), and a light-lettered logo is swapped in only where the dark styling is read.

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
- **Long lists load as you scroll, with Show more always there.** The Job tab and the Clients page load 24 and 30 at a time as the end comes near, eight pages at most by themselves; the button is always below, and a search, a filter or a count covers the whole book, never just what has loaded. Reports and Notes keep the button alone for now. _Added 6 Oct 2026._
- **Hold to act** is used for anything that reaches a client or leaves the app. _Amended 6 Oct 2026:_ a deliberate hand-over to another service’s sign-in on a Settings page (Connect Xero) is a tap; Open in Xero stays a hold.
- **Filters:** binary and ternary filters use `Segmented`, never a dropdown.
- **The report builder** opens on an overview and fills one section at a time, with the section in the URL. A list of more than 12 options opens a picker sheet.
- **Send names who it is for.** The client from their record as it is now (not as the document printed it) and anyone the form asked for are chosen; contacts are offered by role; nobody who already has this report, or is about to, is chosen again; an explicit "no copy for the client" on the form is kept. Saving a typed address to the client's record is offered unticked. An address typed and not yet added goes with Send, and Send counts it; a comma or a semicolon typed after one finishes it, as Add does, and a pasted list goes in whole only when every address in it is ready. One that can't be delivered holds Send until it is put right; one that asks "Did you mean…?", or whose domain takes no mail, holds it once, and Send then says "anyway". _Added 1 Oct 2026; typed addresses 2 Oct._
- **The form doesn't ask who to email; the sheet that locks it does.** One picker, with the client and their contacts named, where the form had asked in three places and its last box read as the way to send the client their copy. Unticked, an address is taken off before anything is sent, and stays listed to be ticked again. _3 Oct 2026; the same day the box's note said who it was for, before the box moved._
- **Report emails need no owner's approval.** Anyone who may send a report may send it anywhere that can receive email. An address not on the client's record is pointed out, never held: "Not on the client’s record" in the Send sheet, "check it’s right" on the lock sheet, and "Wasn’t on the client’s record" in the report's Email list. Every email, and how it went, is in the finished report's Email list, and every act on it in its Activity.
- **No email asks for a reply.** The report email says the PDF is attached and stops. Account email says replies aren't read, and gives no address to ask instead. Never add "Reply to this email if…", "Need help? Email…" or "Get in touch": each question it invites is work for the business.
- **Only the owner deletes a finalised report,** and it waits in Deleted for 30 days like a draft. Every version of its number goes with it, the confirm says anything already emailed stays sent, and it points a report that is only wrong at "Issue a correction" instead. _Amended 30 Sept 2026:_ a finalised report could not be deleted at all.
- **Finalising** is a read-back sheet, not a hold. Its button is never greyed for an incomplete report, because pressing it is how you find out what is missing.
- **Dates** come from the business's day key, not the device's clock, and cards never say "Today" or "Tomorrow".
- **Hidden prices** show "—".
- **New Job opens with nothing chosen:** it asks rather than guesses.
- **Pickers open on "Added recently"** (the newest clients added by hand, up to eight, from the last 90 days, each with its day), then everyone A–Z. Imported clients go straight into the A–Z list. The Clients page lists newest first, with A–Z a tap away.
- **Client numbers are given automatically** from a running count, so none is ever given out twice. Only the owner changes one, to match another system; everyone else sees it read-only.
- **A status is changed by tapping its pill,** for a job and for a client alike (`StatusPicker`), and a choice saves at once. A lead becomes Active when their first job is booked; Inactive is only ever chosen, and offers to stop the client's recurring services.
- **Notes are personal by default,** and each one says who can see it.
- **A job's notes are notes in Notes,** in one card straight after the job's property: "Before you arrive" (the site's and the client's notes, pinned first), then "This visit", then earlier visits' a tap away, with "+ Visit note" and "+ Site note" at its foot (`notes/JobNotesSection`). A note typed in New Job becomes the visit's note, the first visit's for a series; what every visit needs is a site note. A job note is read by whoever can see the job, and says which visit it is on wherever else it is listed. _Amended 30 Sept 2026:_ it was briefly plain text on the job, in a box of its own.
- **A job's sheet reads in the order of a visit.** Under the title, who is going and how often it repeats, and why it can't be edited when it can't. Then Property, Notes, Report & photos (this visit's report and its photos, in one card), Details (price, work order, repeats with the next visit, weather: one row each) and History. History is the address's visits before today: the card shows what happened (the last visit for this job's services first), each visit with its report under it, then the address's other reports and a way to all of them in Reports; "See all" has every earlier visit, cancelled and never-closed ones too. A visit to come, or a projection nobody booked, is never history, unless a report was written on it. _Amended 30 Sept 2026:_ price, work order and repeats each took a card, and "Other visits at this property" showed the furthest projections.
- **A client's sheet is a summary and three tabs.** Under the name: the status, Call/Text/Email, then next visit, last visit, and services and reports, and "Book a job for this client" (New Job over the sheet, their site chosen and a date to pick). Then Jobs (coming up; each recurring service one row that opens to what is to book, coming and done; one-off jobs by year, ten at a time; each visit with its reports; the rest of their reports last), Notes (Before you arrive for each site, About this client, From visits) and Details (number, ABN, contacts, properties, Delete). A contact or property being typed holds the tabs still. _Amended 30 Sept 2026:_ it was one long page, the history projected six months ahead before anything that had happened.
- **The Recurring Job page is by service:** one card per running service (whose, where, how often, who does it, when next or next due, how many ahead, how many to book), services with visits to book first, each opening to its visits; a visit opens its job on the page. "By date" keeps the list of visits. A service with nothing in the next six months still has its card. _Amended 30 Sept 2026:_ it was a card per visit, 127 cards for three services.
- **A report started from Reports asks which visit it is for,** today's first, then the most recent that happened; "Not for a visit" is always there. Its date, technician and weather come from the visit, and a report's visit can't be changed afterwards.
- **A note is deleted where it is read.** Open, on a job or a client, it offers "Delete note" to whoever wrote it and to the owner; it asks first, and the note goes to Recently deleted in Notes for 30 days. A note made with "+" and closed with nothing in it is cleared away, never left as an empty "New note".
- **A job can be for several services** ("General Pest Control, Termite Inspection, Rodents"). New Job starts with none ticked and asks, as it does for the client: with picking now adding rather than replacing, a default would be booked alongside whatever was picked.
- **A job can be for more than one person.** "Assigned to" is its lead, whose colour it carries and whose name a report starts with (unless someone else on the job writes it); "Also going" lists the others, set in the job's edit form and behind "Add someone else" in New Job. Everyone on a job sees it on their own schedule, with its notes, photos and reports, and may do on it whatever its lead may. The Schedule's card, which usually leaves the name to the rail, names everyone on a shared job ("Technicians"), each dot kept with its name; the week's block has two initials at most ("T +3" past two). Removing someone says how many jobs ahead they come off. A shared job counts in each person's own numbers and once in totals. _Added 30 Sept 2026;_ a repeating service's visits take people one visit at a time, for now.
- **A job's time is a start and an end,** each picked as a time of day (`schedule/JobTimeFields.tsx`, in New Job and a job's edit form), with the job said back under them as its card shows it: "9:00am – 1:30pm · 4 hr 30 min". The end follows the start, keeping the job's length, until it is set by hand, and then stays where it was put. A job ends on the day it starts: an end that isn't after the start is refused at Book or Save, saying so under the two. _Amended 25 Oct 2026,_ at a customer's ask: the length was a Minutes box, and a job of a few hours had to be worked out in minutes.
- **Job types are the owner's own list** (Settings → Job types), A–Z in New Job's picker, each with the report it produces. Deleting one only stops it being offered: every job keeps it, and "Offer again" brings it back. A rename changes it on every job and repeating service, finished ones included, and says so before it is saved; renaming onto a name the list has is a merge, asked first. A service typed into New Job is used on that job only ("Use … on this job only") and waits under "Typed into jobs" for the owner to swap or add. _Amended 30 Sept 2026:_ the list was nine names fixed in the app.
- **PDFs** open in the in-app viewer, never in Safari and never as a forced download.
- **A finalised report is one page, not tabs** (see Reports in section 5): its header, what it is, the PDF with Send and Share, Answers a tap away (following the theme), then Email, Details and Activity. The PDF and the Answers each open over it with the address saying so (`?view=pdf`, `?view=answers`), so Back closes them. The viewer's own Send closes the viewer and opens the Send sheet, because a sheet sits under it. _Amended 30 Sept 2026:_ it was four tabs, Form, PDF, Email and Logs, on a page with no header.
- **Every connected Xero gets every client.** The business's own organisation (the owner connects it, Settings → Xero) and each contractor's or subcontractor's own (Settings → My Xero) receive the whole client book's contacts and every change after that. Leads wait until their first job is booked, nothing in the Recycle bin is sent, and PestM8 never deletes or archives anything in Xero. The owner sees a member's Xero read-only and can't disconnect it; removing the member does, and what was copied stays in their Xero. The connect page says so before Xero's sign-in. _Added 6 Oct 2026;_ Release 1 connects, Release 2 matches what each organisation already has, and nothing is sent until Start syncing (Release 3).
- **A client is matched to a Xero contact only on strong evidence:** the same account number with the same name or email, or the same name with an email only that contact has. Anything less is put to whoever connected the organisation, as Same client or Different client, and their answer stands through every later match until they take it back (Unlink, Match again). The answers are the organisation's: whoever connects it next in the business finds them. Xero contacts can't be deleted, so a wrong match, or a duplicate, would stay in someone's books. _Added 15 Oct 2026._
- **A Xero contact another client already has is a question with answers, not a refusal.** The card says who has it and offers Different customers in one tap, or Same customer: merge the two clients, keep both on the one contact (only the client holding it is sent), or give the contact to this one. Merge is offered beside sharing, not instead of it: some customers are kept as two records on purpose. Nothing is settled automatically, the eight left on prod on 15 Oct included. _Added 16 Oct 2026;_ the card had said "Could not match them" and pointed elsewhere.
- **A report email heads with the business's logo as it is now;** the attached PDF keeps the logo its report was locked with. Account emails carry PestM8's own mark, never a business's: a login can belong to more than one.
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

- An off-scale text size (`text-[13px]`, `[14px]`, `[15px]`, `[21px]`…): use `text-caption`, `text-body`, `text-sheet-title` **(lint)**. See 2.3.
- A press scale other than `.975`, `.95`, `.97`, `.99` **(lint)**.
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
- A `Segmented` inside a `<label>`, or inside a sheet's `Field` or `WrappedField`, which render one **(lint)**. Its caption is a `<span id>` beside it, passed as `labelledBy`.

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
