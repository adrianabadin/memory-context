; Class definitions
(class_definition
  name: (identifier) @name) @class

; Top-level function definitions (including async)
(function_definition
  name: (identifier) @name) @function

; Decorated functions
(decorated_definition
  (function_definition
    name: (identifier) @name)) @function

; Methods: ordinary functions defined directly in a class body (unit 1.2-B1).
; The container is resolved from the real AST (block -> class_definition) and
; only kept when that class produced a top-level class symbol.
(class_definition
  body: (block
    (function_definition
      name: (identifier) @name) @method))

; Methods: decorated functions whose wrapper is the direct class-body child.
(class_definition
  body: (block
    (decorated_definition
      (function_definition
        name: (identifier) @name)) @method))
