import { posix } from 'node:path';
import { extractNativeImports } from './native-imports.mjs';
import { extractSymbolsForFile } from '../extractors/tree-sitter/extract.mjs';
import { initParser, loadLanguage } from '../extractors/tree-sitter/runtime.mjs';
import { languageForExtension } from '../extractors/tree-sitter/language-map.mjs';

const SUPPORTED = new Set(['javascript', 'typescript', 'tsx']);
const FUNCTIONS = new Set(['function_declaration', 'function_expression', 'arrow_function', 'method_definition', 'generator_function_declaration', 'generator_function']);
const nodeId = node => `${node.type}:${node.startIndex}:${node.endIndex}`;
const failure = reason => ({ reason });
const symbolEndpoint = symbol => ({ id: symbol.symbolKey, symbolKey: symbol.symbolKey, kind: symbol.kind, path: symbol.filePath });
function add(map, name, value) {
  if (!map.has(name)) map.set(name, []);
  map.get(name).push(value);
}
function* walk(root, skipFunctions = false) {
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    yield node;
    if (skipFunctions && node !== root && FUNCTIONS.has(node.type)) continue;
    for (let i = node.namedChildren.length - 1; i >= 0; i--) stack.push(node.namedChildren[i]);
  }
}
function bindingNames(pattern) {
  if (!pattern) return [];
  return [...walk(pattern)].filter(n => n.type === 'identifier' || n.type === 'shorthand_property_identifier_pattern').map(n => n.text);
}
function simpleType(node) {
  const type = node?.childForFieldName('type');
  const named = type?.namedChildren.filter(n => n.type !== 'comment');
  return type?.type === 'type_annotation' && named?.length === 1 && named[0].type === 'type_identifier' ? named[0].text : null;
}
function staticFlag(node) { return node.children.some(n => n.type === 'static'); }
function ancestor(parent, child) {
  for (let node = child; node; node = node.parent) if (node.id === parent?.id) return true;
  return false;
}

function describeModule(module) {
  module.globals = new Map(); module.exports = new Map(); module.owners = new Map(); module.declarations = [];
  module.mutated = new Set(); module.dynamicScope = false;
  for (const node of walk(module.tree.rootNode)) {
    if (node.type === 'with_statement' || (node.type === 'call_expression' && node.childForFieldName('function')?.type === 'identifier' && node.childForFieldName('function').text === 'eval')) module.dynamicScope = true;
    if (node.type === 'variable_declarator' && node.parent?.type === 'variable_declaration') {
      let boundary = node.parent;
      while (boundary && !FUNCTIONS.has(boundary.type) && boundary.type !== 'class_static_block') boundary = boundary.parent;
      if (!boundary) for (const name of bindingNames(node.childForFieldName('name'))) module.mutated.add(name);
    }
    if (['assignment_expression', 'augmented_assignment_expression', 'update_expression', 'for_in_statement'].includes(node.type)) {
      const left = node.childForFieldName('left') ?? node.childForFieldName('argument');
      for (const name of bindingNames(left)) module.mutated.add(name);
    }
  }
  function declaration(node, anchor, kind, name, cls = null) {
    const candidates = module.symbols.filter(s => s.kind === kind && s.name === name &&
      (s.container ?? null) === (cls?.name ?? null) && s.range.startLine === anchor.startPosition.row + 1 && s.range.endLine === anchor.endPosition.row + 1);
    const entry = { node, anchor, module, kind, name, cls, symbol: !node.hasError && candidates.length === 1 ? candidates[0] : null };
    module.declarations.push(entry);
    if (FUNCTIONS.has(node.type)) module.owners.set(nodeId(node), entry);
    return entry;
  }
  for (const root of module.tree.rootNode.namedChildren) {
    const node = root.type === 'export_statement' ? root.childForFieldName('declaration') : root;
    if (!node) continue;
    if (node.type === 'function_declaration') {
      const name = node.childForFieldName('name')?.text;
      if (name) add(module.globals, name, declaration(node, node, 'function', name));
    } else if (node.type === 'class_declaration') {
      const name = node.childForFieldName('name')?.text;
      if (!name) continue;
      const cls = declaration(node, node, 'class', name);
      cls.methods = new Map(); cls.fields = new Map(); cls.dynamicFields = new Set();
      cls.typeParameters = new Set((node.childForFieldName('type_parameters')?.namedChildren ?? []).map(n => n.childForFieldName('name')?.text).filter(Boolean));
      const heritage = node.namedChildren.find(n => n.type === 'class_heritage');
      cls.inherits = heritage ? [...walk(heritage)].some(n => n.type === 'extends_clause' || n.children.some(c => c.type === 'extends')) : false;
      add(module.globals, name, cls);
      for (const member of node.childForFieldName('body')?.namedChildren ?? []) {
        const memberName = member.childForFieldName('name') ?? member.childForFieldName('property');
        if (member.type === 'method_definition' && ['property_identifier', 'private_property_identifier'].includes(memberName?.type)) {
          const method = declaration(member, member, 'method', memberName.text, cls);
          method.static = staticFlag(member);
          method.accessor = member.children.some(n => n.type === 'get' || n.type === 'set');
          add(cls.methods, method.name, method);
          if (method.name === 'constructor') {
            for (const param of member.childForFieldName('parameters')?.namedChildren ?? []) {
              if (!param.children.some(n => n.type === 'accessibility_modifier' || n.type === 'readonly')) continue;
              const pattern = param.childForFieldName('pattern');
              if (pattern?.type === 'identifier') add(cls.fields, pattern.text, { type: simpleType(param), static: false });
            }
          }
        } else if (['method_signature', 'abstract_method_signature'].includes(member.type) && memberName) {
          add(cls.methods, memberName.text, { symbol: null, static: staticFlag(member), accessor: false });
        } else if (['public_field_definition', 'field_definition'].includes(member.type) && memberName) {
          if (memberName.type === 'computed_property_name') cls.dynamicFields.add(staticFlag(member));
          else add(cls.fields, memberName.text, { type: simpleType(member), static: staticFlag(member), optional: member.children.some(n => n.type === '?') });
        }
      }
    } else if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
      for (const variable of node.namedChildren.filter(n => n.type === 'variable_declarator')) {
        const pattern = variable.childForFieldName('name'); const value = variable.childForFieldName('value');
        for (const name of bindingNames(pattern)) {
          const entry = pattern?.type === 'identifier' && ['arrow_function', 'function_expression'].includes(value?.type)
            ? declaration(value, node, 'function', name) : { kind: 'unsupported', name, module };
          add(module.globals, name, entry);
        }
      }
    } else {
      const name = node.childForFieldName('name')?.text;
      if (name) add(module.globals, name, { kind: 'unsupported', name, module });
    }
  }
  // Explicit local exports only. Reexports/type-only exports do not prove a
  // value binding in this module, and duplicate names never choose a winner.
  for (const node of module.tree.rootNode.namedChildren.filter(n => n.type === 'export_statement')) {
    const declarationNode = node.childForFieldName('declaration');
    const typeOnly = node.children.some(n => n.type === 'type');
    if (declarationNode) {
      const entries = [...module.globals.values()].flat().filter(e => e.anchor?.id === declarationNode.id);
      const isDefault = node.children.some(n => n.type === 'default');
      for (const entry of entries) add(module.exports, isDefault ? 'default' : entry.name, { name: entry.name, typeOnly });
    } else {
      const value = node.childForFieldName('value');
      if (value?.type === 'identifier') add(module.exports, 'default', { name: value.text, typeOnly });
      const clause = node.namedChildren.find(n => n.type === 'export_clause');
      for (const spec of clause?.namedChildren ?? []) {
        if (spec.type !== 'export_specifier') continue;
        const name = spec.childForFieldName('name'); const alias = spec.childForFieldName('alias');
        if (name) add(module.exports, alias?.text ?? name.text, {
          name: name.text, typeOnly: typeOnly || spec.children.some(n => n.type === 'type'),
          reason: node.childForFieldName('source') ? 'unsupported-reexport' : null,
        });
      }
    }
  }
}

function sourceOwner(module, call) {
  for (let parent = call.parent; parent; parent = parent.parent) {
    if (FUNCTIONS.has(parent.type)) return module.owners.get(nodeId(parent)) ?? null;
  }
  return null;
}
function sourceScope(owner) {
  const locals = new Map();
  if (owner.node.type === 'function_expression') {
    const selfName = owner.node.childForFieldName('name')?.text;
    if (selfName) add(locals, selfName, { kind: 'expression-self' });
  }
  const params = owner.node.childForFieldName('parameters');
  for (const param of params?.namedChildren ?? []) {
    const pattern = param.childForFieldName('pattern') ?? param;
    for (const name of bindingNames(pattern)) add(locals, name, { kind: 'parameter' });
  }
  // Broad shadow guard: even sibling-block declarations with this name reject
  // a lookup. This intentionally trades completeness for no invented binding.
  for (const node of walk(owner.node, true)) {
    if (node !== owner.node && FUNCTIONS.has(node.type)) {
      const name = node.childForFieldName('name')?.text;
      if (name) add(locals, name, { kind: 'nested' });
    }
    if (node.type === 'variable_declarator') {
      for (const name of bindingNames(node.childForFieldName('name'))) add(locals, name, {
        kind: 'variable', node, value: node.childForFieldName('value'),
        constant: node.parent?.children.some(n => n.type === 'const') ?? false,
      });
    }
    if (node.type === 'catch_clause') {
      for (const name of bindingNames(node.childForFieldName('parameter'))) add(locals, name, { kind: 'parameter' });
    }
    if (node.type === 'class_declaration') {
      const name = node.childForFieldName('name')?.text;
      if (name) add(locals, name, { kind: 'nested' });
    }
  }
  return locals;
}

function exported(module, name, modules, registry, seen) {
  if (!module || module.tree.rootNode.hasError) return failure('invalid-syntax');
  const entries = module.exports.get(name) ?? [];
  if (entries.length !== 1) return failure(entries.length ? 'ambiguous-export' : 'missing-export');
  const entry = entries[0];
  if (entry.typeOnly) return failure('type-only-binding');
  if (entry.reason) return failure(entry.reason);
  return moduleBinding(module, entry.name, modules, registry, seen);
}
function moduleBinding(module, name, modules, registry, seen = new Set()) {
  if (module.dynamicScope) return failure('unsupported-dynamic-scope');
  const visit = `${module.path}|${name}`;
  if (seen.has(visit)) return failure('cyclic-binding');
  const next = new Set(seen).add(visit);
  if (module.mutated.has(name)) return failure('reassigned-binding');
  const entries = module.globals.get(name) ?? [];
  if (entries.length !== 1) return failure(entries.length ? 'ambiguous-binding' : 'unknown-binding');
  const entry = entries[0];
  if (entry.kind === 'import') {
    if (entry.binding.typeOnly) return failure('type-only-binding');
    if (entry.fact.reason) return failure(entry.fact.reason);
    const targetModule = modules.get(entry.fact.target?.path);
    if (entry.binding.imported === '*') return targetModule ? { namespace: targetModule } : failure('unsupported-language');
    return exported(targetModule, entry.binding.imported, modules, registry, next);
  }
  if (!entry.symbol || !registry.has(entry.symbol.symbolKey)) return failure('canonical-collision');
  return { declaration: entry };
}
function reference(module, node, scope, modules, registry) {
  if (node?.type === 'identifier' || node?.type === 'type_identifier') {
    if (scope?.has(node.text)) return failure('shadowed-binding');
    return moduleBinding(module, node.text, modules, registry);
  }
  if (node?.type === 'member_expression') {
    const object = node.childForFieldName('object'); const property = node.childForFieldName('property');
    if (object?.type === 'identifier' && property?.type === 'property_identifier') {
      const namespace = reference(module, object, scope, modules, registry);
      if (namespace.namespace) return exported(namespace.namespace, property.text, modules, registry, new Set());
    }
  }
  return failure('unsupported-reference');
}
function concreteClass(resolution) {
  const cls = resolution.declaration;
  if (resolution.reason) return resolution;
  if (cls?.kind !== 'class') return failure('unknown-receiver');
  if (cls.inherits) return failure('unsupported-inheritance');
  return { cls };
}
function method(cls, name, isStatic, registry) {
  if (!cls.symbol || !registry.has(cls.symbol.symbolKey) || cls.module.globals.get(cls.name)?.length !== 1) return failure('canonical-collision');
  if (cls.inherits) return failure('unsupported-inheritance');
  if (cls.dynamicFields.has(isStatic) || (cls.fields.get(name) ?? []).some(field => field.static === isStatic)) return failure('field-shadows-method');
  const methods = cls.methods.get(name) ?? [];
  if (methods.length !== 1) return failure(methods.length ? 'ambiguous-method' : 'missing-method');
  const entry = methods[0];
  if (entry.static !== isStatic || entry.accessor || !entry.symbol || !registry.has(entry.symbol.symbolKey)) return failure('unsupported-method');
  return { declaration: entry };
}
function receiver(module, object, owner, scope, call, modules, registry) {
  if (object?.type === 'this' && owner.cls) return { cls: owner.cls, static: owner.static };
  if (object?.type === 'member_expression' && owner.cls) {
    const base = object.childForFieldName('object'); const property = object.childForFieldName('property');
    if (base?.type === 'this' && property?.type === 'property_identifier') {
      const fields = owner.cls.fields.get(property.text) ?? [];
      if (fields.length !== 1 || !fields[0].type || fields[0].optional || fields[0].static !== owner.static) return failure('unknown-receiver');
      if (owner.cls.typeParameters.has(fields[0].type)) return failure('unsupported-generic-type');
      const resolved = concreteClass(moduleBinding(owner.cls.module, fields[0].type, modules, registry));
      return resolved.cls ? { ...resolved, static: false } : resolved;
    }
  }
  if (object?.type === 'identifier' && scope.has(object.text)) {
    const bindings = scope.get(object.text);
    if (bindings.length !== 1 || module.mutated.has(object.text)) return failure('ambiguous-receiver');
    const binding = bindings[0];
    if (!binding.constant || binding.value?.type !== 'new_expression' || binding.node.startIndex >= call.startIndex || !ancestor(binding.node.parent?.parent, call)) return failure('unknown-receiver');
    const resolved = concreteClass(reference(module, binding.value.childForFieldName('constructor'), scope, modules, registry));
    return resolved.cls ? { ...resolved, static: false } : resolved;
  }
  const resolved = concreteClass(reference(module, object, scope, modules, registry));
  return resolved.cls ? { ...resolved, static: true } : resolved;
}
function resolveCall(module, call, owner, scope, modules, registry) {
  const callee = call.childForFieldName(call.type === 'new_expression' ? 'constructor' : 'function');
  if (call.hasError || call.children.some(n => n.type === '?.') || (callee && [...walk(callee)].some(n => n.type === 'optional_chain'))) return failure('unsupported-call');
  if (call.type === 'new_expression') {
    const cls = concreteClass(reference(module, callee, scope, modules, registry));
    return cls.cls ? method(cls.cls, 'constructor', false, registry) : cls;
  }
  if (callee?.type === 'identifier') {
    const result = reference(module, callee, scope, modules, registry);
    return result.declaration?.kind === 'function' ? result : failure(result.reason ?? 'not-callable-declaration');
  }
  if (callee?.type === 'member_expression') {
    const object = callee.childForFieldName('object'); const property = callee.childForFieldName('property');
    if (property?.type !== 'property_identifier' && property?.type !== 'private_property_identifier') return failure('dynamic-call');
    if (object?.type === 'identifier' && !scope.has(object.text)) {
      const namespace = reference(module, object, scope, modules, registry);
      if (namespace.namespace) {
        const result = exported(namespace.namespace, property.text, modules, registry, new Set());
        return result.declaration?.kind === 'function' ? result : failure(result.reason ?? 'not-callable-declaration');
      }
    }
    const resolved = receiver(module, object, owner, scope, call, modules, registry);
    return resolved.cls ? method(resolved.cls, property.text, resolved.static, registry) : resolved;
  }
  return failure('dynamic-call');
}

/** Conservative static declaration calls. Canonical keys come ONLY from the
 * existing extractor. No external symbol registry, runtime dispatch, filesystem
 * lookup, index migration or graph IO. Uncertain calls have no target endpoint.
 */
export async function extractNativeCalls({ files } = {}) {
  const imports = await extractNativeImports({ files });
  const contents = new Map();
  for (const file of files) contents.set(posix.normalize(file.path.replace(/\\/g, '/')), file.content);
  const modules = new Map(); const registry = new Map(); const result = { files: imports.files, symbols: [], relations: [], unresolved: [] };
  try {
    for (const source of imports.files) {
      const language = languageForExtension(posix.extname(source.path));
      if (!SUPPORTED.has(language)) {
        result.unresolved.push({ relation: 'calls', source, callee: null, range: null, reason: 'unsupported-language' });
        continue;
      }
      const symbols = await extractSymbolsForFile({ filePath: source.path, content: contents.get(source.path) });
      const parser = await initParser(); parser.setLanguage(await loadLanguage(language));
      const tree = parser.parse(contents.get(source.path));
      const module = { path: source.path, source, symbols, tree };
      modules.set(source.path, module); describeModule(module);
    }
    // Both raw canonical collisions and AST declarations hidden by historical
    // same-line dedupe withhold IDs. No Map overwrite can fabricate uniqueness.
    const raw = new Map(); const ast = new Map();
    for (const module of modules.values()) {
      for (const symbol of module.symbols) add(raw, symbol.symbolKey, symbol);
      for (const entry of module.declarations) if (entry.symbol) add(ast, entry.symbol.symbolKey, entry);
    }
    for (const [key, symbols] of raw) if (symbols.length === 1 && (ast.get(key)?.length ?? 0) <= 1) registry.set(key, symbolEndpoint(symbols[0]));
    for (const fact of [...imports.relations, ...imports.unresolved]) {
      const module = modules.get(fact.source?.path);
      if (!module) continue;
      for (const binding of fact.bindings) add(module.globals, binding.local, { kind: 'import', binding, fact });
    }
    for (const item of imports.unresolved.filter(e => e.reason === 'file-collision' && !e.source)) result.unresolved.push({ relation: 'calls', source: null, path: item.path, callee: null, range: null, reason: 'file-collision' });
    for (const module of modules.values()) {
      const scopes = new Map();
      for (const call of walk(module.tree.rootNode)) {
        if (call.type !== 'call_expression' && call.type !== 'new_expression') continue;
        const callee = call.childForFieldName(call.type === 'new_expression' ? 'constructor' : 'function');
        const owner = sourceOwner(module, call);
        const source = owner?.symbol && registry.get(owner.symbol.symbolKey);
        const fact = { relation: 'calls', source: source ?? module.source, callee: callee?.text ?? null, range: { startLine: call.startPosition.row + 1, endLine: call.endPosition.row + 1 } };
        if (!source || module.tree.rootNode.hasError || module.dynamicScope) {
          result.unresolved.push({ ...fact, reason: module.tree.rootNode.hasError ? 'invalid-syntax' : module.dynamicScope ? 'unsupported-dynamic-scope' : 'unsupported-source' });
          continue;
        }
        if (!scopes.has(owner)) scopes.set(owner, sourceScope(owner));
        const target = resolveCall(module, call, owner, scopes.get(owner), modules, registry);
        if (target.declaration) result.relations.push({ ...fact, target: registry.get(target.declaration.symbol.symbolKey) });
        else result.unresolved.push({ ...fact, reason: target.reason });
      }
    }
    result.symbols = [...registry.values()].sort((a, b) => a.symbolKey < b.symbolKey ? -1 : a.symbolKey > b.symbolKey ? 1 : 0);
    return result;
  } finally {
    for (const module of modules.values()) module.tree.delete();
  }
}
