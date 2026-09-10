# Repository instructions

- After completing and verifying any code or asset change in this repository, deploy it to production with `npm run deploy` and verify the live deployment, unless the user explicitly says not to deploy.

## Direct-manipulation releases

Every drag gesture in the editor (Beat boxes, Variant chips, Variant container
edges, step rows, mechanic sections) follows one release contract, kept in
`src/client/Editor.tsx` next to `OPTIMISTIC_OPS`:

1. Batch all ops of one gesture into a single `run()` call.
2. Deterministic transforms belong in `OPTIMISTIC_OPS`, so `run()` applies
   them locally in the same paint; the server response stays authoritative.
3. On release the preview state is marked `settling` and cleared only when the
   round trip settles — never synchronously. No frame may show the old
   position between release and acknowledgement. Move handlers ignore a
   settling drag; a new drag may replace it at any time.

A new gesture that skips any of these three steps will flicker on release.

## What a Step owns

A Beat is the timing rule. It snapshots on the step it starts in, resolves on
the step it ends in, and nothing inside it happens at a finer grain — so a Part
has one pose, one geometry and one colour for its whole life, and per-step
overrides are for actors only:

- `STEP_FIELDS` in `src/shared/schema.ts` is the whole list: `x`, `y`,
  `rotation`, `job`, `icon`. Movement, and the token somebody is drawn as
  while a role callout or a debuff is on them.
- Everything else belongs to the entity. `updateEntity` routes by
  `stepOwned()`, so a step-scoped edit of a radius, a colour, a size or a
  tether's pairing writes the thing itself rather than filing an exception
  under the step it was typed in.
- A step that says nothing inherits, field by field, from the last step of the
  same mechanic that did. The walk stops at the mechanic boundary: a mechanic
  whose first step leaves someone undeclared opens with them at their base
  pose. So a drag is a delta, not a snapshot, and `duplicate_step` copies no
  poses — the copy lands next to its source and inherits them.
- `settleOverrides()` in `hydratePlan` folds documents written under the old
  every-property-per-step lens back onto the things they describe.

## End-to-end suites

The e2e set is `scripts/e2e-*.mjs` on `scripts/harness.mjs`, run with `npm run e2e`.
Adding a reasonable section to an existing suite is fine. Adding a new suite needs a
convincing, concise argument presented to the human, and only the human can approve it
— no LLM may approve it. A suite broken by a design change is fixed or trimmed in the
same change, never left red.

## New operations are born client-authoritative

Going forward, design every new op so the client can fully predict its result
(the server is sync + persistence, not an authority on content — there is no
data to protect here):

- The client mints ids (`<kind>_` prefix + random), passed in the op; the
  server honors them. Never server-generated ids in new ops.
- No server-injected context the client cannot predict. Attribution and the
  like are sent by the client in the op itself.
- Every new op is a pure transform of state the client already holds, joins
  `OPTIMISTIC_OPS` in `src/client/Editor.tsx` at birth, and follows the
  release contract above.

Legacy ops (server-minted ids, `apply_encounter`-style server reads) stay
wait-for-ack; migrate them only when there is a concrete reason.
