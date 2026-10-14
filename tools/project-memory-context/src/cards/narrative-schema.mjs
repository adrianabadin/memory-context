// Structured narratives are untrusted descriptions, never generated graph facts.
// Graph membership is supplied by the caller; this module performs no I/O.
const listFields = ['behavior', 'sideEffects', 'errors', 'contracts', 'mentions'];
const fields = ['summary', ...listFields.slice(0, 4), 'changeNotes', 'mentions'];

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

export const NARRATIVE_SCHEMA = freeze({
  type: 'object', additionalProperties: false, required: [...fields],
  properties: {
    summary: { type: 'string', pattern: '^\\s*(?:\\S+(?:\\s+\\S+){0,24})?\\s*$' },
    changeNotes: { type: 'string' },
    ...Object.fromEntries(listFields.map((field) => [field, { type: 'array', items: { type: 'string' } }])),
  },
});

function graphKeys(symbolKeys) {
  if (!(symbolKeys instanceof Set)) throw new TypeError('symbolKeys must be a Set of graph symbol keys');
  return symbolKeys;
}

export function validateNarrative(value, { symbolKeys = new Set() } = {}) {
  graphKeys(symbolKeys);
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { valid: false, errors: ['Narrative must be a JSON object'] };
  }
  for (const field of Object.keys(value)) {
    if (!fields.includes(field)) errors.push(`Unexpected narrative field: ${field}`);
  }
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) errors.push(`Missing narrative field: ${field}`);
  }
  for (const field of ['summary', 'changeNotes']) {
    if (typeof value[field] !== 'string') errors.push(`${field} must be a string`);
  }
  if (typeof value.summary === 'string' && value.summary.trim().split(/\s+/u).filter(Boolean).length > 25) {
    errors.push('summary must contain at most 25 words');
  }
  for (const field of listFields) {
    if (!Array.isArray(value[field]) || value[field].some((item) => typeof item !== 'string')) {
      errors.push(`${field} must be an array of strings`);
    }
  }
  if (Array.isArray(value.mentions)) {
    for (const mention of value.mentions) {
      if (typeof mention === 'string' && !symbolKeys.has(mention)) errors.push(`Mention does not exist in graph: ${mention}`);
    }
  }
  return { valid: errors.length === 0, errors };
}

// This injected orchestration helper bounds schema retries only. Provider errors
// propagate unchanged; provider fallback and persisted status belong to the queue.
export async function generateValidatedNarrative({ generate, symbolKeys = new Set() } = {}) {
  if (typeof generate !== 'function') throw new TypeError('generate must be an injected narrative generator');
  const known = new Set(graphKeys(symbolKeys));
  let errors = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const raw = await generate({ schema: NARRATIVE_SCHEMA, attempt, errors: [...errors] });
    let value = raw;
    if (typeof raw === 'string') {
      try { value = JSON.parse(raw); }
      catch { errors = ['Narrative output must be valid JSON']; continue; }
    }
    const result = validateNarrative(value, { symbolKeys: known });
    errors = result.errors;
    if (result.valid) {
      const narrative = Object.fromEntries(fields.map((field) => [field,
        Array.isArray(value[field]) ? [...value[field]] : value[field],
      ]));
      return { status: 'validated', narrative, attempts: attempt, errors: [] };
    }
  }
  return { status: 'error', narrative: null, attempts: 2, errors };
}
