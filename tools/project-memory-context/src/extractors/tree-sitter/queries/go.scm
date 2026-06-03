; Top-level function declarations
(function_declaration name: (identifier) @name) @function

; Method declarations (receiver functions)
(method_declaration name: (field_identifier) @name) @function

; Struct type declarations (map to class)
(type_declaration
  (type_spec
    name: (type_identifier) @name
    type: (struct_type))) @class

; Interface type declarations
(type_declaration
  (type_spec
    name: (type_identifier) @name
    type: (interface_type))) @interface
