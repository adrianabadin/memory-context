# Community Names API Specification

## Purpose

Expose community names stored in `graph.db` to the Graph Explorer through a read-only HTTP endpoint.

## Requirements

### Requirement: Communities Endpoint

The server MUST provide `GET /api/communities` and return a JSON object mapping each community ID to its stored name.

#### Scenario: Names exist in graph.db

- GIVEN the `community_names` table contains rows
- WHEN the client sends `GET /api/communities`
- THEN it MUST receive `{ "0": "Core API", "1": "CLI Tools", ... }`
- AND the response time MUST be under 100ms

#### Scenario: Empty or missing table

- GIVEN the `community_names` table is empty or absent
- WHEN the client sends `GET /api/communities`
- THEN it MUST receive `{}`

### Requirement: Database Error Resilience

If `graph.db` is missing, locked, or unreadable, the endpoint MUST return `{}` and MUST NOT crash the server.

#### Scenario: graph.db not found

- GIVEN `graph.db` does not exist
- WHEN the client sends `GET /api/communities`
- THEN it MUST receive `{}`
- AND the server MUST continue serving other requests
