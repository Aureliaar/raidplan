import { DurableObject } from "cloudflare:workers";
import type { AppEnv } from "./env";
import type { EncounterSetup, EncounterSummary, PlanRole, PlanSummary, User } from "../shared/schema";

/** "M5S — Dancing Green" and "m5s — dancing green" are the same fight. */
const encounterKey = (name: string) => name.trim().toLowerCase();

/**
 * Single global Durable Object holding users, API tokens, the plan index and
 * per-plan access control. One instance, named "main".
 *
 * Plan *contents* live in PlanAgent; this only knows who may touch what.
 */
export class Registry extends DurableObject<AppEnv> {
  constructor(ctx: DurableObjectState, env: AppEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  private migrate() {
    const sql = this.ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      name TEXT NOT NULL,
      avatar TEXT,
      createdAt INTEGER NOT NULL,
      admin INTEGER NOT NULL DEFAULT 0,
      chat INTEGER NOT NULL DEFAULT 0
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS tokens (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      hash TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      lastUsedAt INTEGER
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS plans (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      encounter TEXT NOT NULL DEFAULT '',
      ownerId TEXT NOT NULL,
      isPublic INTEGER NOT NULL DEFAULT 0,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    )`);
    // One decided floor per encounter, per person: the arena and where that
    // group put the waymarks, so every plan for the fight starts from it.
    sql.exec(`CREATE TABLE IF NOT EXISTS encounters (
      ownerId TEXT NOT NULL,
      encounter TEXT NOT NULL,
      setup TEXT NOT NULL,
      updatedAt INTEGER NOT NULL,
      PRIMARY KEY (ownerId, encounter)
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS acl (
      planId TEXT NOT NULL,
      userId TEXT NOT NULL,
      role TEXT NOT NULL,
      PRIMARY KEY (planId, userId)
    )`);
  }

  /* ------------------------------------------------------------------ users */

  async upsertUser(input: {
    id: string;
    provider: string;
    name: string;
    avatar?: string;
  }): Promise<User> {
    const existing = this.getUserRow(input.id);
    const now = Date.now();
    // The very first account to sign in becomes admin and gets chat access.
    const isFirst = [...this.ctx.storage.sql.exec(`SELECT COUNT(*) AS n FROM users`)][0].n === 0;
    if (existing) {
      this.ctx.storage.sql.exec(
        `UPDATE users SET name = ?, avatar = ? WHERE id = ?`,
        input.name,
        input.avatar ?? null,
        input.id
      );
    } else {
      this.ctx.storage.sql.exec(
        `INSERT INTO users (id, provider, name, avatar, createdAt, admin, chat) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        input.id,
        input.provider,
        input.name,
        input.avatar ?? null,
        now,
        isFirst ? 1 : 0,
        isFirst ? 1 : 0
      );
    }
    return this.getUser(input.id) as Promise<User>;
  }

  private getUserRow(id: string): Record<string, unknown> | undefined {
    return [...this.ctx.storage.sql.exec(`SELECT * FROM users WHERE id = ?`, id)][0];
  }

  async getUser(id: string): Promise<User | null> {
    const row = this.getUserRow(id);
    return row ? rowToUser(row) : null;
  }

  async listUsers(): Promise<User[]> {
    return [...this.ctx.storage.sql.exec(`SELECT * FROM users ORDER BY createdAt`)].map(rowToUser);
  }

  async setUserFlags(id: string, flags: { admin?: boolean; chat?: boolean }): Promise<User | null> {
    if (flags.admin !== undefined)
      this.ctx.storage.sql.exec(`UPDATE users SET admin = ? WHERE id = ?`, flags.admin ? 1 : 0, id);
    if (flags.chat !== undefined)
      this.ctx.storage.sql.exec(`UPDATE users SET chat = ? WHERE id = ?`, flags.chat ? 1 : 0, id);
    return this.getUser(id);
  }

  /* ----------------------------------------------------------------- tokens */

  async createToken(userId: string, label: string, hash: string): Promise<{ id: string }> {
    const id = crypto.randomUUID();
    this.ctx.storage.sql.exec(
      `INSERT INTO tokens (id, userId, hash, label, createdAt) VALUES (?, ?, ?, ?, ?)`,
      id,
      userId,
      hash,
      label,
      Date.now()
    );
    return { id };
  }

  async listTokens(userId: string) {
    return [
      ...this.ctx.storage.sql.exec(
        `SELECT id, label, createdAt, lastUsedAt FROM tokens WHERE userId = ? ORDER BY createdAt DESC`,
        userId
      ),
    ];
  }

  async revokeToken(userId: string, id: string): Promise<boolean> {
    this.ctx.storage.sql.exec(`DELETE FROM tokens WHERE id = ? AND userId = ?`, id, userId);
    return true;
  }

  /** Look up the user behind an API token hash, stamping last use. */
  async userForTokenHash(hash: string): Promise<User | null> {
    const row = [...this.ctx.storage.sql.exec(`SELECT userId FROM tokens WHERE hash = ?`, hash)][0];
    if (!row) return null;
    this.ctx.storage.sql.exec(`UPDATE tokens SET lastUsedAt = ? WHERE hash = ?`, Date.now(), hash);
    return this.getUser(row.userId as string);
  }

  /* ------------------------------------------------------------------ plans */

  async registerPlan(input: {
    id: string;
    name: string;
    encounter?: string;
    ownerId: string;
  }): Promise<void> {
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO plans (id, name, encounter, ownerId, isPublic, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, COALESCE((SELECT isPublic FROM plans WHERE id = ?), 0), COALESCE((SELECT createdAt FROM plans WHERE id = ?), ?), ?)`,
      input.id,
      input.name,
      input.encounter ?? "",
      input.ownerId,
      input.id,
      input.id,
      now,
      now
    );
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO acl (planId, userId, role) VALUES (?, ?, 'owner')`,
      input.id,
      input.ownerId
    );
  }

  async touchPlan(id: string, meta: { name?: string; encounter?: string }): Promise<void> {
    this.ctx.storage.sql.exec(
      `UPDATE plans SET name = COALESCE(?, name), encounter = COALESCE(?, encounter), updatedAt = ? WHERE id = ?`,
      meta.name ?? null,
      meta.encounter ?? null,
      Date.now(),
      id
    );
  }

  async deletePlan(id: string): Promise<void> {
    this.ctx.storage.sql.exec(`DELETE FROM plans WHERE id = ?`, id);
    this.ctx.storage.sql.exec(`DELETE FROM acl WHERE planId = ?`, id);
  }

  async getPlanMeta(id: string): Promise<{
    id: string;
    name: string;
    encounter: string;
    ownerId: string;
    isPublic: boolean;
    createdAt: number;
    updatedAt: number;
  } | null> {
    const row = [...this.ctx.storage.sql.exec(`SELECT * FROM plans WHERE id = ?`, id)][0];
    if (!row) return null;
    return {
      id: row.id as string,
      name: row.name as string,
      encounter: row.encounter as string,
      ownerId: row.ownerId as string,
      isPublic: !!row.isPublic,
      createdAt: row.createdAt as number,
      updatedAt: row.updatedAt as number,
    };
  }

  async setPublic(id: string, isPublic: boolean): Promise<void> {
    this.ctx.storage.sql.exec(`UPDATE plans SET isPublic = ? WHERE id = ?`, isPublic ? 1 : 0, id);
  }

  async listPlansForUser(userId: string): Promise<PlanSummary[]> {
    return [
      ...this.ctx.storage.sql.exec(
        `SELECT p.id, p.name, p.encounter, p.ownerId, p.updatedAt, a.role
         FROM plans p JOIN acl a ON a.planId = p.id
         WHERE a.userId = ? ORDER BY p.updatedAt DESC`,
        userId
      ),
    ].map((r) => ({
      id: r.id as string,
      name: r.name as string,
      encounter: r.encounter as string,
      ownerId: r.ownerId as string,
      updatedAt: r.updatedAt as number,
      role: r.role as PlanRole,
    }));
  }

  /* ------------------------------------------------------------- encounters */

  async saveEncounter(ownerId: string, encounter: string, setup: EncounterSetup): Promise<void> {
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO encounters (ownerId, encounter, setup, updatedAt) VALUES (?, ?, ?, ?)`,
      ownerId,
      encounterKey(encounter),
      JSON.stringify(setup),
      Date.now()
    );
  }

  async getEncounter(ownerId: string, encounter: string): Promise<EncounterSetup | null> {
    const row = [
      ...this.ctx.storage.sql.exec(
        `SELECT setup FROM encounters WHERE ownerId = ? AND encounter = ?`,
        ownerId,
        encounterKey(encounter)
      ),
    ][0];
    return row ? (JSON.parse(row.setup as string) as EncounterSetup) : null;
  }

  async listEncounters(ownerId: string): Promise<EncounterSummary[]> {
    return [
      ...this.ctx.storage.sql.exec(
        `SELECT encounter, setup, updatedAt FROM encounters WHERE ownerId = ? ORDER BY updatedAt DESC`,
        ownerId
      ),
    ].map((r) => ({
      encounter: r.encounter as string,
      markers: (JSON.parse(r.setup as string) as EncounterSetup).markers.length,
      updatedAt: r.updatedAt as number,
    }));
  }

  async deleteEncounter(ownerId: string, encounter: string): Promise<void> {
    this.ctx.storage.sql.exec(
      `DELETE FROM encounters WHERE ownerId = ? AND encounter = ?`,
      ownerId,
      encounterKey(encounter)
    );
  }

  /* -------------------------------------------------------------------- acl */

  /** The role a user has on a plan; "viewer" for anyone if the plan is public. */
  async roleFor(userId: string | null, planId: string): Promise<PlanRole | null> {
    if (userId) {
      const row = [
        ...this.ctx.storage.sql.exec(`SELECT role FROM acl WHERE planId = ? AND userId = ?`, planId, userId),
      ][0];
      if (row) return row.role as PlanRole;
    }
    const plan = [...this.ctx.storage.sql.exec(`SELECT isPublic FROM plans WHERE id = ?`, planId)][0];
    if (plan?.isPublic) return "viewer";
    return null;
  }

  async share(planId: string, userId: string, role: PlanRole): Promise<void> {
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO acl (planId, userId, role) VALUES (?, ?, ?)`,
      planId,
      userId,
      role
    );
  }

  async unshare(planId: string, userId: string): Promise<void> {
    this.ctx.storage.sql.exec(`DELETE FROM acl WHERE planId = ? AND userId = ? AND role != 'owner'`, planId, userId);
  }

  async listCollaborators(planId: string) {
    return [
      ...this.ctx.storage.sql.exec(
        `SELECT a.userId, a.role, u.name, u.avatar FROM acl a LEFT JOIN users u ON u.id = a.userId WHERE a.planId = ?`,
        planId
      ),
    ];
  }
}

function rowToUser(row: Record<string, unknown>): User {
  return {
    id: row.id as string,
    provider: row.provider as string,
    name: row.name as string,
    avatar: (row.avatar as string | null) ?? undefined,
    createdAt: row.createdAt as number,
    admin: !!row.admin,
    chat: !!row.chat,
  };
}

export function registry(env: AppEnv): DurableObjectStub<Registry> {
  return env.Registry.get(env.Registry.idFromName("main")) as DurableObjectStub<Registry>;
}
