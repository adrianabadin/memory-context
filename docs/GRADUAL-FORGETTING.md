# Gradual Forgetting

PMC controls memory growth through staged decay, gist preservation, revival checks, and selective promotion. This prevents unbounded memory accumulation while preserving high-value knowledge.

## Overview

```
active → cooling → dimmed → shadow → gist_only → purged
  ↑                                                  │
  └──────────── reactivation (usage) ────────────────┘
```

Memories decay through stages based on usage. Before pruning, the system preserves a compressed gist. A revive gate judges whether the original should be retained or pruned. Repeated useful patterns are promoted globally.

## Decay Stages

| Stage | Default Trigger | Behavior | Recall Weight |
|-------|----------------|----------|---------------|
| `active` | Default state | Full recall weight, normal search ranking | 1.0 |
| `cooling` | 30 days unused | Reduced recall probability | ~0.7 |
| `dimmed` | 90 days unused | Further reduced ranking | ~0.4 |
| `shadow` | 180 days unused | Minimal recall weight | ~0.1 |
| `gist_only` | 365 days unused | Original text pruned; gist preserved | 0 (gist searchable) |
| `purged` | After gist-only + retention | Original removed; gist remains | 0 |

### State Transitions

Transitions are computed by `transitionDecayStateForMemory()` which reads the current state, `activation_score`, `last_reinforced_at`, and `created_at` to determine the next state.

**Forward transitions** (decay):
- Triggered by time since last reinforcement
- Thresholds configurable via global config

**Backward transitions** (reactivation):
- Any usage (search hit, explicit reference, reinforcement) moves the memory back toward `active`
- `activation_score` is boosted on reinforcement

### Configuration

```json
{
  "forgetting": {
    "coolingAfterDays": 30,
    "dimmedAfterDays": 90,
    "shadowAfterDays": 180,
    "gistCandidateAfterDays": 365,
    "gistOnlyRetentionDays": 90
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `coolingAfterDays` | 30 | Days unused before `active → cooling` |
| `dimmedAfterDays` | 90 | Days unused before `cooling → dimmed` |
| `shadowAfterDays` | 180 | Days unused before `dimmed → shadow` |
| `gistCandidateAfterDays` | 365 | Days unused before `shadow → gist_only` |
| `gistOnlyRetentionDays` | 90 | Days to retain original after gist creation before prune eligibility |

## Activation Score

Each memory has an `activation_score` (REAL, default 1.0) that modulates its recall weight:

```
effective_score = base_score × activation_score × decay_factor
```

- **Reinforcement**: Usage boosts `activation_score` toward 1.0
- **Decay**: Time without usage reduces the score
- **Search integration**: `activation_score` is multiplied into the final search score via the `accessMultiplier` in explain mode

## Gist Preservation

Before pruning an original memory, the system creates a compressed gist in `memory_gists`.

### Gist Format

| Field | Type | Description |
|-------|------|-------------|
| `id` | TEXT | Primary key |
| `original_id` | TEXT | Non-strict FK (gist survives original purge) |
| `original_source` | TEXT | Source of the original memory |
| `kind` | TEXT | Type of knowledge |
| `core_fact` | TEXT | Compressed knowledge — the essential fact |
| `why_it_matters` | TEXT | Importance context |
| `revive_triggers` | JSON | Semantic triggers for recall |
| `non_forgettable` | BOOLEAN | Default `true` for gists |
| `created_at` | TEXT | Creation timestamp |
| `updated_at` | TEXT | Last update timestamp |
| `original_pruned_at` | TEXT | When the original was pruned (null if retained) |
| `status` | TEXT | Gist status |

### Gist Creation

When a memory transitions to `gist_only`:

1. The system calls `createMemoryGist()` with the original memory's content
2. An LLM (local model) generates `core_fact`, `why_it_matters`, and `revive_triggers`
3. The gist is stored with `non_forgettable=1` (gists are never pruned)
4. The original remains until the `gistOnlyRetentionDays` window expires

### Key Design Decision

`original_id` is intentionally NOT a strict foreign key. This ensures the gist survives the original row's purge. If the original is deleted, the gist persists independently.

## Revive Gate

Before pruning an original memory, the revive gate judges whether it should be retained:

1. System identifies prune candidates (memories in `gist_only` past the retention window)
2. For each candidate, the system checks the gist for value
3. An LLM/local model judges: **revive**, **prune**, or **defer**
4. Decision is recorded in `memory_revive_reviews`

### Decision Logic

| Decision | Condition | Action |
|----------|-----------|--------|
| `revive` | Gist suggests ongoing value, `confidence >= 0.7` | Memory is retained or moved back to `active` |
| `prune` | Gist suggests low value, `confidence >= 0.7` | Original is pruned; gist remains |
| `defer` | `confidence < 0.7` | Neither revive nor prune; re-evaluate later |

### `memory_revive_reviews` Table

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT | Primary key |
| `memory_id` | TEXT | The memory being reviewed |
| `gist_id` | TEXT | The associated gist |
| `decision` | TEXT | `revive`, `prune`, or `defer` |
| `confidence` | REAL | Model confidence (0–1) |
| `reason` | TEXT | Explanation of the decision |
| `model` | TEXT | Model used for the decision |
| `created_at` | TEXT | Review timestamp |

> **Naming note**: This table uses `created_at` (not `reviewed_at`) because each row is an immutable audit record of a single review event. The `memories` table uses `reviewed_at` for lifecycle status transitions — a different semantic. Do not rename; `created_at` matches the `global_promotion_log` convention.

## Timed Prune

After the retention window expires and the revive gate does not retain:

1. The original memory row is deleted
2. The gist remains (with `original_pruned_at` set)
3. The gist continues to be searchable via `search_global` (source: `gist`)

Pruning is **never automatic** — it only happens through the scheduled maintenance pipeline (sleep mode) or explicit `prune` tool invocation.

## Global Promotion

Repeated useful errors and design patterns are promoted to global memory.

### Promotion Criteria

| Rule | Condition | Example |
|------|-----------|---------|
| Multi-project occurrence | Same pattern in 2+ projects | "JWT validation error" appears in project A and B |
| Critical recurrence | 2+ times in one project if critical/security/data-loss | Repeated auth bypass fix |
| Revival frequency | Reused/revived 3+ times | Memory revived from gist 3+ times |

### Promotion Process

1. System detects promotion candidates via rule matching
2. A new global memory is created with the consolidated knowledge
3. Source memories are linked to the promoted memory
4. Decision is recorded in `global_promotion_log`

### `global_promotion_log` Table

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT | Primary key |
| `promoted_memory_id` | TEXT | ID of the new global memory |
| `source_ids` | JSON | Array of original memory IDs |
| `source_projects` | JSON | Array of project IDs |
| `rule_matched` | TEXT | E.g., `multi_project_occurrence` |
| `confidence` | REAL | Confidence score (>= 0.75 required) |
| `model` | TEXT | Model/system used for decision |
| `reviewer_provenance` | TEXT | Agent or human reviewer |
| `created_at` | TEXT | Timestamp of promotion |

This table is **append-only** — promotion decisions are traceable and never overwritten.

## Memory Hygiene

### Consolidation

Multiple episodic memories describing the same stable lesson are consolidated into a semantic summary memory. This reduces redundancy while preserving the knowledge.

### Contradiction/Supersession

When two memories conflict or one replaces another:

- The `memory_decay_log.reason` field can record `contradiction_detected`
- Rich conflict detection (via judge/compare) is **future work** — the current implementation supports minimal marking only

## Decay Log

All state transitions are recorded in `memory_decay_log`:

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT | Primary key |
| `memory_id` | TEXT | The memory that transitioned |
| `from_state` | TEXT | Previous state |
| `to_state` | TEXT | New state |
| `reason` | TEXT | Why the transition occurred |
| `score_before` | REAL | Activation score before transition |
| `score_after` | REAL | Activation score after transition |
| `created_at` | TEXT | Transition timestamp |

This provides a complete audit trail of memory lifecycle changes.

## Scheduled Maintenance

Gradual forgetting runs during scheduled maintenance (sleep mode or manual invocation):

1. **Evaluate all memories**: Read `memory_state`, `last_reinforced_at`, `created_at`, `activation_score`
2. **Compute transitions**: For each memory, determine if a state change is needed
3. **Batch update**: Apply all transitions in one transaction
4. **Create gists**: For memories transitioning to `gist_only`
5. **Run revive gate**: For prune candidates past the retention window
6. **Check promotion rules**: For memories meeting promotion criteria
7. **Log everything**: Record all transitions in `memory_decay_log`

### Batch Processing

The `runBatchDecayEvaluation()` function processes all non-purged memories in a single transaction:

```typescript
// Pseudocode
for each memory where memory_state != 'purged':
  newState = computeDecayState(memory)
  if newState != memory.memory_state:
    // Create gist if transitioning to gist_only
    if newState === 'gist_only': createMemoryGist(memory)
    // Update memory state
    UPDATE memories SET memory_state = ?, activation_score = ?
    // Log transition
    INSERT INTO memory_decay_log (...)
```

## Evergreen Memories

Memories tagged `evergreen` or `never-forget` are exempt from:

- Temporal decay (search score is not reduced by age)
- State transitions (always remain `active`)
- Pruning (never eligible for removal)

Use these tags for fundamental architecture decisions, critical security patterns, or core project conventions.

## Tables Summary

| Table | Purpose | Prunable? |
|-------|---------|-----------|
| `memory_gists` | Compressed knowledge preserved before prune | No (`non_forgettable=1`) |
| `memory_decay_log` | Audit trail of state transitions | Yes (older entries) |
| `memory_revive_reviews` | Revive/prune/defer decisions | No (audit trail) |
| `global_promotion_log` | Immutable audit trail for promotions | No (append-only) |
