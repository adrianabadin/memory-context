(class_declaration name: (identifier) @name) @class
(function_declaration name: (identifier) @name) @function
(lexical_declaration
  (variable_declarator
    name: (identifier) @name
    value: [(arrow_function)(function_expression)])) @function
