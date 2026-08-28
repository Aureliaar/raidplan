# Aerelion Dark & Light — Beat Variant Port Audit

Source: archived payload of `plan_mMW41ylx`, revision 3018, SHA-256 `c8596852ea01f748a8e961a1984b2d3c02bdb89bc9d00c96de283939179ea0f6`.

Status: migrated in place to revision 3019 and deployed. The plan ID, owner and ACLs are unchanged; the exact rev-3018 source payload remains owner-recoverable. Clean semantic regrouping and linked Variant Groups remain future authoring work.

## 2.6.P1 — Verdict

- The exact, reversible A/B compatibility port completed successfully.
- A clean semantic port is high-confidence for this plan but needs confirmation of grouping and movement ownership.
- No duplicate IDs, dangling anchors/tethers, or irrecoverable source data were found.
- This is a strong migration fixture because it exercises shared Beats, gated Beat pairs, anchors, tethers, movement, ownership, and legacy override pollution.

## 2.6.P2 — Original audit shape

The mutable live-plan audit below described an earlier revision. The pinned rev-3018 conversion fixture contains 2 Mechanics, 16 Beats, and 19 Steps and is the authoritative regression source.

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
- Conversion preserves authorship as attribution. Beat Variants use normal plan editor permissions; the plan owner retains destructive authority.

## 2.6.P9 — Completed port

1. Archived the exact rev-3018 payload and checksum.
2. Produced Routes matching legacy A and B.
3. Compared all 38 Route × Step states with zero mismatches.
4. Replaced the document in place as rev 3019, retaining ID, owner and ACLs.
5. Verified 26 Beat Variants, 2 Routes, zero Mechanic Variants and zero legacy `variantScenes` in production.

## 2.6.P10 — Repository prerequisite

Resolved. Mechanic-wide Variants were retired in `4a930e9`, deployed as Cloudflare version `f6f35c82-ad63-447e-b889-7ac1e060b20d`. Tracker documentation remains local and separate from the code deployment history.
