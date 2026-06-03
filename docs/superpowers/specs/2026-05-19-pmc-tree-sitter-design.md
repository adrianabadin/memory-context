# PMC Tree-Sitter Multi-Language Extractor Design

## Problem

`symbol-extractor.mjs` uses regex patterns for TypeScript/JavaScript and a hand-written line-by-line state machine for C#. Both approaches miss valid syntax:

- **TS/JS regex gaps:** decorators (`@Injectable() class Foo`), arrow functions in object literals, generic classes (`class Repo<T extends Entity>`), re-exports (`export { foo } from './bar'`)
- **C# state machine gaps:** multiline method signatures, expression-bodied members, default interface methods

Supporting additional languages would require a new bespoke parser per language, multiplying maintenance burden.

## Solution: tree-sitter via WASM

[tree-sitter](https://tree-sitter.github.io/) is a universal incremental parsing framework with compiled grammars for 100+ languages and a uniform query API (S-expression patterns). Using `web-tree-sitter` (WASM distribution) eliminates native compilation dependencies (`node-gyp`) and provides identical behavior on Windows, macOS, and Linux.

### Runtime choice: `web-tree-sitter` over `tree-sitter` native

| Aspect | `web-tree-sitter` (WASM) | `tree-sitter` (native) |
|--------|--------------------------|------------------------|
| Compilation | None — pre-built WASM | Requires `node-gyp` |
| Cross-platform | Guaranteed | Depends on prebuilds |
| Grammar distribution | `.wasm` file per grammar | Native binary per grammar |
| Performance | ~2× slower than native | Fastest |
| Grammar size | ~200–500 KB each | ~200–500 KB each |

For top-level symbol extraction (run once per file, not streaming), WASM performance is adequate.

## Architecture

```
extractTopLevelSymbols({filePath, content})    ← unchanged public API
  │
  ├── language-map.mjs           extension → languageName
  │   .ts/.tsx → typescript      .py → python     .java → java
  │   .js/.jsx → javascript      .go → go         .rs → rust
  │   .cs → csharp               .rb → ruby       .php → php
  │                              .kt → kotlin     .swift → swift
  │                              .cpp/.cc/.cxx/.hpp/.h → cpp
  │
  ├── runtime.mjs               singleton Parser, lazy grammar loading
  │   initParser()              loads web-tree-sitter WASM once
  │   loadLanguage(name)        loads .wasm grammar, caches by name
  │
  ├── extract.mjs               generic symbol extraction
  │   extractSymbolsWithQuery({tree, query, content, filePath, language})
  │   → [{kind, name, range, exportScope, arity?, codeHash, symbolKey}]
  │
  └── queries/{language}.scm    S-expression query per language (12 files)
```

The public API of `extractTopLevelSymbols` is **unchanged** — same input shape, same output shape. All callers continue working without modification.

## Supported Languages (12)

| Language | Extensions | Key symbols extracted |
|----------|-----------|----------------------|
| TypeScript | `.ts`, `.tsx` | interface, class, function, type, const arrow-fn |
| JavaScript | `.js`, `.jsx` | class, function, const arrow-fn |
| C# | `.cs` | class, interface, record, enum, method |
| Python | `.py` | class, function, async function, decorated |
| Java | `.java` | class, interface, enum, method |
| Go | `.go` | function, method, type (struct/interface) |
| Rust | `.rs` | struct, enum, impl, fn, trait |
| Ruby | `.rb` | class, module, method |
| PHP | `.php` | class, interface, trait, function, method |
| Kotlin | `.kt`, `.kts` | class, object, fun, data class |
| Swift | `.swift` | class, struct, protocol, func, extension |
| C++ | `.cpp`, `.cc`, `.cxx`, `.hpp`, `.h` | class, struct, function, namespace |

**Unsupported extensions:** `extractTopLevelSymbols` returns `[]` (no error). No behavioral change from current code.

## Export Scope Heuristics by Language

| Language | `exported` condition |
|----------|---------------------|
| TypeScript/JavaScript | `export` keyword on declaration |
| Python | name does NOT start with `_` |
| Go | name starts with uppercase letter |
| Rust | declaration has `pub` modifier |
| Java/Kotlin | declaration has `public` modifier |
| C# | declaration has `public` modifier |
| Ruby/PHP/Swift | all top-level declarations |
| C++ | not inside anonymous namespace |

## `pmc doctor` Command

New subcommand `pmc doctor` that validates the runtime environment before first use. Returns structured check results used both for CLI output and testability.

```
runDoctor({env, fetchImpl, resolvePythonBin, resolveGraphify}) → {
  checks: [{ name, status: 'ok'|'warn'|'fail', message }]
}
```

**Checks:**
1. Node.js ≥ 18
2. Python 3 in PATH
3. `graphifyy` importable (`python -c "import graphifyy"`)
4. Ollama reachable at configured base URL
5. `MEMORY_DB_PATH` directory writable (or creatable)
6. `EMBEDDING_CACHE_PATH` writable (only if set)

Exit code: `0` if all checks are `ok` or `warn`; `1` if any check is `fail`.

Integrated into `pmc setup`: runs doctor at the end of bootstrap and surfaces `fail` items with corrective instructions.

## Windows Path Hardening

`spawnBackground()` in `platform.mjs` must pass executable paths as array args to `child_process.spawn` (not string concatenation with `shell: true`), ensuring paths containing spaces (e.g. `C:\Users\nombre apellido\...`) are passed without shell word-splitting.

## Files to Create / Modify

| File | Action |
|------|--------|
| `src/symbol-extractor.mjs` | Replace internals; keep public API |
| `src/extractors/tree-sitter/runtime.mjs` | NEW |
| `src/extractors/tree-sitter/extract.mjs` | NEW |
| `src/extractors/tree-sitter/language-map.mjs` | NEW |
| `src/extractors/tree-sitter/queries/*.scm` | NEW × 12 |
| `src/doctor.mjs` | NEW |
| `cli/doctor.mjs` | NEW |
| `src/command-dispatch.mjs` | Register `doctor` |
| `cli/setup.mjs` | Call doctor post-bootstrap |
| `src/platform.mjs` | Harden spawn args |
| `package.json` | Add `web-tree-sitter` + 12 grammar packages |

## Dependency Budget

| Package | Size (approx) | Purpose |
|---------|--------------|---------|
| `web-tree-sitter` | ~1.5 MB | WASM parser runtime |
| `tree-sitter-typescript` | ~400 KB | TS + JS grammars |
| `tree-sitter-c-sharp` | ~300 KB | C# grammar |
| `tree-sitter-python` | ~280 KB | Python grammar |
| `tree-sitter-java` | ~300 KB | Java grammar |
| `tree-sitter-go` | ~250 KB | Go grammar |
| `tree-sitter-rust` | ~350 KB | Rust grammar |
| `tree-sitter-ruby` | ~280 KB | Ruby grammar |
| `tree-sitter-php` | ~350 KB | PHP grammar |
| `tree-sitter-kotlin` | ~300 KB | Kotlin grammar |
| `tree-sitter-swift` | ~400 KB | Swift grammar |
| `tree-sitter-cpp` | ~400 KB | C/C++ grammar |
| **Total** | **~5 MB** | |
