using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace TopSongs
{
    /// <summary>Plain facts about the Top Songs block in Emby's index.html, shown by Run diagnostics.</summary>
    public sealed class TopSongsIndexBlockStatus
    {
        public bool Installed { get; set; }
        public string Status { get; set; }
        public string LastCheckedUtc { get; set; }
        public int Writes { get; set; }
    }

    /// <summary>
    /// Keeps one small, marked block in Emby Web's start page
    /// (&lt;Emby&gt;\system\dashboard-ui\index.html) that loads the Top Songs script.
    ///
    /// Shared rules (also followed by Radio Meta, which writes the same file):
    ///  1. On start, write only if the block is missing or different.
    ///  2. Do not remove it at normal shutdown; remove it only when Top Songs is
    ///     uninstalled from Emby's Plugins page (Plugin.OnUninstalling).
    ///  3. Every read-modify-write holds the shared system-wide mutex
    ///     Global\EmbyDashboardIndexWrite, waiting at most 10 seconds.
    ///  4. Re-read just before swapping the file in; start over if it changed.
    ///  5. Atomic write: temp file in the same folder, then move over the original;
    ///     keep the file's line endings; UTF-8 without BOM.
    ///  6. About 500 ms after writing, check the block is there; retry twice.
    ///  7. Only touch our own markers; leave the file alone if they are incomplete
    ///     or there is no &lt;/body&gt;.
    ///  8. No version number in the block, so plugin updates never rewrite it.
    /// All work runs in the background, so Emby's startup is never slowed.
    /// </summary>
    internal static class TopSongsIndexBlock
    {
        internal const string BeginMarker = "<!-- BEGIN TOPSONGS LOADER -->";
        internal const string EndMarker = "<!-- END TOPSONGS LOADER -->";
        // Loads the tiny always-fresh bootstrap, which loads the versioned loader.
        // If the DLL is deleted by hand, the request fails quietly (one console line, nothing visible).
        internal const string ScriptTag = "<script src=\"../emby/TopSongs/Bootstrap\" defer></script>";

        private const string SharedMutexName = @"Global\EmbyDashboardIndexWrite";
        private const int MutexTimeoutMs = 10000;
        private const string TempPrefix = ".topsongs-index-";

        private static readonly object StatusLock = new object();
        private static bool _installed;
        private static string _status = "not checked yet";
        private static DateTime? _lastChecked;
        private static int _writes;
        private static int _started;

        public static TopSongsIndexBlockStatus GetStatus()
        {
            lock (StatusLock)
            {
                return new TopSongsIndexBlockStatus
                {
                    Installed = _installed,
                    Status = _status,
                    LastCheckedUtc = _lastChecked?.ToString("o"),
                    Writes = _writes
                };
            }
        }

        internal static string IndexPath
        {
            get
            {
                var system = Plugin.ProgramSystemPath;
                return string.IsNullOrEmpty(system) ? null : Path.Combine(system, "dashboard-ui", "index.html");
            }
        }

        /// <summary>Called from the Plugin constructor. Returns immediately; never throws.</summary>
        public static void StartInBackground()
        {
            if (Interlocked.Exchange(ref _started, 1) == 1) return;
            Task.Run(async () =>
            {
                try
                {
                    // Rule 1 (+ rules 3-5, 7): add or replace only if needed.
                    // Nothing written (already present, or a problem already reported): done.
                    if (!EnsureInstalled()) return;

                    // Rule 6: confirm a moment later; another plugin may have written at the same time.
                    for (var attempt = 0; attempt < 3; attempt++)
                    {
                        await Task.Delay(500).ConfigureAwait(false);
                        if (IsBlockPresentInFile()) return;
                        EnsureInstalled();
                    }
                    if (!IsBlockPresentInFile())
                        SetStatus(false, "the block kept disappearing after writing; another program may be rewriting index.html");
                }
                catch (Exception ex)
                {
                    SetStatus(false, "check failed: " + ex.GetType().Name + ": " + ex.Message);
                }
            });
        }

        /// <summary>Rule 2: remove our block only when Top Songs is uninstalled.</summary>
        public static void RemoveForUninstall()
        {
            try
            {
                var path = IndexPath;
                if (path == null || !File.Exists(path)) return;
                WithSharedLock(() =>
                {
                    for (var round = 0; round < 3; round++)
                    {
                        var html = ReadFile(path);
                        var result = StripOurBlocks(html, out _, out var markerError);
                        if (markerError != null) { SetStatus(false, "not removed: " + markerError); return; }
                        if (string.Equals(result, html, StringComparison.Ordinal)) { SetStatus(false, "removed (nothing to remove)"); return; }
                        if (!string.Equals(ReadFile(path), html, StringComparison.Ordinal)) continue; // rule 4
                        WriteAtomically(path, result);
                        SetStatus(false, "removed because Top Songs was uninstalled");
                        Log("Top Songs removed its loader block from Emby's index.html (uninstall).");
                        return;
                    }
                });
            }
            catch (Exception ex)
            {
                Log("Top Songs could not remove its loader block during uninstall (" + ex.GetType().Name + "). " +
                    "It is harmless; to remove it by hand, delete the lines between the TOPSONGS LOADER markers in dashboard-ui\\index.html.");
            }
        }

        /// <summary>Returns true if the file was written.</summary>
        private static bool EnsureInstalled()
        {
            var path = IndexPath;
            if (path == null) { SetStatus(false, "Emby's system folder is unknown"); return false; }
            if (!File.Exists(path)) { SetStatus(false, "Emby's dashboard-ui\\index.html was not found"); return false; }

            var wrote = false;
            var acquired = WithSharedLock(() =>
            {
                for (var round = 0; round < 3; round++)
                {
                    var html = ReadFile(path);
                    var newline = html.Contains("\r\n", StringComparison.Ordinal) ? "\r\n" : "\n";
                    var block = BeginMarker + newline + ScriptTag + newline + EndMarker + newline;

                    var stripped = StripOurBlocks(html, out var firstStart, out var markerError);
                    if (markerError != null) { SetStatus(false, "left index.html alone: " + markerError); return; }

                    string desired;
                    if (firstStart >= 0)
                    {
                        desired = stripped.Insert(Math.Min(firstStart, stripped.Length), block);
                    }
                    else
                    {
                        var body = stripped.LastIndexOf("</body>", StringComparison.OrdinalIgnoreCase);
                        if (body < 0) { SetStatus(false, "left index.html alone: it has no </body> tag"); return; }
                        // Put the block on its own line(s) just before </body>.
                        var lineStart = stripped.LastIndexOf('\n', Math.Max(0, body - 1));
                        var onlySpaceBefore = lineStart >= 0 && stripped.Substring(lineStart + 1, body - lineStart - 1).Trim().Length == 0;
                        desired = onlySpaceBefore
                            ? stripped.Insert(lineStart + 1, block)
                            : stripped.Insert(body, block); // removal then restores the line exactly
                    }

                    if (string.Equals(desired, html, StringComparison.Ordinal))
                    {
                        SetStatus(true, "already present, file not changed");
                        return;
                    }
                    // Rule 4: if someone changed the file since we read it, start over from their version.
                    if (!string.Equals(ReadFile(path), html, StringComparison.Ordinal)) continue;

                    WriteAtomically(path, desired);
                    wrote = true;
                    lock (StatusLock) _writes++;
                    SetStatus(true, "added to the file");
                    Log("Top Songs added its loader block to Emby's dashboard-ui\\index.html.");
                    return;
                }
                SetStatus(false, "index.html kept changing while Top Songs tried to update it; will retry next start");
            });
            if (!acquired) SetStatus(false, "another plugin held the index.html lock for more than 10 seconds; skipped this start");
            return wrote;
        }

        private static bool IsBlockPresentInFile()
        {
            try
            {
                var path = IndexPath;
                if (path == null || !File.Exists(path)) return false;
                var html = ReadFile(path);
                var begin = html.IndexOf(BeginMarker, StringComparison.Ordinal);
                if (begin < 0) return false;
                var end = html.IndexOf(EndMarker, begin, StringComparison.Ordinal);
                return end > begin && html.IndexOf(ScriptTag, begin, end - begin, StringComparison.Ordinal) >= 0;
            }
            catch { return false; }
        }

        /// <summary>
        /// Rule 3. The whole read-modify-write runs synchronously on this thread, because a
        /// .NET named mutex must be released by the thread that acquired it.
        /// Returns false if the lock could not be taken within 10 seconds.
        /// </summary>
        private static bool WithSharedLock(Action work)
        {
            Mutex mutex = null;
            var owned = false;
            try
            {
                try { mutex = new Mutex(false, SharedMutexName); }
                catch (Exception ex)
                {
                    // Named mutexes unavailable on this system: fall back to the re-read check (rule 4).
                    Log("Top Songs could not open the shared index.html lock (" + ex.GetType().Name + "); continuing without it.");
                    work();
                    return true;
                }
                try { owned = mutex.WaitOne(MutexTimeoutMs); }
                catch (AbandonedMutexException) { owned = true; } // previous holder died: the lock is ours
                if (!owned) return false;
                work();
                return true;
            }
            finally
            {
                if (owned) { try { mutex.ReleaseMutex(); } catch { } }
                mutex?.Dispose();
            }
        }

        /// <summary>Removes every block of ours. Reports an error (and changes nothing) if a BEGIN has no END.</summary>
        private static string StripOurBlocks(string html, out int firstStart, out string markerError)
        {
            firstStart = -1;
            markerError = null;
            var result = html;
            while (true)
            {
                var begin = result.IndexOf(BeginMarker, StringComparison.Ordinal);
                if (begin < 0) break;
                var endIdx = result.IndexOf(EndMarker, begin, StringComparison.Ordinal);
                if (endIdx < 0) { markerError = "a TOPSONGS LOADER start marker has no matching end marker"; return html; }
                var start = result.LastIndexOf('\n', Math.Max(0, begin - 1));
                start = start < 0 ? 0 : start + 1;
                if (result.Substring(start, begin - start).Trim().Length != 0) start = begin; // marker not at line start
                var end = endIdx + EndMarker.Length;
                if (end < result.Length && result[end] == '\r') end++;
                if (end < result.Length && result[end] == '\n') end++;
                if (firstStart < 0) firstStart = start;
                result = result.Remove(start, end - start);
            }
            return result;
        }

        private static string ReadFile(string path)
        {
            // Retry briefly if Emby or another plugin has the file open at this instant.
            for (var attempt = 0; ; attempt++)
            {
                try { return File.ReadAllText(path, new UTF8Encoding(false)); }
                catch (IOException) when (attempt < 4) { Thread.Sleep(150); }
            }
        }

        private static void WriteAtomically(string path, string content)
        {
            var dir = Path.GetDirectoryName(path);
            var tmp = Path.Combine(dir, TempPrefix + Guid.NewGuid().ToString("N") + ".tmp");
            try
            {
                File.WriteAllText(tmp, content, new UTF8Encoding(false));
                for (var attempt = 0; ; attempt++)
                {
                    try { File.Move(tmp, path, overwrite: true); break; }
                    catch (IOException) when (attempt < 4) { Thread.Sleep(150); }
                    catch (UnauthorizedAccessException) when (attempt < 4) { Thread.Sleep(150); }
                }
            }
            finally
            {
                if (File.Exists(tmp)) { try { File.Delete(tmp); } catch { } }
            }
        }

        private static void SetStatus(bool installed, string status)
        {
            lock (StatusLock)
            {
                _installed = installed;
                _status = status;
                _lastChecked = DateTime.UtcNow;
            }
            if (!installed) Log("Top Songs loader block: " + status + ".");
        }

        private static void Log(string message)
        {
            try { Console.WriteLine("[TopSongs] " + message); } catch { }
        }
    }
}
