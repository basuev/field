ALTER TABLE tasks ADD COLUMN chain_seen_slot bigint CHECK (chain_seen_slot >= 0);
UPDATE tasks SET chain_seen_slot = chain_slot;
