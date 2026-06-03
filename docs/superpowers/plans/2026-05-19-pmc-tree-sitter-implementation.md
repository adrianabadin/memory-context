# PMC Tree-Sitter Multi-Language Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the regex-based TS/JS extractor and C# state machine in `symbol-extractor.mjs` with a unified tree-sitter engine supporting 12 languages (TS, JS, C#, Python, Java, Go, Rust, Ruby, PHP, Kotlin, Swift, C++). Add `pmc doctor` for environment validation and harden Windows path handling.

**Architecture:** `web-tree-sitter` (WASM) runtime — no native compilation, cross-platform. One `.scm` query file per language. Public API of `extractTopLevelSymbols()` is unchanged. New `pmc doctor` command checks 6 runtime dependencies and integrates into `pmc setup`.

**Tech Stack:** Node.js 18+ ESM, `node:test`, `node:assert/strict`, `web-tree-sitter`, per-language grammar npm packages.

**Design spec:** `docs/superpowers/specs/2026-05-19-pmc-tree-sitter-design.md`

---

## Task 1: Bootstrap tree-sitter Runtime

**Files:**
- Modify: `tools/project-memory-context/package.json`
- Create: `tools/project-memory-context/src/extractors/tree-sitter/runtime.mjs`
- Create: `tools/project-memory-context/src/extractors/tree-sitter/language-map.mjs`
- Create: `tools/project-memory-context/tests/extractors/tree-sitter-runtime.test.mjs`

- [ ] **Step 1: Write the failing test**

  Create `tests/extractors/tree-sitter-runtime.test.mjs`:

  ```js
  import test from 'node:test';
  import assert from 'node:assert/strict';
  import { loadLanguage, initParser } from '../../src/extractors/tree-sitter/runtime.mjs';

  test('initParser returns a Parser instance', async () => {
    const parser = await initParser();
    assert.ok(parser, 'parser should be truthy');
  });

  test('loadLanguage returns a Language for python', async () => {
    const lang = await loadLanguage('python');
    assert.ok(lang, 'language should be truthy');
  });

  test('loadLanguage throws for unsupported language', async () => {
    await assert.rejects(
      () => loadLanguage('brainfuck'),
      /unsupported language/i
    );
  });

  test('loadLanguage is cached (same reference on second call)', async () => {
    const a = await loadLanguage('python');
    const b = await loadLanguage('python');
    assert.strictEqual(a, b);
  });
  ```

  Run `node --test tests/extractors/tree-sitter-runtime.test.mjs` → fails.

- [ ] **Step 2: Add dependencies to `package.json`**

  Add to `dependencies`:
  ```json
  "web-tree-sitter": "^0.22.6",
  "tree-sitter-typescript": "^0.21.2",
  "tree-sitter-python": "^0.21.0",
  "tree-sitter-java": "^0.21.0",
  "tree-sitter-go": "^0.21.0",
  "tree-sitter-rust": "^0.21.2",
  "tree-sitter-ruby": "^0.21.0",
  "tree-sitter-php": "^0.22.8",
  "tree-sitter-kotlin": "^0.3.8",
  "tree-sitter-swift": "^0.5.0",
  "tree-sitter-cpp": "^0.22.1",
  "tree-sitter-c-sharp": "^0.21.3"
  ```

  Run `npm install`.

- [ ] **Step 3: Implement `language-map.mjs`**

  ```js
  export const EXTENSION_TO_LANGUAGE = new Map([
    ['.ts',  'typescript'],  ['.tsx', 'typescript'],
    ['.js',  'javascript'],  ['.jsx', 'javascript'],  ['.mjs', 'javascript'],
    ['.cs',  'csharp'],
    ['.py',  'python'],
    ['.java','java'],
    ['.go',  'go'],
    ['.rs',  'rust'],
    ['.rb',  'ruby'],
    ['.php', 'php'],
    ['.kt',  'kotlin'],      ['.kts', 'kotlin'],
    ['.swift','swift'],
    ['.cpp', 'cpp'],  ['.cc', 'cpp'],  ['.cxx', 'cpp'],
    ['.hpp', 'cpp'],  ['.h',  'cpp'],
  ]);

  // Grammar package names as installed in node_modules
  export const LANGUAGE_TO_GRAMMAR_PACKAGE = {
    typescript: 'tree-sitter-typescript',
    javascript: 'tree-sitter-typescript',  // TS package bundles JS grammar
    csharp:     'tree-sitter-c-sharp',
    python:     'tree-sitter-python',
    java:       'tree-sitter-java',
    go:         'tree-sitter-go',
    rust:       'tree-sitter-rust',
    ruby:       'tree-sitter-ruby',
    php:        'tree-sitter-php',
    kotlin:     'tree-sitter-kotlin',
    swift:      'tree-sitter-swift',
    cpp:        'tree-sitter-cpp',
  };

  export function languageForExtension(ext) {
    return EXTENSION_TO_LANGUAGE.get(ext.toLowerCase()) ?? null;
  }
  ```

- [ ] **Step 4: Implement `runtime.mjs`**

  ```js
  import Parser from 'web-tree-sitter';
  import { createRequire } from 'node:module';
  import { join, dirname } from 'node:path';
  import { fileURLToPath } from 'node:url';
  import { LANGUAGE_TO_GRAMMAR_PACKAGE } from './language-map.mjs';

  const require = createRequire(import.meta.url);
  let parserSingleton = null;
  const languageCache = new Map();

  export async function initParser() {
    if (parserSingleton) return parserSingleton;
    await Parser.init();
    parserSingleton = new Parser();
    return parserSingleton;
  }

  export async function loadLanguage(name) {
    if (languageCache.has(name)) return languageCache.get(name);

    const pkg = LANGUAGE_TO_GRAMMAR_PACKAGE[name];
    if (!pkg) throw new Error(`Unsupported language: "${name}". Supported: ${Object.keys(LANGUAGE_TO_GRAMMAR_PACKAGE).join(', ')}`);

    // Resolve .wasm path from the grammar package
    const pkgDir = dirname(require.resolve(`${pkg}/package.json`));
    // tree-sitter grammar packages expose .wasm under different subpaths
    // common: {pkg}/tree-sitter-{lang}.wasm or {pkg}/grammar.wasm
    const wasmName = name === 'csharp' ? 'tree-sitter-c_sharp.wasm'
                   : name === 'cpp'    ? 'tree-sitter-cpp.wasm'
                   : `tree-sitter-${name}.wasm`;
    const wasmPath = join(pkgDir, wasmName);

    const language = await Parser.Language.load(wasmPath);
    languageCache.set(name, language);
    return language;
  }
  ```

- [ ] **Step 5: Verify**

  ```bash
  cd tools/project-memory-context
  npm install
  node --test tests/extractors/tree-sitter-runtime.test.mjs
  ```
  All 4 runtime tests pass.

---

## Task 2: Generic Symbol Extractor + Python Query

**Files:**
- Create: `tools/project-memory-context/src/extractors/tree-sitter/extract.mjs`
- Create: `tools/project-memory-context/src/extractors/tree-sitter/queries/python.scm`
- Create: `tools/project-memory-context/tests/fixtures/sample.py`
- Create: `tools/project-memory-context/tests/extractors/python-extract.test.mjs`

- [ ] **Step 1: Write the failing test**

  Create `tests/fixtures/sample.py`:
  ```python
  class Animal:
      def speak(self):
          pass

  class Dog(Animal):
      def speak(self):
          return "woof"

  def standalone_function(x, y):
      return x + y

  async def async_handler(request):
      pass

  def _private_function():
      pass
  ```

  Create `tests/extractors/python-extract.test.mjs`:
  ```js
  import test from 'node:test';
  import assert from 'node:assert/strict';
  import { readFile } from 'node:fs/promises';
  import { fileURLToPath } from 'node:url';
  import { join, dirname } from 'node:path';
  import { extractSymbolsForFile } from '../../src/extractors/tree-sitter/extract.mjs';

  const __dirname = dirname(fileURLToPath(import.meta.url));

  test('extracts Python classes and functions', async () => {
    const content = await readFile(join(__dirname, '../fixtures/sample.py'), 'utf-8');
    const symbols = await extractSymbolsForFile({ filePath: 'sample.py', content });

    const names = symbols.map(s => s.name);
    assert.ok(names.includes('Animal'), 'should find class Animal');
    assert.ok(names.includes('Dog'), 'should find class Dog');
    assert.ok(names.includes('standalone_function'), 'should find standalone function');
    assert.ok(names.includes('async_handler'), 'should find async function');

    const classSymbols = symbols.filter(s => s.kind === 'class');
    assert.equal(classSymbols.length, 2);

    const funcSymbols = symbols.filter(s => s.kind === 'function');
    assert.ok(funcSymbols.length >= 3);

    // Export scope: _ prefix = local
    const privateFunc = symbols.find(s => s.name === '_private_function');
    assert.equal(privateFunc?.exportScope, 'local');

    // Public function = exported
    const pubFunc = symbols.find(s => s.name === 'standalone_function');
    assert.equal(pubFunc?.exportScope, 'exported');
  });
  ```

  Run `node --test tests/extractors/python-extract.test.mjs` → fails.

- [ ] **Step 2: Write `python.scm`**

  ```scheme
  ; Class definitions
  (class_definition
    name: (identifier) @name) @class

  ; Top-level function definitions (including async)
  (function_definition
    name: (identifier) @name) @function

  ; Decorated functions
  (decorated_definition
    (function_definition
      name: (identifier) @name)) @function
  ```

- [ ] **Step 3: Implement `extract.mjs`**

  ```js
  import { readFile } from 'node:fs/promises';
  import { createHash } from 'node:crypto';
  import { extname } from 'node:path';
  import { initParser, loadLanguage } from './runtime.mjs';
  import { languageForExtension } from './language-map.mjs';
  import { buildSymbolKey } from '../../symbol-keys.mjs';

  // Resolve export scope per language
  function inferExportScope(name, language, node) {
    switch (language) {
      case 'python':
        return name.startsWith('_') ? 'local' : 'exported';
      case 'go':
        return name[0] === name[0].toUpperCase() ? 'exported' : 'local';
      case 'rust': {
        const src = node.parent?.text ?? '';
        return src.includes('pub ') ? 'exported' : 'local';
      }
      case 'java':
      case 'csharp':
      case 'kotlin': {
        const src = node.parent?.text ?? '';
        return src.includes('public') ? 'exported' : 'local';
      }
      default:
        return 'exported'; // Ruby, PHP, Swift, C++ — all top-level
    }
  }

  export async function extractSymbolsForFile({ filePath, content }) {
    const ext = extname(filePath).toLowerCase();
    const language = languageForExtension(ext);
    if (!language) return [];

    const parser = await initParser();
    const lang = await loadLanguage(language);
    parser.setLanguage(lang);

    const tree = parser.parse(content);
    const queryText = await loadQuery(language);
    const query = lang.query(queryText);

    const matches = query.matches(tree.rootNode);
    const lines = content.split('\n');
    const symbols = [];

    for (const match of matches) {
      const kindCapture = match.captures.find(c => c.name !== 'name');
      const nameCapture = match.captures.find(c => c.name === 'name');
      if (!nameCapture) continue;

      const name = nameCapture.node.text;
      const parentNode = kindCapture?.node ?? nameCapture.node.parent;
      const startLine = (parentNode?.startPosition?.row ?? nameCapture.node.startPosition.row) + 1;
      const endLine = (parentNode?.endPosition?.row ?? nameCapture.node.endPosition.row) + 1;
      const kind = normalizeKind(kindCapture?.name ?? 'function', language);
      const codeFragment = lines.slice(startLine - 1, endLine).join('\n');
      const codeHash = createHash('sha1').update(codeFragment).digest('hex');
      const exportScope = inferExportScope(name, language, nameCapture.node);
      const languageLabel = ext === '.js' || ext === '.jsx' || ext === '.mjs' ? 'js' : language === 'typescript' ? 'ts' : language;

      const symbol = {
        language: languageLabel,
        filePath: filePath.replace(/\\/g, '/'),
        kind,
        name,
        exportScope,
        range: { startLine, endLine },
        codeHash,
      };
      symbol.symbolKey = buildSymbolKey(symbol);
      symbols.push(symbol);
    }

    symbols.sort((a, b) => a.range.startLine - b.range.startLine);
    return deduplicateByKey(symbols);
  }

  // Normalize capture names to canonical kinds
  function normalizeKind(captureName, language) {
    if (captureName.includes('class') || captureName.includes('record') || captureName.includes('struct')) return 'class';
    if (captureName.includes('interface') || captureName.includes('protocol') || captureName.includes('trait')) return 'interface';
    if (captureName.includes('type') || captureName.includes('alias')) return 'type';
    if (captureName.includes('method')) return 'function';
    return 'function';
  }

  function deduplicateByKey(symbols) {
    const seen = new Set();
    return symbols.filter(s => {
      if (seen.has(s.symbolKey)) return false;
      seen.add(s.symbolKey);
      return true;
    });
  }

  const queryCache = new Map();
  async function loadQuery(language) {
    if (queryCache.has(language)) return queryCache.get(language);
    const { default: text } = await import(
      `./queries/${language}.scm`,
      { assert: { type: 'text' } }
    );
    // Fallback for runtimes without import assertions:
    // const text = (await readFile(new URL(`./queries/${language}.scm`, import.meta.url), 'utf-8'));
    queryCache.set(language, text);
    return text;
  }
  ```

  > **Note:** If `import ... with { type: 'text' }` is unsupported on Node 18, use `readFile` with `fileURLToPath(new URL(..., import.meta.url))` as fallback. Comment both variants.

- [ ] **Step 4: Verify**

  ```bash
  node --test tests/extractors/python-extract.test.mjs
  ```
  All assertions pass.

---

## Task 3: Java, Go, Rust Queries

**Files:**
- Create: `queries/java.scm`, `queries/go.scm`, `queries/rust.scm`
- Create: `tests/fixtures/sample.java`, `tests/fixtures/sample.go`, `tests/fixtures/sample.rs`
- Create: `tests/extractors/java-extract.test.mjs`, `tests/extractors/go-extract.test.mjs`, `tests/extractors/rust-extract.test.mjs`

- [ ] **Step 1: Write 3 failing tests**

  Each test reads its fixture and asserts key symbols are found with correct `kind`. Cover:
  - **Java:** class, interface, public method, enum
  - **Go:** function declaration, type struct, type interface, exported vs unexported (by capitalization)
  - **Rust:** struct, enum, impl (method), fn, pub fn vs fn (export scope)

- [ ] **Step 2: Write the 3 queries**

  `java.scm`:
  ```scheme
  (class_declaration name: (identifier) @name) @class
  (interface_declaration name: (identifier) @name) @interface
  (enum_declaration name: (identifier) @name) @class
  (method_declaration name: (identifier) @name) @method
  (constructor_declaration name: (identifier) @name) @method
  ```

  `go.scm`:
  ```scheme
  (function_declaration name: (identifier) @name) @function
  (method_declaration name: (field_identifier) @name) @method
  (type_spec name: (type_identifier) @name) @type
  ```

  `rust.scm`:
  ```scheme
  (struct_item name: (type_identifier) @name) @class
  (enum_item name: (type_identifier) @name) @class
  (trait_item name: (type_identifier) @name) @interface
  (function_item name: (identifier) @name) @function
  (impl_item type: (type_identifier) @name) @class
  ```

- [ ] **Step 3: Verify**

  ```bash
  node --test tests/extractors/java-extract.test.mjs
  node --test tests/extractors/go-extract.test.mjs
  node --test tests/extractors/rust-extract.test.mjs
  ```
  All 3 pass.

---

## Task 4: Ruby, PHP, Kotlin, Swift, C++ Queries

**Files:**
- Create: `queries/ruby.scm`, `queries/php.scm`, `queries/kotlin.scm`, `queries/swift.scm`, `queries/cpp.scm`
- Create: 5 fixture files
- Create: 5 test files

- [ ] **Step 1: Write 5 failing tests** — one per language, covering class/module + method/function + 1 language-specific construct.

- [ ] **Step 2: Write the 5 queries**

  `ruby.scm`:
  ```scheme
  (class name: [(constant)(scope_resolution)] @name) @class
  (module name: [(constant)(scope_resolution)] @name) @class
  (method name: [(identifier)(setter)] @name) @method
  (singleton_method name: [(identifier)(setter)] @name) @method
  ```

  `php.scm`:
  ```scheme
  (class_declaration name: (name) @name) @class
  (interface_declaration name: (name) @name) @interface
  (trait_declaration name: (name) @name) @class
  (function_definition name: (name) @name) @function
  (method_declaration name: (name) @name) @method
  ```

  `kotlin.scm`:
  ```scheme
  (class_declaration (type_identifier) @name) @class
  (object_declaration (type_identifier) @name) @class
  (function_declaration (simple_identifier) @name) @function
  (secondary_constructor) @function
  ```

  `swift.scm`:
  ```scheme
  (class_declaration name: (type_identifier) @name) @class
  (struct_declaration name: (type_identifier) @name) @class
  (protocol_declaration name: (type_identifier) @name) @interface
  (extension_declaration (type_identifier) @name) @class
  (function_declaration name: (simple_identifier) @name) @function
  ```

  `cpp.scm`:
  ```scheme
  (class_specifier name: (type_identifier) @name) @class
  (struct_specifier name: (type_identifier) @name) @class
  (namespace_definition name: (namespace_identifier) @name) @class
  (function_definition declarator: (function_declarator declarator: (identifier) @name)) @function
  (function_definition declarator: (function_declarator declarator: (qualified_identifier name: (identifier) @name))) @method
  ```

- [ ] **Step 3: Verify**

  ```bash
  node --test tests/extractors/ruby-extract.test.mjs
  node --test tests/extractors/php-extract.test.mjs
  node --test tests/extractors/kotlin-extract.test.mjs
  node --test tests/extractors/swift-extract.test.mjs
  node --test tests/extractors/cpp-extract.test.mjs
  ```
  All 5 pass.

---

## Task 5: TS/JS/C# Migration + Legacy Removal

**Files:**
- Create: `queries/typescript.scm`, `queries/javascript.scm`, `queries/csharp.scm`
- Create: `tests/fixtures/sample.ts`, `tests/fixtures/sample.js`, `tests/fixtures/sample.cs`
- Create: `tests/extractors/typescript-extract.test.mjs`, `tests/extractors/javascript-extract.test.mjs`, `tests/extractors/csharp-extract.test.mjs`
- Modify: `src/symbol-extractor.mjs`

- [ ] **Step 1: Write failing tests that cover regex blind spots**

  `tests/extractors/typescript-extract.test.mjs` must include:
  ```js
  test('handles decorator on class', async () => {
    const content = `@Injectable()\nexport class MyService {}`;
    const symbols = await extractSymbolsForFile({ filePath: 'a.ts', content });
    assert.ok(symbols.some(s => s.name === 'MyService' && s.kind === 'class'));
  });

  test('handles generic class', async () => {
    const content = `export class Repository<T extends Entity> {}`;
    const symbols = await extractSymbolsForFile({ filePath: 'a.ts', content });
    assert.ok(symbols.some(s => s.name === 'Repository'));
  });

  test('handles arrow function in const at top level', async () => {
    const content = `export const handler = async (req: Request): Promise<void> => { }`;
    const symbols = await extractSymbolsForFile({ filePath: 'a.ts', content });
    assert.ok(symbols.some(s => s.name === 'handler'));
  });
  ```

  Run → fails (tree-sitter not yet connected to symbol-extractor).

- [ ] **Step 2: Write the 3 queries**

  `typescript.scm`:
  ```scheme
  (interface_declaration name: (type_identifier) @name) @interface
  (class_declaration name: (type_identifier) @name) @class
  ; Decorated class
  (export_statement declaration: (class_declaration name: (type_identifier) @name)) @class
  (function_declaration name: (identifier) @name) @function
  ; const fn = () => {}
  (lexical_declaration
    (variable_declarator
      name: (identifier) @name
      value: [(arrow_function)(function_expression)])) @function
  (type_alias_declaration name: (type_identifier) @name) @type
  ```

  `javascript.scm` (subset without types/interfaces):
  ```scheme
  (class_declaration name: (identifier) @name) @class
  (function_declaration name: (identifier) @name) @function
  (lexical_declaration
    (variable_declarator
      name: (identifier) @name
      value: [(arrow_function)(function_expression)])) @function
  ```

  `csharp.scm`:
  ```scheme
  (class_declaration name: (identifier) @name) @class
  (interface_declaration name: (identifier) @name) @interface
  (record_declaration name: (identifier) @name) @class
  (enum_declaration name: (identifier) @name) @class
  (struct_declaration name: (identifier) @name) @class
  (method_declaration name: (identifier) @name) @method
  (constructor_declaration name: (identifier) @name) @method
  ```

- [ ] **Step 3: Replace `symbol-extractor.mjs` internals**

  Keep only the public API:
  ```js
  export { extractTopLevelSymbols, buildEnrichmentWorklist } from './extractors/tree-sitter/extract.mjs';
  // buildEnrichmentWorklist remains unchanged
  ```

  Or, if `buildEnrichmentWorklist` is not in `extract.mjs`, keep it inline and delegate `extractTopLevelSymbols` to `extractSymbolsForFile`.

- [ ] **Step 4: Delete legacy code**

  Remove from `symbol-extractor.mjs`:
  - `extractTypeScriptSymbols()` (regex patterns)
  - `extractCSharpSymbols()` (state machine)
  - `parseCSharpParameters()`
  - All regex constants

- [ ] **Step 5: Run full test suite**

  ```bash
  cd tools/project-memory-context
  npm test
  ```
  All pre-existing tests pass. All 3 new language tests pass.

---

## Task 6: `pmc doctor` Command

**Files:**
- Create: `tools/project-memory-context/src/doctor.mjs`
- Create: `tools/project-memory-context/cli/doctor.mjs`
- Modify: `tools/project-memory-context/src/command-dispatch.mjs`
- Modify: `tools/project-memory-context/cli/setup.mjs`
- Create: `tools/project-memory-context/tests/doctor.test.mjs`

- [ ] **Step 1: Write the failing test**

  Create `tests/doctor.test.mjs`:

  ```js
  import test from 'node:test';
  import assert from 'node:assert/strict';
  import { runDoctor } from '../src/doctor.mjs';

  test('returns ok for Node version check when >= 18', async () => {
    const result = await runDoctor({
      env: { MEMORY_DB_PATH: '/tmp/test', NODE_VERSION: '18.0.0' },
      fetchImpl: async () => ({ ok: true }),
      resolvePythonBin: () => 'python3',
      resolveGraphify: () => '/usr/bin/graphifyy',
      spawnCheck: async () => ({ exitCode: 0 }),
    });
    const nodeCheck = result.checks.find(c => c.name === 'node-version');
    assert.equal(nodeCheck?.status, 'ok');
  });

  test('returns fail when Ollama is unreachable', async () => {
    const result = await runDoctor({
      env: { MEMORY_DB_PATH: '/tmp/test' },
      fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
      resolvePythonBin: () => 'python3',
      resolveGraphify: () => '/usr/bin/graphifyy',
      spawnCheck: async () => ({ exitCode: 0 }),
    });
    const ollamaCheck = result.checks.find(c => c.name === 'ollama');
    assert.equal(ollamaCheck?.status, 'fail');
  });

  test('returns structured checks array with 6 items', async () => {
    const result = await runDoctor({
      env: { MEMORY_DB_PATH: '/tmp/test' },
      fetchImpl: async () => ({ ok: true }),
      resolvePythonBin: () => null,
      resolveGraphify: () => null,
      spawnCheck: async () => ({ exitCode: 1 }),
    });
    assert.equal(result.checks.length, 6);
    assert.ok(result.checks.every(c => ['ok','warn','fail'].includes(c.status)));
  });
  ```

  Run `node --test tests/doctor.test.mjs` → fails.

- [ ] **Step 2: Implement `src/doctor.mjs`**

  ```js
  import { access, constants } from 'node:fs/promises';
  import { satisfies } from 'node:util';

  export async function runDoctor({
    env = process.env,
    fetchImpl = fetch,
    resolvePythonBin,
    resolveGraphify,
    spawnCheck,
  } = {}) {
    const checks = await Promise.all([
      checkNodeVersion(),
      checkPython(resolvePythonBin, spawnCheck),
      checkGraphify(resolveGraphify, resolvePythonBin, spawnCheck),
      checkOllama(env, fetchImpl),
      checkMemoryDbPath(env),
      checkEmbeddingCachePath(env),
    ]);
    return { checks };
  }

  async function checkNodeVersion() {
    const version = process.version; // e.g. 'v20.0.0'
    const major = parseInt(version.slice(1).split('.')[0], 10);
    return {
      name: 'node-version',
      status: major >= 18 ? 'ok' : 'fail',
      message: major >= 18
        ? `Node.js ${version} ✓`
        : `Node.js ${version} — requires ≥ 18`,
    };
  }

  async function checkPython(resolvePythonBin, spawnCheck) {
    const bin = resolvePythonBin?.() ?? null;
    if (!bin) return { name: 'python', status: 'fail', message: 'Python 3 not found in PATH' };
    const result = await spawnCheck?.(`${bin} --version`) ?? { exitCode: 0 };
    return {
      name: 'python',
      status: result.exitCode === 0 ? 'ok' : 'fail',
      message: result.exitCode === 0 ? `${bin} found ✓` : `${bin} failed to run`,
    };
  }

  async function checkGraphify(resolveGraphify, resolvePythonBin, spawnCheck) {
    const bin = resolvePythonBin?.() ?? 'python3';
    const result = await spawnCheck?.(`${bin} -c "import graphifyy"`) ?? { exitCode: 1 };
    return {
      name: 'graphifyy',
      status: result.exitCode === 0 ? 'ok' : 'fail',
      message: result.exitCode === 0
        ? 'graphifyy importable ✓'
        : 'graphifyy not installed — run: pip install graphifyy',
    };
  }

  async function checkOllama(env, fetchImpl) {
    const baseUrl = env.PMC_LOCAL_MODEL_BASE_URL ?? 'http://localhost:11434';
    try {
      const res = await fetchImpl(`${baseUrl}/api/tags`);
      return { name: 'ollama', status: res.ok ? 'ok' : 'warn', message: res.ok ? `Ollama reachable at ${baseUrl} ✓` : `Ollama responded with ${res.status}` };
    } catch {
      return { name: 'ollama', status: 'warn', message: `Ollama not reachable at ${baseUrl} (enrichment will use cloud fallback)` };
    }
  }

  async function checkMemoryDbPath(env) {
    const p = env.MEMORY_DB_PATH;
    if (!p) return { name: 'memory-db-path', status: 'fail', message: 'MEMORY_DB_PATH not set — required for agent-memory-mcp' };
    try {
      await access(p, constants.W_OK);
      return { name: 'memory-db-path', status: 'ok', message: `${p} writable ✓` };
    } catch {
      return { name: 'memory-db-path', status: 'warn', message: `${p} does not exist yet (will be created on first run)` };
    }
  }

  async function checkEmbeddingCachePath(env) {
    const p = env.EMBEDDING_CACHE_PATH;
    if (!p) return { name: 'embedding-cache', status: 'ok', message: 'EMBEDDING_CACHE_PATH not set (cache disabled — optional)' };
    try {
      await access(p, constants.W_OK);
      return { name: 'embedding-cache', status: 'ok', message: `${p} writable ✓` };
    } catch {
      return { name: 'embedding-cache', status: 'warn', message: `${p} does not exist yet (will be created on first run)` };
    }
  }
  ```

- [ ] **Step 3: Implement `cli/doctor.mjs`**

  ```js
  #!/usr/bin/env node
  import { runDoctor } from '../src/doctor.mjs';
  import { resolvePythonBin, resolveGraphify } from '../src/platform.mjs';
  import { spawnSync } from 'node:child_process';

  function spawnCheck(cmd) {
    const [bin, ...args] = cmd.split(' ');
    const result = spawnSync(bin, args, { encoding: 'utf-8' });
    return { exitCode: result.status ?? 1 };
  }

  const { checks } = await runDoctor({ resolvePythonBin, resolveGraphify, spawnCheck });

  const icon = { ok: '✓', warn: '⚠', fail: '✗' };
  console.log('\npmc doctor\n');
  for (const c of checks) {
    console.log(`  ${icon[c.status]} ${c.name.padEnd(22)} ${c.message}`);
  }

  const hasFail = checks.some(c => c.status === 'fail');
  console.log('');
  if (hasFail) {
    console.log('Some checks failed. Fix the issues above before running pmc setup.');
    process.exit(1);
  } else {
    console.log('All checks passed.');
  }
  ```

- [ ] **Step 4: Register in `command-dispatch.mjs`**

  Add `'doctor'` to the known command list and wire `cli/doctor.mjs`.

- [ ] **Step 5: Integrate into `cli/setup.mjs`**

  After bootstrap completes, call `runDoctor()` and print any `fail` items with corrective messages.

- [ ] **Step 6: Verify**

  ```bash
  node --test tests/doctor.test.mjs
  node bin/pmc.mjs doctor
  ```
  Tests pass. CLI output is readable.

---

## Task 7: Windows Path Hardening

**Files:**
- Modify: `tools/project-memory-context/src/platform.mjs`
- Create: `tools/project-memory-context/tests/platform-paths-windows.test.mjs`

- [ ] **Step 1: Write the failing test**

  ```js
  import test from 'node:test';
  import assert from 'node:assert/strict';
  import { normalizeProjectPath } from '../../src/platform.mjs';

  test('normalizeProjectPath converts backslashes, preserves spaces', () => {
    const result = normalizeProjectPath('C:\\Users\\nombre apellido\\proyecto');
    assert.equal(result, 'C:/Users/nombre apellido/proyecto');
  });

  test('normalizeProjectPath is identity on POSIX paths', () => {
    assert.equal(normalizeProjectPath('/home/user/my project'), '/home/user/my project');
  });
  ```

  Run `node --test tests/platform-paths-windows.test.mjs` → may fail.

- [ ] **Step 2: Harden `spawnBackground()` for paths with spaces**

  In `platform.mjs`, wherever `spawnBackground` or `child_process.spawn` builds a command from a path, use array-form args instead of a shell string:

  ```js
  // BEFORE (fragile with spaces):
  spawn(`${pythonBin} -m graphifyy "${projectPath}"`, { shell: true })

  // AFTER (safe):
  spawn(pythonBin, ['-m', 'graphifyy', projectPath], { shell: false })
  ```

  Review ALL `spawn`/`exec` calls in `platform.mjs` and `cli/` files. Replace string interpolation with array args form.

- [ ] **Step 3: Verify**

  ```bash
  node --test tests/platform-paths-windows.test.mjs
  ```
  Tests pass.

---

## Task 8: Documentation

**Files:**
- Modify: `tools/project-memory-context/README.md`

- [ ] **Step 1: Add Supported Languages table**

  | Language | Extensions |
  |----------|-----------|
  | TypeScript | `.ts`, `.tsx` |
  | JavaScript | `.js`, `.jsx`, `.mjs` |
  | C# | `.cs` |
  | Python | `.py` |
  | Java | `.java` |
  | Go | `.go` |
  | Rust | `.rs` |
  | Ruby | `.rb` |
  | PHP | `.php` |
  | Kotlin | `.kt`, `.kts` |
  | Swift | `.swift` |
  | C/C++ | `.cpp`, `.cc`, `.cxx`, `.hpp`, `.h` |

- [ ] **Step 2: Add Doctor section**

  ```
  ## pmc doctor

  Run environment checks before first use:

      pmc doctor

  Output: status of Node version, Python, graphifyy, Ollama, MEMORY_DB_PATH, and EMBEDDING_CACHE_PATH.
  Exit code: 0 = ok/warn, 1 = any fail.
  ```

- [ ] **Step 3: Add "Adding a New Language" guide**

  Short guide: copy a `.scm` file, register extension in `language-map.mjs`, add grammar package to `package.json`, add fixture + test.

---

## End-to-End Verification

```bash
cd tools/project-memory-context
npm install
npm test                                  # all tests pass, including 12 language extractors

# CLI smoke
node bin/pmc.mjs doctor                   # all 6 checks shown

# Real extraction smoke
# Create dummy files:
echo "def hello(): pass" > /tmp/test.py
echo "func main() {}" > /tmp/test.go
echo "class Foo { public void bar() {} }" > /tmp/test.java
node -e "
import { extractTopLevelSymbols } from './src/symbol-extractor.mjs';
import { readFileSync } from 'fs';
for (const f of ['/tmp/test.py', '/tmp/test.go', '/tmp/test.java']) {
  const content = readFileSync(f, 'utf-8');
  const syms = await extractTopLevelSymbols({ filePath: f, content });
  console.log(f, '->', syms.map(s => s.name));
}
"
```
