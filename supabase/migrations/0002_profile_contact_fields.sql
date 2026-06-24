alter table public.profiles
  add column discord_username text,
  add column steam_profile_url text;

alter table public.profiles
  add constraint profiles_discord_username_length
    check (discord_username is null or char_length(discord_username) <= 64),
  add constraint profiles_steam_profile_url_format
    check (
      steam_profile_url is null
      or (
        char_length(steam_profile_url) <= 200
        and steam_profile_url ~ '^https?://'
      )
    );
