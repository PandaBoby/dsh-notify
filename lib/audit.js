/**
 * dsh-notify — optional local audit trail.
 *
 * Each notification attempt is appended as one JSON line, which makes delivery
 * problems diagnosable without a debugger. The file is local-only, created with
 * `0600`, and rotates at 512 KiB (one `.1` generation).
 */

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const MAX_AUDIT_BYTES = 512 * 1024;

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

function rotateIfNeeded(path) {
  try {
    if (statSync(path).size > MAX_AUDIT_BYTES) renameSync(path, `${path}.1`);
  } catch {
    // Missing or unreadable file: the next append recreates it.
  }
}

/**
 * Append one audit record. Failures are swallowed: auditing must never break a
 * notification or the Host event dispatch.
 * @param {import('./config.js').DEFAULT_CONFIG} config normalized config
 * @param {Record<string, unknown>} record JSON-serializable record
 * @param {Record<string, string | undefined>} env process environment
 */
export function appendAudit(config, record, env = process.env) {
  if (!config?.audit) return;
  try {
    const path = resolveAuditPath(config, env);
    mkdirSync(dirname(path), { recursive: true });
    rotateIfNeeded(path);
    appendFileSync(path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch {
    // Best-effort local diagnostics only.
  }
}
