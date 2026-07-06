# Community Naming Specification

## Purpose

Assign descriptive, function-oriented names to graph communities after symbol enrichment by calling bigmodel.cn's GLM-4.7-Flash model, then expose those names through PMC context queries and the graph explorer.

## Requirements

### Requirement: Automatic Post-Enrichment Trigger

The system MUST trigger community naming automatically after symbol enrichment completes successfully.

#### Scenario: Enrichment finishes with communities

- GIVEN enrichment has produced communities in graph.db
- WHEN the enrichment run reaches a successful finished state
- THEN the naming pipeline MUST run without manual invocation

#### Scenario: Enrichment produces no communities

- GIVEN enrichment completes but graph.db contains no community assignments
- WHEN the post-enrich hook executes
- THEN the naming pipeline MUST complete without error and make no API calls

### Requirement: LLM Provider and Model

The system MUST use bigmodel.cn GLM-4.7-Flash, accessed at `https://open.bigmodel.cn/api/paas/v4/chat/completions`, to generate community names.

#### Scenario: Naming pipeline runs

- GIVEN communities exist and member summaries are gathered
- WHEN the pipeline requests a name
- THEN it MUST call GLM-4.7-Flash, not a local Ollama model

### Requirement: API Key Configuration

The system MUST read the GLM API key from the `BIGMODEL_API_KEY` environment variable or an equivalent configuration entry. The key MUST NOT be hardcoded.

#### Scenario: Key is configured

- GIVEN `BIGMODEL_API_KEY` is set or a config key is provided
- WHEN naming runs
- THEN the API MUST be called with a Bearer token

#### Scenario: Key is missing

- GIVEN no API key is configured
- WHEN naming runs
- THEN the pipeline MUST fall back to generic community IDs and log a warning

### Requirement: Community Name Generation

For each non-empty community, the system MUST gather its member symbols and their enriched summaries, send them to the LLM with a prompt that requests a short functional name, and store the returned name.

#### Scenario: Typical community

- GIVEN a community with 3–50 member symbols that have enriched summaries
- WHEN the pipeline processes it
- THEN a descriptive name reflecting the functional role MUST be stored in graph.db

### Requirement: Large Community Truncation

For communities with more than 50 member symbols, the system SHOULD truncate the symbol list intelligently before sending it to the LLM.

#### Scenario: Community exceeds symbol limit

- GIVEN a community with 75 member symbols
- WHEN the pipeline prepares the prompt
- THEN it MUST include no more than 50 symbols selected by relevance or centrality

### Requirement: Empty Community Handling

The system MUST skip communities that contain no member symbols.

#### Scenario: Community has no symbols

- GIVEN a community identifier exists with zero member symbols
- WHEN naming runs
- THEN it MUST retain the generic ID and make no API call for that community

### Requirement: Graceful API Failure Fallback

If the GLM API call fails, times out, or returns an unusable response, the system MUST keep the generic community ID for that community and continue processing the remaining communities.

#### Scenario: API timeout

- GIVEN a community is being named
- WHEN the API request exceeds the configured timeout
- THEN the pipeline MUST log the failure and keep the generic ID

### Requirement: Re-naming Existing Communities

The system SHOULD support a configurable policy for re-naming communities that already have stored names.

#### Scenario: Re-naming is enabled

- GIVEN a community already has a stored name and re-naming is enabled
- WHEN naming runs
- THEN it MUST generate a new name and overwrite the stored one

#### Scenario: Re-naming is disabled

- GIVEN a community already has a stored name and re-naming is disabled
- WHEN naming runs
- THEN it MUST preserve the existing name and skip that community

### Requirement: Rate Limiting

The system SHOULD enforce rate limiting between API calls to avoid provider abuse.

#### Scenario: Naming many communities

- GIVEN 100 communities require names
- WHEN the pipeline executes
- THEN API requests MUST be throttled to stay within provider limits

### Requirement: Naming Decision Logging

The system SHOULD log each naming decision, including the community ID, generated name, and fallback reason when applicable.

#### Scenario: Name is generated

- GIVEN a community receives the name "Graph Storage"
- WHEN the result is persisted
- THEN the decision MUST be logged

### Requirement: Context and Explorer Availability

Community names stored in `graph.db` MUST be returned by `pmc get-context`. The Graph Explorer MUST fetch names from `/api/communities` during initialization, cache the mapping in state, and display the name in the filters sidebar, node tooltip, and node detail sidebar. If the endpoint returns `{}`, a community ID has no mapped name, or the fetch fails, the UI MUST fall back to `Community {ID}`.

#### Scenario: Query context for a symbol

- GIVEN a symbol belongs to a named community
- WHEN `pmc get-context` is invoked for that symbol
- THEN the output MUST include the community name

#### Scenario: Explorer initializes with names

- GIVEN `graph.db` contains community names
- WHEN the Graph Explorer loads
- THEN it MUST call `/api/communities`
- AND store the result in `state.communityNames`

#### Scenario: Filters sidebar shows names

- GIVEN the explorer has fetched community names
- WHEN the filters sidebar renders the community list
- THEN it MUST show the mapped name instead of `Community {ID}`

#### Scenario: Node tooltip shows names

- GIVEN the explorer has fetched community names
- WHEN a user hovers over a graph node
- THEN the tooltip MUST show the community name

#### Scenario: Node detail sidebar shows names

- GIVEN the explorer has fetched community names
- WHEN a node is selected
- THEN the community badge in the detail sidebar MUST show the name

#### Scenario: Graceful fallback to IDs

- GIVEN `/api/communities` returns `{}` or the request fails
- WHEN the UI renders any community reference
- THEN it MUST display `Community {ID}`
