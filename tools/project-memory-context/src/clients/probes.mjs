export const PROBE_TABLE = Object.freeze({
  codexVersion: async () => ({ status: 'skipped', reason: 'version-threshold-unverified' }),
  kimiVersion: async () => ({ status: 'skipped', reason: 'version-threshold-unverified' }),
  qwenVersion: async () => ({ status: 'skipped', reason: 'version-threshold-unverified' }),
});
