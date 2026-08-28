# Step-owned Variant boxes — UI/UX and State Plan

Status: in progress on `feat/beat-variant-boxes`.

## Authoritative lexicon and hierarchy

- Mechanic — the whole authored timeline, such as Dark and Light.
- Step — one discrete moment on the Mechanic timeline.
- Beat — one timed item placed across Steps.
- Part — a visual primitive owned by a Beat.
- Variant split — declared by one Step. It contains two or more mutually exclusive Variant boxes.
- Variant box — contains zero or more complete Beats. Beats outside every box are Shared.

Canonical structure: `Mechanic → Step → (Shared Beats | Variant boxes containing Beats) → Parts`.

## Locked behavior

- A/D cycles the mutually exclusive boxes of an active Step split.
- Exactly one box from each active split contributes Beats to playback.
- Shared Beats are never placed inside a Variant box and always contribute.
- A split is active wherever one of its contained Beats spans the current Step, or where that split owns actor movement.
- A Variant box may contain several Beats and may also be empty or movement-only.
- A whole Beat moves between Shared and a box; Parts never become direct children of a Variant.
- New Beats created while explicitly editing a box are placed into that box.
- Player/boss/add/anchor movement is sparse, absolute, and stored per `timeline Step × Variant box × actor`.
- Missing movement follows the Shared Step pose. Existing movement is visibly initialized and can be cleared/resynchronized to Shared.
- Simultaneous active splits compose movement when they affect different actors. If two selected boxes move the same actor at the same Step, keep the Shared pose and flag a conflict; never use silent last-writer-wins behavior.
- Routes are non-owning maps of `declaring Step ID → selected Variant box ID`.

## Timeline and authoring UI

- Shared Beats render as ordinary Beat cards.
- A split renders as a persistent outer box on the timeline, with sibling Variant boxes inside it and the contained Beat labels/cards inside each sibling.
- Selecting a Variant box changes both explicit edit destination and preview; viewer-only preview remains possible from the preview strip.
- The selected Beat inspector exposes a Location control: Shared or `declaring Step › Variant`.
- The canvas breadcrumb names the exact box being edited.
- Moving an actor while a box is selected writes Variant movement. Editing a Part edits the complete Beat already owned by that box; Shared Beat edits stay Shared.

## Retirement and migration

- Mechanic-wide Variants and Beat-owned Variants are both retired; neither remains as a parallel authoring or playback path.
- Only Aureon's Jury (`plan_c2b9xZyc`) and Aerelion's Dark & Light (`plan_mMW41ylx`) are migrated.
- Migration inputs are immutable pre-port archives, never the destructively transformed current documents:
  - Jury rev 583 — SHA-256 `757422201d25b1f597866cc8853037faa254840a666798fbbf9e2829c6088dfc`
  - Dark & Light rev 3018 — SHA-256 `c8596852ea01f748a8e961a1984b2d3c02bdb89bc9d00c96de283939179ea0f6`
- No production write occurs until every legacy route at every Step matches the candidate rendered scene.
- Jury uses a Step split whose Light box contains the circle/healer-stack Beats and whose Dark box contains the donut/DPS-stack Beats; Beam remains Shared.
- Dark & Light should represent its independently varying Arcane, Jury, and Divisive sequences as separate Step splits, while preserving the two original A/A/A and B/B/B compatibility Routes.
- Every other old document flattens to its Shared canonical state after cutover.

## Rejected model

The previous `Beat → Variant → Parts` design is rejected. It made one Variant belong to a single Beat, produced child boxes inside Beat cards, and forced coordinated alternatives into several independent toggles. That is the inverse of the intended relationship: one Step-owned Variant box must be able to contain several Beats.
