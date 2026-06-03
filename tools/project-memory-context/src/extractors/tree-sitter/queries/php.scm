; Class declarations
(class_declaration name: (name) @name) @class

; Interface declarations
(interface_declaration name: (name) @name) @interface

; Trait declarations (treated as class)
(trait_declaration name: (name) @name) @class

; Top-level function definitions
(function_definition name: (name) @name) @function

; Method declarations (inside classes/interfaces/traits)
(method_declaration name: (name) @name) @method
