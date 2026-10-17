import { planInstallation } from './plan.mjs';
import { executePlan } from './execute.mjs';
import { verifyInstallation } from './verify.mjs';

export async function runPipeline({
  projectRoot,
  homeDir,
  packageRoot,
  registry,
  probeTable,
  placeholders,
  readTemplate,
  selectedIds,
  consent = { dependencies: false },
  baselineProvider,
}) {
  const { plan } = await planInstallation({
    projectRoot,
    homeDir,
    registry,
    probeTable,
    selectedIds,
    consent,
  });
  const execution = await executePlan({
    plan,
    registry,
    projectRoot,
    homeDir,
    packageRoot,
    placeholders,
    readTemplate,
  });
  const report = await verifyInstallation({
    plan,
    execution,
    registry,
    baselineProvider,
  });
  return { plan, execution, report };
}
