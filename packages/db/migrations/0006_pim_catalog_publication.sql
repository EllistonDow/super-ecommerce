BEGIN;

ALTER TABLE products
    ADD COLUMN pim_source TEXT,
    ADD COLUMN pim_external_id TEXT,
    ADD COLUMN pim_media_url TEXT,
    ADD CONSTRAINT products_pim_identity_pair
        CHECK ((pim_source IS NULL) = (pim_external_id IS NULL));

CREATE UNIQUE INDEX idx_products_pim_identity
    ON products (pim_source, pim_external_id)
    WHERE pim_source IS NOT NULL;

CREATE TABLE pim_ingestions (
    sequence BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    system_source TEXT NOT NULL,
    export_id TEXT NOT NULL,
    payload_json JSONB NOT NULL,
    accepted BOOLEAN NOT NULL,
    audit_json JSONB NOT NULL
);

CREATE UNIQUE INDEX idx_pim_ingestions_accepted_export
    ON pim_ingestions (system_source, export_id)
    WHERE accepted;

COMMIT;
