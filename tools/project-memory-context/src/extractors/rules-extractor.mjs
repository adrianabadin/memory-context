export async function detectRulesContext({ readmeText = '' }) {
  const rules = [];
  for (const sentence of readmeText.split(/(?<=[.!?])\s+/)) {
    if (/^use\s/i.test(sentence) || /^avoid\s/i.test(sentence) || /^keep\s/i.test(sentence)) {
      rules.push(sentence.trim());
    }
  }
  return { rules };
}
