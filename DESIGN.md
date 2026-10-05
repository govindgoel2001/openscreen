---
version: alpha
name: OpenScreen
description: A desktop screen recorder with a dark video editing workspace and green export actions.
colors:
  background: "#09090B"
  primary: "#34B27B"
  foreground: "#E2E8F0"
  muted: "#94A3B8"
  danger: "#F87171"
typography:
  sans:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
  mono:
    fontFamily: "ui-monospace, monospace"
rounded:
  DEFAULT: "0.5rem"
  control: "0.75rem"
  dialog: "1rem"
spacing:
  dialog-padding: "2rem"
  control-gap: "0.75rem"
components:
  button: {}
  dialog: {}
  toast: {}
---

# OpenScreen design context

## Overview

OpenScreen is a desktop recording tool. Its primary workflow is choosing a source,
recording a take, editing that take, and exporting an MP4 or GIF. The compact
recorder floats above other applications; the editor provides a dense timeline
and settings workspace. The visual reference is a quiet video editing console:
dark surfaces, readable counters, and a single green action accent.

This file documents the existing application and the record-again change. No
geographic target market is specified. Supported UI languages are English,
Spanish, and Simplified Chinese; translations live in `src/i18n/locales`, with
English as the fallback. Added translations require native review when available.

## Runtime tokens

`src/index.css` owns the shared HSL theme variables, and `tailwind.config.cjs`
maps them to utility classes. The editor also uses existing explicit zinc, slate,
and green utilities. The colors above mirror the export dialog, rather than
generating a separate theme. The system sans font is inherited from Tailwind;
frame and percentage counters use the mono family.

## Layout, shapes, and depth

The export dialog uses a 448px maximum width, a 90vw width, 90vh maximum height,
and internal scrolling. Its padding is 32px. Buttons are 48px high, with 12px
corners. The dialog has 16px corners, a subtle white border, and a dark overlay.
The floating recorder retains its existing compact layout and positioning.

## Components and states

Use `src/components/ui/button.tsx` for export actions and
`src/components/ui/dialog.tsx` for the modal, focus containment, semantic title,
and description. Use Sonner for recoverable action errors.

The green Record again action uses dark text for contrast. Its label and geometry
stay stable while the request is busy; it is disabled and exposes `aria-busy`
until the recorder opens. Keep Cancel export visually separate with the existing
red treatment. Frame progress has an accessible progressbar label and values.
Lucide icons accompany text labels; the recorder's icon action has an accessible
Start recording or Stop Recording name.

Exports remain in their originating editor window. Record again minimizes that
editor and restores the recorder. Starting another take creates a separate
editor. Video paths, saved project paths, unsaved changes, and export state belong
to each editor. Users can restore an editor from the Windows taskbar. Existing
export animation and dialog motion follow the application's shared components.

## Verification

Exercise the real Electron workflow for MP4 and GIF: begin export, return to the
recorder, record a synthetic second take, and confirm the original export remains
alive and completes. Verify each editor retains its own video and project save
path. Inspect the export dialog visually and check keyboard focus, sizing, and
initializing/rendering/finalizing behavior. Use the existing build, test suite,
translation checks, and a strict frontend audit; unrelated legacy audit findings
remain outside this small workflow fix.

## Do and avoid

- Keep each active export's editor alive when opening the recorder.
- Keep primary actions readable, labeled, and accessible with the keyboard.
- Avoid shared mutable recording or project state between editor windows.
- Avoid closing an editor or showing a discard dialog just to start another take.
