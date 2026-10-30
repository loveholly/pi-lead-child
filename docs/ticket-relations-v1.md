# Ticket Relations V1

## Migration

- Schema migration: `ticket-relations-v1`
- Migration version: `17`
- Table: `ticket_relations`
- Columns: `source_item_id`, `target_item_id`, `relation_type`, `created_by`, `created_by_run_id`, `reason`, `created_at`, `revoked_at`, `revoked_by`, `revoke_reason`
- Active uniqueness:
  - exact active relation: `(source_item_id, target_item_id, relation_type)`
  - duplicate canonical per source: active `duplicates` on `source_item_id`
  - current superseder per old ticket: active `supersedes` on `target_item_id`

Parent/child is not migrated into `ticket_relations`. It remains owned by the existing `items.parent_item_id` task tree and is adapted into relation reads.

## Relation Semantics

| Relation | Stored fact | Reverse view | Scheduling | Canonical/effective impact | Restore impact |
| --- | --- | --- | --- | --- | --- |
| `parent_of` / `child_of` | Existing task tree only | Query adapter | Existing tree semantics only | None | Participates in root/tree restore |
| `depends_on` / `blocks` | `source depends_on target` | `target blocks source` | Source cannot be auto-dispatched or run until target is `done` or relation is revoked | None | Does not expand restore scope |
| `implements` / `implemented_by` | `source implements target` | `target implemented_by source` | None by default; add `depends_on` when blocking is intended | Source provenance only | Does not expand restore scope |
| `duplicates` / `duplicated_by` | `source duplicates target` | `target duplicated_by source` | None | Target is canonical; histories remain separate | Used only as duplicate hint during reviewed tree restore |
| `supersedes` / `superseded_by` | `source supersedes target` | `target superseded_by source` | None | Source is current effective item; target is not deleted | Does not expand restore scope |
| `relates_to` | Navigation edge | Same semantic both ways | None | None | Does not expand restore scope |

Only stored relation types are written to `ticket_relations`: `depends_on`, `implements`, `duplicates`, `supersedes`, `relates_to`. Reverse names are generated at query time.

## Validation

`link_tickets` and control-plane relation endpoints validate:

- source and target tickets exist and are not cancelled
- no self-link
- parent relations cannot be copied into the relation ledger
- task-only relations require task items on both sides
- purpose compatibility for stateful or implementation relations
- dependency cycles
- duplicate canonical constraints
- supersedes cycle and high-impact pair conflicts
- duplicate active relations
- project, workdir, and repository scope risks

Stateful cross-project, cross-workdir, or cross-repository links require an explicit reason. The operation returns visible risk strings instead of hiding the boundary.

## Tool Examples

Design ticket to implementation ticket:

```json
{
  "source_ticket_id": 42,
  "target_ticket_id": 17,
  "relation_type": "implements",
  "reason": "implementation follows the approved design"
}
```

If design completion must block implementation dispatch, also create:

```json
{
  "source_ticket_id": 42,
  "target_ticket_id": 17,
  "relation_type": "depends_on",
  "reason": "implementation must wait until the design ticket is done"
}
```

Duplicate ticket canonical:

```json
{
  "source_ticket_id": 51,
  "target_ticket_id": 12,
  "relation_type": "duplicates",
  "reason": "same user request; #12 is the canonical ticket"
}
```

Revoke instead of deleting:

```json
{
  "relation_id": 9,
  "reason": "not actually a duplicate after comparing scope"
}
```

Companion/control-plane endpoints:

- `POST /v1/tickets/:ticket_id/relations`
- `POST /v1/tickets/:ticket_id/relations/:relation_id/revoke`

Both endpoints act as `user`, require `tickets:create`, reject caller-supplied non-user actors, and write activities for both related tickets.

## Scheduling And Restore

- `depends_on` blocks dispatcher claim and direct run creation while any blocker is not `done`.
- Dispatcher skips now write a system decision activity with blocker details.
- `implements`, `duplicates`, `supersedes`, and `relates_to` do not block dispatch by themselves.
- Restore defaults to the existing tree. Ordinary relations do not pull extra tickets into restore scope.
- Duplicate canonical data is only a recovery hint for reviewed tree restore; it does not silently merge history.

## End-To-End Proof Scenarios

1. Design to implementation:
   - Create design ticket.
   - Create implementation ticket with atomic `relations=[{ relation_type: "implements", target_ticket_id: design }]`.
   - Verify `get_ticket_relations(implementation)` shows `implements`.
   - Verify implementation can dispatch unless a separate `depends_on` is created.

2. Duplicate canonical:
   - Link duplicate ticket to canonical with `duplicates`.
   - Verify `canonicalDuplicateOf(duplicate)` returns canonical and `duplicateSourcesFor(canonical)` includes duplicate.
   - Revoke the relation when wrong; verify the row remains with `revoked_at`, `revoked_by`, and `revoke_reason`.
