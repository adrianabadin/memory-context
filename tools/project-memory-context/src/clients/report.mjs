export function formatInstallReport(report, { jsonMode = false } = {}) {
  if (jsonMode) {
    return JSON.stringify(report, null, 2);
  }

  const lines = [];
  lines.push(`PMC install report (planId=${report.planId})`);
  for (const client of report.clients) {
    lines.push(`  ${client.clientId}${client.error ? ' [error]' : ''}`);
    for (const cap of client.capabilities) {
      lines.push(`    - ${cap.capability}: ${cap.status}${cap.reason ? ` (${cap.reason})` : ''}${cap.targetPath ? ` -> ${cap.targetPath}` : ''}`);
    }
  }
  lines.push(`  exitCode: ${report.exitCode}`);
  return lines.join('\n');
}

export function computeExitCode(report) {
  return report.exitCode;
}
