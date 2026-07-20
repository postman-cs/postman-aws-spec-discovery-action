# Local path escape adversarial fixture

The closure validator creates a temporary workspace with a symlink that points outside the service root.
Expected: resolution refuses the escaping path and records sanitized evidence.
