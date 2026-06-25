# Plugin Installation Spec

## Purpose

Ship capture hooks through the installed PMC OpenCode plugin template.

## Requirements

### Requirement: R1 MUST install the capture-enabled plugin template
`template-installer.mjs` `installOpencode` MUST write the updated `pmc.mjs` template so the exported plugin includes `{ hooks }` together with existing session-start behavior.

#### Scenario: Fresh install
- GIVEN PMC is installed into a project
- WHEN `installOpencode` writes `pmc.mjs`
- THEN the file includes capture hook exports and existing startup logic

#### Scenario: Package update rewrites template
- GIVEN an existing PMC installation
- WHEN the package updates the plugin file in place
- THEN capture becomes available without manual reinstall

#### Scenario: Existing startup behavior
- GIVEN session-start automation already works
- WHEN the new template is installed
- THEN startup behavior remains enabled alongside capture

## Out of Scope
- Migrating old queue files
- Changing gitignore defaults for capture files
- Installing capture into non-OpenCode runtimes
