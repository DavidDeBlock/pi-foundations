-- YT-015: channel-level dashboard tags inherited by canonical videos.
--
-- The relationship is deliberately stored only once, on the subscription.
-- Video reads derive their effective tag set from this table plus video_tags,
-- so existing and future videos react immediately to subscription tag edits.

CREATE TABLE subscription_tags (
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  tag_id           TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (subscription_id, tag_id)
);

CREATE INDEX idx_subscription_tags_tag_id ON subscription_tags(tag_id);
