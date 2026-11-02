const assert = require("node:assert/strict");
const { createRequire } = require("node:module");
const { readFileSync, realpathSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const sdkRequire = createRequire(require.resolve("@github/copilot-sdk"));
const { z } = sdkRequire("zod");

for (const format of ["require", "import"]) {
  test(`official SDK ${format} converts tools and validates structured responses with patched Zod`, async () => {
    const { CopilotSession, defineTool } = format === "require"
      ? require("@github/copilot-sdk")
      : await import("@github/copilot-sdk");
    const requests = [];
    let response = { result: "synthetic", count: 2 };
    const connection = {
      async sendRequest(method, params) {
        requests.push({ method, params });
        if (method === "session.send") {
          return { messageId: "synthetic-message" };
        }
        if (method === "session.sendAndWait") {
          return {
            response: {
              id: "synthetic-event",
              type: "assistant.message",
              data: { content: JSON.stringify(response) },
            },
          };
        }
        if (method === "session.tools.set") {
          return { success: true };
        }
        throw new Error(`Unexpected offline RPC method: ${method}`);
      },
    };
    // Construct the real SDK session over a transport stub; no client or Agent starts.
    const session = new CopilotSession("synthetic-session", connection);
    const schema = z.object({
      result: z.string(),
      count: z.number().int().nonnegative(),
    });
    const tool = defineTool("synthetic", {
      parameters: schema,
      handler: (args) => args.result,
    });
    await session.setTools([tool]);
    assert.deepEqual(requests[0].params.tools[0].parameters, schema.toJSONSchema());
    await session.send({ prompt: "synthetic", responseSchema: schema });
    assert.deepEqual(
      requests[1].params.responseFormat.jsonSchema.schema,
      schema.toJSONSchema(),
    );
    assert.deepEqual(await session.sendAndWait("synthetic", schema), response);
    response = { result: "synthetic", count: "invalid" };
    await assert.rejects(session.sendAndWait("synthetic", schema), z.ZodError);
    assert.equal(requests.length, 4);
  });
}

test("SDK Zod override is scoped and the connector pins child-process stdio", async () => {
  const sdkEntry = require.resolve("@github/copilot-sdk");
  const manifest = JSON.parse(readFileSync(path.resolve(path.dirname(sdkEntry), "../../package.json"), "utf8"));
  assert.equal(manifest.version, "1.0.28");
  assert.equal(manifest.dependencies.zod, "4.3.6");
  assert.equal(sdkRequire("zod/package.json").version, "4.6.7");
  assert.equal(realpathSync(sdkRequire.resolve("zod")), realpathSync(require.resolve("zod")));

  const { createCopilotClient, setCopilotClientFactoryForTests } = require("../dist/sdk.js");
  let captured;
  setCopilotClientFactoryForTests((options) => {
    captured = options;
    return {};
  });
  try {
    await createCopilotClient({ copilotHome: "/synthetic/home", workingDirectory: "/synthetic/workspace" });
    assert.deepEqual(captured.connection, { kind: "stdio" });
  } finally {
    setCopilotClientFactoryForTests(undefined);
  }

  const previous = process.env.COPILOT_SDK_DEFAULT_CONNECTION;
  process.env.COPILOT_SDK_DEFAULT_CONNECTION = "inprocess";
  try {
    const client = await createCopilotClient({
      copilotHome: "/synthetic/home",
      workingDirectory: "/synthetic/workspace",
    });
    assert.ok(client instanceof (await import("@github/copilot-sdk")).CopilotClient);
    assert.equal(
      Object.keys(require.cache).some((file) => file.includes(`${path.sep}koffi${path.sep}`)),
      false,
    );
  } finally {
    if (previous === undefined) {
      delete process.env.COPILOT_SDK_DEFAULT_CONNECTION;
    } else {
      process.env.COPILOT_SDK_DEFAULT_CONNECTION = previous;
    }
  }
});
