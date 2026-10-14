/**
 * Logger — simple leveled logging module
 */

type Level = "debug" | "info" | "warn" | "error";

const LEVEL_PRIORITY: Record<Level, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};
const LOG_LEVEL = (process.env.LOG_LEVEL || "debug") as Level;

function ts() {
  return new Date().toISOString().replace("T", " ").slice(0, 23);
}

function shouldLog(level: Level) {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[LOG_LEVEL];
}

export function redactLogText(text: string): string {
  // Drizzle errors include SQL bind values, which may contain PATs and API keys.
  if (/Failed query:|\bparams:\s/i.test(text))
    return "Database operation failed (query details redacted)";
  return text.replace(
    /(postgres(?:ql)?|https?):\/\/[^\s/@]+(?::[^\s/@]*)?@/gi,
    "$1://[redacted]@",
  );
}
function redactData(data: unknown): unknown {
  if (typeof data === "string") return redactLogText(data);
  if (Array.isArray(data)) return data.map(redactData);
  if (data && typeof data === "object")
    return Object.fromEntries(
      Object.entries(data).map(([key, value]) => [
        key,
        /secret|password|api[_-]?key|authorization|private[_-]?key|credential|token/i.test(
          key,
        )
          ? "[redacted]"
          : redactData(value),
      ]),
    );
  return data;
}
function format(level: Level, tag: string, msg: string, data?: unknown) {
  msg = redactLogText(msg);
  const prefix = `${ts()} [${level.toUpperCase().padEnd(5)}] [${tag}]`;
  if (data !== undefined) {
    return `${prefix} ${msg} ${JSON.stringify(redactData(data), null, 0)}`;
  }
  return `${prefix} ${msg}`;
}

export function createLogger(tag: string) {
  return {
    debug(msg: string, data?: unknown) {
      if (shouldLog("debug")) console.log(format("debug", tag, msg, data));
    },
    info(msg: string, data?: unknown) {
      if (shouldLog("info")) console.log(format("info", tag, msg, data));
    },
    warn(msg: string, data?: unknown) {
      if (shouldLog("warn")) console.warn(format("warn", tag, msg, data));
    },
    error(msg: string, data?: unknown) {
      if (shouldLog("error")) console.error(format("error", tag, msg, data));
    },
  };
}

export const log = createLogger("app");
