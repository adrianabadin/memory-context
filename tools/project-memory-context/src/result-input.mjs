import { readFile } from 'node:fs/promises';

export async function loadResultInput(rawInput) {
  const input = String(rawInput ?? '').trim();
  const jsonText = input.startsWith('@')
    ? await readFile(input.slice(1), 'utf8')
    : input;
  return JSON.parse(jsonText);
}
