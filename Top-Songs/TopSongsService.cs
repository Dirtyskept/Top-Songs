using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Threading.Tasks;
using MediaBrowser.Controller.Api;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Audio;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Net;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Model.Services;

namespace TopSongs
{
    [Route("/TopSongs/Status", "GET", Summary = "Reports whether the TopSongs plugin is available to Emby Web")]
    [Authenticated]
    public sealed class GetTopSongsStatus : IReturn<TopSongsStatusResponse>
    {
    }

    public sealed class TopSongsStatusResponse
    {
        public bool Available { get; set; }
        public bool Configured { get; set; }
        public int TrackCount { get; set; }
    }


    [Route("/TopSongs/Diagnostics", "GET", Summary = "Reports TopSongs build and embedded resources for troubleshooting")]
    [Authenticated]
    public sealed class GetTopSongsDiagnostics : IReturn<TopSongsDiagnosticsResponse>
    {
    }

    public sealed class TopSongsDiagnosticsResponse
    {
        public bool Available { get; set; }
        public bool Configured { get; set; }
        public int TrackCount { get; set; }
        public string PluginName { get; set; }
        public string PluginVersion { get; set; }
        public string AssemblyName { get; set; }
        public string[] EmbeddedResources { get; set; } = Array.Empty<string>();
        public TopSongsDiagnosticPage[] RegisteredPages { get; set; } = Array.Empty<TopSongsDiagnosticPage>();
        public TopSongsCacheStats Cache { get; set; }
        public object RuntimeMetrics { get; set; }
        public TopSongsIndexBlockStatus IndexBlock { get; set; }
    }

    public sealed class TopSongsDiagnosticPage
    {
        public string Name { get; set; }
        public string EmbeddedResourcePath { get; set; }
    }

    [Route("/TopSongs/Bootstrap", "GET", Summary = "Tiny always-fresh script referenced by the Top Songs block in index.html")]
    // Static JavaScript only. The index.html block has no version number, so this
    // few-hundred-byte script is never cached and loads the versioned loader below.
    [Unauthenticated]
    public sealed class GetTopSongsBootstrap : IReturn<string> { }

    [Route("/TopSongs/ItemPageLoader", "GET", Summary = "Serves the embedded TopSongs item-page loader implementation")]
    // Static JavaScript only; classic script tags cannot attach ApiClient auth headers.
    [Unauthenticated]
    public sealed class GetTopSongsItemPageLoader : IReturn<string> { }

    [Route("/TopSongs/ArtistPageScript", "GET", Summary = "Serves the embedded TopSongs artist-page script")]
    // This endpoint returns only static JavaScript and no user/library/configuration data.
    // Emby Web loads a classic script with a script element, which cannot attach the
    // X-Emby-Authorization header used by ApiClient.ajax. Allow anonymous GETs here;
    // all data/status/chart endpoints remain authenticated.
    [Unauthenticated]
    public sealed class GetTopSongsArtistPageScript : IReturn<string>
    {
    }

    [Route("/TopSongs/Artists", "GET", Summary = "Search the Emby music-artist library")]
    [Authenticated]
    public sealed class GetTopSongsArtists : IReturn<TopSongsArtistsResponse>
    {
        public string SearchTerm { get; set; }
        public int? Limit { get; set; }
    }

    [Route("/TopSongs/Chart", "GET", Summary = "Gets an artist's Last.fm top tracks with local Emby matches")]
    [Authenticated]
    public sealed class GetTopSongsChart : IReturn<TopSongsChartResponse>
    {
        public string ArtistId { get; set; }
        public int? Limit { get; set; }
        public bool ForceRefresh { get; set; }
    }

    public sealed class TopSongsArtistsResponse
    {
        public TopSongsArtistDto[] Items { get; set; } = Array.Empty<TopSongsArtistDto>();
        public int TotalRecordCount { get; set; }
    }

    public sealed class TopSongsArtistDto
    {
        public string Id { get; set; }
        public string Name { get; set; }
    }

    public sealed class TopSongsChartResponse
    {
        public string Error { get; set; }
        public string ArtistName { get; set; }
        public TopSongsTrackDto[] Items { get; set; } = Array.Empty<TopSongsTrackDto>();
        // Count-only diagnostics let us distinguish query and matching failures safely.
        public int LastFmTrackCount { get; set; }
        public int DirectArtistTrackCount { get; set; }
        public int AlbumArtistTrackCount { get; set; }
        public int ContributingArtistTrackCount { get; set; }
        public int UniqueLocalTrackCount { get; set; }
        public int UniqueNormalizedLocalTitleCount { get; set; }
        public int DistinctMatchedLocalTrackCount { get; set; }
        public int ReturnedMatchCount { get; set; }
        public int CandidateInternalIdCount { get; set; }
        public int ItemHydrationMissCount { get; set; }
        public int ItemsWithBlankTitleCount { get; set; }
        public string ItemIdMode { get; set; }
        // Server-side phases are copied into cached responses so diagnostics can
        // distinguish Last.fm latency from Emby library preparation and matching.
        public long? LastFmFetchMs { get; set; }
        public long? LibraryPreparationMs { get; set; }
        public long? MatchMs { get; set; }
        public long? ServerBuildMs { get; set; }
    }

    public sealed class TopSongsTrackDto
    {
        public int Rank { get; set; }
        public string Title { get; set; }
        public string Artist { get; set; }
        public string ArtistId { get; set; }
        public string Album { get; set; }
        public string AlbumId { get; set; }
        public string AlbumArtist { get; set; }
        public string AlbumArtistId { get; set; }
        public string CommunityRating { get; set; }
        public string Year { get; set; }
        public long RunTimeTicks { get; set; }
        public string Genres { get; set; }
        public bool Matched { get; set; }
        public string ItemId { get; set; }
    }

    /// <summary>API endpoints and embedded browser resources used by the Top Songs page.</summary>
    public sealed class TopSongsService : BaseApiService
    {
        private static string BuildChartCacheKey(long artistInternalId, int count)
        {
            return artistInternalId.ToString(CultureInfo.InvariantCulture) + ":" + count.ToString(CultureInfo.InvariantCulture);
        }

        public object Get(GetTopSongsBootstrap request)
        {
            // Loads ItemPageLoader?v=<release>: that file can be cached for a year because
            // its URL changes with every release, so plugin updates still apply at once.
            var script =
                "(function(){'use strict';" +
                "if(window.__topSongsBootstrapStarted)return;window.__topSongsBootstrapStarted=true;" +
                "var v='" + Plugin.BuildVersion + "',src=(document.currentScript&&document.currentScript.src)||'',url;" +
                "try{url=new URL('ItemPageLoader?v='+encodeURIComponent(v),src||new URL('../emby/TopSongs/',location.href)).href;}" +
                "catch(e){url='../emby/TopSongs/ItemPageLoader?v='+v;}" +
                "var s=document.createElement('script');s.src=url;s.async=true;" +
                "(document.head||document.documentElement).appendChild(s);})();";
            var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                ["Cache-Control"] = "no-cache, no-store, max-age=0",
                ["X-Content-Type-Options"] = "nosniff"
            };
            return ResultFactory.GetResult(Request, new ReadOnlyMemory<byte>(Encoding.UTF8.GetBytes(script)),
                "application/javascript; charset=utf-8", headers);
        }

        public object Get(GetTopSongsItemPageLoader request) => GetJavaScriptResourceResult(
            "TopSongs.Web.TopSongsItemPageLoader.js",
            "The TopSongs item-page loader implementation is missing from the plugin assembly.");

        public object Get(GetTopSongsArtistPageScript request)
        {
            // Serve through the plugin API rather than /web/__plugin/, which returned 404 on the target server.
            return GetJavaScriptResourceResult(
                "TopSongs.Web.TopSongsArtistPage.js",
                "The TopSongs artist-page script is missing from the plugin assembly.");
        }

        private object GetJavaScriptResourceResult(string resourceName, string missingResourceMessage)
        {
            using var resource = typeof(Plugin).Assembly.GetManifestResourceStream(resourceName);
            if (resource == null)
            {
                throw new FileNotFoundException(missingResourceMessage, resourceName);
            }

            using var buffer = new MemoryStream();
            resource.CopyTo(buffer);
            var content = new ReadOnlyMemory<byte>(buffer.ToArray());
            // Normal loader requests carry an explicit release version. Only those URLs
            // are immutable; diagnostics/direct unversioned requests must not be pinned in
            // browser caches across plugin upgrades.
            string assetVersion = null;
            if (Request != null && Request.QueryString != null)
            {
                assetVersion = Request.QueryString["version"];
                if (string.IsNullOrWhiteSpace(assetVersion)) assetVersion = Request.QueryString["v"];
            }
            var cacheControl = string.IsNullOrWhiteSpace(assetVersion)
                ? "no-store, max-age=0"
                : "public, max-age=31536000, immutable";
            var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                ["Cache-Control"] = cacheControl,
                ["X-Content-Type-Options"] = "nosniff"
            };
            return ResultFactory.GetResult(Request, content, "application/javascript; charset=utf-8", headers);
        }

        public object Get(GetTopSongsStatus request)
        {
            var plugin = Plugin.Instance;
            return new TopSongsStatusResponse
            {
                Available = plugin != null,
                Configured = plugin != null && !string.IsNullOrWhiteSpace(plugin.Configuration?.LastFmApiKey),
                TrackCount = plugin?.Configuration?.CacheSongsPerArtist ?? 10
            };
        }


        public object Get(GetTopSongsDiagnostics request)
        {
            var plugin = Plugin.Instance;
            var assembly = typeof(Plugin).Assembly;
            var pages = plugin == null
                ? Array.Empty<TopSongsDiagnosticPage>()
                : plugin.GetPages().Select(page => new TopSongsDiagnosticPage
                {
                    Name = page.Name,
                    EmbeddedResourcePath = page.EmbeddedResourcePath
                }).ToArray();

            // This response intentionally reports only whether a key exists, never its value.
            return new TopSongsDiagnosticsResponse
            {
                Available = plugin != null,
                Configured = plugin != null && !string.IsNullOrWhiteSpace(plugin.Configuration?.LastFmApiKey),
                TrackCount = plugin?.Configuration?.CacheSongsPerArtist ?? 10,
                PluginName = plugin?.Name ?? "TopSongs",
                PluginVersion = Plugin.BuildVersion,
                AssemblyName = assembly.GetName().Name ?? "unknown",
                EmbeddedResources = assembly.GetManifestResourceNames()
                    .Where(name => name.StartsWith("TopSongs.Web.", StringComparison.Ordinal))
                    .OrderBy(name => name, StringComparer.Ordinal)
                    .ToArray(),
                RegisteredPages = pages,
                Cache = TopSongsChartCache.GetStats(),
                RuntimeMetrics = TopSongsRuntimeDiagnostics.Snapshot(),
                IndexBlock = TopSongsIndexBlock.GetStatus()
            };
        }

        public object Get(GetTopSongsArtists request)
        {
            var user = GetUserForRequest(Guid.Empty);
            var query = new InternalItemsQuery(user)
            {
                IncludeItemTypes = new[] { typeof(MusicArtist).Name },
                Recursive = true,
                SearchTerm = string.IsNullOrWhiteSpace(request.SearchTerm) ? null : request.SearchTerm.Trim(),
                Limit = Math.Clamp(request.Limit ?? 100, 1, 200),
                DtoOptions = new DtoOptions(false) { EnableImages = false }
            };

            var artists = LibraryManager.GetItemList(query)
                .OfType<MusicArtist>()
                .Where(a => !a.IsHidden)
                .OrderBy(a => a.SortName ?? a.Name, StringComparer.CurrentCultureIgnoreCase)
                .Select(a => new TopSongsArtistDto { Id = a.InternalId.ToString(CultureInfo.InvariantCulture), Name = a.Name })
                .ToArray();

            return new TopSongsArtistsResponse { Items = artists, TotalRecordCount = artists.Length };
        }

        public async Task<object> Get(GetTopSongsChart request)
        {
            var plugin = Plugin.Instance;
            var artistId = request?.ArtistId?.Trim();
            if (plugin == null || string.IsNullOrWhiteSpace(artistId))
            {
                return await BuildChartAndRecordAsync(request).ConfigureAwait(false);
            }

            var artist = LibraryManager.GetItemById(artistId) as MusicArtist;
            if (artist == null || artist.IsHidden || string.IsNullOrWhiteSpace(plugin.Configuration?.LastFmApiKey))
            {
                return await BuildChartAndRecordAsync(request).ConfigureAwait(false);
            }

            var configuredCount = plugin.Configuration?.CacheSongsPerArtist ?? 10;
            var count = Math.Clamp(request.Limit ?? configuredCount, 1, 50);
            var cacheKey = BuildChartCacheKey(artist.InternalId, count);
            return await TopSongsChartCache.GetAsync(cacheKey, TopSongsCachePolicy.RefreshHours,
                TopSongsCachePolicy.MaxArtists, TopSongsCachePolicy.DiskLimitMb, TopSongsCachePolicy.EvictionPolicy,
                TopSongsCachePolicy.ShowCachedDuringRefresh && !request.ForceRefresh,
                TopSongsCachePolicy.RefreshStaleOnVisit, request.ForceRefresh,
                async () =>
                {
                    return (TopSongsChartResponse)await BuildChartAndRecordAsync(request).ConfigureAwait(false);
                }).ConfigureAwait(false);
        }

        private async Task<object> BuildChartAndRecordAsync(GetTopSongsChart request)
        {
            var result = (TopSongsChartResponse)await BuildChartUncachedAsync(request).ConfigureAwait(false);
            TopSongsRuntimeDiagnostics.RecordChart(result);
            return result;
        }

        private async Task<object> BuildChartUncachedAsync(GetTopSongsChart request)
        {
            var plugin = Plugin.Instance;
            if (plugin == null)
            {
                return new TopSongsChartResponse { Error = "TopSongs plugin has not finished initializing." };
            }

            // Emby Web item routes may use string-form identifiers. Do not bind this
            // request to Guid: that rejects numeric item IDs before this method runs.
            var artistId = request?.ArtistId?.Trim();
            if (string.IsNullOrWhiteSpace(artistId))
            {
                return new TopSongsChartResponse { Error = "The Emby artist ID was missing from the request." };
            }

            var artist = LibraryManager.GetItemById(artistId) as MusicArtist;
            if (artist == null || artist.IsHidden)
            {
                return new TopSongsChartResponse { Error = "Emby could not find this artist in the music library. Refresh the artist page and try again." };
            }

            var apiKey = plugin.Configuration?.LastFmApiKey;
            if (string.IsNullOrWhiteSpace(apiKey))
            {
                return new TopSongsChartResponse { ArtistName = artist.Name, Error = "No Last.fm API key is saved. Open Dashboard → Plugins → TopSongs, enter the key, and save settings." };
            }

            var configuredCount = plugin.Configuration?.CacheSongsPerArtist ?? 10;
            // CacheSongsPerArtist is the desired number of LOCAL matches to display. Fetch the
            // largest supported chart window first, then filter out tracks not in Emby.
            // Otherwise a 25-track Last.fm window could yield only one or two local songs.
            var count = Math.Clamp(request.Limit ?? configuredCount, 1, 50);
            var buildWatch = Stopwatch.StartNew();
            var lastFm = new LastFmClient(() => apiKey);
            long lastFmFetchMs = -1;
            // Start the Last.fm request first, but do not await it yet. Emby's indexed
            // artist-track queries and item hydration are independent of the chart response,
            // so they can run while the network request is in flight.
            var lastFmTask = FetchLastFmTracksWithTimingAsync(lastFm, artist.Name,
                elapsedMs => lastFmFetchMs = elapsedMs);
            var libraryPreparationWatch = Stopwatch.StartNew();

            // Query Emby's indexed library relationships instead of reading library.db.
            // On this server, GetItemList returns the correct number of Audio objects and
            // their names, but those query-result objects have empty IDs. Consequently,
            // filtering on Audio.InternalId removed every candidate. Obtain the real numeric
            // IDs through GetInternalItemIds, then hydrate each item via GetItemById(long).
            var user = GetUserForRequest(Guid.Empty);
            var audioTypes = new[] { typeof(Audio).Name };

            var directArtistTrackIds = LibraryManager.GetInternalItemIds(new InternalItemsQuery(user)
            {
                IncludeItemTypes = audioTypes,
                ArtistIds = new[] { artist.InternalId },
                Recursive = true,
                Limit = 5000
            }) ?? Array.Empty<long>();

            var albumArtistTrackIds = LibraryManager.GetInternalItemIds(new InternalItemsQuery(user)
            {
                IncludeItemTypes = audioTypes,
                AlbumArtistIds = new[] { artist.InternalId },
                Recursive = true,
                Limit = 5000
            }) ?? Array.Empty<long>();

            var contributingArtistTrackIds = LibraryManager.GetInternalItemIds(new InternalItemsQuery(user)
            {
                IncludeItemTypes = audioTypes,
                ContributingArtistIds = new[] { artist.InternalId },
                Recursive = true,
                Limit = 5000
            }) ?? Array.Empty<long>();

            var candidateItemIds = directArtistTrackIds
                .Concat(albumArtistTrackIds)
                .Concat(contributingArtistTrackIds)
                .Where(id => id > 0)
                .Distinct()
                .ToArray();

            var localTracks = new List<LocalTrackCandidate>(candidateItemIds.Length);
            var itemHydrationMissCount = 0;
            var itemsWithBlankTitleCount = 0;
            foreach (var itemId in candidateItemIds)
            {
                BaseItem item;
                try
                {
                    item = LibraryManager.GetItemById(itemId);
                }
                catch
                {
                    itemHydrationMissCount++;
                    continue;
                }

                if (item is not Audio audio)
                {
                    itemHydrationMissCount++;
                    continue;
                }

                if (string.IsNullOrWhiteSpace(audio.Name))
                {
                    itemsWithBlankTitleCount++;
                    continue;
                }

                // Use the numeric ID returned by GetInternalItemIds, not fields on the
                // initial query result, which this Emby instance leaves unset.
                localTracks.Add(new LocalTrackCandidate
                {
                    ItemId = itemId,
                    Title = audio.Name,
                    Artist = audio.Artists != null && audio.Artists.Length > 0
                        ? string.Join(", ", audio.Artists)
                        : artist.Name,
                    ArtistId = artist.InternalId,
                    Album = audio.Album ?? string.Empty,
                    AlbumId = audio.AlbumId > 0 ? audio.AlbumId : audio.InternalAlbumId,
                    AlbumArtist = ReadMetadataText(audio, "AlbumArtists", "AlbumArtist", "AlbumArtistName"),
                    AlbumArtistId = ReadMetadataLong(audio, "AlbumArtistIds", "AlbumArtistId"),
                    CommunityRating = ReadCommunityRating(audio),
                    Year = ReadMetadataText(audio, "ProductionYear", "Year"),
                    RunTimeTicks = ReadMetadataLong(audio, "RunTimeTicks"),
                    Genres = ReadMetadataText(audio, "Genres")
                });
            }

            var normalizedTracks = localTracks
                .Select(track => new { Track = track, Key = NormalizeTitle(track.Title) })
                .Where(item => !string.IsNullOrWhiteSpace(item.Key))
                .GroupBy(item => item.Key, StringComparer.Ordinal)
                .ToDictionary(
                    group => group.Key,
                    group => group.Select(item => item.Track)
                        .OrderBy(track => track.ItemId)
                        .First(),
                    StringComparer.Ordinal);
            libraryPreparationWatch.Stop();
            var libraryPreparationMs = libraryPreparationWatch.ElapsedMilliseconds;

            LastFmTrack[] sourceTracks;
            try
            {
                sourceTracks = await lastFmTask.ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                buildWatch.Stop();
                // Return a concise actionable error. The API key itself is never included.
                return new TopSongsChartResponse
                {
                    ArtistName = artist.Name,
                    Error = FormatLastFmError(ex),
                    LastFmFetchMs = lastFmFetchMs >= 0 ? lastFmFetchMs : (long?)null,
                    LibraryPreparationMs = libraryPreparationMs,
                    ServerBuildMs = buildWatch.ElapsedMilliseconds
                };
            }

            var matchWatch = Stopwatch.StartNew();
            var rows = new List<TopSongsTrackDto>();
            var emittedItemIds = new HashSet<long>();
            foreach (var sourceTrack in sourceTracks)
            {
                var key = NormalizeTitle(sourceTrack.Title);
                if (string.IsNullOrWhiteSpace(key) || !normalizedTracks.TryGetValue(key, out var localTrack))
                {
                    continue;
                }

                if (!emittedItemIds.Add(localTrack.ItemId))
                {
                    continue;
                }

                // Use Emby's own title and the numeric ID for the resolved library item.
                // Unmatched Last.fm songs are omitted and no Last.fm URLs are returned.
                rows.Add(new TopSongsTrackDto
                {
                    Rank = rows.Count + 1,
                    Title = localTrack.Title,
                    Artist = localTrack.Artist,
                    ArtistId = localTrack.ArtistId.ToString(CultureInfo.InvariantCulture),
                    Album = localTrack.Album,
                    AlbumId = localTrack.AlbumId > 0
                        ? localTrack.AlbumId.ToString(CultureInfo.InvariantCulture)
                        : string.Empty,
                    AlbumArtist = string.IsNullOrWhiteSpace(localTrack.AlbumArtist) ? artist.Name : localTrack.AlbumArtist,
                    AlbumArtistId = localTrack.AlbumArtistId > 0
                        ? localTrack.AlbumArtistId.ToString(CultureInfo.InvariantCulture)
                        : (string.Equals(localTrack.AlbumArtist, artist.Name, StringComparison.OrdinalIgnoreCase)
                            ? artist.InternalId.ToString(CultureInfo.InvariantCulture)
                            : string.Empty),
                    CommunityRating = localTrack.CommunityRating,
                    Year = localTrack.Year,
                    RunTimeTicks = localTrack.RunTimeTicks,
                    Genres = localTrack.Genres,
                    Matched = true,
                    ItemId = localTrack.ItemId.ToString(CultureInfo.InvariantCulture)
                });
            }

            var matchedBeforeLimit = rows.Count;
            if (rows.Count > count)
            {
                rows = rows.Take(count).ToList();
            }
            matchWatch.Stop();
            buildWatch.Stop();

            return new TopSongsChartResponse
            {
                ArtistName = artist.Name,
                Items = rows.ToArray(),
                LastFmTrackCount = sourceTracks.Length,
                DirectArtistTrackCount = directArtistTrackIds.Where(id => id > 0).Distinct().Count(),
                AlbumArtistTrackCount = albumArtistTrackIds.Where(id => id > 0).Distinct().Count(),
                ContributingArtistTrackCount = contributingArtistTrackIds.Where(id => id > 0).Distinct().Count(),
                UniqueLocalTrackCount = localTracks.Count,
                UniqueNormalizedLocalTitleCount = normalizedTracks.Count,
                DistinctMatchedLocalTrackCount = matchedBeforeLimit,
                ReturnedMatchCount = rows.Count,
                CandidateInternalIdCount = candidateItemIds.Length,
                ItemHydrationMissCount = itemHydrationMissCount,
                ItemsWithBlankTitleCount = itemsWithBlankTitleCount,
                ItemIdMode = "GetInternalItemIds + GetItemById(long)",
                LastFmFetchMs = lastFmFetchMs >= 0 ? lastFmFetchMs : (long?)null,
                LibraryPreparationMs = libraryPreparationMs,
                MatchMs = matchWatch.ElapsedMilliseconds,
                ServerBuildMs = buildWatch.ElapsedMilliseconds
            };
        }

        private static async Task<LastFmTrack[]> FetchLastFmTracksWithTimingAsync(
            LastFmClient client, string artistName, Action<long> recordElapsedMs)
        {
            var watch = Stopwatch.StartNew();
            try
            {
                return await client.GetArtistTopTracksAsync(artistName, 50).ConfigureAwait(false);
            }
            finally
            {
                watch.Stop();
                recordElapsedMs?.Invoke(watch.ElapsedMilliseconds);
            }
        }

        private sealed class LocalTrackCandidate
        {
            public long ItemId { get; set; }
            public string Title { get; set; }
            public string Artist { get; set; }
            public long ArtistId { get; set; }
            public string Album { get; set; }
            public long AlbumId { get; set; }
            public string AlbumArtist { get; set; }
            public long AlbumArtistId { get; set; }
            public string CommunityRating { get; set; }
            public string Year { get; set; }
            public long RunTimeTicks { get; set; }
            public string Genres { get; set; }
        }

        // Read optional metadata reflectively because Emby plugin/API versions expose some
        // music metadata on slightly different base types. Missing values remain blank rather
        // than making the plugin fail to load against an otherwise compatible Emby build.
        private static object ReadMetadataProperty(object source, string propertyName)
        {
            if (source == null || string.IsNullOrWhiteSpace(propertyName)) return null;
            try
            {
                var property = source.GetType().GetProperty(propertyName,
                    BindingFlags.Public | BindingFlags.Instance | BindingFlags.IgnoreCase);
                if (property == null || property.GetIndexParameters().Length != 0) return null;
                return property.GetValue(source);
            }
            catch { return null; }
        }

        private static string ReadMetadataText(object source, params string[] propertyNames)
        {
            foreach (var propertyName in propertyNames)
            {
                var text = MetadataValueToText(ReadMetadataProperty(source, propertyName));
                if (!string.IsNullOrWhiteSpace(text)) return text;
            }
            return string.Empty;
        }

        private static string MetadataValueToText(object value)
        {
            if (value == null) return string.Empty;
            if (value is string directText) return directText.Trim();
            if (value is IEnumerable sequence)
            {
                var parts = new List<string>();
                foreach (var entry in sequence)
                {
                    var part = MetadataEntryToText(entry);
                    if (!string.IsNullOrWhiteSpace(part) && !parts.Contains(part, StringComparer.OrdinalIgnoreCase))
                        parts.Add(part);
                }
                return string.Join(", ", parts);
            }
            return MetadataEntryToText(value);
        }

        private static string MetadataEntryToText(object value)
        {
            if (value == null) return string.Empty;
            if (value is string text) return text.Trim();
            var name = ReadMetadataProperty(value, "Name") ?? ReadMetadataProperty(value, "DisplayName");
            if (name is string nameText && !string.IsNullOrWhiteSpace(nameText)) return nameText.Trim();
            if (value is IFormattable formattable)
                return formattable.ToString(null, CultureInfo.InvariantCulture)?.Trim() ?? string.Empty;
            return value.ToString()?.Trim() ?? string.Empty;
        }

        private static long ReadMetadataLong(object source, params string[] propertyNames)
        {
            foreach (var propertyName in propertyNames)
            {
                var value = ReadMetadataProperty(source, propertyName);
                if (value == null) continue;
                if (value is IEnumerable sequence && value is not string)
                {
                    foreach (var entry in sequence)
                    {
                        var number = TryMetadataLong(entry);
                        if (number > 0) return number;
                    }
                }
                else
                {
                    var number = TryMetadataLong(value);
                    if (number > 0) return number;
                }
            }
            return 0;
        }

        private static long TryMetadataLong(object value)
        {
            if (value == null) return 0;
            try
            {
                var number = Convert.ToInt64(value, CultureInfo.InvariantCulture);
                if (number > 0) return number;
            }
            catch { }
            foreach (var name in new[] { "InternalId", "Id" })
            {
                var nested = ReadMetadataProperty(value, name);
                if (nested == null || ReferenceEquals(nested, value)) continue;
                try
                {
                    var number = Convert.ToInt64(nested, CultureInfo.InvariantCulture);
                    if (number > 0) return number;
                }
                catch { }
            }
            return 0;
        }

        private static string ReadCommunityRating(object source)
        {
            var value = ReadMetadataProperty(source, "CommunityRating");
            if (value == null) return string.Empty;
            try
            {
                var rating = Convert.ToDouble(value, CultureInfo.InvariantCulture);
                return rating > 0 ? rating.ToString("0.0", CultureInfo.InvariantCulture) : string.Empty;
            }
            catch { return string.Empty; }
        }

        private static string FormatLastFmError(Exception exception)
        {
            var messages = new System.Collections.Generic.List<string>();
            for (var current = exception; current != null && messages.Count < 4; current = current.InnerException)
            {
                if (!string.IsNullOrWhiteSpace(current.Message)) messages.Add(current.Message.Trim());
            }
            var message = string.Join(" | ", messages);

            if (message.IndexOf("No Last.fm API key is saved", StringComparison.OrdinalIgnoreCase) >= 0 ||
                message.IndexOf("configure a Last.fm API key", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                return "No Last.fm API key is saved. Open Dashboard → Plugins → TopSongs, enter the key, and save settings.";
            }

            if (message.IndexOf("Last.fm API error 10:", StringComparison.OrdinalIgnoreCase) >= 0 ||
                message.IndexOf("Last.fm API error 10 :", StringComparison.OrdinalIgnoreCase) >= 0 ||
                message.IndexOf("invalid api key", StringComparison.OrdinalIgnoreCase) >= 0 ||
                message.IndexOf("invalid API Key", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                return "Last.fm rejected the API key (error 10). Re-enter the API key from your Last.fm API account in Dashboard → Plugins → TopSongs, save settings, and try again.";
            }

            if (message.IndexOf("Last.fm API error 26", StringComparison.OrdinalIgnoreCase) >= 0 ||
                message.IndexOf("suspended API key", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                return "Last.fm reports that this API key is suspended (error 26). Check your Last.fm API account.";
            }

            if (message.IndexOf("Last.fm API error 29", StringComparison.OrdinalIgnoreCase) >= 0 ||
                message.IndexOf("rate limit exceeded", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                return "Last.fm rate limit exceeded (error 29). Wait a while and try again.";
            }

            if (message.IndexOf("Last.fm API error 6", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                return "Last.fm could not find chart data for this artist (error 6). Check the artist name in Emby or try again later. Details: " + ClipDiagnostic(message, 180);
            }

            if (message.IndexOf("could not reach", StringComparison.OrdinalIgnoreCase) >= 0 ||
                message.IndexOf("name or service not known", StringComparison.OrdinalIgnoreCase) >= 0 ||
                message.IndexOf("no such host", StringComparison.OrdinalIgnoreCase) >= 0 ||
                message.IndexOf("temporary failure in name resolution", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                return "The Emby server could not reach Last.fm. Check server DNS and outbound HTTPS access. Details: " + ClipDiagnostic(message, 180);
            }

            if (message.IndexOf("timed out", StringComparison.OrdinalIgnoreCase) >= 0 ||
                message.IndexOf("timeout", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                return "The request to Last.fm timed out. Check the server's internet connection or firewall and try again.";
            }

            if (message.IndexOf("Last.fm API error", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                return "Last.fm returned an API error: " + ClipDiagnostic(message, 220);
            }

            // Include the failure type and useful inner-exception text. Never include the
            // request URL because it contains the API key in its query string.
            var typeName = exception == null ? "Unknown error" : exception.GetType().Name;
            if (string.IsNullOrWhiteSpace(message)) message = "No additional error information was provided.";
            return "Last.fm request failed (" + typeName + "): " + ClipDiagnostic(message, 220);
        }

        private static string ClipDiagnostic(string value, int maxLength)
        {
            if (string.IsNullOrWhiteSpace(value)) return "No details available.";
            // Remove anything resembling an API key query parameter if a nested exception ever
            // includes a URL. These diagnostics are returned to the authenticated Emby client.
            var safe = System.Text.RegularExpressions.Regex.Replace(
                value,
                "(?i)(api_key\\s*=\\s*)[^&\\s]+",
                "$1[redacted]");
            safe = System.Text.RegularExpressions.Regex.Replace(safe, "\\s+", " ").Trim();
            return safe.Length <= maxLength ? safe : safe.Substring(0, maxLength) + "…";
        }

        private static string NormalizeTitle(string value)
        {
            if (string.IsNullOrWhiteSpace(value)) return string.Empty;

            // Last.fm often lists a remaster label while Emby stores the base title.
            // Strip only explicit terminal remaster suffixes, not meaningful words like Live.
            var title = value.Trim();
            title = System.Text.RegularExpressions.Regex.Replace(
                title,
                @"\s*[\(\[][^\)\]]*\b(?:digital(?:ly)?\s+)?remaster(?:ed)?\b[^\)\]]*[\)\]]\s*$",
                string.Empty,
                System.Text.RegularExpressions.RegexOptions.IgnoreCase | System.Text.RegularExpressions.RegexOptions.CultureInvariant);
            title = System.Text.RegularExpressions.Regex.Replace(
                title,
                @"\s*[-–—:]\s*(?:(?:19|20)\d{2}\s+)?(?:digital(?:ly)?\s+)?remaster(?:ed)?(?:\s+(?:lp\s+)?(?:version|edition))?\s*$",
                string.Empty,
                System.Text.RegularExpressions.RegexOptions.IgnoreCase | System.Text.RegularExpressions.RegexOptions.CultureInvariant);

            var decomposed = title.Normalize(NormalizationForm.FormD);
            var builder = new StringBuilder(decomposed.Length);
            foreach (var c in decomposed)
            {
                var category = CharUnicodeInfo.GetUnicodeCategory(c);
                if (category == UnicodeCategory.NonSpacingMark || category == UnicodeCategory.SpacingCombiningMark || category == UnicodeCategory.EnclosingMark)
                    continue;
                if (char.IsLetterOrDigit(c)) builder.Append(char.ToLowerInvariant(c));
            }
            return builder.ToString();
        }
    }
}
