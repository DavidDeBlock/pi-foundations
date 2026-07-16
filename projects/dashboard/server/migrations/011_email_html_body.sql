-- Preserve the original HTML alternative for rich email rendering.
-- Plain text remains the searchable and API-friendly fallback.
ALTER TABLE emails ADD COLUMN body_html TEXT;
