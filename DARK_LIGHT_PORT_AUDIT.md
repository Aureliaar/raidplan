# Aerelion Dark & Light — Beat Variant Port Audit

Source: `plan_mMW41ylx` at the deployed Raidplan site.

Status: read-only audit; source plan not modified.

## 2.6.P1 — Verdict

- An exact, reversible A/B compatibility port can be fully automatic.
- A clean semantic port is high-confidence for this plan but needs confirmation of grouping and movement ownership.
- No duplicate IDs, dangling anchors/tethers, or irrecoverable source data were found.
- This is a strong migration fixture because it exercises shared Beats, gated Beat pairs, anchors, tethers, movement, ownership, and legacy override pollution.

## 2.6.P2 — Source shape

- 18 Steps.
- 1 legacy whole-Mechanic wrapper.
- 2 legacy Variants: A and B.
- 14 current `mechs` (future Beats): 13 populated and 1 empty.
- 72 canonical entities:
  - 8 players
  - 8 waymarks
  - 5 enemies/anchors
  - 4 tethers
  - 47 zones
- 35 anchored Parts and 4 endpoint-based tethers.

## 2.6.P3 — Recommended Beat mapping

| Existing item(s) | Proposed Beat | Variants |
| --- | --- | --- |
| `Tethers` | Tethers | None; shared |
| `Orbs` | Orbs | Light / Dark |
| Gated Light + Dark at Arcane hit | Arcane Revelation hit | Light circles / Dark circles |
| `Jury` | Jury lines | Light / Dark |
| Gated Light + Dark at Baits | Baits | Light player circles / Dark donuts |
| Gated LP + Pairs | LP / Pairs | Light Parties / Pairs |
| `Divisive Indicator` | Divisive indicator | Light / Dark color |
| Unnamed rectangle | Divisive line 1 | Light / Dark color |
| Gated Light + Dark at line 2 | Divisive line 2 | Light / Dark patterns |
| Empty `mech_0SUabJPx` | Author-review item | None |

After merging complementary A/B pairs, the clean plan has 9 populated content Beats: 8 varying and 1 shared.

## 2.6.P4 — Compatibility Routes

`Legacy A / All Light` selects the Light/A option for all eight varying Beats plus Movement A.

`Legacy B / All Dark` selects the Dark/B option for all eight varying Beats plus Movement B/Pairs.

These Routes can reproduce the old viewer output exactly and provide a reversible compatibility layer.

## 2.6.P5 — Movement

A and B differ for all eight players at 10 Steps (80 player-pose pairs):

- Steps 6–7: Arcane Revelation.
- Steps 11–12: LP/Pairs and resolve.
- Steps 13–18: Divisive sequence.

Safest automatic migration:

- Generate one `Party movement` Beat with A/B Variants.
- Preserve the exact legacy choices through Routes A/B.

Cleaner plan-specific migration:

- Arcane movement: Steps 6–7.
- Jury movement: Steps 11–12.
- Divisive movement: Steps 13–18.

The cleaner split matches three apparent independent occurrences, but generic migration cannot safely infer those semantic boundaries.

## 2.6.P6 — Required linked-selection concept

The plan exposes three coordinated branch groups:

- Arcane: Orbs + hit + movement.
- Jury: lines + baits + LP/Pairs + movement.
- Divisive: indicator + line 1 + line 2 + movement.

Plain independent Beat choices allow incoherent previews such as a Dark orb indicator with a Light explosion.

Recommended direction:

- Add an optional Variant Group (working name) that links selection across several Beats without owning their content.
- Each Beat keeps its own Variants and copy-on-write state.
- A group maps one named choice to member Beat choices, for example `Light → { Orbs: Light, Hit: Light, Movement: Light }`.
- Changing a member independently makes the group `Custom` rather than silently forcing it back.
- Whole-Mechanic Routes remain presets across groups/Beats, not content owners.

This coordinates related Beats without restoring Mechanic-wide Variant ownership.

## 2.6.P7 — Data cleanup findings

- All 36 legacy `Step × Variant` pairs are materialized, including identical Steps.
- The boss has identical A/B overrides everywhere, which caused snapshot presence to overstate deliberate editing.
- Canonical boss data is stale (`boss 1`, off-center, rotation 0), while all rendered snapshots agree on the intended common state (blank name, centered, rotation 180). Migration should promote the common rendered state to Shared.
- 639 legacy override records exist; 266 are outside their owning Beat's active span and never render.
- 25 entities contain such dead overrides.
- Small A/B drifts exist in otherwise similar positions (for example orb anchors and Jury donut alignment). Preserve them during lossless conversion, then offer optional alignment cleanup.
- The empty Beat should be flagged for author review, not silently deleted.

## 2.6.P8 — Ownership

- Legacy A is unowned/shared.
- Legacy B is owned by Aerelion.
- A port must preserve this as attribution or consistently transfer ownership to every resulting local Variant.
- Final Beat-Variant collaboration policy remains an open product decision.

## 2.6.P9 — Port sequence

1. Implement the additive Beat-Variant model and compatibility reader.
2. Convert into a new plan/copy; never mutate the only source first.
3. Produce Routes matching legacy A and B.
4. Render-compare every Step in legacy A/B against the corresponding new Route.
5. Preserve the original plan/history or archival payload for recovery.
6. Present the clean nine-Beat grouping, three movement ranges, empty Beat, ownership mapping, and alignment drift for author confirmation.
7. Only then make the converted plan the working copy.

## 2.6.P10 — Repository prerequisite

The local tracker branch and deployed implementation branch currently diverge. Beat migration implementation must start from deployed/origin `99a1daf` (or its successor) and bring documentation separately; it must not be built from the older local schema that ignores `variantScenes`.
