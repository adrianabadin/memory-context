(interface_declaration name: (type_identifier) @name) @interface
(class_declaration name: (type_identifier) @name) @class
(function_declaration name: (identifier) @name) @function
(lexical_declaration
  (variable_declarator
    name: (identifier) @name
    value: [(arrow_function)(function_expression)])) @function
(type_alias_declaration name: (type_identifier) @name) @type
(enum_declaration name: (identifier) @name) @class
