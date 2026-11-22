using MediaBrowser.Model.Plugins;

namespace TopSongs
{
    /// <summary>Persisted user settings for the Top Songs plugin.</summary>
    public sealed class PluginConfiguration : BasePluginConfiguration
    {
        public PluginConfiguration()
        {
            LastFmApiKey = string.Empty;
            CacheSongsPerArtist = 10;
        }

        /// <summary>Last.fm API key. Never returned by the Top Songs API.</summary>
        public string LastFmApiKey { get; set; }

        /// <summary>Number of matched local songs displayed for each artist.</summary>
        public int CacheSongsPerArtist { get; set; }
    }
}
