export function createEmptyRefreshState() {
  return {
    trackedFiles: {},
    memoryHashes: {},
    updatedAt: null,
  };
}

export function updateRefreshStateEntry(state, filePath, hash) {
  return {
    ...state,
    trackedFiles: {
      ...state.trackedFiles,
      [filePath]: hash,
    },
  };
}

export function shouldRefreshProjectContext(state, filePath, nextHash) {
  return state.trackedFiles[filePath] !== nextHash;
}
