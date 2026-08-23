# raidplan

An XIVPlan-style raid plan editor where the plan is a JSON document living in a Cloudflare
Durable Object — and a **remote MCP server** sits in front of it, so a model can move the
pieces while you watch the canvas update.

```
browser ──WebSocket (state sync)──┐
                                  ├── PlanAgent (Durable Object) ── plan JSON
model ──MCP /mcp ── tools ────────┤
you   ──POST /api/plans/:id/ops ──┘
```

Every mutation — a drag on the canvas, a chat message, an MCP tool call — is the same `Op`
applied by the same code (`src/shared/ops.ts`), so the three paths cannot drift apart.

## Run it

```bash
npm install
cp .dev.vars.example .dev.vars   # optional; the app works with defaults
npm run dev                      # http://localhost:5173
```

`DEV_AUTH=true` in `.dev.vars` enables the passwordless sign-in page (`/auth/dev?name=you`).
**The first account to sign in becomes admin and gets chat access.** It is opt-in precisely
so it can never be live on a deployed instance by accident.

## Deploy

```bash
npx wrangler secret put SESSION_SECRET      # openssl rand -base64 32; required
npx wrangler secret put BOOTSTRAP_SECRET    # lets you mint the first API token
npm run deploy
```

A fresh deploy has **no interactive sign-in**: `DEV_AUTH` is unset and Discord isn't
configured, so nobody can create an account. Mint yourself a token instead:

```bash
curl -X POST "https://<worker>/auth/bootstrap?name=you&label=laptop" \
  -H "x-bootstrap-secret: <BOOTSTRAP_SECRET>"
```

That returns an `rp_` token (and makes you admin, being the first user). Delete the secret
once you hold one — `npx wrangler secret delete BOOTSTRAP_SECRET` — and the door closes.

From there:

- **You and your models** edit through the token, over MCP or the REST API.
- **Everyone else** reads a plan you marked public (`set_plan_public`, or the Share button)
  straight from its link, no account required — the editor opens read-only.
- **Teammates who need to edit** want Discord OAuth, added at any time without changing the
  URL: set `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET`, point `APP_URL` at the deployed
  origin, and register `$APP_URL/auth/discord/callback` as a redirect URI.

Optional vars: `DISCORD_ALLOWLIST` (comma-separated user ids), `DISCORD_GUILD_ID`
(require guild membership), `GLM_API_KEY` / `GLM_BASE_URL` / `GLM_MODEL` for the chat.

## Baited mechanics

A beam that spawns on whoever it targeted does not live at a coordinate, and usually does not
live on a *named* player either — it goes to whoever is nearest when the cast goes off. Baits
are ordinary entities carrying an **anchor**, re-solved against the party every time the plan
is drawn, and the anchor can name a target or state a rule:

```
add_bait { plan_id, kind: "beam", pick: "closest", count: 2, from: "boss" }   # autobait
add_bait { plan_id, kind: "beam", on: "MT, M1", from: "boss", name: "Sword" } # named
add_bait { plan_id, kind: "puddle", on: "R1", name: "Desolation" }
```

- `pick: "closest" | "farthest"` re-targets itself as the party moves; `count` covers the
  nearest N (rank 1, 2, 3…), and `of` chooses what counts as a target. Ties break by id, so
  the same party always yields the same assignment.
- `beam` and `cone` fire from `from` through the target and reach the arena wall, whatever
  shape the arena is (`extend: false` to use an explicit `length`/`radius` instead).
- `donut`, `spread`, `puddle`, `stack`, `tower`, `proximity` sit on the target.
- `tether` links source and target, and is the one kind that needs a named target.

A bait's `from` is any entity, not just the boss: an add, an orb, a portal, a waymark, even a
player. Drag the source and its beams swing with it. `npm run e2e:source` covers that.

### The palette

**Add** is four things you *drag*, and where you let go is the whole of what you meant:

| dropped on | what you get |
| --- | --- |
| bare floor | the shape itself, yours to move |
| the big **Party** / **Supports** / **Damagers** panels beside the arena | one each, bound to those players — proteans and beams thrown from the boss |
| a **bait anchor** | a mechanic on whoever stands nearest it; a second of the same kind takes the second-nearest, and so on |

The five are **Circle** (a desolation), **Donut**, **Protean**, **Beam** and **Bait anchor** —
the anchor being a bare point a mechanic comes out of when it is not the boss: an add, an orb,
a portal. Nothing else is in the palette because nothing else is a mechanic; the party, the
waymarks and the arena live under Layout. `npm run e2e:palette` drags each of them onto each
kind of target.

**Scroll over anything on the arena to size it** — 8% a notch, 2% with shift held. It changes
the real dimensions rather than a display scale, so a donut still reports the radius and hole
it actually has, and a scroll over a shape a group owns resizes the whole set. Notches are
multiplied together and land as one edit. `npm run e2e:size` covers both.

What a group takes is one object with several faces, not several objects. The eight
proteans are frozen on the canvas — you cannot drag one out of its set, and a click on one
falls through — because the set is what you are holding: it appears as a row on the group's
panel, lights up when you point at that row, and leaves through the ✕ on it, all eight at
once. That is what `bond` on an entity means.

**Delete** removes the selection, **ctrl+c / ctrl+v** drops a twin under the cursor (a copied
bait keeps following its target instead), and neither fires while a text field has focus —
`npm run e2e:keys`.

The inspector edits the rule — closest/farthest, rank, source, reach — and tells you who
it lands on right now. Drag a bait and the drop is stored as an **offset** from wherever its
anchor puts it, so it still follows its target while sitting where you put it — `recentre`
clears the offset, `unbind` converts the bait into a plain shape frozen in place. (A bait
under a token is grabbed by its edge: the canvas picks the smallest thing under the pointer.)

### Points, not art

A player's hitbox in FFXIV is a point. The 72-unit token is decoration, so a beam can lap
over half a token and still miss: every coverage test in `src/shared/hits.ts` is
point-in-shape, the canvas draws the point as a white pip at each token's centre, and both
the inspector and `read_plan` say who a zone catches (`— hits MT, M2` / `— hits nobody`).
`npm run e2e:hitbox` pins the distinction with a player 30 units outside a beam whose art
overlaps it.

Everything derived redraws *while* you drag, not on release: the canvas solves anchors
against the in-flight pose, so a bait follows its target and an autobait hands its beam to
whoever you are dragging into range with the mouse still down. `npm run e2e:livedrag` holds
the button and checks the canvas has moved while the server has not.

`npm run e2e:bait -- http://localhost:59577` drives all of that through the real MCP endpoint
and a real canvas drag, including a player walking in and stealing a bait.

## MCP

Sign in → **MCP access** → create a token. Then:

```bash
claude mcp add --transport http raidplan https://<your-worker>/mcp \
  --header "Authorization: Bearer rp_…"
```

or in a client config:

```json
{
  "mcpServers": {
    "raidplan": {
      "type": "http",
      "url": "https://<your-worker>/mcp",
      "headers": { "Authorization": "Bearer rp_…" }
    }
  }
}
```

The token *is* the identity: a model sees exactly the plans that user can see, and cannot
edit a plan the user only has viewer access to. `/sse` is available for older clients.

### Tools

| | |
|---|---|
| `list_plans` `create_plan` `read_plan` `get_plan_json` `set_plan_info` | plans |
| `list_steps` `add_step` `update_step` `move_step` `delete_step` | steps |
| `list_mechs` `add_mech` `update_mech` `assign_mech` `delete_mech` | mechanics |
| `add_player` `add_enemy` `add_marker` `add_waymarks` `add_party` `add_zone` `add_text` `add_tether` `add_icon` | create |
| `move_entity` `update_entity` `delete_entity` `find_entities` `arrange_party` `set_arena` `list_assets` | edit |
| `save_encounter` `apply_encounter` `list_encounters` | the fight's arena + waymarks |
| `share_plan` `set_plan_public` | access |

`read_plan` renders the whole document as text with entity ids — start there.

To drive the endpoint without a client — the same streamable-HTTP handshake, from a shell:

```bash
export RAIDPLAN_URL=http://localhost:5173/mcp RAIDPLAN_TOKEN=rp_…
npm run mcp -- list                 # every tool
npm run mcp -- list add_zone        # one tool's JSON schema
npm run mcp -- call read_plan '{"plan_id":"plan_…"}'
```

## The document

```jsonc
{
  "id": "plan_…", "name": "M5S — quadruple", "rev": 42,
  "arena": { "shape": "square", "width": 1000, "height": 1000, "grid": { "type": "radial" } },
  "steps": [{ "id": "step_…", "name": "Step 1", "notes": "" }],
  "mechs": [{ "id": "mech_…", "name": "", "snap": "step_…", "boom": "step_…" }],
  "entities": [
    {
      "id": "player_…", "type": "player", "job": "WHM", "name": "H1",
      "x": 0, "y": -300, "rotation": 0,
      "steps": "all",                       // or ["step_…"] to exist in one step
      "overrides": { "step_…": { "x": -301, "y": 301 } }   // per-step pose
    }
  ]
}
```

- Origin is the arena centre, **+x east, +y south**; rotation `0` = north, clockwise.
- An entity exists in every step by default and holds one base pose; `overrides` is how
  movement between steps is expressed. `add_step --copy_from` carries poses forward, which
  is the normal way to build a sequence.
- **A binding belongs to the step it was declared in.** Eight donuts dropped on the party
  in step 1 mark where the party stood in step 1; step 2 can show everyone running out and
  the donuts stay where they were called. The step is recorded as `declaredIn` when the
  shape is dropped — without it (anything authored plan-wide, or over MCP) a binding
  follows its target step by step, as before.
- **A mech is one cast, written as two moments.** `snap` is the step it snapshots in,
  `boom` the step it goes off in; the shapes that carry `mech` are on the floor for
  exactly that span and nowhere else, so `steps` is not consulted for them. The span is
  read off the step order, so reordering steps re-times the mech. See `## Mechs`.
- The step rail names, reorders and deletes: **F2** (or a double-click) renames the selected
  step in place, ↑ / ↓ move it in the sequence, and because poses are keyed by step id they
  travel with it. `npm run e2e:steps` walks that. `move_step {step, to}` is the same over MCP.
- Entity types: `marker` `player` `enemy` `zone` `tether` `text` `path` `icon`.
  Zone shapes: circle, donut, cone, rect, line, arrow, triangle, exaflare, knockback,
  stack, spread, tower, eye, meteor, proximity.

## Art

Real FFXIV art is bundled under `public/assets` — job and role tokens, enemy tokens,
waymarks A-D / 1-4, field markers (attack1-8, bind, ignore, limit cut, tankbuster, targets)
and 35 arena backdrops. It comes from [XIVPlan](https://github.com/joelspadin/xivplan)
(MIT); see [NOTICE.md](NOTICE.md).

Anything with art takes an asset key, and `list_assets` is how a model browses them:

- `player.job` picks its own icon (`WHM` → the White Mage tile, `MT` → tank 1); set
  `icon: "actor/tank2"` to override.
- `enemy` art follows its hitbox size; override the same way.
- `icon` entities take any key: `add_icon plan_id icon:"marker/attack1" at:"NE"`.
- `arena.image` takes a backdrop key: `set_arena image:"arena/p12_octagon"`.

Every renderer keeps its vector fallback, so deleting `public/assets` and re-running
`npm run assets:manifest` degrades cleanly instead of breaking.

## Canvas behaviour

Two rules make a busy plan workable, both worth knowing before you go rearranging
`Scene.tsx`:

- **Draw bands.** Entities layer by type — zones, paths, waymarks, tethers, enemies,
  players, icons, text — so an AoE added after the party never buries it. Front/Back
  reorder within a band.
- **Smallest target wins.** A click picks whichever entity under the pointer covers the
  least ground, not the topmost one, and drags start from there. That is what lets you
  grab a player standing inside a raid-wide circle, or a tether crossing it.

The **Layout** buttons apply the conventions everyone plots against:

- **8/4/2-radial** — a radial grid with that many ways, for cardinal/intercardinal splits.
- **standard markers** — clockwise from north: A, 2, B, 3, C, 4, D, 1. Markers already in
  the plan get moved rather than skipped, so it doubles as "put them back".
- **PF positions** — the party-finder clock on the waymark ring, each slot a little inside
  its own mark so the mark stays visible under nobody: MT N, R2 NE, H2 E, M2 SE, OT S, M1 SW, H1 W, R1 NW. The melees hold the two
  southern diagonals, behind the boss. It arranges the players already in the plan; the
  older D1-D4 names map onto M1/M2/R1/R2, D1/D2 being the melees.

**PF positions** honours the "Drag moves" selector, so you can restage a single step
without touching the rest of the plan. `arrange_party` and `add_waymarks` are the same
thing over MCP.

## Encounter markers

Waymarks belong to the fight, not to one diagram. Name a plan's **encounter** (the field
beside its name) and **save for fight**: the arena and the eight waymark positions are
stored under that name, and every later plan for the encounter — from the UI or from
`create_plan {encounter}` — opens on the same floor with the same markers. **use saved**
puts them back on a plan that has drifted.

### The waymark layer

Marks go down before the pull and never move again, so on the ordinary canvas they are
scenery: a drag aimed at a mechanic cannot nudge one, and a click on one falls through to
whatever is underneath. **move waymarks** raises their own layer — now the marks drag and
everything else is the frozen, dimmed thing — and **done with waymarks** puts you back.
`npm run e2e:markers` walks that whole gesture.

Three rules follow from that, and all three are enforced rather than documented-and-hoped:

- A waymark never takes a per-step override. Dragging one always moves it in every step,
  because a fight cannot have a different A depending on which mechanic you are looking at.
- A waymark is in every step regardless of its `steps` list: it belongs to the plan.
- Applying a setup removes markers it does not mention, so a fight that only uses A and B
  does not inherit a stray C.

Setups are per user, so two statics can disagree about where D goes. Over MCP:
`save_encounter`, `apply_encounter`, `list_encounters`.

`npm run e2e -- http://localhost:5173` drives a real browser and asserts every entity
type can still be grabbed and moved (run `npm run dev` first). It exists because a stray
`listening={false}` once made half the canvas unclickable, and nothing else catches that.
`npm run e2e:access` checks that a stranger can read a plan neither over HTTP nor over the
sync socket — the socket half matters because the SDK pushes state the moment a connection
is accepted, so the ACL has to be enforced in the Worker, before routing.

## Mechs

A cast is three moments: it appears, it snapshots, it goes off. Plans are written from
the last two — "snapshot here", "explodes there" — and the first is usually not worth a
step of its own.

So a mechanic is a **slot** in the rail beside the steps, holding a snapshot step, an
explosion step, and the shapes that are the mechanic. Two bindings, and everything else
follows from them:

- **Timing.** Its shapes exist from the snapshot to the explosion, inclusive, and in no
  other step. Nothing is tagged step by step; move either end and the whole mech re-times.
  A step deleted out from under one end collapses the mech onto the other; delete both and
  the mech goes with them.
- **Aim.** Its bindings are solved in the snapshot step — where the party stood when the
  game took the picture. The steps after it are people walking out of a shape that stays
  put, which is the entire content of most raid plans. (That is `declaredIn` above, with
  the mech's snapshot overriding whatever step a shape happened to be dropped in.)

Until it goes off it is a telegraph, and it is drawn faint; in its explosion step it is
drawn solid.

In the rail, a mech is a **box beside the step list**, spanning the rows of the steps it is
on the floor for — top edge at the snapshot, `BOOM` bar at the explosion — so the fight
reads down the page and two casts in the air at once sit in adjacent columns.

The box is also the control. A mech never *moves* — it is two moments in the fight — so a
drag always takes hold of one end: grab the top half and the snapshot follows the pointer,
the bottom half and the explosion does, in either direction, so the same grab stretches it
and shortens it. The step rows are the ruler and the drag is previewed as you cross them.
Click it to open it, and rename it with **F2** or a double-click — with a mech open, F2
renames the mech; otherwise it renames the selected step.

Open a new slot with **New mech here** (it snapshots in the step you are on), and
everything you drop while it is open joins it, floor, group chip or bait anchor alike. An
unnamed slot goes by whatever went into it first, so a donut on the party is "Donut" until
you call it Ice Missile. The ✕ takes the slot and its shapes together; the Inspector's mech
select moves an existing shape in or out of one.

`npm run e2e:mechs` walks the whole thing: open a slot, drop eight donuts on the party,
set the explosion two steps later, run the party to the north wall, and check the donuts
stayed on the snapshot.

## Access

- **Discord OAuth** for people, **`rp_` bearer tokens** for models and scripts — both resolve
  to the same user and the same per-plan ACL (owner / editor / viewer, plus link-sharing).
- The in-app chat (bottom right) is gated on a per-user `chat` flag so a shared model key
  stays under control. Admins can flip it: `PATCH /api/users/:id {"chat":true}`.

## Layout

```
src/shared/    schema.ts (zod document) · ops.ts (all mutations) · apply.ts (op dispatch)
               jobs.ts · assets.ts (generated art catalogue)
src/server/    index.ts (router) · plan-agent.ts (DO + sync) · registry.ts (users/ACL)
               tools.ts (the one tool table) · mcp.ts · chat.ts · auth.ts
src/client/    Editor.tsx · Inspector.tsx · ChatPanel.tsx · canvas/Scene.tsx (Konva)
```
