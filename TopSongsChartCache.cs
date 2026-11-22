using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace TopSongs
{
    /// <summary>Persistent cache of successfully matched artist charts. API keys are never stored.</summary>
    internal static class TopSongsChartCache
    {
        private sealed class Entry
        {
            public string Key { get; set; }
            public DateTime UpdatedUtc { get; set; }
            public DateTime LastAccessUtc { get; set; }
            public TopSongsChartResponse Value { get; set; }
        }

        private sealed class DiskState { public List<Entry> Entries { get; set; } = new List<Entry>(); }
        private static readonly object Gate = new object();
        private static readonly Dictionary<string, Entry> Entries = new Dictionary<string, Entry>(StringComparer.Ordinal);
        private static readonly Dictionary<string, Task<TopSongsChartResponse>> InFlight = new Dictionary<string, Task<TopSongsChartResponse>>(StringComparer.Ordinal);
        private static bool _loaded;
        private static string _loadedPath;
        private static int _appliedMaxArtists = -1;
        private static int _appliedDiskLimitMb = -1;
        private static int _appliedRefreshHours = -1;
        private static string _appliedEvictionPolicy;
        private static long _cacheHits, _cacheMisses, _refreshFailures;
        private static readonly JsonSerializerOptions JsonOptions = new JsonSerializerOptions { WriteIndented = false };

        /// <summary>Load and constrain the persistent cache during plugin startup. This performs no network work.</summary>
        public static void Initialize(int refreshHours, int maxArtists, int diskLimitMb, string evictionPolicy)
        {
            try
            {
                EnsureLoaded();
                ApplySettings(refreshHours, maxArtists, diskLimitMb, evictionPolicy);
            }
            catch (Exception ex)
            {
                // Persistent caching is optional. Never allow a cache startup failure to stop
                // the Emby plugin from registering or displaying its settings page.
                Console.Error.WriteLine("[TopSongs] Cache initialization failed; continuing without startup cache initialization: " + ex);
            }
        }

        private static void ApplySettings(int refreshHours, int maxArtists, int diskLimitMb, string evictionPolicy)
        {
            // Apply caps as soon as settings are known, including at plugin startup.
            lock (Gate)
            {
                var settingsChanged = _appliedMaxArtists != maxArtists ||
                    _appliedDiskLimitMb != diskLimitMb || _appliedRefreshHours != refreshHours ||
                    !string.Equals(_appliedEvictionPolicy, evictionPolicy, StringComparison.OrdinalIgnoreCase);
                var maxBytes = Math.Clamp(diskLimitMb, 1, 2048) * 1024L * 1024L;
                var cachePath = GetPath();
                var diskOverLimit = !string.IsNullOrWhiteSpace(cachePath) && File.Exists(cachePath) &&
                    new FileInfo(cachePath).Length > maxBytes;
                var entriesEvicted = Evict(maxArtists, evictionPolicy, refreshHours);
                if (settingsChanged || diskOverLimit || entriesEvicted)
                    Save(diskLimitMb, evictionPolicy, refreshHours);
                _appliedMaxArtists = maxArtists;
                _appliedDiskLimitMb = diskLimitMb;
                _appliedRefreshHours = refreshHours;
                _appliedEvictionPolicy = evictionPolicy;
            }
        }

        public static TopSongsCacheStats GetStats()
        {
            lock (Gate)
            {
                var path = GetPath();
                long bytes = 0;
                try { if (!string.IsNullOrWhiteSpace(path) && File.Exists(path)) bytes = new FileInfo(path).Length; } catch { }
                return new TopSongsCacheStats
                {
                    CachedArtistKeys = Entries.Keys.Select(k => k.Contains(":") ? k.Substring(0, k.LastIndexOf(":")) : k).Distinct(StringComparer.Ordinal).Count(),
                    CachedCharts = Entries.Count,
                    CachedSongs = Entries.Values.Sum(e => e.Value?.Items?.Length ?? 0),
                    DiskBytes = bytes,
                    InFlightRefreshes = InFlight.Count,
                    CacheLoaded = _loaded,
                    CacheHits = _cacheHits,
                    CacheMisses = _cacheMisses,
                    RefreshFailures = _refreshFailures
                };
            }
        }

        public static async Task<TopSongsChartResponse> GetAsync(string key, int refreshHours, int maxArtists, int diskLimitMb,
            string evictionPolicy, bool showStale, bool refreshStale, bool forceRefresh, Func<Task<TopSongsChartResponse>> factory)
        {
            try
            {
                EnsureLoaded();
                ApplySettings(refreshHours, maxArtists, diskLimitMb, evictionPolicy);
            }
            catch (Exception ex)
            {
                // Cache file/path/settings problems should degrade to the uncached request path.
                Console.Error.WriteLine("[TopSongs] Cache unavailable; serving this request without cache: " + ex);
                return await factory().ConfigureAwait(false);
            }
            Entry cached;
            bool fresh = false;
            lock (Gate)
            {
                if (Entries.TryGetValue(key, out cached))
                {
                    cached.LastAccessUtc = DateTime.UtcNow;
                    fresh = DateTime.UtcNow - cached.UpdatedUtc < TimeSpan.FromHours(Math.Clamp(refreshHours, 1, 720));
                }
            }
            if (cached != null && fresh && !forceRefresh) { lock (Gate) _cacheHits++; return Clone(cached.Value); }
            if (cached != null && !fresh && !refreshStale && !forceRefresh) { lock (Gate) _cacheHits++; return Clone(cached.Value); }
            lock (Gate) _cacheMisses++;

            Task<TopSongsChartResponse> refreshTask;
            TaskCompletionSource<TopSongsChartResponse> refreshStarter = null;
            lock (Gate)
            {
                if (!InFlight.TryGetValue(key, out refreshTask))
                {
                    // Publish a shared task before any refresh work can run. A factory may
                    // complete synchronously (for example, when LastFmClient is already warm);
                    // calling the async refresh method before storing its task could otherwise
                    // let its finally block run first and leave a completed task stuck in InFlight.
                    refreshStarter = new TaskCompletionSource<TopSongsChartResponse>(TaskCreationOptions.RunContinuationsAsynchronously);
                    refreshTask = refreshStarter.Task;
                    InFlight[key] = refreshTask;
                }
            }

            if (refreshStarter != null)
            {
                // Start outside Gate so synchronous work in the factory cannot hold the cache lock.
                _ = RunRefreshAndCompleteAsync(key, refreshHours, maxArtists, diskLimitMb,
                    evictionPolicy, factory, refreshStarter);
            }

            // Stale-while-refresh: immediately return the old chart; the shared task refreshes it in background.
            if (cached != null && showStale)
            {
                // A background refresh may fail even though this request has already returned stale data.
                // Observe that exception to avoid an unobserved-task warning; awaited callers still see it.
                _ = refreshTask.ContinueWith(task => { _ = task.Exception; }, CancellationToken.None,
                    TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
                return Clone(cached.Value);
            }

            return await refreshTask.ConfigureAwait(false);
        }

        private static async Task RunRefreshAndCompleteAsync(string key, int refreshHours, int maxArtists, int diskLimitMb,
            string evictionPolicy, Func<Task<TopSongsChartResponse>> factory,
            TaskCompletionSource<TopSongsChartResponse> completion)
        {
            try
            {
                var value = await RefreshAndStoreAsync(key, refreshHours, maxArtists, diskLimitMb, evictionPolicy, factory).ConfigureAwait(false);
                completion.TrySetResult(value);
            }
            catch (Exception ex)
            {
                lock (Gate) _refreshFailures++;
                completion.TrySetException(ex);
            }
            finally
            {
                lock (Gate)
                {
                    if (InFlight.TryGetValue(key, out var current) && ReferenceEquals(current, completion.Task))
                        InFlight.Remove(key);
                }
            }
        }

        private static async Task<TopSongsChartResponse> RefreshAndStoreAsync(string key, int refreshHours, int maxArtists, int diskLimitMb,
            string evictionPolicy, Func<Task<TopSongsChartResponse>> factory)
        {
            var value = await factory().ConfigureAwait(false);
            if (value == null || !string.IsNullOrWhiteSpace(value.Error) || value.Items == null)
            {
                lock (Gate) _refreshFailures++;
                return value;
            }
            lock (Gate)
            {
                var now = DateTime.UtcNow;
                Entries[key] = new Entry { Key = key, UpdatedUtc = now, LastAccessUtc = now, Value = Clone(value) };
                Evict(maxArtists, evictionPolicy, refreshHours);
                Save(diskLimitMb, evictionPolicy, refreshHours);
            }
            return value;
        }

        private static void EnsureLoaded()
        {
            var path = GetPath();
            lock (Gate)
            {
                if (_loaded && string.Equals(_loadedPath, path, StringComparison.OrdinalIgnoreCase)) return;
                Entries.Clear(); _loaded = true; _loadedPath = path;
                try
                {
                    if (!string.IsNullOrWhiteSpace(path) && File.Exists(path))
                    {
                        var state = JsonSerializer.Deserialize<DiskState>(File.ReadAllText(path), JsonOptions);
                        if (state?.Entries != null)
                            foreach (var entry in state.Entries.Where(e => e != null && !string.IsNullOrWhiteSpace(e.Key) && e.Value != null && e.Value.Items != null))
                                Entries[entry.Key] = entry;
                    }
                }
                catch (Exception ex) { Console.Error.WriteLine("[TopSongs] Cache load failed; continuing with an empty cache: " + ex.Message); }
            }
        }

        private static string GetPath()
        {
            var directory = Plugin.ConfigurationDirectory;
            if (string.IsNullOrWhiteSpace(directory)) return null;
            return Path.Combine(directory, "TopSongsCache.json");
        }

        private static bool Evict(int maxArtists, string policy, int refreshHours)
        {
            var max = Math.Clamp(maxArtists, 1, 100000);
            var originalCount = Entries.Count;
            var staleAfter = TimeSpan.FromHours(Math.Clamp(refreshHours, 1, 720));
            while (Entries.Count > max)
            {
                var now = DateTime.UtcNow;
                var expiredFirst = string.Equals(policy, "ExpiredFirst", StringComparison.OrdinalIgnoreCase);
                var oldest = Entries.Values.OrderBy(e => expiredFirst ? (now - e.UpdatedUtc < staleAfter ? 1 : 0) : 0)
                    .ThenBy(e => e.LastAccessUtc).FirstOrDefault();
                if (oldest == null) break;
                Entries.Remove(oldest.Key);
            }
            return Entries.Count != originalCount;
        }

        private static void Save(int diskLimitMb, string policy, int refreshHours)
        {
            var path = GetPath();
            if (string.IsNullOrWhiteSpace(path)) return;
            try
            {
                var dir = Path.GetDirectoryName(path);
                if (!string.IsNullOrWhiteSpace(dir)) Directory.CreateDirectory(dir);
                var state = new DiskState { Entries = Entries.Values.OrderByDescending(e => e.LastAccessUtc).ToList() };
                var json = JsonSerializer.Serialize(state, JsonOptions);
                var limit = Math.Clamp(diskLimitMb, 1, 2048) * 1024L * 1024L;
                // Trim least useful entries until the serialized cache fits the configured disk budget.
                var staleAfter = TimeSpan.FromHours(Math.Clamp(refreshHours, 1, 720));
                while (System.Text.Encoding.UTF8.GetByteCount(json) > limit && state.Entries.Count > 0)
                {
                    var victim = string.Equals(policy, "ExpiredFirst", StringComparison.OrdinalIgnoreCase)
                        ? state.Entries.OrderBy(e => DateTime.UtcNow - e.UpdatedUtc < staleAfter ? 1 : 0).ThenBy(e => e.LastAccessUtc).First()
                        : state.Entries.OrderBy(e => e.LastAccessUtc).First();
                    state.Entries.Remove(victim);
                    Entries.Remove(victim.Key);
                    json = JsonSerializer.Serialize(state, JsonOptions);
                }
                var temp = path + ".tmp";
                File.WriteAllText(temp, json);
                if (File.Exists(path))
                {
                    try { File.Replace(temp, path, null); }
                    catch (PlatformNotSupportedException) { File.Move(temp, path, true); }
                    catch (IOException) { File.Move(temp, path, true); }
                }
                else File.Move(temp, path);
            }
            catch (Exception ex) { Console.Error.WriteLine("[TopSongs] Cache save failed; results remain available in memory: " + ex.Message); }
        }

        private static TopSongsChartResponse Clone(TopSongsChartResponse value)
        {
            if (value == null) return null;
            return new TopSongsChartResponse
            {
                Error = value.Error, ArtistName = value.ArtistName, Items = value.Items?.Select(x => new TopSongsTrackDto
                {
                    Rank = x.Rank, Title = x.Title, Artist = x.Artist, ArtistId = x.ArtistId, Album = x.Album,
                    AlbumId = x.AlbumId, AlbumArtist = x.AlbumArtist, AlbumArtistId = x.AlbumArtistId,
                    CommunityRating = x.CommunityRating, Year = x.Year, RunTimeTicks = x.RunTimeTicks,
                    Genres = x.Genres, Matched = x.Matched, ItemId = x.ItemId
                }).ToArray() ?? Array.Empty<TopSongsTrackDto>(),
                LastFmTrackCount = value.LastFmTrackCount, DirectArtistTrackCount = value.DirectArtistTrackCount,
                AlbumArtistTrackCount = value.AlbumArtistTrackCount, ContributingArtistTrackCount = value.ContributingArtistTrackCount,
                UniqueLocalTrackCount = value.UniqueLocalTrackCount, UniqueNormalizedLocalTitleCount = value.UniqueNormalizedLocalTitleCount,
                DistinctMatchedLocalTrackCount = value.DistinctMatchedLocalTrackCount, ReturnedMatchCount = value.ReturnedMatchCount,
                CandidateInternalIdCount = value.CandidateInternalIdCount, ItemHydrationMissCount = value.ItemHydrationMissCount,
                ItemsWithBlankTitleCount = value.ItemsWithBlankTitleCount, ItemIdMode = value.ItemIdMode,
                LastFmFetchMs = value.LastFmFetchMs, LibraryPreparationMs = value.LibraryPreparationMs,
                MatchMs = value.MatchMs, ServerBuildMs = value.ServerBuildMs
            };
        }
    }
}
