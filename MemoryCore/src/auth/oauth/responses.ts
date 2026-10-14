import {
  OAuthFailure,
  type OAuthInferenceAdapter,
  type InferenceRequest,
  type InferenceResult,
} from "./types.js";
import {
  OPENAI_RESOURCE,
  providerFailure,
  responseJson,
  type Http,
} from "./openai.js";
/** OpenAI plan-usage transport. No configurable destination and no API-key/paid fallback. */
export class OpenAIResponsesAdapter implements OAuthInferenceAdapter {
  readonly authProvider = "openai";
  constructor(private readonly http: Http = fetch) {}
  async models(accessToken: string, signal: AbortSignal) {
    try {
      const res = await this.http(`${OPENAI_RESOURCE}/models`, {
        headers: { authorization: `Bearer ${accessToken}` },
        signal,
        redirect: "error",
      });
      if (!res.ok) throw providerFailure(res.status);
      const data = await responseJson(res);
      if (!Array.isArray(data.models))
        throw new OAuthFailure("invalid_response");
      return data.models
        .filter(
          (m: any) =>
            m.visibility === "list" &&
            typeof m.slug === "string" &&
            typeof m.display_name === "string",
        )
        .map((m: any) => ({ slug: m.slug, displayName: m.display_name }));
    } catch (e) {
      throw e instanceof OAuthFailure
        ? e
        : new OAuthFailure(signal.aborted ? "aborted" : "unavailable");
    }
  }
  async complete(
    accessToken: string,
    request: InferenceRequest,
  ): Promise<InferenceResult> {
    try {
      request.signal.throwIfAborted();
      const response = await this.http(`${OPENAI_RESOURCE}/responses`, {
        method: "POST",
        redirect: "error",
        signal: request.signal,
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify({
          model: request.model,
          input: request.input,
          instructions: request.instructions,
          tools: request.tools,
          store: false,
          stream: true,
        }),
      });
      if (!response.ok) {
        const data = await responseJson(response);
        throw providerFailure(
          response.status,
          data.error?.code,
          response.headers.get("x-request-id") ?? undefined,
        );
      }
      if (
        !response.body ||
        !response.headers.get("content-type")?.includes("text/event-stream")
      )
        throw new OAuthFailure("invalid_response");
      let completed: Record<string, any> | undefined;
      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let pending = "",
        bytes = 0;
      const event = (raw: string) => {
        const data = raw
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data || data === "[DONE]") return;
        let e: any;
        try {
          e = JSON.parse(data);
        } catch {
          throw new OAuthFailure("invalid_response");
        }
        if (e.type === "response.failed" || e.type === "error")
          throw providerFailure(
            0,
            e.response?.error?.code ?? e.code ?? e.error?.code,
          );
        if (e.type === "response.incomplete")
          throw new OAuthFailure("incomplete_stream");
        if (e.type === "response.completed") {
          if (
            completed ||
            e.response?.status !== "completed" ||
            !Array.isArray(e.response.output)
          )
            throw new OAuthFailure("invalid_response");
          completed = e.response;
        }
      };
      try {
        while (true) {
          request.signal.throwIfAborted();
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 32 * 1024 * 1024)
            throw new OAuthFailure("invalid_response");
          pending += decoder.decode(chunk.value, { stream: true });
          // Normalize CRLF, including a CR/LF split across chunks.
          pending = pending.replace(/\r\n/g, "\n");
          let boundary: number;
          while ((boundary = pending.indexOf("\n\n")) >= 0) {
            event(pending.slice(0, boundary));
            pending = pending.slice(boundary + 2);
          }
          if (pending.length > 4 * 1024 * 1024)
            throw new OAuthFailure("invalid_response");
        }
        pending += decoder.decode();
        if (pending.trim()) event(pending);
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      if (!completed) throw new OAuthFailure("incomplete_stream");
      const output = completed.output as Record<string, any>[];
      if (
        output.some(
          (item) =>
            !item || typeof item !== "object" || typeof item.type !== "string",
        )
      )
        throw new OAuthFailure("invalid_response");
      const text = output
        .filter((item) => item.type === "message")
        .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
        .filter(
          (item) =>
            item.type === "output_text" && typeof item.text === "string",
        )
        .map((item) => item.text)
        .join("");
      const usage = completed.usage ?? {};
      const count = (n: unknown) =>
        typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 0;
      const promptTokens = count(usage.input_tokens),
        completionTokens = count(usage.output_tokens);
      return {
        output,
        text,
        usage: {
          promptTokens,
          completionTokens,
          totalTokens:
            count(usage.total_tokens) || promptTokens + completionTokens,
        },
      };
    } catch (e) {
      throw e instanceof OAuthFailure
        ? e
        : new OAuthFailure(
            request.signal.aborted ? "aborted" : "incomplete_stream",
          );
    }
  }
}
