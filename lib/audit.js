/**
 * dsh-notify — optional local audit trail.
 *
 * Each notification attempt is appended as one JSON line, which makes delivery
 * problems diagnosable without a debugger. The file is local-only, created with
 * `0600`, and rotates at 512 KiB (one `.1` generation).
 *
 * Writes are asynchronous and serialized behind one promise chain: the Host
 * event loop is never blocked by disk I/O, and concurrent notifications cannot
 * interleave partial lines.
 */

import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const MAX_AUDIT_BYTES = 512 * 1024;

/** Serializes audit writes for this Host process. */
let writeQueue = Promise.resolve();

/**
 * Resolve the DSH data root the same way the Harness does: `$DSH_HOME`, else
 * `~/.dsh`.
 * @param {Record<string, string | undefined>} env process environment
 */
export function resolveDshHome(env = process.env) {
  const configured = env.DSH_HOME;
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim();
  return join(homedir(), '.dsh');
}

/**
 * Resolve the audit log path; an explicit `auditPath` wins, with `~` expansion.
 * @param {import('./config.js').DEFAULT_CONFIG} config normalized config
 * @param {Record<string, string | undefined>} env process environment
 */
export function resolveAuditPath(config, env = process.env) {
  const configured = typeof config?.auditPath === 'string' ? config.auditPath.trim() : '';
  if (configured) return configured.replace(/^~(?=$|[\\/])/, homedir());
  return join(resolveDshHome(env), 'dsh-notify', 'audit.jsonl');
}

async function rotateIfNeeded(path) {
  try {
    const info = await stat(path);
    if (info.size > MAX_AUDIT_BYTES) await rename(path, `${path}.1`);
  } catch {
    // Missing or unreadable file: the next append recreates it.
  }
}

async function writeRecord(path, line) {
  try {
    await mkdir(dirname(path), { recursive: true });
    await rotateIfNeeded(path);
    await appendFile(path, line, { encoding: 'utf8', mode: 0o600 });
  } catch {
    // Best-effort local diagnostics only.
  }
}

/**
 * Queue one audit record. Returns a promise that settles after this record's
 * write attempt; callers may ignore it. Auditing never throws and never rejects.
 * @param {import('./config.js').DEFAULT_CONFIG} config normalized config
 * @param {Record<string, unknown>} record JSON-serializable record
 * @param {Record<string, string | undefined>} env process environment
 * @returns {Promise<void>}
 */
export function appendAudit(config, record, env = process.env) {
  if (!config?.audit) return Promise.resolve();
  let line;
  try {
    line = `${JSON.stringify(record)}\n`;
  } catch {
    return Promise.resolve();
  }
  const path = resolveAuditPath(config, env);
  writeQueue = writeQueue.then(() => writeRecord(path, line));
  return writeQueue;
}
