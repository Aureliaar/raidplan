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
| `list_steps` `add_step` `update_step` `delete_step` | steps |
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
- **PF positions** — the party-finder clock: MT N, R2 NE, H2 E, M2 SE, OT S, R1 SW, H1 W,
  M1 NW. It arranges the players already in the plan; D1-D4 map onto M1/M2/R1/R2.

**PF positions** honours the "Drag moves" selector, so you can restage a single step
without touching the rest of the plan. `arrange_party` and `add_waymarks` are the same
thing over MCP.

## Encounter markers

Waymarks belong to the fight, not to one diagram. Name a plan's **encounter** (the field
beside its name) and **save for fight**: the arena and the eight waymark positions are
stored under that name, and every later plan for the encounter — from the UI or from
`create_plan {encounter}` — opens on the same floor with the same markers. **use saved**
puts them back on a plan that has drifted.

Two rules follow from that, and both are enforced rather than documented-and-hoped:

- A waymark never takes a per-step override. Dragging one always moves it in every step,
  because a fight cannot have a different A depending on which mechanic you are looking at.
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
