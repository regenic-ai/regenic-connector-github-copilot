import type {
  CopilotClient as CopilotClientType,
  CopilotClientOptions,
  CopilotSession as CopilotSessionType,
  PermissionHandler,
  PermissionRequestResult,
  ResumeSessionConfig,
  SessionConfig,
  SessionEvent,
} from "@github/copilot-sdk";
import {
  runtimeEnvironment,
  type CopilotPaths,
} from "./settings";

export type CopilotClientInstance = CopilotClientType;
export type CopilotSessionInstance = CopilotSessionType;

type ClientFactory = (options: CopilotClientOptions) => CopilotClientType;

let clientFactory: ClientFactory | undefined;

export function setCopilotClientFactoryForTests(factory?: ClientFactory): void {
  clientFactory = factory;
}

export async function createCopilotClient(
  paths: CopilotPaths,
): Promise<CopilotClientType> {
  const options: CopilotClientOptions = {
    mode: "empty",
    baseDirectory: paths.copilotHome,
    workingDirectory: paths.workingDirectory,
    useLoggedInUser: true,
    env: runtimeEnvironment(),
    logLevel: "none",
  };
  if (clientFactory) {
    return clientFactory(options);
  }
  const { CopilotClient } = await import("@github/copilot-sdk");
  return new CopilotClient(options);
}

export function sessionConfig(
  workingDirectory: string,
  availableTools: string[],
  onPermissionRequest: PermissionHandler,
): SessionConfig & ResumeSessionConfig {
  return {
    workingDirectory,
    availableTools,
    excludedTools: ["mcp:*", "custom:*", "plugin:*"],
    enableConfigDiscovery: false,
    enableMcpApps: false,
    enableSkills: false,
    enableFileHooks: false,
    mcpServers: {},
    tools: [],
    customAgents: [],
    pluginDirectories: [],
    skillDirectories: [],
    agentDirectories: [],
    hookDirectories: [],
    instructionDirectories: [],
    includedBuiltinSkills: [],
    skipCustomInstructions: true,
    enableSessionTelemetry: false,
    onPermissionRequest,
  };
}

export function denyPermission(): PermissionRequestResult {
  return { kind: "reject", feedback: "This operation is not approved by the connector." };
}

export function persistedSessionEvents(events: SessionEvent[]): SessionEvent[] {
  return events.filter((event) => event.ephemeral !== true);
}

export async function configureManualPermissions(
  session: CopilotSessionType,
  timeoutMs = 5_000,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const mode = await bounded(
    session.rpc.permissions.setMode({ mode: "manual" }),
    remainingMs(deadline),
    signal,
  );
  if (!mode.success || mode.mode !== "manual") {
    throw new Error("Copilot did not confirm manual permission mode.");
  }
  const approveAll = await bounded(
    session.rpc.permissions.setApproveAll({ enabled: false }),
    remainingMs(deadline),
    signal,
  );
  if (!approveAll.success) {
    throw new Error("Copilot did not confirm automatic permission approval is disabled.");
  }
}

function remainingMs(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new Error("Copilot permission setup timed out.");
  }
  return remaining;
}

export async function bounded<T>(
  operation: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) {
    throw new Error("Operation stopped.");
  }
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Operation timed out.")), timeoutMs);
    timer.unref();
    if (signal) {
      onAbort = () => reject(new Error("Operation stopped."));
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  try {
    return await Promise.race([operation, stopped]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    if (signal && onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

export async function stopClient(
  client: CopilotClientType,
  timeoutMs = 4_000,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const errors = await bounded(client.stop(), timeoutMs, signal);
    if (errors.length > 0) {
      throw new Error("Copilot SDK reported cleanup errors.");
    }
  } catch (error) {
    try {
      await bounded(client.forceStop(), 2_000);
    } catch {
      throw new Error(
        error instanceof Error && error.message === "Operation stopped."
          ? "Copilot runtime did not stop before shutdown was cancelled."
          : "Copilot runtime failed its bounded shutdown.",
      );
    }
    if (signal?.aborted) {
      throw new Error("Copilot runtime was force-stopped after shutdown cancellation.");
    }
  }
}

export function safeRuntimeError(): Error {
  return new Error("Copilot SDK operation failed. Sensitive runtime details were omitted.");
}
