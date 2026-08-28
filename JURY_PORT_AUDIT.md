# Aureon Jury — Beat Variant Port Audit

Source: archived payload of `plan_c2b9xZyc`, revision 583, SHA-256 `757422201d25b1f597866cc8853037faa254840a666798fbbf9e2829c6088dfc`.

Status: migrated in place to revision 584 and deployed. The plan ID, owner and ACLs are unchanged; the exact rev-583 source payload remains owner-recoverable.

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
- Production version: `f6f35c82-ad63-447e-b889-7ac1e060b20d`.
