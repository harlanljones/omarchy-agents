# Preserve experiment cohorts across index rebuilds

Experiment cohorts store stable session IDs without a foreign key to the mutable session index, and completed reviews snapshot the IDs and aggregates used in their calculation. A full index rebuild deliberately deletes and repopulates sessions: cascading foreign keys would silently erase cohort membership, while restrictive foreign keys would block rebuilds. Missing sessions therefore remain explicit and unavailable until they reappear, preserving the user's selections and prior reviews without weakening the indexer's rebuild behavior.
