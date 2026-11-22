using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Threading.Tasks;

namespace TopSongs
{
    public sealed class LastFmTrack
    {
        public string Title { get; set; }
    }

    /// <summary>Fetches public artist charts. Raw results have a six-hour lifetime and a bounded process-wide cache.</summary>
    public sealed class LastFmClient
    {
        private static readonly HttpClient Http = new HttpClient { Timeout = TimeSpan.FromSeconds(15) };
        private const int MaxCacheEntries = 512;
        private const int CachePruneEveryWrites = 32;
        private static readonly ConcurrentDictionary<string, CacheEntry> Cache =
            new ConcurrentDictionary<string, CacheEntry>(StringComparer.OrdinalIgnoreCase);
        private static readonly object CacheMaintenanceGate = new object();
        private static int _writesSincePrune;
        private readonly Func<string> _apiKey;

        public LastFmClient(Func<string> apiKey) { _apiKey = apiKey; }

        public async Task<LastFmTrack[]> GetArtistTopTracksAsync(string artist, int limit = 50)
        {
            if (string.IsNullOrWhiteSpace(artist)) return Array.Empty<LastFmTrack>();
            var key = (_apiKey() ?? string.Empty).Trim();
            if (key.Length == 0) throw new InvalidOperationException("No Last.fm API key is saved in TopSongs settings.");

            limit = Math.Max(1, Math.Min(limit, 50));
            var cacheKey = artist.Trim() + "|" + limit;
            if (Cache.TryGetValue(cacheKey, out var cached) && cached.ExpiresUtc > DateTime.UtcNow)
                return cached.Tracks;

            // Public artist.getTopTracks requires an API key, not a Last.fm user session or callback.
            var url = "https://ws.audioscrobbler.com/2.0/?method=artist.getTopTracks"
                + "&artist=" + Uri.EscapeDataString(artist.Trim())
                + "&api_key=" + Uri.EscapeDataString(key)
                + "&autocorrect=1&limit=" + limit.ToString(CultureInfo.InvariantCulture) + "&format=json";

            using (var response = await Http.GetAsync(url).ConfigureAwait(false))
            {
                var body = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
                JsonDocument document = null;
                if (!string.IsNullOrWhiteSpace(body))
                {
                    try
                    {
                        document = JsonDocument.Parse(body);
                    }
                    catch (JsonException)
                    {
                        var contentType = response.Content.Headers.ContentType?.MediaType ?? "unknown content type";
                        throw new InvalidOperationException(
                            "Last.fm returned a non-JSON response (HTTP " + (int)response.StatusCode +
                            ", " + response.ReasonPhrase + ", " + contentType + "). This can indicate an outbound proxy, filtering page, or temporary Last.fm error.");
                    }
                }

                using (document)
                {
                    if (document != null)
                    {
                        var root = document.RootElement;
                        if (root.ValueKind == JsonValueKind.Object && root.TryGetProperty("error", out var errorCode))
                        {
                            var message = root.TryGetProperty("message", out var errorMessage)
                                ? ReadJsonValue(errorMessage)
                                : "No message supplied by Last.fm";
                            throw new InvalidOperationException(
                                "Last.fm API error " + ReadJsonValue(errorCode) + ": " + message.Trim());
                        }

                        if (!response.IsSuccessStatusCode)
                        {
                            throw new InvalidOperationException(
                                "Last.fm returned HTTP " + (int)response.StatusCode + " (" + response.ReasonPhrase + ") without a readable API error message.");
                        }

                        if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("toptracks", out var topTracks) || topTracks.ValueKind != JsonValueKind.Object)
                        {
                            throw new InvalidOperationException(
                                "Last.fm responded successfully, but the JSON did not contain the expected 'toptracks' object. Check that the request reached ws.audioscrobbler.com and was not intercepted by a proxy.");
                        }

                        var tracks = new List<LastFmTrack>();
                        if (topTracks.TryGetProperty("track", out var items))
                        {
                            if (items.ValueKind == JsonValueKind.Array)
                            {
                                foreach (var item in items.EnumerateArray())
                                    tracks.Add(ParseTrack(item));
                            }
                            else if (items.ValueKind == JsonValueKind.Object)
                            {
                                tracks.Add(ParseTrack(items));
                            }
                        }

                        var result = tracks.ToArray();
                        StoreCachedTracks(cacheKey, result);
                        return result;
                    }
                }

                if (!response.IsSuccessStatusCode)
                {
                    throw new InvalidOperationException(
                        "Last.fm returned HTTP " + (int)response.StatusCode + " (" + response.ReasonPhrase + ") with an empty response body.");
                }

                throw new InvalidOperationException("Last.fm returned an empty response body.");
            }
        }


        private static void StoreCachedTracks(string key, LastFmTrack[] tracks)
        {
            lock (CacheMaintenanceGate)
            {
                Cache[key] = new CacheEntry { Tracks = tracks, ExpiresUtc = DateTime.UtcNow.AddHours(6) };
                _writesSincePrune++;
                if (_writesSincePrune < CachePruneEveryWrites && Cache.Count <= MaxCacheEntries)
                    return;

                var now = DateTime.UtcNow;
                foreach (var entry in Cache)
                {
                    if (entry.Value.ExpiresUtc <= now)
                        Cache.TryRemove(entry.Key, out _);
                }

                // Put a hard bound on this process-wide raw-chart cache. Expiring sooner
                // entries first is a simple approximation of LRU without tracking every read.
                while (Cache.Count > MaxCacheEntries)
                {
                    var oldest = Cache.OrderBy(entry => entry.Value.ExpiresUtc).FirstOrDefault();
                    if (oldest.Value == null) break;
                    Cache.TryRemove(oldest.Key, out _);
                }

                _writesSincePrune = 0;
            }
        }

        private static LastFmTrack ParseTrack(JsonElement item)
        {
            return new LastFmTrack
            {
                Title = item.ValueKind == JsonValueKind.Object && item.TryGetProperty("name", out var name)
                    ? ReadJsonValue(name).Trim()
                    : string.Empty
            };
        }

        private static string ReadJsonValue(JsonElement value)
        {
            if (value.ValueKind == JsonValueKind.String) return value.GetString() ?? string.Empty;
            if (value.ValueKind == JsonValueKind.Null || value.ValueKind == JsonValueKind.Undefined) return string.Empty;
            return value.ToString();
        }

        private sealed class CacheEntry
        {
            public LastFmTrack[] Tracks;
            public DateTime ExpiresUtc;
        }
    }
}
