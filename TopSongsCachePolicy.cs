namespace TopSongs
{
    /// <summary>Fixed internal cache policy; these values are deliberately not user settings.</summary>
    internal static class TopSongsCachePolicy
    {
        public const int RefreshHours = 24;
        public const int MaxArtists = 5000;
        public const int DiskLimitMb = 50;
        public const string EvictionPolicy = "LeastRecentlyUsed";
        public const bool ShowCachedDuringRefresh = true;
        public const bool RefreshStaleOnVisit = true;
    }
}
