import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { parseToolAllowlist, type CopilotPaths } from "./settings";

export type SessionStatus =
  | "creating"
  | "created"
  | "sending"
  | "sent"
  | "uncertain"
  | "completed"
  | "failed"
  | "cancelled";

export interface OwnedSession {
  sessionId: string;
  installationId: string;
  orgId: string;
  runId: string;
  recipeId: string;
  workItemId: string;
  activationId: string;
  copilotHome: string;
  workingDirectory: string;
  availableTools: string[];
  createdAt: string;
  status: SessionStatus;
  messageId?: string;
  pendingPermissions: StoredPendingPermission[];
}

export interface StoredPendingPermission {
  promptId: string;
  requestId: string;
  toolName: string;
  requestDigest: string;
  expiresAt: number;
}

interface SessionManifest {
  version: 1;
  revision: number;
  entries: OwnedSession[];
}

const manifestName = "github-copilot-sessions-v1.json";
const maximumManifestBytes = 2 * 1024 * 1024;
const writeQueues = new Map<string, Promise<void>>();

export class CopilotSessionStore {
  private readonly manifestPath: string;

  constructor(
    readonly paths: CopilotPaths,
    readonly installationId: string,
    readonly orgId: string,
  ) {
    this.manifestPath = path.join(paths.stateDir, manifestName);
  }

  async listConfirmed(): Promise<OwnedSession[]> {
    return (await this.listAll())
      .filter(
        (entry) =>
          entry.status !== "creating" &&
          entry.status !== "uncertain",
      )
      .sort((left, right) => left.sessionId.localeCompare(right.sessionId));
  }

  async listAll(): Promise<OwnedSession[]> {
    const manifest = await this.read();
    return manifest.entries
      .filter(
        (entry) =>
          entry.copilotHome === this.paths.copilotHome &&
          entry.workingDirectory === this.paths.workingDirectory &&
          entry.installationId === this.installationId &&
          entry.orgId === this.orgId,
      )
      .sort((left, right) => left.sessionId.localeCompare(right.sessionId));
  }

  async get(sessionId: string): Promise<OwnedSession | undefined> {
    const manifest = await this.read();
    return manifest.entries.find(
      (entry) =>
        entry.sessionId === sessionId &&
        entry.copilotHome === this.paths.copilotHome &&
        entry.workingDirectory === this.paths.workingDirectory &&
        entry.installationId === this.installationId &&
        entry.orgId === this.orgId,
    );
  }

  async getByRunId(runId: string): Promise<OwnedSession | undefined> {
    const manifest = await this.read();
    return manifest.entries.find(
      (entry) =>
        entry.runId === runId &&
        entry.copilotHome === this.paths.copilotHome &&
        entry.workingDirectory === this.paths.workingDirectory &&
        entry.installationId === this.installationId &&
        entry.orgId === this.orgId,
    );
  }

  async addPendingPermission(
    sessionId: string,
    pending: StoredPendingPermission,
  ): Promise<void> {
    await this.update((manifest) => {
      const entry = this.requireEntry(manifest, sessionId);
      if (
        entry.pendingPermissions.some(
          (existing) =>
            existing.promptId === pending.promptId ||
            existing.requestId === pending.requestId,
        )
      ) {
        throw new Error("The Copilot permission request is already registered.");
      }
      entry.pendingPermissions.push(pending);
    });
  }

  async consumePendingPermission(
    sessionId: string,
    promptId: string,
  ): Promise<StoredPendingPermission | undefined> {
    let consumed: StoredPendingPermission | undefined;
    await this.update((manifest) => {
      const entry = this.requireEntry(manifest, sessionId);
      const index = entry.pendingPermissions.findIndex(
        (pending) => pending.promptId === promptId,
      );
      if (index >= 0) {
        consumed = entry.pendingPermissions.splice(index, 1)[0];
      }
    });
    return consumed;
  }

  async listPendingPermissions(
    sessionId: string,
  ): Promise<StoredPendingPermission[]> {
    const entry = await this.get(sessionId);
    if (!entry) {
      throw new Error("The Copilot session is not registered to this connector.");
    }
    return entry.pendingPermissions;
  }

  async clearPendingPermissions(sessionId: string): Promise<void> {
    await this.update((manifest) => {
      this.requireEntry(manifest, sessionId).pendingPermissions = [];
    });
  }

  async begin(entry: Omit<OwnedSession, "status" | "createdAt">): Promise<void> {
    if (
      entry.installationId !== this.installationId ||
      entry.orgId !== this.orgId ||
      entry.copilotHome !== this.paths.copilotHome ||
      entry.workingDirectory !== this.paths.workingDirectory
    ) {
      throw new Error("The Copilot session record does not match this installation.");
    }
    await this.update((manifest) => {
      if (
        manifest.entries.some(
          (existing) =>
            existing.sessionId === entry.sessionId ||
            (existing.runId === entry.runId &&
              existing.installationId === entry.installationId &&
            existing.orgId === entry.orgId &&
            existing.copilotHome === entry.copilotHome &&
              existing.workingDirectory === entry.workingDirectory),
        )
      ) {
        throw new Error("This run already has a Copilot session record.");
      }
      manifest.entries.push({
        ...entry,
        createdAt: new Date().toISOString(),
        status: "creating",
        pendingPermissions: [],
      });
    });
  }

  async setStatus(
    sessionId: string,
    status: SessionStatus,
    messageId?: string,
  ): Promise<void> {
    await this.update((manifest) => {
      const entry = this.requireEntry(manifest, sessionId);
      if (!canTransition(entry.status, status)) {
        throw new Error("The Copilot session status transition is invalid.");
      }
      entry.status = status;
      if (messageId !== undefined) {
        entry.messageId = messageId;
      }
    });
  }

  async setActivationId(sessionId: string, activationId: string): Promise<void> {
    await this.update((manifest) => {
      const entry = this.requireEntry(manifest, sessionId);
      if (
        entry.status === "completed" ||
        entry.status === "failed" ||
        entry.status === "cancelled"
      ) {
        throw new Error("A terminal Copilot session cannot be rebound.");
      }
      entry.activationId = activationId;
    });
  }

  async revision(): Promise<number> {
    return (await this.read()).revision;
  }

  private async update(change: (manifest: SessionManifest) => void): Promise<void> {
    await serializeWrite(this.manifestPath, async () => {
      const manifest = await this.read();
      change(manifest);
      manifest.revision += 1;
      await this.write(manifest);
    });
  }

  private requireEntry(
    manifest: SessionManifest,
    sessionId: string,
  ): OwnedSession {
    const entry = manifest.entries.find(
      (candidate) =>
        candidate.sessionId === sessionId &&
        candidate.copilotHome === this.paths.copilotHome &&
        candidate.workingDirectory === this.paths.workingDirectory &&
        candidate.installationId === this.installationId &&
        candidate.orgId === this.orgId,
    );
    if (!entry) {
      throw new Error("The Copilot session is not registered to this connector.");
    }
    return entry;
  }

  private async read(): Promise<SessionManifest> {
    let handle;
    try {
      handle = await open(
        this.manifestPath,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
    } catch (error) {
      if (isMissing(error)) {
        return { version: 1, revision: 0, entries: [] };
      }
      throw new Error("Could not read the connector-owned session manifest.");
    }
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || stats.size > maximumManifestBytes) {
        throw new Error("The connector-owned session manifest is invalid.");
      }
      const parsed: unknown = JSON.parse(await handle.readFile("utf8"));
      return validateManifest(parsed);
    } catch {
      throw new Error(
        "The connector-owned session manifest is damaged or uses an unsupported schema.",
      );
    } finally {
      await handle.close();
    }
  }

  private async write(manifest: SessionManifest): Promise<void> {
    const temporaryPath = `${this.manifestPath}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(JSON.stringify(manifest), "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, this.manifestPath);
    } catch {
      if (handle) {
        await handle.close().catch(() => undefined);
      }
      await unlink(temporaryPath).catch(() => undefined);
      throw new Error("Could not persist the connector-owned session manifest.");
    }
  }
}

function validateManifest(value: unknown): SessionManifest {
  if (!isRecord(value) || value.version !== 1 || !Number.isSafeInteger(value.revision)) {
    throw new Error("Unsupported manifest schema.");
  }
  if (!Array.isArray(value.entries)) {
    throw new Error("Invalid manifest entries.");
  }
  const entries = value.entries.map((entry): OwnedSession => {
    if (
      !isRecord(entry) ||
      typeof entry.sessionId !== "string" ||
      !entry.sessionId ||
      typeof entry.installationId !== "string" ||
      !entry.installationId ||
      typeof entry.orgId !== "string" ||
      !entry.orgId ||
      typeof entry.runId !== "string" ||
      !entry.runId ||
      typeof entry.recipeId !== "string" ||
      !entry.recipeId ||
      typeof entry.workItemId !== "string" ||
      !entry.workItemId ||
      typeof entry.activationId !== "string" ||
      !entry.activationId ||
      typeof entry.copilotHome !== "string" ||
      !path.isAbsolute(entry.copilotHome) ||
      typeof entry.workingDirectory !== "string" ||
      !path.isAbsolute(entry.workingDirectory) ||
      !Array.isArray(entry.availableTools) ||
      !entry.availableTools.every((tool) => typeof tool === "string") ||
      typeof entry.createdAt !== "string" ||
      !Number.isFinite(Date.parse(entry.createdAt)) ||
      !isSessionStatus(entry.status) ||
      (entry.messageId !== undefined && typeof entry.messageId !== "string") ||
      (entry.pendingPermissions !== undefined &&
        (!Array.isArray(entry.pendingPermissions) ||
          !entry.pendingPermissions.every(isStoredPendingPermission)))
    ) {
      throw new Error("Invalid manifest record.");
    }
    return {
      sessionId: entry.sessionId,
      installationId: entry.installationId,
      orgId: entry.orgId,
      runId: entry.runId,
      recipeId: entry.recipeId,
      workItemId: entry.workItemId,
      activationId: entry.activationId,
      copilotHome: entry.copilotHome,
      workingDirectory: entry.workingDirectory,
      availableTools: parseToolAllowlist(entry.availableTools.join(",")),
      createdAt: entry.createdAt,
      status: entry.status,
      ...(typeof entry.messageId === "string" ? { messageId: entry.messageId } : {}),
      pendingPermissions: entry.pendingPermissions ?? [],
    };
  });
  const sessionIds = new Set<string>();
  for (const entry of entries) {
    if (sessionIds.has(entry.sessionId)) {
      throw new Error("Duplicate session ID.");
    }
    sessionIds.add(entry.sessionId);
  }
  return {
    version: 1,
    revision: value.revision as number,
    entries,
  };
}

function isStoredPendingPermission(value: unknown): value is StoredPendingPermission {
  return (
    isRecord(value) &&
    typeof value.promptId === "string" &&
    value.promptId.length > 0 &&
    typeof value.requestId === "string" &&
    value.requestId.length > 0 &&
    typeof value.toolName === "string" &&
    value.toolName.length > 0 &&
    typeof value.requestDigest === "string" &&
    /^[a-f0-9]{64}$/.test(value.requestDigest) &&
    typeof value.expiresAt === "number" &&
    Number.isSafeInteger(value.expiresAt)
  );
}

function isSessionStatus(value: unknown): value is SessionStatus {
  return (
    value === "creating" ||
    value === "created" ||
    value === "sending" ||
    value === "sent" ||
    value === "uncertain" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled"
  );
}

function canTransition(from: SessionStatus, to: SessionStatus): boolean {
  if (from === to) {
    return true;
  }
  switch (from) {
    case "creating":
      return to === "created" || to === "uncertain" || to === "failed" || to === "cancelled";
    case "created":
      return to === "sending" || to === "uncertain" || to === "failed" || to === "cancelled";
    case "sending":
      return to === "sent" || to === "uncertain" || to === "failed" || to === "cancelled";
    case "sent":
      return to === "completed" || to === "failed" || to === "cancelled" || to === "uncertain";
    case "uncertain":
      return to === "failed" || to === "cancelled";
    case "completed":
    case "failed":
    case "cancelled":
      return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function serializeWrite<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(key) ?? Promise.resolve();
  const current = previous.then(work, work);
  writeQueues.set(
    key,
    current.then(
      () => undefined,
      () => undefined,
    ),
  );
  return current;
}
