; Struct definitions
(struct_item name: (type_identifier) @name) @class

; Enum definitions
(enum_item name: (type_identifier) @name) @class

; Trait definitions (analogous to interfaces)
(trait_item name: (type_identifier) @name) @interface

; Function definitions (includes pub fn and fn)
(function_item name: (identifier) @name) @function

; Concrete impl methods (container is resolved from the impl's self type)
(impl_item
  body: (declaration_list
    (function_item name: (identifier) @name) @method))

; Impl blocks (for completeness, treated as class)
(impl_item type: (type_identifier) @name) @class
