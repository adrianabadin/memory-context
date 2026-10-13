(class_declaration name: (identifier) @name) @class
(function_declaration name: (identifier) @name) @function
(lexical_declaration
  (variable_declarator
    name: (identifier) @name
    value: [(arrow_function)(function_expression)])) @function
(class_body
  (method_definition
    name: [(property_identifier) (private_property_identifier)] @name) @method)
