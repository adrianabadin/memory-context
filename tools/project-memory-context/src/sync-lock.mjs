import { rm, readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isPidAlive } from './watcher-lifecycle.mjs';

export const SYNC_LOCK_STALE_MS = 5 * 60 * 1000;

export class SyncLock {
  constructor(lockFilePath, deps = {}) {
    this.lockFilePath = lockFilePath;
    this.isPidAliveImpl = deps.isPidAlive ?? isPidAlive;
    this.nowImpl = deps.now ?? Date.now;
    this.mkdirImpl = deps.mkdir ?? mkdir;
    this.writeFileImpl = deps.writeFile ?? writeFile;
    this.renameImpl = deps.rename ?? rename;
    this.rmImpl = deps.rm ?? rm;
    this.readFileImpl = deps.readFile ?? readFile;
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

  async writeLockAtomically(data) {
    const tempPath = `${this.lockFilePath}.tmp`;
    const dir = dirname(this.lockFilePath);
    await this.mkdirImpl(dir, { recursive: true });
    await this.writeFileImpl(tempPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');

    const maxRetries = 5;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.renameImpl(tempPath, this.lockFilePath);
        return;
      } catch (err) {
        if (err.code === 'ENOENT') {
          await this.mkdirImpl(dir, { recursive: true });
          if (attempt === maxRetries) throw err;
        } else if (err.code === 'EPERM' || err.code === 'EEXIST') {
          if (attempt === maxRetries) throw err;
          await new Promise((r) => setTimeout(r, 25 * attempt));
        } else {
          throw err;
        }
      }
    }
  }

  async acquire(selfPid = process.pid) {
    const lock = await this.readLock();
    const now = this.nowImpl();
    if (lock) {
      const isAlive = this.isPidAliveImpl(lock.pid);
      const heartbeatMs = Date.parse(lock.heartbeatAt ?? '');
      const isFresh = Number.isFinite(heartbeatMs) && (now - heartbeatMs <= SYNC_LOCK_STALE_MS);
      if (lock.pid !== selfPid && isAlive && isFresh) {
        return false;
      }
    }
    const startedAt = new Date(now).toISOString();
    await this.writeLockAtomically({
      pid: selfPid,
      startedAt,
      heartbeatAt: startedAt,
    });
    this.pid = selfPid;
    this.startedAt = startedAt;
    return true;
  }

  async heartbeat() {
    if (!this.pid || !this.startedAt) return;
    const now = this.nowImpl();
    await this.writeLockAtomically({
      pid: this.pid,
      startedAt: this.startedAt,
      heartbeatAt: new Date(now).toISOString(),
    });
  }

  async release() {
    try {
      await this.rmImpl(this.lockFilePath, { force: true });
    } catch {
      // ignore
    }
  }
}
