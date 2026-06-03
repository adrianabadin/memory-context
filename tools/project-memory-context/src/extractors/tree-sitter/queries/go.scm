; Top-level function declarations
(function_declaration name: (identifier) @name) @function

; Method declarations (receiver functions)
(method_declaration name: (field_identifier) @name) @method

; Type specifications (structs, interfaces, type aliases)
(type_spec name: (type_identifier) @name) @type
