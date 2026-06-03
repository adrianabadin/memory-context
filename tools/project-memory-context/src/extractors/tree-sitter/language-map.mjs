export const EXTENSION_TO_LANGUAGE = new Map([
  ['.ts',   'typescript'], ['.tsx',   'tsx'],
  ['.js',   'javascript'], ['.jsx',   'javascript'], ['.mjs', 'javascript'],
  ['.cs',   'csharp'],
  ['.py',   'python'],
  ['.java', 'java'],
  ['.go',   'go'],
  ['.rs',   'rust'],
  ['.rb',   'ruby'],
  ['.php',  'php'],
  ['.kt',   'kotlin'],    ['.kts',   'kotlin'],
  ['.swift','swift'],
  ['.cpp',  'cpp'],       ['.cc',    'cpp'],         ['.cxx', 'cpp'],
  ['.hpp',  'cpp'],       ['.h',     'cpp'],
]);

// Maps language name → { package, wasmFile }
// Only languages with shipped WASM files are included.
// kotlin and swift do not ship WASM in their npm packages and are omitted.
export const LANGUAGE_TO_GRAMMAR = {
  typescript: { pkg: 'tree-sitter-typescript', wasm: 'tree-sitter-typescript.wasm' },
  tsx:        { pkg: 'tree-sitter-typescript', wasm: 'tree-sitter-tsx.wasm' },
  javascript: { pkg: 'tree-sitter-javascript', wasm: 'tree-sitter-javascript.wasm' },
  csharp:     { pkg: 'tree-sitter-c-sharp',    wasm: 'tree-sitter-c_sharp.wasm' },
  python:     { pkg: 'tree-sitter-python',     wasm: 'tree-sitter-python.wasm' },
  java:       { pkg: 'tree-sitter-java',       wasm: 'tree-sitter-java.wasm' },
  go:         { pkg: 'tree-sitter-go',         wasm: 'tree-sitter-go.wasm' },
  rust:       { pkg: 'tree-sitter-rust',       wasm: 'tree-sitter-rust.wasm' },
  ruby:       { pkg: 'tree-sitter-ruby',       wasm: 'tree-sitter-ruby.wasm' },
  php:        { pkg: 'tree-sitter-php',        wasm: 'tree-sitter-php.wasm' },
  cpp:        { pkg: 'tree-sitter-cpp',        wasm: 'tree-sitter-cpp.wasm' },
};

/** Returns the canonical language name for a file extension, or null. */
export function languageForExtension(ext) {
  return EXTENSION_TO_LANGUAGE.get(ext.toLowerCase()) ?? null;
}
