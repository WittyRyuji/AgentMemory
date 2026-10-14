import { Ajv } from "ajv";
import { asSchema, type Tool } from "ai";
import type { LLMRunParams } from "../../core/types.js";
import {
  OAuthFailure,
  type OAuthInferenceAdapter,
  type InferenceResult,
} from "./types.js";
import type { OAuthService } from "./service.js";
/** Preserve the memory pipeline's caller/storage-backed tools with a bounded client-side loop. */
export async function runOAuth(
  params: LLMRunParams,
  options: {
    service: OAuthService;
    inference: OAuthInferenceAdapter;
    model: string;
    tools?: Record<string, unknown>;
    timeoutMs: number;
  },
) {
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal = params.abortSignal
    ? AbortSignal.any([timeout, params.abortSignal])
    : timeout;
  const input: Record<string, unknown>[] = [
    { role: "user", content: params.prompt },
  ];
  const ajv = new Ajv({ strict: false, allErrors: false });
  const prepared = new Map<
    string,
    {
      validate: ReturnType<Ajv["compile"]>;
      definition: Record<string, unknown>;
      schema: ReturnType<typeof asSchema>;
      tool: Tool;
    }
  >();
  for (const [name, value] of Object.entries(options.tools ?? {})) {
    const t = value as Tool;
    if (
      !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(name) ||
      !t.inputSchema ||
      typeof t.execute !== "function" ||
      t.needsApproval
    )
      throw new OAuthFailure("unsupported_capability");
    const schema = asSchema(t.inputSchema);
    prepared.set(name, {
      validate: ajv.compile(await schema.jsonSchema),
      tool: t,
      schema,
      definition: {
        type: "function",
        name,
        description: t.description ?? name,
        parameters: await schema.jsonSchema,
        strict: false,
      },
    });
  }
  const tools = prepared.size
    ? [
        {
          type: "namespace",
          name: "memory",
          description: "Memory pipeline tools",
          tools: [...prepared.values()].map((t) => t.definition),
        },
      ]
    : undefined;
  const maxIterations = params.maxIterations ?? 20;
  if (
    !Number.isInteger(maxIterations) ||
    maxIterations < 1 ||
    maxIterations > 50
  )
    throw new OAuthFailure("tool_error");
  const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  const executed = new Set<string>();
  try {
    for (let step = 0; step < maxIterations; step++) {
      signal.throwIfAborted();
      const token = await options.service.accessToken();
      signal.throwIfAborted();
      let result: InferenceResult;
      try {
        result = await options.inference.complete(token, {
          model: options.model,
          instructions: params.systemPrompt,
          input,
          tools,
          signal,
        });
      } catch (e) {
        if (e instanceof OAuthFailure)
          await options.service.noteInferenceFailure?.(e);
        throw e;
      }
      for (const key of Object.keys(usage) as (keyof typeof usage)[])
        usage[key] += result.usage[key];
      const calls = result.output.filter(
        (item) => item.type === "function_call",
      );
      if (!calls.length) return { text: result.text.trim(), usage };
      if (!prepared.size || calls.length > 50 || step === maxIterations - 1)
        throw new OAuthFailure("tool_error");
      // Carry all response items, including encrypted reasoning, into the next stateless request.
      input.push(...result.output);
      for (const call of calls) {
        signal.throwIfAborted();
        if (
          typeof call.name !== "string" ||
          typeof call.call_id !== "string" ||
          !call.call_id ||
          typeof call.arguments !== "string" ||
          (call.namespace !== undefined && call.namespace !== "memory") ||
          executed.has(call.call_id)
        )
          throw new OAuthFailure("tool_error");
        const selected = prepared.get(call.name.replace(/^memory\./, ""));
        if (!selected) throw new OAuthFailure("tool_error");
        let args: unknown;
        try {
          args = JSON.parse(call.arguments);
        } catch {
          throw new OAuthFailure("tool_error");
        }
        if (!args || typeof args !== "object" || Array.isArray(args))
          throw new OAuthFailure("tool_error");
        if (!selected.validate(args)) throw new OAuthFailure("tool_error");
        if (selected.schema.validate) {
          const checked = await selected.schema.validate(args);
          if (!checked.success) throw new OAuthFailure("tool_error");
          args = checked.value;
        }
        executed.add(call.call_id);
        const value = await selected.tool.execute!(args, {
          toolCallId: call.call_id,
          messages: [],
          abortSignal: signal,
        });
        signal.throwIfAborted();
        const output =
          typeof value === "string" ? value : JSON.stringify(value ?? null);
        if (output.length > 2 * 1024 * 1024)
          throw new OAuthFailure("tool_error");
        input.push({
          type: "function_call_output",
          call_id: call.call_id,
          output,
        });
      }
    }
    throw new OAuthFailure("tool_error");
  } catch (e) {
    throw e instanceof OAuthFailure
      ? e
      : new OAuthFailure(signal.aborted ? "aborted" : "tool_error");
  }
}
