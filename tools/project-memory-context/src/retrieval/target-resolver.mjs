function normalizeTargetPath(target) {
  return String(target ?? '').replace(/\\/g, '/');
}

function hasFileNameishLastSegment(target) {
  const last = target.split(/[\\/]/).pop();
  return looksLikeBareFilename(last) || /\.[a-zA-Z0-9]{2,6}$/.test(last);
}

function looksLikePath(target) {
  return /^[A-Za-z]:[\\/]/.test(target)
    || /^[\\/]{2}/.test(target)
    || /^\.{1,2}$/.test(target)
    || /^\.{1,2}[\\/]/.test(target)
    || (/[\\/]/.test(target) && (!/\s/.test(target) || hasFileNameishLastSegment(target)));
}

function looksLikeBareFilename(target) {
  return /^(Dockerfile|Makefile|README\.(md|txt)|package\.json|tsconfig\.json|jsconfig\.json|\.gitignore|\.npmrc|\.env(\.[A-Za-z0-9_-]+)?)$/i.test(target);
}

function resolveSymbolTarget(engine, target) {
  const symbolKeys = engine.findSymbolKeyByName(target);
  if (symbolKeys.length === 1) {
    return { mode: 'symbol', target, symbolKey: symbolKeys[0] };
  }
  if (symbolKeys.length > 1) {
    return { mode: 'symbol-ambiguous', target, symbolKeys };
  }
  return { mode: 'symbol-missing', target };
}

export function resolveTarget({ engine, explicitMode = null, target }) {
  if (explicitMode === 'query') {
    return { mode: 'query', target };
  }

  if (explicitMode === 'file') {
    return { mode: 'file', target: normalizeTargetPath(target) };
  }

  if (explicitMode === 'symbol') {
    return resolveSymbolTarget(engine, target);
  }

  const normalizedTarget = normalizeTargetPath(target);
  if (looksLikePath(target) || looksLikeBareFilename(target) || engine.findSymbolKeysByFilePath(normalizedTarget).length > 0) {
    return { mode: 'file', target: normalizedTarget };
  }

  const symbolResult = resolveSymbolTarget(engine, target);
  if (symbolResult.mode !== 'symbol-missing') {
    return symbolResult;
  }

  return { mode: 'query', target };
}
