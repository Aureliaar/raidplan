# Aureon Jury — Beat Variant Port Audit

Source: archived payload of `plan_c2b9xZyc`, revision 583, SHA-256 `757422201d25b1f597866cc8853037faa254840a666798fbbf9e2829c6088dfc`.

Status: migrated in place and semantically repaired at revision 586. The plan ID, owner and ACLs are unchanged; the exact rev-583 source payload remains owner-recoverable.

## 2.6.J1 — Preflight finding

- A generic conversion initially found four unassigned Dark & Light tethers leaking backward into Jury Steps.
- Those tethers are declared at `step_Syxm14On`; they were assigned to a new one-Step Beat, `mech_jury_tethers_cutover`, named `Tethers`.
- Their stale records were removed from earlier legacy Variant scenes before conversion.
- No other plan-specific repair was required.

## 2.6.J2 — Equivalence and result

- All 48 Route × Step comparisons matched after the repair.
- The migrated plan contains 10 Beat Variants and 4 Routes.
- It contains zero Mechanic Variants and zero legacy `variantScenes`.
- The source archive identifies the same plan ID at rev 583; production is rev 584.

## 2.6.J3 — Deployment

- Mechanic-wide Variants were retired in `4a930e9`.
- The first compatibility port preserved playback but produced four separately varying Jury Beats, each with an empty opposite branch. That made every card inherit the same Light/Dark Route selection and obscured the intended Variant containers.
- The rev-586 repair merges circles + healer stacks into the Light box and donuts + DPS stacks into the Dark box of one `Jury baits` Beat. Beam and tethers remain Shared.
- The repair matched all 48 pre-repair Route × Step scenes, reduced four duplicate Routes to Light/Dark, and left one varying Beat with two Variants.
- Persistent child Variant boxes landed in `20fd7d3` and deployed as Cloudflare version `2c6235a2-b557-4cfe-beee-7ec6ac669e51`.
