function parseList(value) {
  return String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function normalizeSemanticReport(report) {
  const fields = new Map();

  for (const finding of report.findings ?? []) {
    const [rawKey, ...rest] = String(finding).split(':');
    if (!rawKey || rest.length === 0) continue;
    fields.set(rawKey.trim().toLowerCase(), rest.join(':').trim());
  }

  const summary = String(report.summary ?? '').trim();
  return {
    responsibility: fields.get('responsibility') || summary,
    inputs: parseList(fields.get('inputs')),
    output: fields.get('output') || 'Not specified.',
    dependencies: parseList(fields.get('dependencies')),
    role: fields.get('role') || 'Not specified.',
    summary,
  };
}
