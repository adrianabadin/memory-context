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
