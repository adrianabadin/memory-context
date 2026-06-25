# Community Naming — Delta

## MODIFIED Requirements

### Requirement: Context and Explorer Availability

Community names stored in `graph.db` MUST be returned by `pmc get-context`. The Graph Explorer MUST fetch names from `/api/communities` during initialization, cache the mapping in state, and display the name in the filters sidebar, node tooltip, and node detail sidebar. If the endpoint returns `{}`, a community ID has no mapped name, or the fetch fails, the UI MUST fall back to `Community {ID}`.

(Previously: Required names to be displayed in the explorer without specifying the API contract or fallback behavior.)

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
