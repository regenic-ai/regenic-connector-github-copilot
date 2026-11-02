import path from "node:path";
import {
  ChannelDriverError,
  INGEST_SCHEMA_VERSION,
  type ChannelDriver,
  type ConnectorInstallation,
  type ConnectorStream,
  type JsonValue,
  type PollResult,
} from "@regenic/connector-contract";
import {
  getActiveActivation,
  startActivation,
  stopActivation,
} from "./activation";
import { CONNECTOR_PROTOCOL, CONNECTOR_TYPE, SOURCE } from "./constants";
import { readSessionEvents } from "./executor";
import {
  configEnabled,
  parseToolAllowlist,
  readCopilotSettings,
} from "./settings";
import {
  deterministicDeliveryId,
  pageSessionEvents,
} from "./session-events";
import type { OwnedSession } from "./store";

const defaultPermissionTimeoutMs = 5 * 60_000;
const eventPageSize = 100;

export const githubCopilotSessionDriver: ChannelDriver = {
  connector_type: CONNECTOR_TYPE,
  connector_protocol: CONNECTOR_PROTOCOL,
  source: SOURCE,
  source_mode: "poll",

  install(input) {
    let config: Record<string, JsonValue>;
    try {
      config = normalizeInstallConfig(input.config);
      validateInstallConfig(config);
    } catch (error) {
      if (error instanceof ChannelDriverError) {
        throw error;
      }
      throw new ChannelDriverError(
        "invalid_config",
        error instanceof Error
          ? error.message
          : "The GitHub Copilot installation configuration is invalid.",
      );
    }
    return {
      id: input.id,
      org_id: input.org_id,
      connector_type: CONNECTOR_TYPE,
      status: "enabled",
      config,
      created_at: input.now,
    };
  },

  matchesThread(_installation, thread) {
    return thread.source === SOURCE && isSessionId(thread.target);
  },

  ownsThread(_installation, thread) {
    return thread.source === SOURCE && isSessionId(thread.target);
  },

  capabilities(installation) {
    const settings = readCopilotSettings(installation.config);
    const enabled = installation.status === "enabled";
    return {
      sync: enabled && settings.sync_enabled,
      reply: false,
      create: false,
      execute: enabled && settings.execution_enabled,
      backfill: false,
      attachments: false,
      await_reply: false,
      list_title: "prompt",
      hydrate_on_open: true,
    };
  },

  installCatalog() {
    return {
      title: "GitHub Copilot CLI",
      description:
        "Read persisted sessions created by this connector and, when explicitly enabled, run Copilot tasks in a configured local workspace.",
      credential_hint:
        "Authentication is provided by the official Copilot CLI SDK using the account already configured in the selected Copilot home. This connector does not read or store tokens.",
      channel_label: "GitHub Copilot CLI",
      fields: [
        {
          key: "copilot_home",
          label: "Copilot home directory",
          required: true,
          placeholder: "Absolute path to the configured Copilot home",
        },
        {
          key: "state_dir",
          label: "Connector state directory",
          required: true,
          placeholder: "Absolute path for connector-owned session metadata",
        },
        {
          key: "working_directory",
          label: "Workspace directory",
          required: true,
          placeholder: "Absolute path to the workspace Copilot may use",
        },
        {
          key: "sync_enabled",
          label: "Synchronize connector-created sessions",
          default: "false",
        },
        {
          key: "execution_enabled",
          label: "Enable direct Copilot task execution",
          default: "false",
        },
        {
          key: "available_tools",
          label: "Built-in tool allowlist",
          required: true,
          placeholder: "Comma-separated exact builtin:<name> tool names",
          visible_when: { field: "execution_enabled", value: "true" },
        },
        {
          key: "permission_timeout_ms",
          label: "Permission prompt timeout (milliseconds)",
          default: String(defaultPermissionTimeoutMs),
          visible_when: { field: "execution_enabled", value: "true" },
        },
      ],
      install_confirm: {
        when: { field: "execution_enabled", value: "true" },
        warning:
          "The configured workspace is not a sandbox. Only explicitly allowlisted built-in tools are exposed; permission requests are manual and default-deny. Some SDK-approved operations may not prompt.",
        ack: "I understand this executes Copilot tasks in the configured workspace.",
      },
    };
  },

  async startInstallation(installation) {
    await startActivation(installation);
  },

  async stopInstallation(installation, _host, context) {
    await stopActivation(installation, context.signal);
  },

  async resolveStreams(installation, host, _env, options) {
    const settings = readCopilotSettings(installation.config);
    if (installation.status !== "enabled" || !settings.sync_enabled) {
      return [];
    }
    const activation = getActiveActivation(installation);
    if (!activation) {
      throw new ChannelDriverError(
        "sync_failed",
        "The GitHub Copilot installation is not active.",
      );
    }
    const entries = await activation.store.listConfirmed();
    const requestedIds = options?.threads
      ? new Set(
          options.threads
            .filter((thread) => thread.source === SOURCE)
            .map((thread) => thread.target),
        )
      : undefined;
    return entries
      .filter((entry) => !requestedIds || requestedIds.has(entry.sessionId))
      .map((entry) => createStream(installation, activation, host, entry));
  },

  async resolveThreadStream(installation, thread, host) {
    if (!this.matchesThread(installation, thread)) {
      throw new ChannelDriverError(
        "unsupported_channel",
        "This thread is not a GitHub Copilot CLI session.",
      );
    }
    const settings = readCopilotSettings(installation.config);
    const activation = getActiveActivation(installation);
    if (
      installation.status !== "enabled" ||
      !settings.sync_enabled ||
      !activation
    ) {
      throw new ChannelDriverError(
        "sync_failed",
        "The GitHub Copilot installation is not active for synchronization.",
      );
    }
    const entry = await activation.store.get(thread.target);
    if (!entry || entry.status === "creating" || entry.status === "uncertain") {
      throw new ChannelDriverError(
        "unsupported_channel",
        "This Copilot session is not registered as a confirmed connector-owned session.",
      );
    }
    return createStream(installation, activation, host, entry);
  },
};

function createStream(
  installation: ConnectorInstallation,
  activation: NonNullable<ReturnType<typeof getActiveActivation>>,
  host: Parameters<NonNullable<ChannelDriver["resolveStreams"]>>[1],
  entry: OwnedSession,
): ConnectorStream {
  return {
    stream_key: `session:${entry.sessionId}`,
    thread_id: entry.sessionId,
    label: `Copilot task ${entry.sessionId.slice(0, 8)}`,
    connector: {
      source: SOURCE,
      source_mode: "poll",
      poll: async (cursor, options = {}): Promise<PollResult> => {
        if (options.signal?.aborted) {
          throw new ChannelDriverError("sync_failed", "Copilot session polling was cancelled.");
        }
        try {
          const events = await readSessionEvents(activation, entry, options.signal);
          const page = pageSessionEvents({
            events,
            sessionId: entry.sessionId,
            cursor: cursor?.value ?? null,
            connectorId: installation.id,
            orgId: installation.org_id,
            now: host.now(),
            pageSize: eventPageSize,
          });
          const deliveryId = deterministicDeliveryId(
            `${installation.id}:${entry.sessionId}:${cursor?.value ?? "begin"}:${page.nextCursor ?? "end"}`,
          );
          return {
            batch: {
              schema_version: INGEST_SCHEMA_VERSION,
              connector_id: installation.id,
              org_id: installation.org_id,
              delivery_id: deliveryId,
              records: page.records,
              received_at: host.now(),
              ...(page.nextCursor ? { next_cursor: page.nextCursor } : {}),
            },
            ...(page.nextCursor ? { next_cursor: page.nextCursor } : {}),
            has_more: page.hasMore,
            poll_hint: {
              live_seeded: !page.hasMore,
              history_pending: page.hasMore,
            },
          };
        } catch (error) {
          if (error instanceof ChannelDriverError) {
            throw error;
          }
          throw new ChannelDriverError(
            "sync_failed",
            "Could not read the selected GitHub Copilot task session.",
          );
        }
      },
    },
  };
}

function normalizeInstallConfig(
  config: Record<string, unknown>,
): Record<string, JsonValue> {
  const syncEnabled = configEnabled(config.sync_enabled);
  const executionEnabled = configEnabled(config.execution_enabled);
  const rawPermissionTimeout = config.permission_timeout_ms;
  if (
    rawPermissionTimeout !== undefined &&
    typeof rawPermissionTimeout !== "number" &&
    typeof rawPermissionTimeout !== "string"
  ) {
    throw new Error("permission_timeout_ms must be a whole number.");
  }
  const normalized: Record<string, JsonValue> = {
    sync_enabled: syncEnabled,
    execution_enabled: executionEnabled,
    available_tools:
      executionEnabled && typeof config.available_tools === "string"
        ? config.available_tools.trim()
        : "",
    permission_timeout_ms: rawPermissionTimeout ?? defaultPermissionTimeoutMs,
  };
  for (const key of ["copilot_home", "state_dir", "working_directory"]) {
    const value = config[key];
    if (typeof value === "string") {
      normalized[key] = value.trim();
    }
  }
  return normalized;
}

function validateInstallConfig(config: Record<string, JsonValue>): void {
  const settings = readCopilotSettings(config);
  if (!settings.sync_enabled && !settings.execution_enabled) {
    return;
  }
  const requiredPaths: [string, string][] = [
    ["copilot_home", settings.copilot_home],
    ["state_dir", settings.state_dir],
    ["working_directory", settings.working_directory],
  ];
  for (const [label, value] of requiredPaths) {
    if (!path.isAbsolute(value) || value.includes("\0")) {
      throw new ChannelDriverError(
        "invalid_config",
        `${label} must be an explicitly configured absolute path.`,
      );
    }
  }
  if (settings.execution_enabled) {
    parseToolAllowlist(config.available_tools);
  }
}

function isSessionId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}
