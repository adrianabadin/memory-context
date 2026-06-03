; Class declarations
(class_declaration name: (identifier) @name) @class

; Interface declarations
(interface_declaration name: (identifier) @name) @interface

; Enum declarations (treated as class)
(enum_declaration name: (identifier) @name) @class

; Method declarations
(method_declaration name: (identifier) @name) @method

; Constructor declarations
(constructor_declaration name: (identifier) @name) @method
