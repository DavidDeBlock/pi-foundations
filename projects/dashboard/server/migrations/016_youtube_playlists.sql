CREATE TABLE youtube_playlist_sync_state (
  google_account_id TEXT PRIMARY KEY REFERENCES youtube_accounts(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'idle'
    CHECK (status IN ('idle', 'running', 'completed', 'failed')),
  playlist_count INTEGER NOT NULL DEFAULT 0,
  included_count INTEGER NOT NULL DEFAULT 0,
  synced_item_count INTEGER NOT NULL DEFAULT 0,
  failed_playlist_count INTEGER NOT NULL DEFAULT 0,
  requested_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  error TEXT,
  retryable INTEGER NOT NULL DEFAULT 0 CHECK (retryable IN (0, 1))
);

CREATE TABLE youtube_playlists (
  google_account_id TEXT NOT NULL REFERENCES youtube_accounts(id) ON DELETE CASCADE,
  playlist_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  thumbnail_url TEXT,
  privacy_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (privacy_status IN ('public', 'private', 'unlisted', 'unknown')),
  remote_item_count INTEGER NOT NULL DEFAULT 0,
  local_item_count INTEGER NOT NULL DEFAULT 0,
  is_included INTEGER NOT NULL DEFAULT 0 CHECK (is_included IN (0, 1)),
  special_type TEXT CHECK (special_type IN ('liked', 'watch_later', 'history')),
  live_sync_supported INTEGER NOT NULL DEFAULT 1 CHECK (live_sync_supported IN (0, 1)),
  sync_status TEXT NOT NULL DEFAULT 'idle'
    CHECK (sync_status IN ('idle', 'pending', 'running', 'completed', 'failed', 'unsupported')),
  last_synced_at TEXT,
  sync_started_at TEXT,
  sync_completed_at TEXT,
  sync_error TEXT,
  sync_retryable INTEGER NOT NULL DEFAULT 0 CHECK (sync_retryable IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (google_account_id, playlist_id)
);

CREATE TABLE youtube_playlist_items (
  google_account_id TEXT NOT NULL,
  playlist_id TEXT NOT NULL,
  playlist_item_id TEXT NOT NULL,
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  added_at TEXT,
  synced_at TEXT NOT NULL,
  PRIMARY KEY (google_account_id, playlist_id, playlist_item_id),
  FOREIGN KEY (google_account_id, playlist_id)
    REFERENCES youtube_playlists(google_account_id, playlist_id) ON DELETE CASCADE
);

CREATE INDEX idx_youtube_playlists_account_included
  ON youtube_playlists(google_account_id, is_included, title);
CREATE INDEX idx_youtube_playlist_items_order
  ON youtube_playlist_items(google_account_id, playlist_id, position, playlist_item_id);
CREATE INDEX idx_youtube_playlist_items_video
  ON youtube_playlist_items(video_id);
