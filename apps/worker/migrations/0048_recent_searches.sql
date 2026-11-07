-- Each person's recent searches with their filters, which take over from the words alone that 0023's
-- `searches` keeps: each search as its key (@ember/protocol `searchKey`), the JSON of its words and the
-- filters it has on, ordered as 0023 orders them, starting with a copy of those, words alone. 0023's stay
-- for the release before, and go with these when someone clears them or is removed.
CREATE TABLE IF NOT EXISTS recent_searches (
  user_id TEXT NOT NULL REFERENCES users (id),
  search TEXT NOT NULL,
  -- One past the highest of the person's when they last searched for it, so the newest is the highest.
  position INTEGER NOT NULL,
  PRIMARY KEY (user_id, search)
);
CREATE INDEX IF NOT EXISTS index_recent_searches_on_user_id_and_position ON recent_searches (user_id, position);

INSERT INTO recent_searches (user_id, search, position) SELECT user_id, json_object('q', query), position FROM searches WHERE true ON CONFLICT DO NOTHING;
