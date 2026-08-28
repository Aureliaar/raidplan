# Raidplan Feedback Backlog

Canonical tracker for the Aerelion authoring-feedback pass.

## Conventions

- IDs are permanent shorthand. Do not renumber completed or removed items.
- Statuses: `open`, `in progress`, `blocked`, `done`, `not planned`, `invalid`.
- Every implementation update should record verification and, when applicable, the commit/deployment.
- “Agreed direction” captures decisions already made. “Open question” must be resolved before an implementation that depends on it.
- Workflow: the primary agent performs implementation. Subagents are used only for bounded, read-only reviews/audits; implementation delegation was substantially slower for this project.

## 1 — Confirmed bugs

### 1.1 — Variant positions reset or fail to share

- Status: open
- Issue: Boss, bait-anchor, and other shared-part positions can reset to their original drop positions or fail to propagate when Variant B is created.
- Agreed direction: Shared parts need predictable initial inheritance and optional cross-variant linking; Variant B must not be encoded as a delta from Variant A.
- Open question: Exact reproduction and whether the root cause is creation, persistence, or variant resolution.

### 1.2 — Deep-copy regression

- Status: open
- Issue: Deep copy is broken and no longer reliably preserves position and color.
- Agreed direction: A deep copy must preserve the complete visible part state.
- Open question: Which relationships and IDs should remain linked versus be regenerated.

### 1.3 — Deleting the final slide corrupts mechanic end

- Status: open
- Issue: Deleting the last slide in a mechanic's range resets its end to the mechanic start.
- Agreed direction: Clamp the end to the preceding surviving slide.
- Open question: None currently.

### 1.4 — Share dialog cannot be dismissed

- Status: done
- Owner: Terra agent `issue_1_4_share_dialog`
- Issue: The share dialog can enter a state where it cannot be closed.
- Agreed direction: Restore reliable intended dismissal paths and verify them manually.
- Resolution: Added an explicit close button, accessible dialog semantics, outside-pointer dismissal, and Escape dismissal.
- Root cause: The share popover had no close control or outside/Escape handler.
- Open question: None.
- Verification: `npm run check`; `npm run build`; local Playwright checks for close button, outside click, and Escape; live bundle confirmed.
- Commit/deployment: `bd64adb` (`Fix share options dismissal`); production version `cd7187cc-ecfb-46c1-bdff-c5b33bace7d7`.

### 1.5 — Dropping into an inactive selected mechanic makes parts disappear

- Status: done
- Issue: A mechanic stays selected after navigating outside its active range; parts dropped into it then appear to disappear.
- Agreed direction: Automatically finish/exit mechanic fill mode when moving to a step outside that mechanic.
- Resolution: Navigation outside the selected mechanic's inclusive active span now clears selection; returning to the span does not automatically reselect it.
- Open question: None.
- Verification: Covered by the mechanics E2E boundary/navigation regression in 3.4.
- Commit/deployment: `aca3068` (`Close mech filling outside its active steps`); production version `69a25404-0381-4903-8535-cc8e02dbdb6b`.

### 1.6 — Symmetry mode creates only one circle AOE

- Status: open
- Issue: Circle AOE placement is not mirrored in symmetry mode.
- Agreed direction: Symmetry placement should behave consistently across eligible part types.
- Open question: Confirm whether circles are the only affected type.

## 2 — Variant and shared-state workflow

### 2.1 — Linked/unlinked shared-part toggle

- Status: open
- Issue: Editing a shared part currently requires duplicate positioning in each variant, but some shared parts must later diverge.
- Agreed direction: Use a contextual treatment rather than persistent controls in every variant header. Show quiet per-step inheritance glyphs in the timeline; expose full state and actions in the inspector. Automatic detachment already snapshots the whole step upon its first scene edit (2.3).
- Open question: Whether an explicit pre-emptive “detach now” action is useful in addition to automatic first-edit detachment.

### 2.2 — Align-to-other-variant action

- Status: open
- Issue: Authors need exact synchronization after variants have diverged.
- Agreed direction: In the inspector, show `Following shared` or `Edited independently`. For detached steps, provide `Resume shared` with explicit copy that the step's edits will be discarded. This removes the detached snapshot and resumes live inheritance; it is not a one-time positional copy.
- Open question: Whether a separate one-time “copy shared state but remain detached” action is needed later.

### 2.3 — New-variant initial inheritance

- Status: done
- Issue: Creating a new variant can discard already-positioned groundwork.
- Agreed direction: A new variant step inherits the live shared authored scene until that variant step receives its first scene edit. Any edit detaches the whole step; conflict detection is not required.
- Resolution: Added copy-on-write `variantScenes`: absence means live shared inheritance, while the first contextual add/update/clear/delete/duplicate/reorder/assign/arrange snapshots the complete ordered non-waymark scene. Later shared edits cannot change a detached step; other untouched variant steps continue inheriting independently. Arena, waymarks, timeline/mechanic definitions, and plan metadata remain shared.
- Security/lifecycle: Added strict runtime operation validation and patch allowlists, ownership/context enforcement, concurrency revision checks, lossless detached-variant lifecycle handling, validated history/import boundaries, and coherent client/MCP handling of variant-only entities.
- Open question: None for automatic inheritance/detachment; explicit relinking remains tracked in 2.1 and 2.5.
- Verification: Typecheck/build/diff check; focused inheritance and adversarial ownership/concurrency/history suites; mechanics, mechs, steps, markers, palette, bait, symmetry, history, glide, keys, source, multiselect, and group regressions; final independent Sol audit found no blocker; live root and production bundle both HTTP 200.
- Commit/deployment: `99a1daf` (`Implement copy-on-write variant scenes`); production version `97d044e0-5cd9-4655-ad25-fad048d72501`.

### 2.4 — Draggable variant start/end and branch rejoin

- Status: open
- Issue: The timeline cannot clearly show where a variant set begins and collapses back together.
- Agreed direction: Make variant ranges draggable with the mechanic timing interface.
- Open question: Visual treatment for nested or overlapping variant ranges.

### 2.5 — Synchronization and unlink precedence

- Status: open
- Issue: Linked shared state needs deterministic conflict rules.
- Agreed direction: Preserve explicit per-variant divergence without forcing duplicate work before divergence.
- Open question: Precedence for edits, relinking, alignment, persistence, and nested mechanics.

### 2.6 — Scope variants to a Beat

- Status: done
- Implementation baseline: `defc744` on `origin/master` (minor-fixes release plus contextual palette regression update).
- Issue: Variants currently belong to an entire timeline sequence, but authors need alternatives for one timed item within that sequence.
- Agreed direction: A Variant belongs to one Beat, not to the whole Mechanic. Use one timeline card per Beat, independent per-Beat preview choices, contextual authoring in the selected Beat inspector, and separate per-Step copy-on-write domains for Beat content and sparse player movement. See `BEAT_VARIANTS_UX_PLAN.md`.
- Resolution: Beat-local mutually exclusive boxes are exposed contextually from the selected timeline Beat. Fresh boxes visibly follow Shared state; content and movement detach independently on first edit. A/D changes preview only. Routes, deterministic conflict handling, deep duplication, independent resets, and an owner-only “Collapse Variants” path are included.
- Port fixture: Aerelion's Dark & Light rev 3018 is pinned at checksum `91afbea639a7ca185c52614de577bf14d603c255e8e12be5e5cda490ba4aa72b` and converts losslessly into a new copy with compatibility Routes and an immutable source archive. See `DARK_LIGHT_PORT_AUDIT.md`.
- Open question: Optional linked Variant selection across coordinated Beats, and later authoring support for non-player actor movement.
- Verification: `npm run check`; production build; all six legacy + Beat Variant regression suites; contextual panels, history, keyboard, Steps, Mechanics, Beats, and access E2Es; manual 1440×1000 timeline paint check; live asset verification.
- Commit/deployment: `304adae` (`Expose Beat Variant boxes on the timeline`) on top of `3634201`, `06136ef`, and `e39a6e1`; production version `0e8749c1-c4ee-49a4-8b6e-5140ec0dd8aa`.

## 3 — Timeline, lifetimes, and structure

### 3.1 — Independent part lifetime/removal

- Status: open
- Issue: A part's lifetime is bound to its mechanic, forcing authors to split mechanics or shrink unwanted AOEs to near-zero size.
- Agreed direction: Timed components can be separate mechanics today.
- Open question: Whether parts should gain independent start/end/removal controls.

### 3.2 — Player-following part detachment

- Status: open
- Issue: Authors want a bait/part to follow a player on one slide, then detach and remain stationary on a later slide.
- Agreed direction: Player-following baits already work; only the transition to detached state is missing.
- Open question: Whether detachment keeps the last resolved world position or requires an explicit target position.

### 3.3 — Nested/reusable mechanics

- Status: open
- Issue: Splitting one encounter mechanic into many timed mechanics creates clutter and duplicate setup.
- Agreed direction: Allow a complete mechanic to be nested/reused inside another.
- Open question: Ownership, timing, editing, and variant inheritance semantics.

### 3.4 — Auto-exit inactive mechanic fill mode

- Status: done
- Issue: Manual “done filling” is tedious and contributes to 1.5.
- Agreed direction: Leaving the selected mechanic's active range should end fill mode automatically.
- Resolution: The selected mechanic remains active on both inclusive range boundaries and is unselected upon navigation to the first step outside the range. Returning does not reselect it.
- Root cause: Fill selection persisted independently of `stepIndex`, so later drops could still be assigned to an off-screen mechanic.
- Open question: None.
- Verification: `npm run check`; `npm run build`; full mechanics E2E including both boundaries, outside navigation, and return navigation.
- Commit/deployment: `aca3068` (`Close mech filling outside its active steps`); production version `69a25404-0381-4903-8535-cc8e02dbdb6b`.

## 4 — Part authoring

### 4.1 — Select and edit generated attachment shadows

- Status: open
- Issue: Player-attached/generated bait shadows cannot be edited through the side cards.
- Agreed direction: Make shadows selectable as a group while hiding irrelevant position controls.
- Open question: Whether individual shadow overrides are ever needed.

### 4.2 — Numeric size and color controls

- Status: open
- Issue: Shadow size is only approximately adjustable with the wheel, and color is not directly editable.
- Agreed direction: Provide proper detail controls during placement/editing.
- Open question: Whether later steps may override these properties.

### 4.3 — Donut inner and outer radius controls

- Status: open
- Issue: Generated donut baits need editable inner radius as well as overall size.
- Agreed direction: Expose the same inner/outer controls already available to individual donuts.
- Open question: None currently.

### 4.4 — Mechanic color inheritance and fine wheel steps

- Status: open
- Issue: Generated parts need more predictable defaults and precise resizing.
- Agreed direction: Inherit mechanic color and retain wheel resizing; consider Shift+wheel for fine steps.
- Open question: Exact increment sizes and override indicator.

### 4.5 — Auto-promote parts to mechanics and revisit terminology

- Status: open
- Issue: “Mechanic” is overloaded across the whole encounter sequence, timed timeline items, and visual primitives. XIV players expect a named sequence such as “Dark and Light” to be a Mechanic.
- Agreed direction: Use `Mechanic → Beat → Part`. A Part is a visual primitive such as a circle, beam, tether, text, or castbar. A Beat is one timed item placed on the Mechanic timeline and can own one or more Parts. A Mechanic is the complete authored sequence. Step remains the side-axis discrete moment/keyframe. Variants belong to Beats (2.6). Consider auto-promoting a dropped Part into a Beat when appropriate.
- Open question: Migration/code naming, multi-Part Beat authoring, and whether any visible UI needs the expanded label “Mechanic Beat” during onboarding.

## 5 — Visual presentation

### 5.1 — Static/fading indicator behavior

- Status: open
- Issue: Donuts used only as light/dark indicators still visually explode.
- Agreed direction: Support a static or fading presentation distinct from an impact/explosion.
- Open question: Separate indicator part type versus a per-part animation mode.

### 5.2 — Stack-marker/player layering

- Status: open
- Issue: Stack markers are forced below players, hiding small pair stacks.
- Agreed direction: Make stack markers visibly layer around/above players as appropriate.
- Open question: Global layer rule versus configurable z-order.

### 5.3 — Reduce W/S transition overload

- Status: open
- Issue: Rapid step navigation creates a visually overwhelming sequence of animations.
- Agreed direction: None finalized.
- Open question: Reduce animation, skip intermediate transitions, or immediately settle on the target step.

### 5.4 — Optional placeable castbar

- Status: open
- Issue: Plans sometimes need to show cast progress before or during a mechanic.
- Agreed direction: Add an optional castbar part usable as a pre-mechanic element or its own mechanic; manual timing is acceptable.
- Open question: Editable properties and whether progress derives from slide timing.

### 5.5 — Text, arrows, and notes

- Status: open
- Issue: Arena visuals cannot adequately explain a completed plan, and the side description is too limited.
- Agreed direction: Add text, arrows, and notes as placeable parts.
- Open question: Scope/ownership, anchoring, formatting, and variant/timing behavior.

## 6 — Debuffs and roles

### 6.1 — Explicit optional per-player assignments

- Status: open
- Issue: Automatic deal order is too indirect to guarantee correct light/dark or paired assignments.
- Agreed direction: Restore explicit but optional player assignment controls and keep the resolved deal data.
- Open question: UI shape and automatic fallback rules.

### 6.2 — Multiple debuffs per player

- Status: open
- Issue: The deal flow cannot assign several debuffs to one player.
- Agreed direction: Allow multiple explicit assignments per player.
- Open question: Conflict validation and display layout.

### 6.3 — Melee/ranged DPS split

- Status: open
- Issue: DPS role grouping lacks a melee/ranged split.
- Agreed direction: Add melee and ranged options.
- Open question: Treatment of flexible fourth-DPS compositions.

### 6.4 — Assignment preview/validation against pairs

- Status: open
- Issue: Mid-mechanic debuff dealing can create logically invalid tether pairs while identities and anchors remain technically intact.
- Agreed direction: Explicit assignment solves the immediate control problem.
- Open question: Whether the UI should preview or warn about pair/tether incompatibilities.

### 6.5 — Default debuff filtering

- Status: open
- Issue: The debuff list contains low-value clutter.
- Agreed direction: Hide tank-only entries and generic resistance-down/vulnerability-up entries by default behind an opt-in flag.
- Open question: Exact filter taxonomy and discoverability.

## 7 — Sharing and permissions

### 7.1 — Explain view-link versus Discord write access

- Status: open
- Issue: The share UI requests a Discord ID without explaining that it grants write access, and the link's view permissions are unclear.
- Agreed direction: Clearly label link viewing and Discord-based editing; an initial UX improvement may already exist.
- Open question: Final copy and whether commenter access is needed.

### 7.2 — Access roles and revocation UX

- Status: open
- Issue: Permission management beyond initial sharing is underspecified.
- Agreed direction: None finalized.
- Open question: Commenter/owner roles, individual revocation, and disabling public-link access.

## Invalidated or clarified feedback

### X.1 — Player baits do not follow players

- Status: invalid
- Resolution: Reporter confirmed player-following circle baits now work. The distinct detachment request remains tracked as 3.2.
