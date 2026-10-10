import { rm, readFile, writeFile, mkdir, open, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { isPidAlive } from './watcher-lifecycle.mjs';

export const SYNC_LOCK_STALE_MS = 5 * 60 * 1000;

const GUARD_MAX_ATTEMPTS = 10;
const GUARD_DELAY_MS = 25;

// Cross-process sync lock built on two atomic filesystem primitives:
//
//   - `${lockFilePath}.guard`: a short-lived directory created with atomic
//     mkdir. Holding it serializes every lock transition (acquire, reclaim,
//     heartbeat, release) between cooperating sync processes. Each transition
//     re-reads the lock while holding the guard, so the decision and the
//     mutation cannot be interleaved by another cooperating transition.
//   - an exclusive create (`open 'wx'`) to publish the lock record.
//
// Ownership records carry a unique `token`; heartbeat and release verify the
// token under the guard before mutating, so an old owner can never overwrite
// or remove a new owner's lock. A known-live PID is never evicted — including
// another instance of the same process (same pid, different token).
//
// Recovery limitation (deliberate fail-closed trade-off): a crash inside a
// transition can orphan the guard directory. We never auto-steal it; all
// transitions fail with an actionable error until the guard is removed
// manually. A crash mid-heartbeat can leave a malformed lock record, which is
// only reclaimed once older than SYNC_LOCK_STALE_MS.
export class SyncLock {
  constructor(lockFilePath, deps = {}) {
    this.lockFilePath = lockFilePath;
    this.guardDirPath = `${lockFilePath}.guard`;
    this.isPidAliveImpl = deps.isPidAlive ?? isPidAlive;
    this.nowImpl = deps.now ?? Date.now;
    this.sleepImpl = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.guardMaxAttempts = deps.guardMaxAttempts ?? GUARD_MAX_ATTEMPTS;
    this.guardDelayMs = deps.guardDelayMs ?? GUARD_DELAY_MS;
    this.mkdirImpl = deps.mkdir ?? mkdir;
    this.writeFileImpl = deps.writeFile ?? writeFile;
    this.rmImpl = deps.rm ?? rm;
    this.readFileImpl = deps.readFile ?? readFile;
    this.openImpl = deps.open ?? open;
    this.statImpl = deps.stat ?? stat;
  }

  async readLock() {
    try {
      const raw = await this.readFileImpl(this.lockFilePath, 'utf8');
      return JSON.parse(raw);
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
      return null;
    }
  }

  async acquire(selfPid = process.pid) {
    const now = this.nowImpl();
    // Filesystem-safe token (no ':', invalid in Windows paths); it identifies
    // the owning instance for guarded heartbeat/release verification.
    const token = `${selfPid}-${now}-${randomBytes(6).toString('hex')}`;
    const startedAt = new Date(now).toISOString();
    const record = { pid: selfPid, startedAt, heartbeatAt: startedAt, token };
    return this._withGuard(() => this._acquireLocked(record));
  }

  // Refreshes the heartbeat, but only while this instance still owns the lock.
  // Verification and write both happen under the guard. Returns false (and
  // drops local ownership) when the record is gone or belongs to another owner.
  async heartbeat() {
    if (!this.token) return false;
    return this._withGuard(async () => {
      const current = await this._readOwnedRecord();
      if (!current) return false;
      const now = this.nowImpl();
      const updated = {
        pid: this.pid,
        startedAt: this.startedAt,
        heartbeatAt: new Date(now).toISOString(),
        token: this.token,
      };
      await this.writeFileImpl(this.lockFilePath, `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
      return true;
    });
  }

  // Read-only ownership probe for callers that must verify authority right
  // before starting new work (e.g. the sync pipeline's pre-mutation and
  // pre-checkpoint gates). Runs under the transition guard like every other
  // transition and verifies the ownership token, but never writes the lock
  // file or refreshes the heartbeat — and, unlike heartbeat()/release(),
  // never mutates local ownership state: a probe does not own that
  // bookkeeping. I/O errors other than ENOENT propagate so callers can fail
  // closed instead of trusting stale flags.
  async isOwner() {
    if (!this.token) return false;
    return this._withGuard(async () => {
      const raw = await this._readRawLock();
      if (raw === null) return false;
      let current = null;
      try {
        current = JSON.parse(raw);
      } catch {
        current = null;
      }
      return Boolean(current && current.token === this.token && current.pid === this.pid);
    });
  }

  // Removes the lock file only when it still holds this instance's ownership
  // token, verified under the guard. Never removes another owner's lock.
  async release() {
    if (!this.token) return false;
    return this._withGuard(async () => {
      const current = await this._readOwnedRecord();
      if (!current) return false;
      await this.rmImpl(this.lockFilePath, { force: true });
      this._releaseOwnership();
      return true;
    });
  }

  async _acquireLocked(record) {
    const raw = await this._readRawLock();
    if (raw !== null) {
      let existing = null;
      try {
        existing = JSON.parse(raw);
      } catch {
        existing = null;
      }

      // Re-acquiring from the owning instance itself is idempotent.
      if (existing?.token && existing.token === this.token) {
        return true;
      }

      if (existing && Number.isInteger(existing.pid)) {
        let alive;
        try {
          alive = this.isPidAliveImpl(existing.pid);
        } catch {
          alive = undefined;
        }
        // Never evict a known-live PID — including another instance of this
        // same process (same pid, different token). Unknown liveness holds.
        if (alive !== false) return false;
      } else {
        // Malformed record: recover only when it is old enough that no
        // initialization window can explain it.
        let staleEnough = false;
        try {
          const info = await this.statImpl(this.lockFilePath);
          staleEnough = (this.nowImpl() - info.mtimeMs) > SYNC_LOCK_STALE_MS;
        } catch (err) {
          if (err?.code !== 'ENOENT') throw err;
          staleEnough = true;
        }
        if (!staleEnough) return false;
      }

      // Judged dead (or ancient-malformed) while holding the guard: the unlink
      // cannot race another cooperating transition.
      await this.rmImpl(this.lockFilePath, { force: true });
    }

    const created = await this._createExclusive(record);
    if (created) this._claim(record);
    return created;
  }

  async _createExclusive(record) {
    let handle;
    try {
      handle = await this.openImpl(this.lockFilePath, 'wx');
    } catch (err) {
      if (err?.code === 'EEXIST') return false; // foreign non-cooperating writer
      throw err;
    }
    try {
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
    } finally {
      await handle.close();
    }
    return true;
  }

  async _readRawLock() {
    try {
      return await this.readFileImpl(this.lockFilePath, 'utf8');
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
      return null;
    }
  }

  // Must be called under the guard. Returns the on-disk record only when it
  // still belongs to this instance; otherwise local ownership is dropped.
  async _readOwnedRecord() {
    const raw = await this._readRawLock();
    if (raw === null) {
      this._releaseOwnership();
      return null;
    }
    let current = null;
    try {
      current = JSON.parse(raw);
    } catch {
      current = null;
    }
    if (!current || current.token !== this.token || current.pid !== this.pid) {
      this._releaseOwnership();
      return null;
    }
    return current;
  }

  async _withGuard(fn) {
    await this.mkdirImpl(dirname(this.lockFilePath), { recursive: true });
    for (let attempt = 1; attempt <= this.guardMaxAttempts; attempt++) {
      try {
        await this.mkdirImpl(this.guardDirPath); // atomic create-if-absent
        break;
      } catch (err) {
        if (err?.code !== 'EEXIST') throw err;
        if (attempt === this.guardMaxAttempts) {
          throw new Error(
            `sync lock transition guard is held at ${this.guardDirPath}; ` +
            'if no sync process is running a transition, remove it manually and retry'
          );
        }
        await this.sleepImpl(this.guardDelayMs);
      }
    }
    try {
      return await fn();
    } finally {
      await this.rmImpl(this.guardDirPath, { recursive: true, force: true }).catch(() => {});
    }
  }

  _claim(record) {
    this.pid = record.pid;
    this.startedAt = record.startedAt;
    this.token = record.token;
  }

  _releaseOwnership() {
    this.pid = undefined;
    this.startedAt = undefined;
    this.token = undefined;
  }
}
