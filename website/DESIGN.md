---
name: antigravity-booster docs
description: The flight director's console for Antigravity agent fleets.
colors:
  console-white: "#f8f9fc"
  panel-white: "#ffffff"
  panel-raised: "#eff2f7"
  rule-grey: "#e1e6ec"
  instrument-ink: "#121317"
  readout-grey: "#45474d"
  caption-grey: "#5b5e66"
  go-blue: "#3279f9"
  link-blue: "#1f63d6"
  night-console: "#121317"
  night-panel: "#18191d"
  night-raised: "#212226"
  night-rule: "#2f3034"
  night-ink: "#e6eaf0"
  night-readout: "#b2bbc5"
  night-link: "#7ea8ff"
typography:
  display:
    fontFamily: "Google Sans Flex Variable, Google Sans Flex, system-ui, sans-serif"
    fontSize: "3.5rem"
    fontWeight: 450
    lineHeight: 1.02
    letterSpacing: "-0.035em"
  headline:
    fontFamily: "Google Sans Flex Variable, Google Sans Flex, system-ui, sans-serif"
    fontSize: "2rem"
    fontWeight: 500
    lineHeight: 1.1
    letterSpacing: "-0.02em"
  title:
    fontFamily: "Google Sans Flex Variable, Google Sans Flex, system-ui, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: "-0.005em"
  body:
    fontFamily: "Google Sans Flex Variable, Google Sans Flex, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.65
    letterSpacing: "0.01em"
  label:
    fontFamily: "Google Sans Code Variable, Google Sans Code, ui-monospace, monospace"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: "0.06em"
rounded:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  pill: "9999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "36px"
  2xl: "48px"
  3xl: "80px"
components:
  button-primary:
    backgroundColor: "{colors.instrument-ink}"
    textColor: "{colors.console-white}"
    rounded: "{rounded.pill}"
    padding: "10px 20px"
  button-primary-hover:
    backgroundColor: "#2f3034"
  button-secondary:
    backgroundColor: "{colors.panel-raised}"
    textColor: "{colors.instrument-ink}"
    rounded: "{rounded.pill}"
    padding: "10px 20px"
  command-block:
    backgroundColor: "{colors.panel-white}"
    textColor: "{colors.instrument-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "16px 20px"
  telemetry-strip:
    backgroundColor: "{colors.instrument-ink}"
    textColor: "{colors.night-readout}"
    typography: "{typography.label}"
    height: "32px"
  evidence-tag:
    backgroundColor: "{colors.panel-raised}"
    textColor: "{colors.readout-grey}"
    typography: "{typography.label}"
    rounded: "{rounded.xs}"
    padding: "1px 6px"
---

# Design System: antigravity-booster docs

## 1. Overview

**Creative North Star: "The Flight Director's Console"**

Antigravity is the launch platform; agb is the console that keeps the fleet in formation. The system borrows Antigravity's family traits (airy cool-white surfaces, Google Sans Flex with tight display tracking, generous rounding, a single blue) and adds the one thing a flight director's console has that a launch site does not: exact, labelled readouts. Every value that matters (a command, a flag, a version, an exit code, a source line) is set in Google Sans Code as an instrument reading, so the eye can find it at a glance.

Density follows the surface. Reference and guide pages are working panels: compact, ruled, predictable, built for scanning and copying. The landing page is the one place the console powers up, with a large display line and the flight sequence laid out in full. Depth comes from tonal layers, never shadows; colour comes from one signal blue, used only when something is live, selected, or go.

This system rejects the stock Fumadocs / Nextra template, any imitation of a Google property, and the neon-dark "AI tool" look of purple gradients, glow and glassmorphism.

**Key Characteristics:**
- Cool, faintly blue-tinted neutrals; never pure black or white.
- One signal colour (go blue), on under 10% of any screen.
- Sans for reading, mono for every readout.
- Tonal layering for depth; flat at rest.
- Pill-shaped actions, 16px panels, 4px evidence tags.
- Motion conveys state only, 150 to 250ms, ease-out-quint.

## 2. Colors

A restrained console palette: tinted neutrals carry the surface, one blue carries the signal.

### Primary
- **Go Blue** (#3279f9): the signal colour. Focus rings, the active sidebar item marker, the live dot in the telemetry strip, selected tabs. It is a 3:1 indicator colour only and never sets body text.
- **Link Blue** (#1f63d6, night #7ea8ff): link text in prose. The deep sibling of Go Blue, chosen for AA contrast (5.2:1 on Console White, 7.9:1 on Night Console).

### Neutral
- **Console White** (#f8f9fc): the page surface.
- **Panel White** (#ffffff): command blocks, tables and the search dialog sit one step brighter than the page.
- **Panel Raised** (#eff2f7): secondary buttons, evidence tags, the sidebar's hover state.
- **Rule Grey** (#e1e6ec): hairline dividers and panel outlines.
- **Instrument Ink** (#121317): headings, body text and primary buttons (17.6:1).
- **Readout Grey** (#45474d): secondary text and descriptions (8.8:1).
- **Caption Grey** (#5b5e66): captions, breadcrumbs, metadata (6.2:1).
- **Night Console / Panel / Raised / Rule** (#121317 / #18191d / #212226 / #2f3034) with **Night Ink** (#e6eaf0) and **Night Readout** (#b2bbc5): the dark theme, the same layers inverted.

### Named Rules
**The Signal Rule.** Go Blue means live, selected, or go. If a blue element does none of those, it is decoration and must become neutral.

**The No Pure Values Rule.** #000 and #fff never appear as text or page colours; every neutral carries the faint blue tint of the console.

## 3. Typography

**Display Font:** Google Sans Flex (variable; fallback system-ui)
**Body Font:** Google Sans Flex
**Label/Mono Font:** Google Sans Code (variable; fallback ui-monospace)

**Character:** one humanist-geometric sans does all the reading; its code sibling does all the measuring. Self-hosted from npm, so builds never fetch fonts from the network.

### Hierarchy
- **Display** (450, 3.5rem, 1.02, -0.035em): the landing headline only. Clamps down to 2.5rem on narrow screens.
- **Headline** (500, 2rem, 1.1, -0.02em): page titles (h1).
- **Title** (500, 1.25rem, 1.3): section headings (h2); h3 steps down to 1.0625rem.
- **Body** (400, 1rem, 1.65, +0.01em): prose, capped at 72ch.
- **Label** (500, 0.75rem, +0.06em, uppercase where it names a section): telemetry strip, sidebar group headers, evidence tags, table headers. Commands and inline code use the same family at 0.875em without the uppercase.

### Named Rules
**The Readout Rule.** Anything a reader might copy or compare (commands, flags, env vars, versions, exit codes, paths) is set in Google Sans Code. Anything they read is Google Sans Flex. Never mix the roles.

## 4. Elevation

Flat by default. Depth is tonal: Console White page, Panel White panels, Panel Raised controls, each separated by a Rule Grey hairline. The only shadow in the system belongs to floating layers (search dialog, popovers), and it is soft and cool.

### Shadow Vocabulary
- **Float** (`box-shadow: 0 1px 2px rgb(18 19 23 / 0.06), 0 12px 32px rgb(18 19 23 / 0.10)`): search dialog and popovers only.

### Named Rules
**The Flat Panel Rule.** Cards, code blocks, tables and callouts never cast shadows. If a panel needs to stand out, raise its tone, not its shadow.

## 5. Components

### Buttons
- **Shape:** fully pill-shaped (9999px).
- **Primary:** Instrument Ink fill, Console White text, 10px 20px; hover lifts to #2f3034 in 150ms.
- **Secondary:** Panel Raised fill with Instrument Ink text; hover deepens one tonal step.
- **Focus:** 2px Go Blue ring with 2px offset on every button and link.

### Command Block (signature)
- Panel White, 16px radius, Rule Grey hairline, Google Sans Code at 0.875rem, a `$` prompt in Caption Grey, and a pill copy button on the right. Code fences across the docs share this shape.

### Telemetry Strip (signature)
- A 32px strip above the nav: Instrument Ink in both themes, Night Readout label text, a Go Blue live dot, reading "These docs track main. Latest release: vX.Y.Z." in Label type.

### Evidence Tag (signature)
- Links to pinned source (`/blob/v1.0.0/…`) end in a small Panel Raised tag reading `src`, 4px radius, Label type, so every claim visibly carries its proof.

### Callouts
- Panel Raised fill, full 1px hairline border tinted by role (info Go Blue, warning amber, error red), a leading role icon, 16px radius. No side stripes.

### Navigation
- Sidebar group headers in uppercase Label type; items in body type at 0.9375rem. The active item gets Instrument Ink text, a Panel Raised fill and a 6px Go Blue dot, never a coloured side bar. Top nav carries the agb mark and wordmark, search, and the GitHub link.

### Flight Sequence (landing signature)
- The run lifecycle (plan, dispatch, gate, prosecute, merge) as a numbered horizontal sequence joined by a hairline track, each stage labelled with its readout in mono. It collapses to a vertical track on mobile.

## 6. Do's and Don'ts

### Do:
- **Do** keep Go Blue (#3279f9) under 10% of any screen and only on live, selected, or go states.
- **Do** set every command, flag, env var, version and exit code in Google Sans Code.
- **Do** use tonal steps (Console White, Panel White, Panel Raised) and 1px Rule Grey hairlines for structure.
- **Do** keep motion to 150 to 250ms with ease-out-quint, and disable all of it under prefers-reduced-motion.
- **Do** meet WCAG 2.2 AA in both themes; Link Blue (#1f63d6) for link text, never Go Blue.

### Don't:
- **Don't** ship anything that reads as the stock Fumadocs / Nextra default: grey sidebar, default accent, nothing that says what this tool is.
- **Don't** imitate a Google property: no Google logo, legal bar, product marks, or copy implying Google authorship.
- **Don't** use the neon-dark "AI tool" aesthetic: purple-to-blue gradients, glow, glassmorphism on black, particle backgrounds.
- **Don't** use border-left or border-right greater than 1px as a coloured accent on callouts, list items or nav items.
- **Don't** use gradient text, hero-metric blocks, or identical icon-card grids.
- **Don't** add shadows to panels, code blocks, tables or callouts.
