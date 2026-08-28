# Beat-scoped Variants — UI/UX and State Plan

Status: implemented and deployed in `304adae` (production version `0e8749c1-c4ee-49a4-8b6e-5140ec0dd8aa`).

This plan replaces whole-Mechanic variants with variants owned by one Beat. It uses the agreed lexicon:

- **Mechanic** — the complete authored timeline, such as Dark and Light.
- **Beat** — one timed item placed on that timeline.
- **Part** — a visual primitive owned by a Beat: circle, beam, tether, text, castbar, and so on.
- **Step** — a discrete moment on the timeline's side axis.
- **Variant** — one alternative of one Beat.

## 2.6.1 — Core interaction model

- There is no Mechanic-wide active Variant.
- Every varying Beat independently remembers which Variant is being previewed.
- Sibling Variant boxes inside one Beat are mutually exclusive: exactly one playable Variant contributes at a time. Until detached at a Step, it resolves the live direct/shared Beat Parts; after its first content edit, its Beat-local snapshot replaces only that Beat's shared result at that Step.
- Preview choice and edit destination are separate state:
  - `Preview` determines what the canvas/playback displays.
  - `Editing` determines where the next authored change is stored.
- The current preview is a map of `Beat → Variant`; the UI never expands or names the Cartesian product.
- Selecting a Step outside the selected Beat's inclusive span unselects that Beat and exits its edit context.

## 2.6.2 — Timeline

Remove the current whole-Mechanic `Shared | A | B` columns.

- Render one timed frame/card per Beat, regardless of how many Variants it owns.
- Shared Parts sit directly on the Beat. There is no `Shared` Variant box.
- Optional Variant boxes are child containers inside the Beat and contain only divergent Variant Parts/overrides plus optional Variant movement.
- Continue using ordinary lanes only for overlapping Beats.
- A Beat with Variants gets a quiet fork badge such as `◇2` and may show the previewed Variant name, such as `Light ▾`.
- A small footsteps glyph marks movement authored by that Beat at the current Step.
- When a Beat is selected, quiet row-aligned glyphs may show which of its Step states are inherited, edited, or conflicted.
- Shared/non-varying Beats have no Variant chrome.

This keeps timeline width proportional to overlapping Beats rather than `Beats × Variants`.

## 2.6.3 — Selected Beat inspector

Selecting a Beat opens the contextual authoring surface:

```text
BEAT
Explosion                         Step 3 → Step 4

VARIANTS
[ Beat ]   [ Light ] [ Dark ]   [+]

Previewing: Light
Editing: Explosion › Light › Step 3

Content
Following shared

Movement
Uses Step positions
```

- `Beat` selects the Beat itself and edits Parts placed directly on it; it is not a Variant box.
- Clicking a playable Variant previews it and makes it the explicit edit destination.
- Selecting `Beat` edits the shared baseline inherited by still-linked Variant content.
- A persistent breadcrumb above the canvas states the exact destination, for example `Editing: Explosion › Light › Step 3`.
- With no Beat selected, the breadcrumb reads `Editing: Step 3 shared scene`.

## 2.6.4 — Variant creation and lifecycle

`+ Variant` acts only on the selected Beat.

- The first use creates two playable Variants, initially following Shared at every Step.
- Later additions create one new Variant following Shared; they do not copy the currently selected Variant.
- `Duplicate Variant` is a separate action that explicitly deep-copies another Variant's content and movement.
- Variant actions: Rename, Duplicate, Reset edited Steps, Delete.
- Deleting the final branch uses a deliberate `Collapse Variants…` flow and asks which resolved branch should become Shared.
- Empty Beat Variants and Variants containing only movement are valid.

One-time creation guidance:

> Variants change only this Beat. Content and player movement remain shared until you edit them.

## 2.6.5 — Two independent copy-on-write domains

For each `Beat × Variant × Step`, content and movement detach independently.

### Content

- Shared Parts are direct children of the Beat, outside every Variant box.
- No Variant content snapshot means `Following shared`.
- The first Part/style edit at that Step snapshots only this Beat's resolved content for that Step.
- That detached/overridden content belongs inside the selected Variant box; the source Shared Part remains on the Beat.
- Content includes the Beat's visible Parts, their properties/order, Beat color/style, and whether the Beat happens in that Variant.
- Later Shared content changes continue reaching untouched Steps but cannot modify detached Steps.
- `Resume shared content` deletes the current snapshot and resumes live inheritance.

### Player movement

- No movement override means `Uses Step positions`.
- Moving one player while editing a Beat Variant creates an absolute pose override only for that player at that `Beat × Variant × Step`.
- Other players continue following the shared Step positions until individually moved.
- A Part edit never detaches movement, and a player move never detaches Beat content.
- `Clear variant movement` removes the current Step's movement overrides and resumes the shared positions.

Actor identity, job, icon, name, roster membership, arena, waymarks, timeline structure, and Beat timing remain shared.

## 2.6.6 — Contextual status and reset actions

The timeline stays quiet; the inspector carries the full explanation.

Content states:

- `Following shared`
- `Edited independently`

Movement states:

- `Uses Step positions`
- `Overrides M1`
- `Overrides 4 players`
- `Movement conflict`

Contextual actions:

- `Resume shared content`
  - Warning: `Your content edits on this Step will be discarded.`
- `Clear variant movement`
  - Warning: `Player movement owned by this Variant on this Step will be discarded.`
- `Reset this Variant Step…`
  - Clears both domains after confirmation.
- Variant overflow: `Reset all edited Steps…`

Quiet glyphs:

- Chain — following Shared.
- Edited dot/pencil — independent content.
- Footsteps — movement exists.
- Warning — active preview contains a movement conflict.

## 2.6.7 — Player-drag behavior

- No Beat selected: dragging players edits the shared Step positions.
- The Beat itself selected: dragging players edits the shared Step positions.
- A playable Beat Variant selected: dragging a player creates movement for that Beat Variant at the current Step.
- The first Variant-owned drag produces an undoable toast:

> M1's movement now belongs to Explosion › Light at Step 3. Undo

This makes movement ownership explicit without a blocking mode dialog.

## 2.6.8 — Composing movement from simultaneous Beats

Sparse movement overrides compose when active Beat Variants move different players.

- Two active Beat Variants overriding the same player at the same Step are ambiguous.
- Never silently resolve that collision as normal playback behavior.
- Preserve both authored alternatives and mark the player, Beat cards, and preview chips with a warning.
- The inspector offers `Keep movement from <Beat>` and `Open both Beats`.
- A conflicting selection cannot be saved as the default preview or a Route.
- During author editing only, the selected Beat's pose may be shown so the scene remains editable; the conflict must remain visibly flagged.

Delta transforms and invisible last-Beat-wins ordering are explicitly rejected.

## 2.6.9 — Preview and viewer controls

Above the canvas, show only varying Beats active at the current Step:

```text
PREVIEW   Explosion: Light ▾   Orbs: Clockwise ▾
```

- Each chip changes only that Beat.
- Choices remain remembered while navigating Steps, even while a Beat is inactive.
- Viewer mode uses the same preview strip without authoring controls.
- Shared Beats never appear in the strip.
- A/D cycles the selected/focused Beat's mutually exclusive Variant boxes.
- If exactly one varying Beat is active on the current Step, A/D cycles it automatically even when it is not selected, preserving the previous quick-preview behavior.
- If several varying Beats are active and none is selected/focused, A/D does nothing and briefly asks the user to choose a Beat rather than changing an unrelated choice invisibly.
- W/S continues changing Steps.

Optional later feature: **Routes**, named presets containing only a `Beat → Variant` selection map. Manually changing a selection makes the current preview `Custom`. Routes own no Parts or movement.

## 2.6.10 — Data-shape direction

Conceptual structure:

```ts
Beat {
  id
  name
  snapStepId
  boomStepId
  sharedContent
  variants: BeatVariant[]
}

BeatVariant {
  id
  name
  createdBy?
}

Step {
  beatVariantContent?: Record<BeatVariantId, BeatContentSnapshot>
  beatVariantMovement?: Record<BeatVariantId, Record<ActorId, Pose>>
}
```

Important invariants:

- A Variant ID belongs to exactly one Beat.
- A Part belongs to exactly one Beat.
- All Variants of a Beat share that Beat's inclusive Step span.
- A content snapshot contains only its owning Beat's Parts/state.
- Actors and waymarks never enter Beat content snapshots.
- Preview selection is browser/session state; previewing cannot mutate the document.
- Anchored Parts resolve after effective player movement is composed.

Persistence fields may temporarily retain current internal names while UI and TypeScript terminology move to Beat. A destructive schema rename should be a later migration.

## 2.6.11 — Legacy-plan migration

Old Mechanic-wide branches cannot be safely guessed into one Beat.

Lossless conversion:

- Convert ungated old timed items into shared/non-varying Beats.
- Give each gated/differing old item local Beat Variants representing its old branch content.
- Convert legacy player/boss/anchor formations into a generated `Party movement` Beat with matching Variants.
- Create Routes corresponding to old whole-Mechanic A/B paths so legacy playback remains exact.
- Preserve the formerly selected/first old path as the default Route.
- Compare every old branch at every Step against its converted Route before committing migration.
- Refuse conversion with a clear report if content cannot be attributed safely; never guess and discard it.

Rollout should initially use a compatibility reader and an explicit, undoable `Convert Variants to Beats` action. Do not silently rewrite all existing plans on load.

## 2.6.12 — Implementation phases

### Phase A — Terminology and additive model

- Expose Beat terminology and internal aliases.
- Add Beat-local Variant structures and resolver behind a feature flag.
- Keep legacy plans on the legacy reader.

Acceptance:

- Old plans render identically.
- No visible UI calls a Beat a Mechanic.
- One Mechanic can contain shared and independently varying Beats.

### Phase B — Timeline, inspector, and preview

- Replace whole-Mechanic Variant columns with one-card-per-Beat timeline.
- Add inspector tabs, explicit preview/edit separation, breadcrumb, and independent preview strip.

Acceptance:

- Two simultaneous Beats can switch Variants independently.
- Timeline width does not grow when a Variant is added.
- The author can always identify the destination of the next edit.

### Phase C — Copy-on-write and movement

- Implement separate per-Step content and sparse movement COW.
- Add contextual statuses, reset actions, first-drag toast, conflict detection, and undo.

Acceptance:

- Untouched Variant Steps follow later Shared edits.
- A Part edit does not detach movement.
- Moving M1 does not detach the other players.
- Content and movement can be reset independently.
- No same-player movement collision is silent.

### Phase D — Migration and playback polish

- Add lossless explicit conversion and legacy Routes.
- Add keyboard/accessibility behavior, optional named Routes, bulk reset, and guided cleanup.

Acceptance:

- Every converted old Route visually matches its old branch at every Step.
- Migration is idempotent and undoable.
- No old Part, pose, ownership record, or branch is discarded.
- Viewer playback and author preview use the same Beat selection map.

## 2.6.13 — Open product decisions

- Whether movement overrides should later support boss/add/anchor actors in the UI; the schema should use general actor IDs even if the first UI exposes players only.

## 2.6.13A — Decisions locked for implementation

- A detached content snapshot is the complete resolved content of its owning Beat at one `Beat × Variant × Step`; it replaces only that Beat's shared result at that Step.
- Compatibility Routes and a document-owned default Route ship with migration. Local preview changes remain session-only.
- `Duplicate Variant` copies content and movement across all Steps and rewires Variant-private Part references.
- Beat Variants are collaborative plan content. `createdBy` is attribution only; normal plan editor permissions govern edits and the plan owner retains destructive authority.
- If several selected Beat Variants move the same actor at one Step, render that actor at the shared Step pose and show a conflict. Never choose a winning Beat silently, and do not allow the conflicting map to become a default or saved Route.
- A/D changes preview only. It never redirects the edit destination; only explicit inspector/Variant-box selection does that.
- Legacy conversion is owner-only and creates a new plan copy atomically with a pinned source archive; it never mutates the only source.
- Cross-Beat draw order is stable Beat order followed by Part order within each resolved Beat.
- Migration tests use a pinned Dark & Light export and checksum, never the mutable public URL.

## 2.6.14 — Rejected approaches

- Keeping full `Step.variantScenes` keyed by Beat Variant: simultaneous Beats would snapshot each other's content and could not compose.
- Variant B as a delta from A: fragile ordering/deletion semantics.
- Mechanic-wide Cartesian combinations: recreates the original coupling and grows exponentially.
- One column per Beat Variant: timeline width explodes.
- Editing a Part freezing player positions: invisible unrelated detachment.
- Moving one player freezing the whole formation: creates unnecessary stale state.
- Silent last-Beat-wins movement precedence: playback changes for non-obvious reasons.
