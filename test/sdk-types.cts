import { z } from "zod";
import {
  defineTool,
  type CopilotSession,
  type ResponseSchema,
  type Tool,
  type ZodSchema,
} from "@github/copilot-sdk";

const schema = z.object({
  result: z.string(),
  count: z.number().int().nonnegative(),
});
const parameters: ZodSchema<z.infer<typeof schema>> = schema;
const response: ResponseSchema<z.infer<typeof schema>> = schema;
const tool = defineTool("synthetic", {
  parameters: schema,
  handler: (args) => {
    const text: string = args.result;
    const count: number = args.count;
    return { text, count };
  },
});
const typedTool: Tool<z.infer<typeof schema>> = tool;

async function publicSchemaTypes(session: CopilotSession): Promise<string> {
  await session.setTools([typedTool]);
  await session.send({ prompt: "synthetic", responseSchema: parameters });
  const result = await session.sendAndWait("synthetic", response);
  const count: number = result.count;
  return `${result.result}:${count}`;
}

void publicSchemaTypes;
