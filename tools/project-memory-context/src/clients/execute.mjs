import { writeAtomic } from '../config-merge/atomic-write.mjs';

async function safeRun(adapter, context, capabilityName) {
  const writer = adapter.writers?.[capabilityName];
  if (typeof writer !== 'function') {
    return { ok: false, error: new Error(`Adapter ${adapter.id} has no writer for capability ${capabilityName}`) };
  }
  try {
    await writer(context);
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

function buildContext({ plan, client, projectRoot, homeDir, packageRoot, placeholders, readTemplate }) {
  return {
    projectRoot,
    homeDir,
    globalConfigDir: homeDir,
    packageRoot,
    placeholders,
    readTemplate,
    atomicWrite: writeAtomic,
  };
}

export async function executePlan({
  plan,
  registry,
  adapterOverride,
  projectRoot: explicitProjectRoot,
  homeDir: explicitHomeDir,
  packageRoot,
  placeholders,
  readTemplate,
} = {}) {
  if (!plan || !Array.isArray(plan.clients)) {
    throw new Error('executePlan requires a plan with clients');
  }

  const projectRoot = explicitProjectRoot ?? plan.projectRoot;
  const homeDir = explicitHomeDir ?? plan.homeDir ?? projectRoot;

  const overrides = adapterOverride ?? {};
  const adaptersById = new Map((registry ?? []).map((a) => [a.id, a]));
  for (const [id, adapter] of Object.entries(overrides)) {
    adaptersById.set(id, adapter);
  }

  const clientResults = [];
  for (const client of plan.clients) {
    const adapter = adaptersById.get(client.clientId) ?? null;
    if (!adapter) {
      clientResults.push({
        clientId: client.clientId,
        capabilities: client.capabilities.map((c) => ({ ...c, status: 'failed', reason: 'no-adapter' })),
        error: client.error ?? `No adapter for client ${client.clientId}`,
      });
      continue;
    }

    let firstError = undefined;
    const capabilityOutcomes = [];
    for (const cap of client.capabilities) {
      if (cap.status === 'skipped') {
        capabilityOutcomes.push({ ...cap });
        continue;
      }
      if (cap.status !== 'planned') {
        capabilityOutcomes.push({ ...cap, status: 'failed', reason: 'unexpected-plan-status' });
        continue;
      }

      const context = buildContext({
        plan,
        client,
        projectRoot,
        homeDir,
        packageRoot,
        placeholders,
        readTemplate,
      });

      const outcome = await safeRun(adapter, context, cap.capability);
      if (!outcome.ok) {
        firstError = firstError ?? outcome.error;
        capabilityOutcomes.push({
          ...cap,
          status: 'failed',
          reason: outcome.error.message ?? String(outcome.error),
        });
      } else {
        capabilityOutcomes.push({ ...cap, status: 'installed' });
      }
    }

    clientResults.push({
      clientId: client.clientId,
      capabilities: capabilityOutcomes,
      error: firstError ? firstError.message ?? String(firstError) : undefined,
    });
  }

  return {
    planId: plan.planId,
    clients: clientResults,
    companions: [],
  };
}
