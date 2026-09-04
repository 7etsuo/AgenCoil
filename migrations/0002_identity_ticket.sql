-- Arena identity tickets: minted for a signed-in player by the site, handed
-- to the game server in HELLO, redeemed by the server with a GET back to the
-- site. A ticket is a random secret; it stays valid until expires_at so a
-- reconnect or an arena hop can present it again.
create table if not exists identity_ticket (
  ticket text not null primary key,
  user_id text not null,
  handle text not null,
  name text not null default '',
  avatar text not null default '',
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists identity_ticket_user on identity_ticket (user_id);
create index if not exists identity_ticket_expires on identity_ticket (expires_at);
