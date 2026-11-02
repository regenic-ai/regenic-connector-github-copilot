import { randomUUID } from "node:crypto";
import type {
  ConnectorInstallation,
  ExecutorContext,
} from "@regenic/connector-contract";
import {
  readCopilotSettings,
  resolveCopilotPaths,
  type CopilotPaths,
  type CopilotSettings,
} from "./settings";
import { CopilotSessionStore } from "./store";

export interface ActivationResource {
  close(signal?: AbortSignal): Promise<void>;
}

export interface CopilotActivation {
  readonly activationId: string;
  readonly installationId: string;
  readonly orgId: string;
  readonly settings: CopilotSettings;
  readonly paths: CopilotPaths;
  readonly store: CopilotSessionStore;
  readonly resources: Set<ActivationResource>;
  stopping: boolean;
}

const activations = new Map<string, CopilotActivation>();
const activationQueues = new Map<string, Promise<void>>();

export function startActivation(
  installation: ConnectorInstallation,
): Promise<void> {
  return serializeActivationOperation(installation.id, () =>
    startActivationUnlocked(installation),
  );
}

async function startActivationUnlocked(
  installation: ConnectorInstallation,
): Promise<void> {
  if (installation.status !== "enabled") {
    return;
  }
  const settings = readCopilotSettings(installation.config);
  if (!settings.sync_enabled && !settings.execution_enabled) {
    return;
  }
  const existing = activations.get(installation.id);
  if (existing) {
    if (existing.stopping || existing.orgId !== installation.org_id) {
      throw new Error("The Copilot installation is still stopping or is misbound.");
    }
    if (serializeSettings(existing.settings) !== serializeSettings(settings)) {
      throw new Error("The active Copilot installation must stop before reconfiguration.");
    }
    return;
  }

  const paths = await resolveCopilotPaths(installation.config);
  const store = new CopilotSessionStore(
    paths,
    installation.id,
    installation.org_id,
  );
  await store.listAll();
  activations.set(installation.id, {
    activationId: randomUUID(),
    installationId: installation.id,
    orgId: installation.org_id,
    settings,
    paths,
    store,
    resources: new Set(),
    stopping: false,
  });
}

export function stopActivation(
  installation: ConnectorInstallation,
  signal: AbortSignal,
): Promise<void> {
  return serializeActivationOperation(installation.id, () =>
    stopActivationUnlocked(installation, signal),
  );
}

async function stopActivationUnlocked(
  installation: ConnectorInstallation,
  signal: AbortSignal,
): Promise<void> {
  const activation = activations.get(installation.id);
  if (!activation) {
    return;
  }
  if (activation.orgId !== installation.org_id) {
    throw new Error("The Copilot installation is not owned by this organization.");
  }
  activation.stopping = true;
  try {
    await stopActivationResources(activation, signal);
    if (activations.get(installation.id) === activation) {
      activations.delete(installation.id);
    }
  } catch {
    throw new Error("Could not safely stop the GitHub Copilot installation.");
  }
}

export function requireExecutionActivation(
  context: ExecutorContext,
): CopilotActivation {
  const installationId = context.installation_id;
  if (typeof installationId !== "string" || !installationId) {
    throw new Error("GitHub Copilot execution requires a host-pinned installation.");
  }
  const activation = activations.get(installationId);
  if (
    !activation ||
    activation.stopping ||
    activation.orgId !== context.org_id ||
    !activation.settings.execution_enabled
  ) {
    throw new Error("The pinned GitHub Copilot installation is not active for execution.");
  }
  return activation;
}

export function getActiveActivation(
  installation: ConnectorInstallation,
): CopilotActivation | undefined {
  const activation = activations.get(installation.id);
  if (
    !activation ||
    activation.stopping ||
    activation.orgId !== installation.org_id ||
    installation.status !== "enabled"
  ) {
    return undefined;
  }
  return activation;
}

export function registerActivationResource(
  activation: CopilotActivation,
  resource: ActivationResource,
): () => void {
  assertCurrent(activation);
  activation.resources.add(resource);
  return () => activation.resources.delete(resource);
}

export function isCurrentActivation(activation: CopilotActivation): boolean {
  return activations.get(activation.installationId) === activation && !activation.stopping;
}

async function stopActivationResources(
  activation: CopilotActivation,
  signal: AbortSignal,
): Promise<void> {
  const closeResults = await Promise.allSettled(
    [...activation.resources].map((resource) => resource.close(signal)),
  );
  if (closeResults.some((result) => result.status === "rejected")) {
    throw new Error("One or more Copilot resources did not stop cleanly.");
  }

  for (const entry of await activation.store.listAll()) {
    if (
      entry.status !== "completed" &&
      entry.status !== "failed" &&
      entry.status !== "cancelled"
    ) {
      await activation.store.setStatus(entry.sessionId, "cancelled");
    }
  }
}

function assertCurrent(activation: CopilotActivation): void {
  if (!isCurrentActivation(activation)) {
    throw new Error("The GitHub Copilot installation is stopping.");
  }
}

function serializeSettings(settings: CopilotSettings): string {
  return JSON.stringify({
    copilot_home: settings.copilot_home,
    state_dir: settings.state_dir,
    working_directory: settings.working_directory,
    sync_enabled: settings.sync_enabled,
    execution_enabled: settings.execution_enabled,
    available_tools: settings.available_tools,
    permission_timeout_ms: settings.permission_timeout_ms,
  });
}

function serializeActivationOperation<T>(
  installationId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = activationQueues.get(installationId) ?? Promise.resolve();
  const current = previous.then(operation, operation);
  activationQueues.set(
    installationId,
    current.then(
      () => undefined,
      () => undefined,
    ),
  );
  return current;
}
