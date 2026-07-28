export const CLIENT_MARKERS = Object.freeze({
  opencode: Object.freeze({
    project: ['.opencode'],
    instructionFiles: [],
  }),
  'claude-code': Object.freeze({
    project: ['.claude'],
    instructionFiles: ['CLAUDE.md'],
  }),
  cursor: Object.freeze({
    project: ['.cursor'],
    instructionFiles: ['.cursorrules'],
  }),
  antigravity: Object.freeze({
    project: ['.agents'],
    instructionFiles: [],
  }),
  generic: Object.freeze({
    project: [],
    instructionFiles: ['README-SETUP.md'],
  }),
  codex: Object.freeze({
    project: ['.codex'],
    instructionFiles: [],
  }),
});
