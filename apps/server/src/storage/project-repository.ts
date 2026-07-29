import { createHash, timingSafeEqual } from "node:crypto";
import type { ErrorHubDatabase } from "./database.js";
import type { SecretStore } from "../secrets.js";
import { validateWebhookDestination } from "../webhooks/destination.js";

export type ForwardingMode = "disabled" | "shadow";
export type WebhookMode = "disabled" | "live";

export interface ProjectInput {
  readonly id: number;
  readonly slug: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly createdAt: string;
}

export interface IngestKeyInput {
  readonly projectId: number;
  readonly environment: string;
  readonly publicKey: string;
  readonly allowedOrigins: readonly string[];
  readonly forwardingMode: ForwardingMode;
  readonly forwardingSecretRef: string | null;
  readonly webhookMode: WebhookMode;
  readonly webhookTargetUrl: string | null;
  readonly webhookSecretRef: string | null;
  readonly enabledAt: string | null;
  readonly webhookSecrets?: Pick<SecretStore, "references">;
}

export interface VerifiedIngestKey {
  readonly id: number;
  readonly projectId: number;
  readonly projectSlug: string;
  readonly projectName: string;
  readonly enabled: boolean;
  readonly environment: string;
  readonly allowedOrigins: readonly string[];
  readonly forwardingMode: ForwardingMode;
  readonly forwardingSecretRef: string | null;
  readonly webhookMode: WebhookMode;
  readonly webhookTargetUrl: string | null;
  readonly webhookSecretRef: string | null;
  readonly enabledAt: string | null;
}

interface IngestKeyRow {
  id: number;
  project_id: number;
  project_slug: string;
  project_name: string;
  project_enabled: 0 | 1;
  environment: string;
  public_key_hash: Buffer;
  cors_origins_json: string;
  forwarding_mode: ForwardingMode;
  forwarding_secret_ref: string | null;
  webhook_mode: WebhookMode;
  webhook_target_url: string | null;
  webhook_secret_ref: string | null;
  enabled_at: string | null;
}

export class ProjectRepository {
  public constructor(private readonly database: ErrorHubDatabase) {}

  public create(input: ProjectInput): void {
    assertPositiveInteger(input.id, "project id");
    assertNonEmpty(input.slug, "project slug");
    assertNonEmpty(input.name, "project name");
    assertTimestamp(input.createdAt, "project creation timestamp");
    this.database
      .prepare(
        `INSERT INTO projects
           (id, slug, name, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.slug,
        input.name,
        input.enabled ? 1 : 0,
        input.createdAt,
        input.createdAt,
      );
  }

  public setIngestKey(input: IngestKeyInput): void {
    assertPositiveInteger(input.projectId, "project id");
    assertNonEmpty(input.environment, "ingest environment");
    assertNonEmpty(input.publicKey, "public key");
    if (input.enabledAt !== null) {
      assertTimestamp(input.enabledAt, "webhook enabled timestamp");
    }
    const destination =
      input.webhookMode === "live"
        ? validateWebhookDestination(
            input.webhookTargetUrl ?? "",
            input.webhookSecretRef ?? "",
            requiredSecretCatalog(input.webhookSecrets),
          )
        : { targetUrl: null, secretRef: null };
    if (input.webhookMode === "live" && input.enabledAt === null) {
      throw new TypeError("live webhook requires an enabled timestamp");
    }
    const enabledAt = input.webhookMode === "live" ? input.enabledAt : null;
    const now = enabledAt ?? new Date().toISOString();
    const origins = [...new Set(input.allowedOrigins)].sort(compareCodePoints);
    this.database
      .prepare(
        `INSERT INTO project_ingest_keys (
           project_id, environment, public_key_hash, cors_origins_json,
           forwarding_mode, forwarding_secret_ref, webhook_mode,
           webhook_target_url, webhook_secret_ref, enabled_at, created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, environment) DO UPDATE SET
           public_key_hash = excluded.public_key_hash,
           cors_origins_json = excluded.cors_origins_json,
           forwarding_mode = excluded.forwarding_mode,
           forwarding_secret_ref = excluded.forwarding_secret_ref,
           webhook_mode = excluded.webhook_mode,
           webhook_target_url = excluded.webhook_target_url,
           webhook_secret_ref = excluded.webhook_secret_ref,
           enabled_at = excluded.enabled_at,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.projectId,
        input.environment,
        hashPublicKey(input.publicKey),
        JSON.stringify(origins),
        input.forwardingMode,
        input.forwardingSecretRef,
        input.webhookMode,
        destination.targetUrl,
        destination.secretRef,
        enabledAt,
        now,
        now,
      );
  }

  public enableWebhookDestination(input: {
    readonly projectId: number;
    readonly environment: string;
    readonly targetUrl: string;
    readonly secretRef: string;
    readonly enabledAt: string;
    readonly secrets: Pick<SecretStore, "references">;
  }): void {
    assertPositiveInteger(input.projectId, "project id");
    assertNonEmpty(input.environment, "ingest environment");
    assertNonEmpty(input.targetUrl, "webhook target URL");
    assertNonEmpty(input.secretRef, "webhook secret reference");
    assertTimestamp(input.enabledAt, "webhook enabled timestamp");
    const destination = validateWebhookDestination(
      input.targetUrl,
      input.secretRef,
      input.secrets,
    );
    const result = this.database
      .prepare(
        `UPDATE project_ingest_keys
         SET webhook_mode = 'live', webhook_target_url = ?,
             webhook_secret_ref = ?,
             enabled_at = CASE
               WHEN webhook_mode = 'disabled' THEN ?
               ELSE enabled_at
             END,
             updated_at = ?
         WHERE project_id = ? AND environment = ?`,
      )
      .run(
        destination.targetUrl,
        destination.secretRef,
        input.enabledAt,
        input.enabledAt,
        input.projectId,
        input.environment,
      );
    if (result.changes !== 1) {
      throw new Error("ingest key does not exist for webhook destination");
    }
  }

  public disableWebhookDestination(input: {
    readonly projectId: number;
    readonly environment: string;
    readonly disabledAt: string;
  }): void {
    assertPositiveInteger(input.projectId, "project id");
    assertNonEmpty(input.environment, "ingest environment");
    assertTimestamp(input.disabledAt, "webhook disabled timestamp");
    const result = this.database
      .prepare(
        `UPDATE project_ingest_keys
         SET webhook_mode = 'disabled', webhook_target_url = NULL,
             webhook_secret_ref = NULL, enabled_at = NULL, updated_at = ?
         WHERE project_id = ? AND environment = ?`,
      )
      .run(input.disabledAt, input.projectId, input.environment);
    if (result.changes !== 1) {
      throw new Error("ingest key does not exist for webhook destination");
    }
  }

  /**
   * Looks up all keys for the trusted numeric project and compares every hash.
   * The loop deliberately does not short-circuit on a match.
   */
  public verifyIngestKey(
    projectId: number,
    publicKey: string,
  ): VerifiedIngestKey | null {
    if (!Number.isSafeInteger(projectId) || projectId <= 0) {
      return null;
    }
    const rows = this.database
      .prepare(
        `SELECT
           k.id, k.project_id, p.slug AS project_slug,
           p.name AS project_name, p.enabled AS project_enabled,
           k.environment, k.public_key_hash, k.cors_origins_json,
           k.forwarding_mode, k.forwarding_secret_ref, k.webhook_mode,
           k.webhook_target_url, k.webhook_secret_ref, k.enabled_at
         FROM project_ingest_keys AS k
         INNER JOIN projects AS p ON p.id = k.project_id
         WHERE k.project_id = ?
         ORDER BY k.id`,
      )
      .all(projectId) as IngestKeyRow[];

    let match: IngestKeyRow | null = null;
    for (const row of rows) {
      const matches = matchesPublicKeyHash(row.public_key_hash, publicKey);
      if (matches) {
        match = row;
      }
    }
    if (match === null) {
      return null;
    }

    return {
      id: match.id,
      projectId: match.project_id,
      projectSlug: match.project_slug,
      projectName: match.project_name,
      enabled: match.project_enabled === 1,
      environment: match.environment,
      allowedOrigins: parseOrigins(match.cors_origins_json),
      forwardingMode: match.forwarding_mode,
      forwardingSecretRef: match.forwarding_secret_ref,
      webhookMode: match.webhook_mode,
      webhookTargetUrl: match.webhook_target_url,
      webhookSecretRef: match.webhook_secret_ref,
      enabledAt: match.enabled_at,
    };
  }
}

function requiredSecretCatalog(
  value: Pick<SecretStore, "references"> | undefined,
): Pick<SecretStore, "references"> {
  if (value === undefined) {
    throw new TypeError("live webhook requires a typed secret store");
  }
  return value;
}

export function hashPublicKey(publicKey: string): Buffer {
  assertNonEmpty(publicKey, "public key");
  return createHash("sha256").update(publicKey, "utf8").digest();
}

export function matchesPublicKeyHash(
  storedHash: Uint8Array,
  publicKey: string,
): boolean {
  const candidate = hashPublicKey(publicKey);
  const validLength = storedHash.byteLength === candidate.byteLength;
  const comparable = validLength
    ? Buffer.from(storedHash)
    : Buffer.alloc(candidate.byteLength);
  const equal = timingSafeEqual(comparable, candidate);
  return validLength && equal;
}

function parseOrigins(value: string): readonly string[] {
  const parsed: unknown = JSON.parse(value);
  if (
    !Array.isArray(parsed) ||
    !parsed.every((entry) => typeof entry === "string")
  ) {
    throw new Error("stored CORS origins are invalid");
  }
  return parsed;
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
}

function assertNonEmpty(value: string, field: string): void {
  if (value.length === 0) {
    throw new TypeError(`${field} must not be empty`);
  }
}

function assertTimestamp(value: string, field: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${field} must be an ISO timestamp`);
  }
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
