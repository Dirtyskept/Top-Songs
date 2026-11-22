# Top Songs — Emby plugin

Adds a **Top Songs >** link next to **Songs >** on every music artist page in Emby. It opens that artist's most popular songs from Last.fm, showing only the ones you actually have in your library, ready to play.

## What it does
- Looks up an artist's top tracks on Last.fm and matches them to songs in your Emby library.
- Shows the matched songs as a list on the artist page. Artists with no matches don't get the link.
- Saves each artist's chart and refreshes it after 24 hours, so pages load quickly.
- **Settings** (Plugins › Top Songs): your Last.fm API key, how many songs to show (1–50), and Diagnostics to check that everything works, for one artist or overall.

## What it changes in Emby
To show the link, Emby's web app has to load Top Songs' script. So Top Songs adds three marked lines to one Emby file, `system/dashboard-ui/index.html`. They're added only when missing and removed when you uninstall the plugin. Emby's phone, TV and desktop apps aren't affected. For the full details, see [WHAT-TOP-SONGS-CHANGES-IN-EMBY.txt](WHAT-TOP-SONGS-CHANGES-IN-EMBY.txt).

## Install
1. Download `TopSongs.dll` from [Releases](../../releases).
2. Copy it into Emby's `plugins` folder and restart Emby.
3. Go to Plugins › Top Songs and enter a Last.fm API key (free from last.fm/api).
4. Press Ctrl+F5 once in any browser that already had Emby open.

## Build
`dotnet build TopSongs.csproj -c Release -p:EmbySystemDir=<folder with MediaBrowser.Common, Controller and Model.dll>`, then use `bin/Release/net8.0/TopSongs.dll`.

## Licence
Copyright (C) 2026 Dirtyskept. Top Songs is free software under the [GNU General Public License, version 3](LICENSE): you may use, change and share it, and a changed version you share must also be under GPL-3.0. It comes with no warranty.

Song charts come from [Last.fm](https://www.last.fm); Top Songs isn't made or endorsed by Last.fm.
