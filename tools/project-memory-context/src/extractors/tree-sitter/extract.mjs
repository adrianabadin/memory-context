import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extname } from 'node:path';
import { Query } from 'web-tree-sitter';
import { initParser, loadLanguage } from './runtime.mjs';
import { languageForExtension } from './language-map.mjs';
import { hashSymbol } from '../../hash.mjs';
import { buildSymbolKey } from '../../symbol-keys.mjs';

// Cache for loaded query text
const queryCache = new Map();

async function loadQuery(language) {
  if (queryCache.has(language)) return queryCache.get(language);
  const url = new URL(`./queries/${language}.scm`, import.meta.url);
  const text = await readFile(fileURLToPath(url), 'utf-8');
  queryCache.set(language, text);
  return text;
}

// Map capture names to canonical kinds
const CAPTURE_TO_KIND = {
  class: 'class',
  function: 'function',
  interface: 'interface',
  type: 'type',
  record: 'record',
  method: 'method',
};

// Unit 1.2-A: structured class-member extraction is bounded to the JS/TS
// family grammars (`.jsx` shares the javascript grammar); unit 1.2-B1 extends
// the same fail-closed container resolution to Python and Java enclosed types.
// Unit 1.2-B2 resolves Go receivers and Rust impl self types directly, without
// requiring a same-file type symbol. C#/PHP and other legacy output is unchanged.
//
// Value = the enclosing node types whose top-level symbol capture authorizes a
// container, keyed per language so a method can never match a foreign
// same-named type. Java `record_declaration` is deliberately absent: record
// bodies have no captured top-level container in this unit, so record methods
// fail closed instead of inventing identity.
const MEMBER_CONTAINER_TYPES = {
  javascript: new Set(['class_declaration']),
  typescript: new Set(['class_declaration']),
  tsx: new Set(['class_declaration']),
  python: new Set(['class_definition']),
  java: new Set(['class_declaration', 'interface_declaration', 'enum_declaration']),
};

/**
 * Resolve the structured container for a class method, or null (fail closed),
 * dispatching to the small language-specific resolver over the real AST.
 */
function resolveMethodContainer(methodNode, topLevelContainers, rawLanguage) {
  if (rawLanguage === 'go') return resolveGoMethodContainer(methodNode);
  if (rawLanguage === 'rust') return resolveRustMethodContainer(methodNode);
  if (rawLanguage === 'python') return resolvePythonMethodContainer(methodNode, topLevelContainers);
  if (rawLanguage === 'java') return resolveJavaMethodContainer(methodNode, topLevelContainers);
  return resolveJavaScriptMethodContainer(methodNode, topLevelContainers);
}

/**
 * JS/TS/TSX container resolution (unit 1.2-A, unchanged behavior). A method
 * only qualifies when its direct parent is the `class_body` of a top-level,
 * named `class_declaration` that produced a top-level class symbol.
 * Object-literal methods (parent `object`), anonymous default classes (node
 * type `class`), nested/abstract containers and non-identifier method names
 * therefore never acquire an invented container.
 */
function resolveJavaScriptMethodContainer(methodNode, topLevelContainers) {
  const body = methodNode.parent;
  if (body?.type !== 'class_body') return null;
  const classNode = body.parent;
  if (classNode?.type !== 'class_declaration') return null;
  if (!isTopLevel(classNode)) return null;
  return topLevelContainers.get(classNode.startIndex) ?? null;
}

/**
 * Python container resolution (unit 1.2-B1): ordinary methods are a
 * `function_definition` and decorated methods a `decorated_definition` wrapper
 * — both must be the direct child of the class body `block`, which must belong
 * to an actual named top-level `class_definition` that produced a class symbol
 * in the pre-pass (module parent, keyed by the class AST span). Nested classes,
 * classes without a captured symbol (including decorated top-level classes,
 * which existing extraction never captured) and functions inside other bodies
 * therefore fail closed; no container is ever invented.
 */
function resolvePythonMethodContainer(methodNode, topLevelContainers) {
  const block = methodNode.parent;
  if (block?.type !== 'block') return null;
  const classNode = block.parent;
  if (classNode?.type !== 'class_definition') return null;
  if (!isTopLevel(classNode)) return null;
  return topLevelContainers.get(classNode.startIndex) ?? null;
}

/**
 * Java container resolution (unit 1.2-B1) over the actual grammar shapes:
 * class/record bodies are `class_body`, interfaces use `interface_body`, and
 * enum members sit in `enum_body_declarations` under `enum_body`. The resolved
 * type node must be a named top-level class/interface/enum that produced a
 * top-level symbol in the pre-pass (keyed by the type AST span). Nested types
 * (no nested parent identity without an existing container symbol) and record
 * bodies fail closed; enum-constant bodies (`enum_constant` parent) also fail
 * closed.
 */
function resolveJavaMethodContainer(methodNode, topLevelContainers) {
  const body = methodNode.parent;
  let typeNode = null;
  if (body?.type === 'class_body') typeNode = body.parent;
  else if (body?.type === 'interface_body') typeNode = body.parent;
  else if (body?.type === 'enum_body_declarations') typeNode = body.parent?.parent;
  else return null;
  if (!MEMBER_CONTAINER_TYPES.java.has(typeNode?.type)) return null;
  if (!isTopLevel(typeNode)) return null;
  return topLevelContainers.get(typeNode.startIndex) ?? null;
}

/** Go methods carry a separate receiver list, never an enclosing type body.
 * Only a single simple named type (optionally one pointer) is supported here;
 * generic/scoped/complex receivers fail closed. No same-file type is invented.
 */
function resolveGoMethodContainer(methodNode) {
  if (methodNode.type !== 'method_declaration' || !isTopLevel(methodNode)) return null;
  const receiver = methodNode.childForFieldName('receiver');
  if (!receiver || receiver.hasError) return null;
  const slots = receiver.namedChildren.filter(c => c.type !== 'comment');
  if (slots.length !== 1 || slots[0].type !== 'parameter_declaration') return null;
  if (slots[0].childrenForFieldName('name').length > 1) return null;
  let type = slots[0].childForFieldName('type');
  if (type?.type === 'pointer_type') {
    const children = type.namedChildren.filter(c => c.type !== 'comment');
    if (children.length !== 1) return null;
    type = children[0];
  }
  return type?.type === 'type_identifier' ? type.text : null;
}

/** Rust ownership comes from the enclosing top-level impl's `type` field,
 * never its `trait`. Only simple named self types are supported. A generic
 * binder is not a concrete container; scoped/generic/complex self types and
 * nested impls remain unresolved. The old impl-class capture is preserved.
 */
function resolveRustMethodContainer(methodNode) {
  const body = methodNode.parent;
  const impl = body?.parent;
  if (body?.type !== 'declaration_list' || impl?.type !== 'impl_item' || !isTopLevel(impl)) return null;
  const type = impl.childForFieldName('type');
  if (type?.type !== 'type_identifier' || type.hasError || type.text === 'Self') return null;
  const binders = impl.childForFieldName('type_parameters')?.namedChildren ?? [];
  if (binders.some(b => b.childForFieldName('name')?.text === type.text)) return null;
  return type.text;
}

/**
 * Determine if a node is at the top level of the file (not nested inside
 * another class/function body). For Python the module is the direct parent;
 * for other languages the root node (program/source_file/…) is the parent.
 * C++ nodes inside a namespace are also considered top-level.
 */
function isTopLevel(node) {
  const parentType = node.parent?.type;
  if (!parentType) return true;
  // Python: module; JS/TS: program; Go/Rust/Java/etc: source_file; C++: translation_unit
  if (
    parentType === 'module' ||
    parentType === 'program' ||
    parentType === 'source_file' ||
    parentType === 'translation_unit'
  ) return true;
  // JS/TS: exported declarations are wrapped in export_statement (which is itself top-level)
  if (parentType === 'export_statement' && node.parent?.parent?.type === 'program') return true;
  // C++: class/struct inside a namespace — parent is declaration_list whose parent is namespace_definition
  if (parentType === 'declaration_list' && node.parent?.parent?.type === 'namespace_definition') return true;
  // C#: types at the root of a file-scoped or block namespace
  if (parentType === 'compilation_unit') return true;
  if (parentType === 'declaration_list' && node.parent?.parent?.type === 'namespace_declaration') return true;
  // C# methods: inside declaration_list whose parent is a class or struct declaration
  if (parentType === 'declaration_list' && node.parent?.parent?.type === 'class_declaration') return true;
  if (parentType === 'declaration_list' && node.parent?.parent?.type === 'struct_declaration') return true;
  return false;
}

/**
 * Infer export scope based on language conventions and symbol name.
 */
function inferExportScope(language, name, node) {
  switch (language) {
    case 'python':
      return name.startsWith('_') ? 'local' : 'exported';

    case 'go':
      // Uppercase first letter → exported (Go convention)
      return name[0] === name[0].toUpperCase() && name[0] !== name[0].toLowerCase()
        ? 'exported'
        : 'local';

    case 'rust': {
      // Check the symbol node's own text for 'pub' visibility modifier
      // (parent is source_file or declaration_list which may span many items)
      const nodeText = node.text ?? '';
      return nodeText.trimStart().startsWith('pub ') ? 'exported' : 'local';
    }

    case 'java':
    case 'csharp':
    case 'kotlin': {
      const parentText = node.parent?.text ?? '';
      return parentText.includes('public') ? 'exported' : 'local';
    }

    case 'typescript':
    case 'tsx':
    case 'javascript': {
      // For TS/JS, check if the node or its parent is an export_statement
      // or if the parent text starts with 'export'
      const parent = node.parent;
      if (parent?.type === 'export_statement') return 'exported';
      if (parent?.parent?.type === 'export_statement') return 'exported';
      const grandParentText = parent?.parent?.text ?? '';
      if (grandParentText.trimStart().startsWith('export')) return 'exported';
      const parentText2 = parent?.text ?? '';
      if (parentText2.trimStart().startsWith('export')) return 'exported';
      return 'local';
    }

    // ruby, php, swift, cpp — all public by convention
    default:
      return 'exported';
  }
}

/**
 * Count parameters for a symbol node if it's a function/method.
 * Looks for formal_parameters (JS/TS/Python) or parameter_list (C#/Java).
 * Returns undefined if not applicable.
 */
function countArity(symbolNode, kind) {
  if (kind !== 'function' && kind !== 'method') return undefined;
  let funcNode = symbolNode;
  // If this is a lexical_declaration, find the arrow_function or function_expression child
  if (symbolNode.type === 'lexical_declaration') {
    const declarator = symbolNode.children.find(c => c.type === 'variable_declarator');
    funcNode = declarator?.children.find(c => c.type === 'arrow_function' || c.type === 'function_expression') ?? symbolNode;
  }
  // If this is a decorated_definition (Python), descend to the actual function_definition
  if (symbolNode.type === 'decorated_definition') {
    funcNode = symbolNode.children.find(c => c.type === 'function_definition' || c.type === 'class_definition') ?? symbolNode;
  }
  // Find formal_parameters or parameter_list
  const paramNode = funcNode.children.find(c =>
    c.type === 'formal_parameters' || c.type === 'parameter_list' || c.type === 'parameters'
  );
  if (!paramNode) return undefined;
  // Count named parameters (skip punctuation, 'self', 'cls')
  const skip = new Set(['(', ')', ',', 'self', 'cls']);
  let count = 0;
  for (const child of paramNode.children) {
    if (!child.isNamed) continue;
    if (skip.has(child.text)) continue;
    // In Python, skip *args / **kwargs prefixes — count the identifier inside
    if (child.type === 'list_splat_pattern' || child.type === 'dictionary_splat_pattern') {
      count++;
      continue;
    }
    count++;
  }
  return count;
}

/**
 * Count declared parameter slots for a JS/TS/TSX class member (unit 1.2-B0).
 *
 * Members count the ACTUAL declared parameter slots in `formal_parameters`:
 * every top-level named child is exactly one slot (optional, default, rest and
 * destructuring parameters each count one), `comment` nodes inside the list are
 * not parameters, and parameter names such as `self`/`cls` count normally —
 * unlike the legacy `countArity` rule below, which stays byte-identical so all
 * historical global/C#/PHP/other-language keys keep their exact bytes. A
 * TypeScript explicit `this: T` receiver parameter (real AST:
 * `required_parameter`/`optional_parameter` whose pattern child is the `this`
 * keyword) is a compile-time receiver, not a runtime formal slot, so it is
 * excluded. Only the JS/TS/TSX member path calls this counter; top-level
 * symbols and every other language keep `countArity` untouched.
 */
function countMemberArity(symbolNode) {
  // Bounded duplication of the parameter-node lookup: the legacy countArity
  // path is deliberately left byte-for-byte as-is (historical keys).
  const paramNode = symbolNode.children?.find(c => c.type === 'formal_parameters') ?? null;
  if (!paramNode) return 0;
  let count = 0;
  for (const child of paramNode.children) {
    if (!child.isNamed) continue;
    if (child.type === 'comment') continue; // parameter comments are not slots
    if (isExplicitThisReceiver(child)) continue; // compile-time receiver, not a slot
    count++;
  }
  return count;
}

/**
 * Detect a TypeScript/TSX explicit `this: T` receiver parameter from its real
 * AST shape: a `required_parameter`/`optional_parameter` whose first named
 * (pattern) child is the `this` keyword node.
 */
function isExplicitThisReceiver(paramChild) {
  if (paramChild.type !== 'required_parameter' && paramChild.type !== 'optional_parameter') {
    return false;
  }
  const pattern = paramChild.children?.find(c => c.isNamed);
  return pattern?.type === 'this';
}

/**
 * Unit 1.2-B1: count declared parameter slots for a Python class member.
 *
 * This is the syntactic declared signature of the method — never a runtime-call
 * guarantee, and decorator return types are never guessed:
 * - every top-level named parameter child counts exactly one slot (identifier,
 *   default, typed, typed-default and splat forms alike); `comment` nodes and
 *   the `*` / `/` separator markers are not slots;
 * - unless the method carries the known syntactic `@staticmethod` decorator
 *   (bare identifier only — dotted/call forms are not assumed), the FIRST
 *   declared positional slot is the bound receiver and is excluded BY POSITION,
 *   not by parameter name (so renamed receivers are excluded and real
 *   arguments literally named `self`/`cls` after the receiver still count);
 * - an undecorated, `@classmethod` or unknown-decorator method all follow
 *   Python's ordinary bound-method convention exactly as written — a
 *   syntactic ordinary convention only: no runtime-call guarantee is implied
 *   and decorator return types are never resolved;
 * - a first variadic is not an explicit positional receiver slot: it counts
 *   one slot and is never removed wholesale. This holds for the untyped
 *   `*args`/`**kwargs` splat forms AND for a `typed_parameter` whose FIRST
 *   NAMED CHILD is a `list_splat_pattern` (`*args: int`) or
 *   `dictionary_splat_pattern` (`**kw: int`) — the distinction is the actual
 *   AST child kind, never parameter text or an identifier guess. After the
 *   star the remaining keyword-only slots all count.
 *
 * Only the Python member path calls this counter; top-level Python functions
 * keep the legacy `countArity` rule byte-for-byte (including its historical
 * self/cls name skip), so historical global key bytes never change.
 */
function countPythonMemberArity(symbolNode) {
  let funcNode = symbolNode;
  if (funcNode.type === 'decorated_definition') {
    funcNode = funcNode.children.find(c => c.type === 'function_definition') ?? funcNode;
  }
  const paramNode = funcNode.children.find(c => c.type === 'parameters');
  if (!paramNode) return 0;

  const receiverAllowed = !hasStaticMethodDecorator(symbolNode);
  // Receiver shapes: bare identifiers plus default/typed-default forms. A
  // typed_parameter is judged by its inner (first named) child instead, so a
  // typed splat can never enter this set through the wrapper node type.
  const positionalTypes = new Set([
    'identifier', 'default_parameter', 'typed_default_parameter',
  ]);
  let count = 0;
  let receiverTaken = false;
  let afterStar = false;

  for (const child of paramNode.children) {
    if (!child.isNamed) continue;
    if (child.type === 'comment') continue; // parameter comments are not slots
    if (child.type === 'positional_separator') continue; // `/` marker, not a slot
    if (child.type === 'keyword_separator') { afterStar = true; continue; // `*` marker, not a slot
    }
    count++;
    if (child.type === 'list_splat_pattern') {
      afterStar = true; // `*args` occupies the star position (counts one)
      continue;
    }
    // Actual-AST child-kind distinction for typed parameters: `*args: int` /
    // `**kw: int` are typed_parameter → list/dictionary splat pattern, i.e.
    // variadic shapes (never positional receiver candidates), while
    // `name: T` is typed_parameter → identifier (a real positional slot).
    let shapeType = child.type;
    if (child.type === 'typed_parameter') {
      shapeType = child.children.find(c => c.isNamed)?.type ?? null;
      if (shapeType === 'list_splat_pattern') {
        afterStar = true; // typed `*args: int` counts one, elides no slot
        continue;
      }
      if (shapeType === 'dictionary_splat_pattern') continue; // typed `**kw: int` counts one
    }
    if (
      receiverAllowed && !receiverTaken && !afterStar &&
      positionalTypes.has(shapeType)
    ) {
      count--; // first explicit positional slot is the bound receiver
      receiverTaken = true;
    }
  }
  return count;
}

/**
 * Syntactic `@staticmethod` detection for Python members: a `decorator` child
 * of the `decorated_definition` whose expression is the bare identifier
 * `staticmethod`. Dotted (`a.b.staticmethod`), called (`staticmethod()`) and
 * every other/unknown decorator are NOT treated as static — they keep the
 * ordinary syntactic convention as written (receiver excluded by position; no
 * runtime guarantee, decorator return types are never resolved).
 */
function hasStaticMethodDecorator(symbolNode) {
  if (symbolNode.type !== 'decorated_definition') return false;
  return symbolNode.children
    .filter(c => c.type === 'decorator')
    .some(decorator => decorator.children.some(
      gc => gc.isNamed && gc.type === 'identifier' && gc.text === 'staticmethod',
    ));
}

/**
 * Unit 1.2-B1: count declared parameter slots for a Java class member.
 *
 * Every named child of `formal_parameters` counts one slot — `formal_parameter`
 * and varargs `spread_parameter` are one slot each — while comment nodes
 * (`line_comment`/`block_comment`) are ignored and an actual AST
 * `receiver_parameter` (the explicit `Type this` form) is excluded because it
 * is a receiver, not an argument. Java has no implicit receiver node, so
 * ordinary and static methods share this same syntactic rule. Only the Java
 * member path calls this counter; every other language keeps `countArity`.
 */
function countJavaMemberArity(symbolNode) {
  const paramNode = symbolNode.children?.find(c => c.type === 'formal_parameters');
  if (!paramNode) return 0;
  let count = 0;
  for (const child of paramNode.children) {
    if (!child.isNamed) continue;
    if (child.type === 'comment' || child.type.endsWith('_comment')) continue;
    if (child.type === 'receiver_parameter') continue; // explicit receiver, not an argument
    count++;
  }
  return count;
}

/**
 * Dispatch the member-specific declared-slot counter for unit 1.2-A/B1
 * containers. The legacy `countArity` below is deliberately left byte-for-
 * byte as-is (historical global/C#/PHP/other-language keys).
 */
// B2: Go grouped declarations contribute one slot per name; unnamed types
// and variadics contribute one. Select the parameters FIELD, not the earlier
// receiver list. Rust self_parameter and typed self patterns are receivers;
// argument patterns (including destructuring) each contribute one slot.
function countGoRustMemberArity(symbolNode, rawLanguage) {
  const params = symbolNode.childForFieldName('parameters');
  if (!params) return 0;
  let count = 0;
  for (const child of params.namedChildren) {
    if (rawLanguage === 'go') {
      if (child.type !== 'parameter_declaration' && child.type !== 'variadic_parameter_declaration') continue;
      count += Math.max(1, child.childrenForFieldName('name').length);
    } else {
      if (child.type === 'self_parameter') continue;
      if (child.type !== 'parameter' && child.type !== 'variadic_parameter') continue;
      if (child.childForFieldName('pattern')?.type === 'self') continue;
      count++;
    }
  }
  return count;
}

function countMemberArityForLanguage(symbolNode, rawLanguage) {
  if (rawLanguage === 'go' || rawLanguage === 'rust') return countGoRustMemberArity(symbolNode, rawLanguage);
  if (rawLanguage === 'python') return countPythonMemberArity(symbolNode);
  if (rawLanguage === 'java') return countJavaMemberArity(symbolNode);
  return countMemberArity(symbolNode); // JS/TS/TSX (unit 1.2-B0, unchanged)
}

function normalizeLanguageName(rawLanguage) {
  // tree-sitter language names vs PMC language names
  if (rawLanguage === 'typescript') return 'ts';
  if (rawLanguage === 'tsx') return 'tsx';
  if (rawLanguage === 'javascript') return 'js';
  return rawLanguage;
}

/**
 * Extract symbols from a single file using tree-sitter.
 *
 * @param {{ filePath: string, content: string }} opts
 * @returns {Promise<Array>} array of symbol objects
 */
export async function extractSymbolsForFile({ filePath, content }) {
  const ext = extname(filePath).toLowerCase();
  const rawLanguage = languageForExtension(ext);
  if (!rawLanguage) return [];

  // Check we have a query file for this language
  let queryText;
  try {
    queryText = await loadQuery(rawLanguage);
  } catch {
    // No query file for this language yet — skip silently
    return [];
  }

  const parser = await initParser();
  const lang = await loadLanguage(rawLanguage);
  parser.setLanguage(lang);

  const tree = parser.parse(content);

  let query;
  try {
    query = new Query(lang, queryText);
  } catch (e) {
    throw new Error(`Failed to compile tree-sitter query for ${rawLanguage}: ${e.message}`);
  }

  const captures = query.captures(tree.rootNode);
  const language = normalizeLanguageName(rawLanguage);
  const normalizedFilePath = filePath.replace(/\\/g, '/');
  const lines = content.split('\n');

  // Pre-pass (JS/TS/TSX/Python/Java): map every top-level named container
  // (class, and for Java also interface/enum captures) to its name so member
  // methods can resolve a structured container regardless of capture ordering.
  // Containers without a top-level symbol (nested, abstract, anonymous,
  // decorated Python classes) are deliberately absent, which makes their
  // methods fail closed. The map is keyed by the container AST span so a
  // method can only ever resolve its actual enclosing type, never a foreign
  // same-named one.
  const containerTypes = MEMBER_CONTAINER_TYPES[rawLanguage];
  const topLevelContainers = new Map();
  if (containerTypes) {
    for (const cap of captures) {
      if (cap.name !== 'class' && cap.name !== 'interface') continue;
      const containerNode = cap.node;
      if (!containerTypes.has(containerNode.type) || !isTopLevel(containerNode)) continue;
      const nameCap = captures.find(
        c =>
          c.name === 'name' &&
          c.node.startIndex >= containerNode.startIndex &&
          c.node.endIndex <= containerNode.endIndex
      );
      if (nameCap) topLevelContainers.set(containerNode.startIndex, nameCap.node.text);
    }
  }

  // Group captures: we get pairs of (kind-capture, name-capture) per symbol.
  // We want only top-level symbols. Walk captures in order; when we see a
  // kind capture (@class / @function / …) followed by a @name capture for the
  // same subtree, emit a symbol.
  const seen = new Set(); // deduplicate by startRow+name
  const symbolPromises = [];

  for (let i = 0; i < captures.length; i++) {
    const cap = captures[i];
    const captureName = cap.name;
    const kind = CAPTURE_TO_KIND[captureName];
    if (!kind) continue; // skip @name captures in this loop — handled below

    const symbolNode = cap.node;

    // Unit 1.2-A/B1 methods are class members, not top-level nodes: they
    // resolve a structured container instead of the isTopLevel filter. A method
    // whose container cannot be resolved fails closed (no invented identity).
    const isClassMember = kind === 'method' && (containerTypes != null || rawLanguage === 'go' || rawLanguage === 'rust');
    const container = isClassMember
      ? resolveMethodContainer(symbolNode, topLevelContainers, rawLanguage)
      : null;
    // Everything else must be a top-level symbol.
    if (isClassMember) {
      if (!container) continue;
    } else if (!isTopLevel(symbolNode)) {
      continue;
    }

    // Find the associated @name capture (next capture that is 'name' and whose
    // node is a descendant of symbolNode)
    let nameNode = null;
    for (let j = i + 1; j < captures.length; j++) {
      if (captures[j].name === 'name' && symbolNode.startIndex <= captures[j].node.startIndex && captures[j].node.endIndex <= symbolNode.endIndex) {
        nameNode = captures[j].node;
        break;
      }
    }
    if (!nameNode) continue;

    const name = nameNode.text;
    const startLine = symbolNode.startPosition.row + 1; // 1-indexed
    const endLine = symbolNode.endPosition.row + 1;     // 1-indexed

    // Container-qualified JS/TS/TSX members dedupe by their actual AST
    // declaration span: repeated captures of the same node collapse, while
    // distinct same-line declarations (accessor pairs, same-key duplicates)
    // survive as separate records so future collision handling can see them.
    // Historical non-member dedupe (functions/classes/C#/PHP) is untouched.
    const dedupeKey = container
      ? `${kind}:${container}:${symbolNode.startIndex}:${symbolNode.endIndex}`
      : `${kind}:${name}:${startLine}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    // Members of a structured container have the effective export scope
    // `member` (D2); everything else keeps the language inference.
    const exportScope = container
      ? 'member'
      : inferExportScope(rawLanguage, name, symbolNode);
    const codeFragment = lines.slice(startLine - 1, endLine).join('\n');
    // Unit 1.2-B0/B1: structured members use the language-specific
    // declared-slot counter; everything else keeps the legacy countArity.
    const arity = container
      ? countMemberArityForLanguage(symbolNode, rawLanguage)
      : countArity(symbolNode, kind);

    symbolPromises.push(
      hashSymbol(codeFragment).then(codeHash => {
        const symbol = {
          language,
          filePath: normalizedFilePath,
          kind,
          name,
          ...(container && { container }),
          exportScope,
          ...(arity !== undefined && { arity }),
          range: { startLine, endLine },
          codeHash,
        };
        symbol.symbolKey = buildSymbolKey(symbol);
        return symbol;
      })
    );
  }

  const symbols = await Promise.all(symbolPromises);
  symbols.sort((a, b) => a.range.startLine - b.range.startLine);
  return symbols;
}
