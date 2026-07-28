import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

export async function writeAtomic(filePath, data, options = {}) {
  const encoding = options.encoding ?? 'utf8';
  const renameImpl = options.renameImpl ?? rename;
  const unlinkImpl = options.unlinkImpl ?? (async (p) => rm(p, { force: true }));
  const maxRetries = options.maxRetries ?? 10;
  const retryDelayMs = options.retryDelayMs ?? 20;

  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });

  const nonce = randomBytes(6).toString('hex');
  const tmpPath = join(dir, `.tmp-${nonce}`);

  await writeFile(tmpPath, data, encoding);

  let attempt = 0;
  while (true) {
    try {
      await renameImpl(tmpPath, filePath);
      return;
    } catch (err) {
      attempt++;
      if ((err.code === 'EPERM' || err.code === 'EBUSY') && attempt <= maxRetries) {
        await new Promise((res) => setTimeout(res, retryDelayMs));
        continue;
      }
      try {
        await unlinkImpl(tmpPath);
      } catch {
        // Ignore failure on cleanup to allow original error to throw
      }
      throw err;
    }
  }
}
