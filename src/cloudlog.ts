/**
 * Send the app's log lines to Google Cloud Logging, so Claude can read them
 * (read-only, with a Logs Viewer key) without access to the server.
 *
 * Only on a Google Cloud VM: it uses the VM's own credentials from the
 * metadata server, so there's nothing to install or configure. Lines are
 * batched and sent every 30 s. On a laptop (no metadata server) or with
 * CLOUD_LOGGING=0 it does nothing. It never writes to the console itself
 * (the console is what it's shipping) and never throws.
 */

const METADATA = "http://metadata.google.internal/computeMetadata/v1";
const LOG_NAME = "date-night-planner";
const FLUSH_MS = 30_000;
const MAX_BUFFER = 5000;

interface Entry {
  timestamp: string;
  severity: string;
  textPayload: string;
}

let project: string | null = null;
let buffer: Entry[] = [];
let token: { value: string; expires: number } | null = null;
let timer: NodeJS.Timeout | undefined;
let warned = false;

async function metadata(pathname: string): Promise<string> {
  const res = await fetch(`${METADATA}/${pathname}`, { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(2000) });
  if (!res.ok) throw new Error(`metadata ${pathname}: ${res.status}`);
  return res.text();
}

/** Start shipping if this is a Google Cloud VM. Returns the project id, or null when off. */
export async function startCloudLogging(stderr: (msg: string) => void = (m) => process.stderr.write(`${m}\n`)): Promise<string | null> {
  if (process.env.CLOUD_LOGGING === "0") return null;
  try {
    project = (await metadata("project/project-id")).trim();
  } catch {
    return null; // not on Google Cloud
  }
  timer = setInterval(() => void flushCloudLogs(stderr), FLUSH_MS);
  timer.unref();
  return project;
}

/** Queue one log line (called for everything the app prints). */
export function cloudLog(level: string, line: string, at = new Date()): void {
  if (!project) return;
  buffer.push({ timestamp: at.toISOString(), severity: { log: "INFO", info: "INFO", warn: "WARNING", error: "ERROR" }[level] ?? "DEFAULT", textPayload: line.slice(0, 50_000) });
  if (buffer.length > MAX_BUFFER) buffer = buffer.slice(-MAX_BUFFER);
}

async function accessToken(): Promise<string> {
  if (token && Date.now() < token.expires - 60_000) return token.value;
  const t = JSON.parse(await metadata("instance/service-accounts/default/token")) as { access_token: string; expires_in: number };
  token = { value: t.access_token, expires: Date.now() + t.expires_in * 1000 };
  return token.value;
}

/** Send what's queued. Kept for the next try if Cloud Logging can't be reached. */
export async function flushCloudLogs(stderr: (msg: string) => void = (m) => process.stderr.write(`${m}\n`)): Promise<void> {
  if (!project || !buffer.length) return;
  const batch = buffer.splice(0, 1000);
  try {
    const res = await fetch("https://logging.googleapis.com/v2/entries:write", {
      method: "POST",
      headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ logName: `projects/${project}/logs/${LOG_NAME}`, resource: { type: "global", labels: { project_id: project } }, entries: batch }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
    warned = false;
  } catch (err) {
    buffer.unshift(...batch);
    if (buffer.length > MAX_BUFFER) buffer = buffer.slice(-MAX_BUFFER);
    if (!warned) stderr(`cloud logging: couldn't send logs (${(err as Error).message}); kept for the next try`);
    warned = true;
  }
}

/** Tests only. */
export function _resetCloudLog(p: string | null = null): Entry[] {
  project = p;
  token = null;
  buffer = [];
  return buffer;
}
