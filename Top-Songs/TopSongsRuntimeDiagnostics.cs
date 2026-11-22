using System;
using System.Collections.Generic;
using System.Linq;

namespace TopSongs
{
    public sealed class TopSongsCacheStats
    {
        public int CachedArtistKeys { get; set; }
        public int CachedCharts { get; set; }
        public int CachedSongs { get; set; }
        public long DiskBytes { get; set; }
        public int InFlightRefreshes { get; set; }
        public bool CacheLoaded { get; set; }
        public long CacheHits { get; set; }
        public long CacheMisses { get; set; }
        public long RefreshFailures { get; set; }
    }

    public sealed class TopSongsFailureRecord
    {
        public DateTime Utc { get; set; }
        public string Stage { get; set; }
        public string Artist { get; set; }
        public string Reason { get; set; }
    }

    internal static class TopSongsRuntimeDiagnostics
    {
        private static readonly object Gate = new object();
        private static readonly Queue<TopSongsFailureRecord> Failures = new Queue<TopSongsFailureRecord>();
        private static long _chartRequests, _chartSuccesses, _chartFailures, _lastFmFailures, _matchingEmpty;
        public static void RecordChart(TopSongsChartResponse result)
        {
            lock (Gate)
            {
                _chartRequests++;
                if (result == null || !string.IsNullOrWhiteSpace(result.Error))
                {
                    _chartFailures++;
                    var reason = result?.Error ?? "Chart response was empty.";
                    if (reason.IndexOf("Last.fm", StringComparison.OrdinalIgnoreCase) >= 0 || reason.IndexOf("API", StringComparison.OrdinalIgnoreCase) >= 0) _lastFmFailures++;
                    AddFailure("chart", result?.ArtistName, reason);
                }
                else
                {
                    _chartSuccesses++;
                    if (result.Items == null || result.Items.Length == 0)
                    {
                        _matchingEmpty++;
                        AddFailure("matching", result.ArtistName, "Last.fm chart returned, but no local Emby tracks matched.");
                    }
                }
            }
        }
        public static void RecordFailure(string stage, string artist, string reason)
        {
            lock (Gate) AddFailure(stage, artist, reason);
        }
        private static void AddFailure(string stage, string artist, string reason)
        {
            Failures.Enqueue(new TopSongsFailureRecord { Utc = DateTime.UtcNow, Stage = stage, Artist = Limit(artist, 120), Reason = Limit(reason, 300) });
            while (Failures.Count > 30) Failures.Dequeue();
        }
        private static string Limit(string value, int max) => string.IsNullOrWhiteSpace(value) ? "(unknown)" : value.Replace("\r", " ").Replace("\n", " ").Substring(0, Math.Min(value.Length, max));
        public static object Snapshot()
        {
            lock (Gate) return new { ChartRequests = _chartRequests, ChartSuccesses = _chartSuccesses, ChartFailures = _chartFailures, LastFmFailures = _lastFmFailures, EmptyLocalMatches = _matchingEmpty, RecentFailures = Failures.Reverse().ToArray() };
        }
    }
}
