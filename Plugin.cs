using System;
using System.Collections.Generic;
using System.IO;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Drawing;
using MediaBrowser.Model.Serialization;

namespace TopSongs
{
    /// <summary>Emby plugin entry point, configuration owner, and page registrar.</summary>
    public sealed class Plugin : BasePlugin<PluginConfiguration>, IHasWebPages, IHasThumbImage
    {
        // This identifier must remain stable across releases once users install the plugin.
        private static readonly Guid PluginId = new Guid("6c16e980-1e21-4a3a-a25d-b8cc43d4cb5f");
        public const string BuildVersion = "1.2.1.0";

        public static string ConfigurationDirectory { get; private set; }

        /// <summary>Emby's system folder (contains dashboard-ui). Read-only use.</summary>
        public static string ProgramSystemPath { get; private set; }

        public static Plugin Instance { get; private set; }

        public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
            : base(applicationPaths, xmlSerializer)
        {
            // Register the plugin instance before touching the optional cache. A cache-path,
            // disk, permissions, or JSON problem must never prevent Emby from loading the plugin.
            Instance = this;

            try
            {
                ProgramSystemPath = applicationPaths?.ProgramSystemPath;
            }
            catch
            {
                ProgramSystemPath = null;
            }

            try
            {
                ConfigurationDirectory = applicationPaths?.PluginConfigurationsPath;
            }
            catch (Exception ex)
            {
                ConfigurationDirectory = null;
                Console.Error.WriteLine("[TopSongs] Could not resolve the plugin configuration path; persistent cache is disabled for this session: " + ex);
            }

            try
            {
                // Checks (in the background) that Emby Web's index.html has the small marked
                // Top Songs block, and adds it only if missing. See TopSongsIndexBlock.
                TopSongsIndexBlock.StartInBackground();
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("[TopSongs] index.html check could not start; Emby continues normally: " + ex);
            }

            try
            {
                // Ordinary chart caching uses one predictable internal policy; it is not user-configurable.
                TopSongsChartCache.Initialize(
                    TopSongsCachePolicy.RefreshHours,
                    TopSongsCachePolicy.MaxArtists,
                    TopSongsCachePolicy.DiskLimitMb,
                    TopSongsCachePolicy.EvictionPolicy);
            }
            catch (Exception ex)
            {
                // Cache initialization is best-effort; API calls can proceed without cache.
                Console.Error.WriteLine("[TopSongs] Cache initialization failed; plugin startup will continue: " + ex);
            }
        }

        public override Guid Id => PluginId;

        /// <summary>
        /// Emby calls this when Top Songs is uninstalled from the Plugins page, before it
        /// deletes the DLL. Only then is the Top Songs block removed from index.html
        /// (it is deliberately kept through normal restarts).
        /// </summary>
        public override void OnUninstalling()
        {
            try { TopSongsIndexBlock.RemoveForUninstall(); }
            catch (Exception ex) { Console.Error.WriteLine("[TopSongs] Could not remove the index.html block during uninstall: " + ex); }
            base.OnUninstalling();
        }

        public override string Name => "TopSongs";

        public override string Description =>
            "Shows an artist's Last.fm top songs matched to tracks in the Emby library.";

        // Emby uses this embedded 16:9 image in the installed Plugins list.
        public Stream GetThumbImage() =>
            GetType().Assembly.GetManifestResourceStream("TopSongs.Images.plugin.png");

        public ImageFormat ThumbImageFormat => ImageFormat.Png;

        public IEnumerable<PluginPageInfo> GetPages()
        {
            // The settings page remains a standard Emby plugin page. The artist-page script is
            // served by the authenticated /TopSongs/ArtistPageScript API route instead of
            // relying on the __plugin URL resolver, which returned 404 on the target server.
            yield return new PluginPageInfo
            {
                Name = "configPage",
                DisplayName = "TopSongs",
                EmbeddedResourcePath = "TopSongs.Web.configPage.html",
                IsMainConfigPage = true
            };

            // The settings controller remains a normal embedded plugin page.
            yield return new PluginPageInfo
            {
                Name = "configPageJS",
                EmbeddedResourcePath = "TopSongs.Web.configPage.js"
            };

            // TopSongsArtistPage.js remains embedded in the DLL but is delivered by the
            // authenticated /TopSongs/ArtistPageScript endpoint with application/javascript
            // content type, not through the failing /web/__plugin/... URL path.
        }
    }
}
