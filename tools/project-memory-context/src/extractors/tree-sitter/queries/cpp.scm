; Class specifiers
(class_specifier name: (type_identifier) @name) @class

; Struct specifiers (treated as class)
(struct_specifier name: (type_identifier) @name) @class

; Namespace definitions (treated as class)
(namespace_definition name: (namespace_identifier) @name) @class

; Free function definitions (plain identifier declarator)
(function_definition
  declarator: (function_declarator
    declarator: (identifier) @name)) @function

; Qualified function definitions (e.g. Foo::bar)
(function_definition
  declarator: (function_declarator
    declarator: (qualified_identifier
      name: (identifier) @name))) @method
