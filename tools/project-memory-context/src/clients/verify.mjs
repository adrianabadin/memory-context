import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

async function safeRead(filePath, readFn) {
  try {
    const content = await readFn(filePath, 'utf8');
    return { ok: true, content };
  } catch (err) {
    if (err?.code === 'ENOENT') return { ok: false, reason: 'file-missing' };
    return { ok: false, reason: err?.message ?? String(err) };
  }
}

async function evaluateCapability({ plannedCap, execCap, adapter, plan, exists, readFn, baselineProvider }) {
  if (plannedCap.status === 'skipped') {
    return {
      capability: plannedCap.capability,
      status: 'skipped',
      reason: plannedCap.reason ?? 'not-installed',
      targetPath: plannedCap.targetPath,
      ownedKeys: plannedCap.ownedKeys,
    };
  }

  if (execCap && execCap.status === 'failed') {
    return {
      capability: plannedCap.capability,
      status: 'failed',
      reason: execCap.reason ?? 'writer-threw',
      targetPath: plannedCap.targetPath,
      ownedKeys: plannedCap.ownedKeys,
    };
  }

  const verifierResult = adapter?.verifiers?.[plannedCap.capability];
  const verified = typeof verifierResult === 'function'
    ? Boolean(await verifierResult({ projectRoot: plan.projectRoot, homeDir: plan.homeDir }))
    : execCap?.status === 'installed';

  if (!verified) {
    return {
      capability: plannedCap.capability,
      status: 'failed',
      reason: 'verifier-false',
      targetPath: plannedCap.targetPath,
      ownedKeys: plannedCap.ownedKeys,
    };
  }

  let detectedUnchanged = false;
  const targetPath = plannedCap.targetPath;
  if (typeof targetPath === 'string' && exists(targetPath) && typeof baselineProvider === 'function') {
    const baseline = await baselineProvider(targetPath);
    if (typeof baseline === 'string') {
      const observed = await safeRead(targetPath, readFn);
      if (observed.ok && observed.content === baseline) {
        detectedUnchanged = true;
      }
    }
  }

  return {
    capability: plannedCap.capability,
    status: detectedUnchanged ? 'unchanged' : 'installed',
    reason: detectedUnchanged ? 'byte-identical-to-baseline' : undefined,
    targetPath,
    ownedKeys: plannedCap.ownedKeys,
  };
}

async function evaluateClient({ clientPlan, execClient, adapter, plan, exists, readFn, baselineProvider }) {
  const capabilities = [];
  for (const plannedCap of clientPlan.capabilities) {
    const execCap = execClient?.capabilities?.find((c) => c.capability === plannedCap.capability);
    capabilities.push(await evaluateCapability({
      plannedCap,
      execCap,
      adapter,
      plan,
      exists,
      readFn,
      baselineProvider,
    }));
  }
  return {
    clientId: clientPlan.clientId,
    error: execClient?.error,
    capabilities,
  };
}

export async function verifyInstallation({
  plan,
  execution,
  registry,
  exists = existsSync,
  readFile: readFn = readFile,
  baselineProvider,
} = {}) {
  if (!plan || !execution) throw new Error('verifyInstallation requires plan + execution');

  const adaptersById = new Map((registry ?? []).map((a) => [a.id, a]));
  const byClientExec = new Map(execution.clients.map((c) => [c.clientId, c]));

  const reportClients = await Promise.all(plan.clients.map((clientPlan) => {
    const execClient = byClientExec.get(clientPlan.clientId);
    const adapter = adaptersById.get(clientPlan.clientId);
    return evaluateClient({ clientPlan, execClient, adapter, plan, exists, readFn, baselineProvider });
  }));

  let exitCode = 0;
  for (const c of reportClients) {
    for (const cap of c.capabilities) {
      if (cap.status === 'failed') {
        exitCode = 1;
        break;
      }
    }
    if (exitCode === 1) break;
  }

  return Object.freeze({
    planId: plan.planId,
    clients: reportClients,
    companions: execution.companions ?? [],
    exitCode,
  });
}
