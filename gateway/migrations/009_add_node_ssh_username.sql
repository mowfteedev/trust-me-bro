-- NULL preserves the existing Gateway-wide SSH account for older nodes.
SET lock_timeout = '2s';
SET statement_timeout = '10s';

ALTER TABLE public.nodes
    ADD COLUMN ssh_username VARCHAR(32)
    CONSTRAINT ck_nodes_ssh_username CHECK (ssh_username ~ '^[A-Za-z_][A-Za-z0-9_.-]{0,31}$');

RESET lock_timeout;
RESET statement_timeout;
