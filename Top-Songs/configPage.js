define(["emby-button", "emby-input"], function () {
  "use strict";
  return function (view) {
    var pluginId = '6c16e980-1e21-4a3a-a25d-b8cc43d4cb5f';
    var keyInput = view.querySelector('#lastFmApiKey');
    var cacheSongsPerArtistInput = view.querySelector('#cacheSongsPerArtist');
    var saveButton = view.querySelector('#save');
    var status = view.querySelector('#status');
    var testArtistInput = view.querySelector('#testArtist');
    var debugSummary = view.querySelector('#debugSummary');
    var debugResults = view.querySelector('#debugResults');
    var diagnosticChecks = view.querySelector('#diagnosticChecks');
    var debugOutput = view.querySelector('#debugOutput');
    var runDiagnosticsButton = view.querySelector('#runDiagnostics');
    var copyDiagnosticsButton = view.querySelector('#copyDiagnostics');
    var lastReport = '';

    function showStatus(message, good) {
      status.textContent = message || '';
      status.className = good ? 'good' : 'bad';
    }

    function safeReportText(value) {
      value = String(value == null ? '' : value);
      value = value.replace(/([?&](?:api_key|apikey|api-key|api[_-]?token|access_token|token|X-Emby-Token)=)[^&#\s]*/ig, '$1[redacted]');
      value = value.replace(/(api[_ -]?key\s*[:=]\s*)[^\s,;]+/ig, '$1[redacted]');
      value = value.replace(/(X-Emby-Token\s*[:=]\s*)[^\s,;]+/ig, '$1[redacted]');
      return value.replace(/\s+/g, ' ').trim().slice(0, 500);
    }

    function errorText(error) {
      if (!error) return 'Unknown error';
      var parts = [];
      if (error.status) parts.push('HTTP ' + error.status);
      if (error.statusText) parts.push(error.statusText);
      if (error.message) parts.push(error.message);
      return safeReportText(parts.join(' — ') || String(error)) || 'Unknown error';
    }

    function apiGet(path, params) {
      return ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl(path, params || {}), dataType: 'json' });
    }

    function readField(object, pascal, camel) {
      if (!object) return undefined;
      return object[pascal] !== undefined ? object[pascal] : object[camel];
    }

    function asList(value) { return Array.isArray(value) ? value : []; }

    function webUrl(relativePath) {
      var path = window.location.pathname || '/web/index.html';
      var base = path.slice(0, path.lastIndexOf('/') + 1);
      return new URL(relativePath, window.location.origin + base).toString();
    }

    // Older setups (WebLoader, hand edits) added a Top Songs line to Emby's item.js.
    // 1.2.x does not use it; report whether one is still there.
    async function probeOldItemJsLine() {
      try {
        var response = await fetch(webUrl('item/item.js?topsongs_diag=' + Date.now()), { credentials: 'same-origin', cache: 'no-store' });
        var body = await response.text();
        return {
          status: response.status,
          found: /TOPSONGS_WEBLOADER_POINTER_BEGIN|TOPSONGS_WEB_PATCH_BEGIN|TopSongs\/ItemPageLoader|TopSongs\/ArtistPageScript/.test(body)
        };
      } catch (error) { return { status: 'FETCH ERROR', found: null, error: errorText(error) }; }
    }

    async function probeBootstrapScript() {
      try {
        var url = ApiClient.getUrl('TopSongs/Bootstrap', { topsongs_diag: Date.now() });
        var response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
        var body = await response.text();
        return {
          status: response.status,
          contentType: response.headers.get('content-type') || '',
          loadsLoader: body.indexOf('ItemPageLoader?v=') >= 0
        };
      } catch (error) { return { status: 'FETCH ERROR', error: errorText(error) }; }
    }

    function hasTopSongsBlock(body) {
      return typeof body === 'string' && (body.indexOf('TopSongs/Bootstrap') >= 0 || body.indexOf('TopSongs/ItemPageLoader') >= 0);
    }

    // Two views of Emby's start page: what the server sends now (no-store), and the copy
    // this browser has saved (force-cache), which is what a normal refresh would reuse.
    async function probeIndexHtml() {
      var result = { status: 'FETCH ERROR', hasTag: false, savedHasTag: null };
      try {
        var response = await fetch(webUrl('index.html?topsongs_diag=' + Date.now()), { credentials: 'same-origin', cache: 'no-store' });
        result.status = response.status;
        result.hasTag = hasTopSongsBlock(await response.text());
      } catch (error) { result.error = errorText(error); }
      try {
        var pageUrl = String(window.location.href).split('#')[0];
        var saved = await fetch(pageUrl, { credentials: 'same-origin', cache: 'force-cache' });
        result.savedHasTag = hasTopSongsBlock(await saved.text());
      } catch (ignore) { }
      return result;
    }

    async function probeItemPageLoaderScript() {
      try {
        var url = ApiClient.getUrl('TopSongs/ItemPageLoader', { topsongs_diag: Date.now() });
        var response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
        var body = await response.text();
        return {
          status: response.status,
          contentType: response.headers.get('content-type') || '',
          contentLength: body.length,
          hasLoaderState: body.indexOf('__topSongsWebLoaderState') >= 0,
          hasImplementationStart: body.indexOf('implementationStarted') >= 0
        };
      } catch (error) { return { status: 'FETCH ERROR', error: errorText(error) }; }
    }

    async function probeArtistPageScript() {
      try {
        var url = ApiClient.getUrl('TopSongs/ArtistPageScript', { topsongs_diag: Date.now() });
        var response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
        var body = await response.text();
        return {
          status: response.status,
          contentType: response.headers.get('content-type') || '',
          contentLength: body.length,
          hasInitializer: body.indexOf('initializeTopSongsArtistPage') >= 0,
          hasSectionMarker: body.indexOf('topSongsArtistSection') >= 0
        };
      } catch (error) { return { status: 'FETCH ERROR', error: errorText(error) }; }
    }

    function makeCheck(statusValue, name, detail) {
      return { status: statusValue, name: safeReportText(name), detail: safeReportText(detail) };
    }

    function renderDiagnostics(checks, reportHeader, failureCount, warningCount) {
      var passCount = checks.filter(function (item) { return item.status === 'PASS'; }).length;
      var infoCount = checks.filter(function (item) { return item.status === 'INFO'; }).length;
      while (diagnosticChecks.firstChild) diagnosticChecks.removeChild(diagnosticChecks.firstChild);
      checks.forEach(function (item) {
        var row = document.createElement('div');
        row.className = 'diagnostic-check';
        var state = document.createElement('span');
        state.className = 'diagnostic-state ' + item.status.toLowerCase();
        state.textContent = item.status;
        var name = document.createElement('strong');
        name.textContent = item.name;
        var detail = document.createElement('span');
        detail.className = 'diagnostic-detail';
        detail.textContent = item.detail;
        row.appendChild(state);
        row.appendChild(name);
        row.appendChild(detail);
        diagnosticChecks.appendChild(row);
      });

      var reportLines = reportHeader.slice();
      reportLines.push('');
      reportLines.push('SUMMARY: ' + passCount + ' PASS, ' + warningCount + ' WARN, ' + failureCount + ' FAIL, ' + infoCount + ' INFO');
      reportLines.push('');
      checks.forEach(function (item) {
        reportLines.push('[' + item.status + '] ' + item.name + ': ' + item.detail);
      });
      reportLines.push('');
      reportLines.push('Privacy: API key values, authorization tokens, filesystem paths, and request query strings are not included.');
      reportLines.push('If Top Songs is still missing, share this report and the artist name—even if there are no FAIL items.');
      lastReport = reportLines.join('\n');
      debugOutput.textContent = lastReport;
      debugResults.hidden = false;
      copyDiagnosticsButton.hidden = false;
      copyDiagnosticsButton.disabled = !lastReport;
      debugSummary.textContent = failureCount
        ? 'Diagnostics completed: ' + failureCount + ' FAIL, ' + warningCount + ' WARN, ' + passCount + ' PASS, ' + infoCount + ' INFO. Start with the first FAIL.'
        : warningCount
          ? 'Diagnostics completed: ' + warningCount + ' WARN, ' + passCount + ' PASS, no FAIL items. Review the WARN items.'
          : infoCount
            ? 'Diagnostics completed: ' + passCount + ' checks passed; ' + infoCount + ' additional checks could not be verified.'
            : 'Diagnostics completed: all ' + passCount + ' checks passed.';
      debugSummary.className = failureCount ? 'bad' : warningCount ? '' : 'good';
    }

    async function runDiagnostics() {
      if (!debugSummary || !debugOutput || !runDiagnosticsButton || !diagnosticChecks) return;
      runDiagnosticsButton.disabled = true;
      copyDiagnosticsButton.disabled = true;
      debugResults.hidden = true;
      debugSummary.textContent = 'Running diagnostics…';
      debugSummary.className = '';

      var checks = [];
      var failureCount = 0;
      var warningCount = 0;
      var reportHeader = [
        'TOPSONGS DIAGNOSTIC REPORT',
        'Generated (UTC): ' + new Date().toISOString(),
        'Diagnostic runner: active',
        'Loaded settings page: confirmed',
        'Saved API key value: deliberately omitted.'
      ];
      function addCheck(state, name, detail) {
        checks.push(makeCheck(state, name, detail));
        if (state === 'FAIL') failureCount++;
        if (state === 'WARN') warningCount++;
      }
      function addPass(name, detail) { addCheck('PASS', name, detail); }
      function addFail(name, detail) { addCheck('FAIL', name, detail); }
      function addWarn(name, detail) { addCheck('WARN', name, detail); }
      function addInfo(name, detail) { addCheck('INFO', name, detail); }

      addPass('Settings page', 'The TopSongs settings controller is running.');

      try {
        var statusResult = await apiGet('TopSongs/Status');
        var available = readField(statusResult, 'Available', 'available') === true;
        var configured = readField(statusResult, 'Configured', 'configured') === true;
        var trackCount = readField(statusResult, 'TrackCount', 'trackCount');
        if (available) addPass('Plugin status endpoint', 'The /TopSongs/Status endpoint responded and reports the plugin as available.');
        else addFail('Plugin status endpoint', 'The endpoint responded but reports the plugin as unavailable.');
        if (configured) addPass('Last.fm API key setting', 'An API key is saved. Its value is not read into or included in the report.');
        else addFail('Last.fm API key setting', 'No API key is saved. Enter your Last.fm API key and select Save settings.');
        addInfo('Song-count setting', 'Configured to display ' + (trackCount || 'an unknown number of') + ' songs per artist.');
      } catch (error) {
        addFail('Plugin status endpoint', 'Could not read /TopSongs/Status: ' + errorText(error) + '. Verify the installed DLL and restart Emby if it was just replaced.');
      }

      var diag = null;
      try {
        diag = await apiGet('TopSongs/Diagnostics');
        var pluginName = readField(diag, 'PluginName', 'pluginName') || 'TopSongs';
        var pluginVersion = String(readField(diag, 'PluginVersion', 'pluginVersion') || 'unknown');
        var assemblyName = readField(diag, 'AssemblyName', 'assemblyName') || 'unknown';
        addPass('Plugin diagnostics endpoint', 'The /TopSongs/Diagnostics endpoint responded. Loaded plugin: ' + pluginName + ' ' + pluginVersion + ' (' + assemblyName + ').');
        var cacheStats = readField(diag, 'Cache', 'cache') || {};
        var metrics = readField(diag, 'RuntimeMetrics', 'runtimeMetrics') || {};
        reportHeader.push('');
        reportHeader.push('Runtime/cache metrics:');
        reportHeader.push('  Cached charts: ' + (readField(cacheStats, 'CachedCharts', 'cachedCharts') ?? 'unknown'));
        reportHeader.push('  Cached songs: ' + (readField(cacheStats, 'CachedSongs', 'cachedSongs') ?? 'unknown'));
        reportHeader.push('  Cache disk bytes: ' + (readField(cacheStats, 'DiskBytes', 'diskBytes') ?? 'unknown'));
        reportHeader.push('  Cache hits / misses / failed refreshes: ' + (readField(cacheStats, 'CacheHits', 'cacheHits') ?? '?') + ' / ' + (readField(cacheStats, 'CacheMisses', 'cacheMisses') ?? '?') + ' / ' + (readField(cacheStats, 'RefreshFailures', 'refreshFailures') ?? '?'));
        reportHeader.push('  In-flight refreshes: ' + (readField(cacheStats, 'InFlightRefreshes', 'inFlightRefreshes') ?? 'unknown'));
        reportHeader.push('  Chart requests / successes / failures: ' + (readField(metrics, 'ChartRequests', 'chartRequests') ?? '?') + ' / ' + (readField(metrics, 'ChartSuccesses', 'chartSuccesses') ?? '?') + ' / ' + (readField(metrics, 'ChartFailures', 'chartFailures') ?? '?'));
        reportHeader.push('  Last.fm failures: ' + (readField(metrics, 'LastFmFailures', 'lastFmFailures') ?? '?') + '; empty local matches: ' + (readField(metrics, 'EmptyLocalMatches', 'emptyLocalMatches') ?? '?'));
        var recentFailures = asList(readField(metrics, 'RecentFailures', 'recentFailures'));
        var browserFailures = [];
        try { browserFailures = JSON.parse(window.localStorage.getItem('topSongs.v11.clientFailures') || '[]'); if (!Array.isArray(browserFailures)) browserFailures = []; } catch (ignore) { browserFailures = []; }
        var artistMetrics = [];
        try { artistMetrics = JSON.parse(window.localStorage.getItem('topSongs.v11.artistMetrics') || '[]'); if (!Array.isArray(artistMetrics)) artistMetrics = []; } catch (ignore) { artistMetrics = []; }
        reportHeader.push('');
        reportHeader.push('Recent artist-page performance metrics (local to this browser; newest first):');
        if (artistMetrics.length) {
          artistMetrics.slice(-10).reverse().forEach(function (metric) {
            var label = safeReportText(metric.artist || metric.artistId || '(unknown artist)');
            var embyTiming = metric.embyItemsMs != null ? metric.embyItemsMs + 'ms' :
              (metric.embyLoadMs != null ? 'legacy combined ' + metric.embyLoadMs + 'ms' : '?');
            var nativeListAtStart = metric.nativeArtistRowsReadyAtChartStart == null ? 'legacy/unknown' :
              (metric.nativeArtistRowsReadyAtChartStart ? 'ready' : 'not-ready') +
              ' (section=' + (metric.nativeArtistSectionPresentAtChartStart == null ? '?' : (metric.nativeArtistSectionPresentAtChartStart ? 'yes' : 'no')) +
              ', rows=' + (metric.nativeArtistRowsAtChartStart == null ? '?' : metric.nativeArtistRowsAtChartStart) + ')';
            var timing = 'chart(last/total)=' + (metric.chartRequestMs == null ? '?' : metric.chartRequestMs + 'ms') +
              '/' + (metric.chartTotalRequestMs == null ? '?' : metric.chartTotalRequestMs + 'ms') +
              ', renderer-setup=' + (metric.rendererSetupMs == null ? '?' : metric.rendererSetupMs + 'ms') +
              ', renderer-to-chart-start=' + (metric.rendererToChartStartMs == null ? '?' : metric.rendererToChartStartMs + 'ms') +
              ', shell-to-chart-start=' + (metric.shellToChartStartMs == null ? '?' : metric.shellToChartStartMs + 'ms') +
              ', chart-response-to-Emby-start=' + (metric.chartResponseToEmbyStartMs == null ? '?' : metric.chartResponseToEmbyStartMs + 'ms') +
              ', server last-build Last.fm=' + (metric.serverLastFmMs == null ? '?' : metric.serverLastFmMs + 'ms') +
              ', server last-build library prep=' + (metric.serverLibraryPreparationMs == null ? '?' : metric.serverLibraryPreparationMs + 'ms') +
              ', server last-build matching=' + (metric.serverMatchMs == null ? '?' : metric.serverMatchMs + 'ms') +
              ', server last-build total=' + (metric.serverBuildMs == null ? '?' : metric.serverBuildMs + 'ms') +
              ', Emby items/module=' + embyTiming +
              ', list activation-to-first-row=' + (metric.listRenderMs == null ? '?' : metric.listRenderMs + 'ms') +
              ', chart-response-to-first-row=' + (metric.chartResponseToFirstRowMs == null ? '?' : metric.chartResponseToFirstRowMs + 'ms') +
              ', shell-to-first-row=' + (metric.shellToFirstRowMs == null ? '?' : metric.shellToFirstRowMs + 'ms') +
              ', load-policy=' + safeReportText(metric.loadPolicy || 'legacy/unknown') +
              ', native artist list at chart start=' + nativeListAtStart +
              ', matched=' + (metric.matchedTracks == null ? '?' : metric.matchedTracks) +
              ', attempts=' + (metric.chartAttempts == null ? '?' : metric.chartAttempts) +
              ', outcome=' + safeReportText(metric.outcome || 'unknown');
            reportHeader.push('  ' + safeReportText(metric.utc || '') + ' — ' + label + ': ' + timing);
            if (metric.failure) reportHeader.push('    Failure [' + safeReportText(metric.failureStage || 'unknown') + ']: ' + safeReportText(metric.failure));
          });
          addInfo('Artist-page performance metrics', artistMetrics.length + ' recent artist-page timing record(s) are stored locally. Phase timings include client and server build phases; server phase values describe the chart response and may reflect the last successful refresh when a cached chart is served. No telemetry is sent to the server.');
        } else addInfo('Artist-page performance metrics', 'No completed artist-page timing records are stored in this browser yet. Open an artist page, wait for Top Songs to finish, then run diagnostics again.');
        if (browserFailures.length) {
          reportHeader.push('  Recent browser-side failures (this browser only; newest first):');
          browserFailures.slice(-10).reverse().forEach(function (failure) {
            reportHeader.push('    ' + safeReportText(failure.utc || '') + ' [' + safeReportText(failure.stage || 'artist-page') + '] ' + safeReportText(failure.reason || 'unknown'));
          });
          addWarn('Recent browser-side failures', browserFailures.length + ' local failure record(s) are available in the full report. These are stored only in this browser and are not transmitted automatically.');
        } else addInfo('Recent browser-side failures', 'No browser-side failure records are stored in this browser.');

        var activity = null;
        try { activity = JSON.parse(window.localStorage.getItem('topSongs.v11.loaderActivity') || 'null'); } catch (ignore) { activity = null; }
        reportHeader.push('');
        reportHeader.push('Browser integration activity (local to this browser; newest snapshot):');
        if (activity && activity.updatedUtc) {
          reportHeader.push('  Snapshot updated: ' + safeReportText(activity.updatedUtc) + '; loader started=' + safeReportText(activity.startedUtc || 'unknown'));
          reportHeader.push('  Loader route polls / lifecycle events: ' + (activity.routePollTicks || 0) + ' / ' + (activity.lifecycleEvents || 0) + '; route-poll callback total/max=' + Math.round(activity.routePollDurationMsTotal || 0) + '/' + Math.round(activity.routePollDurationMsMax || 0) + 'ms');
          reportHeader.push('  Artist item API requests / shared item-info uses / cached item-info hits: ' + (activity.shellApiRequests || 0) + ' / ' + (activity.sharedItemInfoCalls || 0) + ' / ' + (activity.cachedItemInfoHits || 0));
          reportHeader.push('  Status requests / artist-script loads / shell sections created: ' + (activity.statusRequests || 0) + ' / ' + (activity.artistScriptLoads || 0) + ' / ' + (activity.shellSectionsCreated || 0));
          reportHeader.push('  Rebuilt sections recovered without a refresh: ' + (activity.shellAdoptions || 0));
          reportHeader.push('  Top Songs links placed / early clicks queued / fast-start checks: ' + (activity.inlineLinksPlaced || 0) + ' / ' + (activity.inlineClicksQueued || 0) + ' / ' + (activity.fastStartKicks || 0));
          reportHeader.push('  Artist pages opened instantly from this browser\'s memory: ' + (activity.rememberedArtistHits || 0));
          reportHeader.push('  Loader mutation callbacks / records / added nodes: ' + (activity.loaderMutationCallbacks || 0) + ' / ' + (activity.loaderMutationRecords || 0) + ' / ' + (activity.loaderMutationAddedNodes || 0) + '; callback total/max=' + Math.round(activity.loaderMutationDurationMsTotal || 0) + '/' + Math.round(activity.loaderMutationDurationMsMax || 0) + 'ms');
          reportHeader.push('  Artist section mutation callbacks / records / delayed probes: ' + (activity.artistSectionMutationCallbacks || 0) + ' / ' + (activity.artistSectionMutationRecords || 0) + ' / ' + (activity.artistSectionProbeRuns || 0));
          reportHeader.push('  Native row mutation callbacks / scroller repairs: ' + (activity.nativeRowsMutationCallbacks || 0) + ' / ' + (activity.nativeScrollerRepairs || 0));
          reportHeader.push('  Long tasks (50ms+ where supported): ' + (activity.longTaskCount || 0) + '; combined/max duration=' + Math.round(activity.longTaskDurationMsTotal || 0) + '/' + Math.round(activity.longTaskDurationMsMax || 0) + 'ms');
          addInfo('Browser integration activity', 'Local counters show polling, observer activity, item-info request reuse and supported long tasks. Stored only in this browser; no telemetry is sent.');
        } else {
          addInfo('Browser integration activity', 'No activity snapshot is available yet. Visit a few artist pages, then run diagnostics again.');
        }

        if (recentFailures.length) {
          reportHeader.push('  Recent server failures (newest first):');
          recentFailures.slice(0, 10).forEach(function (failure) {
            reportHeader.push('    ' + safeReportText(readField(failure, 'Utc', 'utc') || '') + ' [' + safeReportText(readField(failure, 'Stage', 'stage') || 'unknown') + '] ' + safeReportText(readField(failure, 'Artist', 'artist') || 'unknown') + ': ' + safeReportText(readField(failure, 'Reason', 'reason') || 'unknown'));
          });
          addWarn('Recent TopSongs failures', recentFailures.length + ' recent server-side failure/matching record(s) are available in the full report.');
        } else addPass('Recent TopSongs failures', 'No server-side chart failures or empty local matches have been recorded since this plugin process started.');
        if (pluginVersion.indexOf('1.2.1.0') === 0) addPass('Installed plugin version', 'The server reports release 1.2.1.0.');
        else addWarn('Installed plugin version', 'The server reports ' + pluginVersion + '; this package expects 1.2.1.0. Build this source, copy the new DLL, and restart Emby.')

        var resourceNames = asList(readField(diag, 'EmbeddedResources', 'embeddedResources'));
        var requiredResources = [
          ['Settings page HTML', 'TopSongs.Web.configPage.html'],
          ['Settings page controller', 'TopSongs.Web.configPage.js'],
          ['Artist-page display script', 'TopSongs.Web.TopSongsArtistPage.js']
        ];
        requiredResources.forEach(function (required) {
          if (resourceNames.indexOf(required[1]) >= 0) addPass('Embedded resource: ' + required[0], 'The expected resource is present in the loaded plugin assembly.');
          else addFail('Embedded resource: ' + required[0], 'Missing ' + required[1] + ' from the loaded DLL. Rebuild and replace the DLL with this release.');
        });

        var registeredPages = asList(readField(diag, 'RegisteredPages', 'registeredPages'));
        var pageConfigOk = registeredPages.some(function (page) {
          return readField(page, 'Name', 'name') === 'configPage' && readField(page, 'EmbeddedResourcePath', 'embeddedResourcePath') === 'TopSongs.Web.configPage.html';
        });
        var pageJsOk = registeredPages.some(function (page) {
          return readField(page, 'Name', 'name') === 'configPageJS' && readField(page, 'EmbeddedResourcePath', 'embeddedResourcePath') === 'TopSongs.Web.configPage.js';
        });
        if (pageConfigOk && pageJsOk) addPass('Settings page registration', 'Emby has both the TopSongs settings page and its JavaScript controller registered.');
        else addFail('Settings page registration', 'The registered settings page or controller does not match this release. Rebuild and replace the DLL.');
      } catch (error) {
        addFail('Plugin diagnostics endpoint', 'Could not read /TopSongs/Diagnostics: ' + errorText(error) + '. The installed DLL may be older or the endpoint may not be registered.');
      }

      var scriptCheck = await probeArtistPageScript();
      if (scriptCheck.status === 200 && scriptCheck.hasInitializer && scriptCheck.hasSectionMarker) {
        addPass('Artist-page script endpoint', 'HTTP 200; expected initializer and TopSongs section marker found (' + scriptCheck.contentLength + ' characters).');
      } else {
        addFail('Artist-page script endpoint', 'Expected HTTP 200 with initializer and section marker. Received HTTP ' + scriptCheck.status + '; initializer=' + Boolean(scriptCheck.hasInitializer) + '; section marker=' + Boolean(scriptCheck.hasSectionMarker) + (scriptCheck.error ? '; ' + scriptCheck.error : '') + '.');
      }
      if (scriptCheck.contentType && !/javascript|ecmascript/i.test(scriptCheck.contentType)) {
        addWarn('Artist-page script content type', 'The endpoint returned content type "' + scriptCheck.contentType + '"; JavaScript was expected.');
      }

      var bootstrapCheck = await probeBootstrapScript();
      if (bootstrapCheck.status === 200 && bootstrapCheck.loadsLoader) {
        addPass('Top Songs bootstrap', 'HTTP 200; loads the Top Songs loader.');
      } else {
        addFail('Top Songs bootstrap', 'Expected HTTP 200 from /TopSongs/Bootstrap. Received HTTP ' + bootstrapCheck.status + (bootstrapCheck.error ? '; ' + bootstrapCheck.error : '') + '. Rebuild and replace the plugin DLL, then restart Emby.');
      }

      var loaderCheck = await probeItemPageLoaderScript();
      if (loaderCheck.status === 200 && loaderCheck.hasLoaderState && loaderCheck.hasImplementationStart) {
        addPass('Top Songs loader', 'HTTP 200; loader markers found (' + loaderCheck.contentLength + ' characters).');
      } else {
        addFail('Top Songs loader', 'Expected HTTP 200 with loader markers. Received HTTP ' + loaderCheck.status + '; loader state=' + Boolean(loaderCheck.hasLoaderState) + '; implementation start=' + Boolean(loaderCheck.hasImplementationStart) + (loaderCheck.error ? '; ' + loaderCheck.error : '') + '. Rebuild and replace the plugin DLL, then restart Emby.');
      }
      if (loaderCheck.contentType && !/javascript|ecmascript/i.test(loaderCheck.contentType)) {
        addWarn('Top Songs loader content type', 'The endpoint returned content type "' + loaderCheck.contentType + '"; JavaScript was expected.');
      }

      // Top Songs keeps one small marked block in Emby's dashboard-ui\index.html that
      // loads its script. It is added when Emby starts (only if missing) and removed when
      // Top Songs is uninstalled from the Plugins page.
      var page = await probeIndexHtml();
      var blk = null;
      try { blk = readField(await apiGet('TopSongs/Diagnostics'), 'IndexBlock', 'indexBlock'); } catch (ignore) { }
      var blockInstalled = blk ? readField(blk, 'Installed', 'installed') === true : false;
      var blockStatus = blk ? String(readField(blk, 'Status', 'status') || '') : '';
      var running = window.__topSongsEmbeddedModuleBootstrapped === true;
      reportHeader.push('');
      reportHeader.push('Emby start page (index.html) block:');
      reportHeader.push('  Server status: ' + (blk ? (blockInstalled ? 'installed' : 'not installed') + ' – ' + safeReportText(blockStatus) : 'unknown (older plugin build?)'));
      reportHeader.push('  Page Emby sends now: HTTP ' + page.status + '; Top Songs block=' + Boolean(page.hasTag));
      reportHeader.push('  Copy saved in this browser: ' + (page.savedHasTag === null ? 'unknown' : 'Top Songs block=' + page.savedHasTag));
      reportHeader.push('  Loader running in this browser tab: ' + running);

      if (!blk) {
        addFail('Emby start page block', 'This DLL is an older build. Replace TopSongs.dll in the plugins folder and restart Emby.');
      } else if (!blockInstalled) {
        addFail('Emby start page block', 'Could not add the block to dashboard-ui\\index.html: ' + safeReportText(blockStatus) + '. Restart Emby to retry; if it persists, send this report.');
      } else if (!page.hasTag) {
        addFail('Emby start page block', 'The block is in the file, but Emby sends its start page without it (Emby may use a different web folder). Send this report.');
      } else {
        addPass('Emby start page block', 'Emby\'s start page includes the Top Songs block (' + safeReportText(blockStatus) + ').');
      }

      if (running) {
        addPass('Top Songs script running in this tab', 'Artist pages opened in this tab will show Top Songs.');
      } else if (page.hasTag) {
        addWarn('Top Songs script running in this tab', 'This browser is using a copy of Emby\'s page from before Top Songs was installed. Press Ctrl+F5 once (Cmd+Shift+R on a Mac).');
      } else {
        addFail('Top Songs script running in this tab', 'The Top Songs script is not running in this browser tab. Fix the item above first.');
      }

      var oldLine = await probeOldItemJsLine();
      if (oldLine.found === true) {
        addInfo('Old item.js line', 'Emby\'s item.js still has a Top Songs line from an older setup. It is harmless, and the next Emby update removes it. To remove it now: stop Emby, delete that line from dashboard-ui\\item\\item.js, and start Emby.');
      } else if (oldLine.found === false) {
        addPass('Old item.js line', 'No leftover Top Songs line in Emby\'s item.js.');
      }

      addInfo('What Top Songs changes in Emby', 'Only dashboard-ui\\index.html, between the TOPSONGS LOADER markers. Kept through restarts; removed when Top Songs is uninstalled from the Plugins page.');


      var testArtist = (testArtistInput && testArtistInput.value || '').trim();
      if (!testArtist) {
        addInfo('Artist chart and library-match test', 'Skipped: enter an artist name to check Last.fm results and local matches.');
      } else {
        reportHeader.push('Artist supplied for test: ' + safeReportText(testArtist).slice(0, 120));
        try {
          var artistResponse = await apiGet('TopSongs/Artists', { SearchTerm: testArtist, Limit: 10 });
          var artists = asList(readField(artistResponse, 'Items', 'items'));
          var chosen = null;
          for (var ai = 0; ai < artists.length; ai++) {
            var candidateName = String(readField(artists[ai], 'Name', 'name') || '');
            if (candidateName.toLocaleLowerCase() === testArtist.toLocaleLowerCase()) { chosen = artists[ai]; break; }
          }
          if (!chosen && artists.length) chosen = artists[0];
          if (!chosen) {
            addFail('Emby artist lookup', 'Emby returned no music-artist item matching "' + safeReportText(testArtist) + '". Check that the artist exists in the music library and try the exact library name.');
          } else {
            var embyArtistName = String(readField(chosen, 'Name', 'name') || testArtist);
            var embyArtistId = String(readField(chosen, 'Id', 'id') || '');
            addPass('Emby artist lookup', 'Matched the library artist "' + embyArtistName + '" (item ID ' + embyArtistId + ').');
            var chart = await apiGet('TopSongs/Chart', { ArtistId: embyArtistId });
            var chartError = String(readField(chart, 'Error', 'error') || '');
            var lastFmCount = Number(readField(chart, 'LastFmTrackCount', 'lastFmTrackCount'));
            var directCount = Number(readField(chart, 'DirectArtistTrackCount', 'directArtistTrackCount'));
            var albumArtistCount = Number(readField(chart, 'AlbumArtistTrackCount', 'albumArtistTrackCount'));
            var contributingCount = Number(readField(chart, 'ContributingArtistTrackCount', 'contributingArtistTrackCount'));
            var uniqueLocalCount = Number(readField(chart, 'UniqueLocalTrackCount', 'uniqueLocalTrackCount'));
            var normalizedCount = Number(readField(chart, 'UniqueNormalizedLocalTitleCount', 'uniqueNormalizedLocalTitleCount'));
            var matchedCount = Number(readField(chart, 'DistinctMatchedLocalTrackCount', 'distinctMatchedLocalTrackCount'));
            var returnedCountRaw = readField(chart, 'ReturnedMatchCount', 'returnedMatchCount');
            var returnedCount = returnedCountRaw === undefined || returnedCountRaw === null ? asList(readField(chart, 'Items', 'items')).length : Number(returnedCountRaw);
            reportHeader.push('');
            reportHeader.push('Artist chart/library details for: ' + safeReportText(embyArtistName));
            reportHeader.push('  Last.fm tracks returned: ' + (Number.isFinite(lastFmCount) ? lastFmCount : 'unknown'));
            reportHeader.push('  Direct artist tracks: ' + (Number.isFinite(directCount) ? directCount : 'unknown'));
            reportHeader.push('  Album-artist tracks: ' + (Number.isFinite(albumArtistCount) ? albumArtistCount : 'unknown'));
            reportHeader.push('  Contributing-artist tracks: ' + (Number.isFinite(contributingCount) ? contributingCount : 'unknown'));
            reportHeader.push('  Unique local tracks: ' + (Number.isFinite(uniqueLocalCount) ? uniqueLocalCount : 'unknown'));
            reportHeader.push('  Unique normalized local titles: ' + (Number.isFinite(normalizedCount) ? normalizedCount : 'unknown'));
            reportHeader.push('  Distinct matched local tracks: ' + (Number.isFinite(matchedCount) ? matchedCount : 'unknown'));
            reportHeader.push('  Rows returned for display: ' + (Number.isFinite(returnedCount) ? returnedCount : 'unknown'));
            reportHeader.push('  Item ID mode: ' + safeReportText(readField(chart, 'ItemIdMode', 'itemIdMode') || 'unknown'));

            if (chartError) {
              addFail('Last.fm chart retrieval', 'The chart endpoint returned an error: ' + safeReportText(chartError));
            } else if (Number.isFinite(lastFmCount) && lastFmCount > 0) {
              addPass('Last.fm chart retrieval', 'The request returned ' + lastFmCount + ' Last.fm track(s).');
            } else {
              addWarn('Last.fm chart retrieval', 'The request returned no Last.fm tracks for this artist. Check spelling and the Last.fm API response; the report never includes the API key.');
            }

            if (chartError) {
              addInfo('Local library matching', 'Not evaluated because the chart endpoint returned an error. Fix the Last.fm/API error above first.');
            } else if (Number.isFinite(uniqueLocalCount) && uniqueLocalCount === 0) {
              addWarn('Local library matching', 'No local tracks were found through the artist, album-artist, or contributing-artist relationships.');
            } else if (Number.isFinite(returnedCount) && returnedCount > 0) {
              addPass('Local library matching', returnedCount + ' matched track row(s) are available to show on the artist page.');
            } else {
              addWarn('Local library matching', 'Local tracks were queried but no TopSongs rows were returned. Compare Last.fm track count (' + (Number.isFinite(lastFmCount) ? lastFmCount : 'unknown') + '), unique local tracks (' + (Number.isFinite(uniqueLocalCount) ? uniqueLocalCount : 'unknown') + '), and matched tracks (' + (Number.isFinite(matchedCount) ? matchedCount : 'unknown') + ').');
            }
            addInfo('Library match counts', 'Direct artist=' + (Number.isFinite(directCount) ? directCount : '?') + ', album artist=' + (Number.isFinite(albumArtistCount) ? albumArtistCount : '?') + ', contributing artist=' + (Number.isFinite(contributingCount) ? contributingCount : '?') + ', unique local=' + (Number.isFinite(uniqueLocalCount) ? uniqueLocalCount : '?') + ', distinct matched=' + (Number.isFinite(matchedCount) ? matchedCount : '?') + ', display rows=' + (Number.isFinite(returnedCount) ? returnedCount : '?') + '.');
          }
        } catch (error) {
          addFail('Artist chart and library-match test', 'The artist search or chart request failed: ' + errorText(error));
        }
      }

      renderDiagnostics(checks, reportHeader, failureCount, warningCount);
      runDiagnosticsButton.disabled = false;
    }

    function fallbackCopy(text) {
      var area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', 'readonly');
      area.style.position = 'fixed';
      area.style.left = '-10000px';
      area.style.top = '0';
      document.body.appendChild(area);
      area.select();
      var copied = false;
      try { copied = document.execCommand('copy'); } catch (ignore) { copied = false; }
      document.body.removeChild(area);
      return copied;
    }

    async function copyReport() {
      if (!lastReport) return;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(lastReport);
        else if (!fallbackCopy(lastReport)) throw new Error('Clipboard access is unavailable.');
        debugSummary.textContent = 'Diagnostic report copied. Paste it into your support message.';
        debugSummary.className = 'good';
      } catch (error) {
        if (fallbackCopy(lastReport)) {
          debugSummary.textContent = 'Diagnostic report copied. Paste it into your support message.';
          debugSummary.className = 'good';
        } else {
          debugSummary.textContent = 'Copy was blocked. Open Full text report, select the text, and copy it manually.';
          debugSummary.className = 'bad';
          var fullReport = view.querySelector('#fullReport');
          if (fullReport) fullReport.open = true;
          debugOutput.focus();
        }
      }
    }

    function loadSettings() {
      if (!window.ApiClient) { showStatus('Open this page from the Emby Dashboard.', false); return; }
      ApiClient.getPluginConfiguration(pluginId).then(function (config) {
        config = config || {};
        keyInput.value = config.LastFmApiKey || '';
        cacheSongsPerArtistInput.value = Math.max(1, Math.min(50, Number(config.CacheSongsPerArtist) || 10));
        status.textContent = '';
        status.className = '';
      }).catch(function () { showStatus('Could not load settings. Check the Emby server log.', false); });
    }

    view.addEventListener('viewshow', loadSettings);
    loadSettings();
    saveButton.addEventListener('click', function () {
      var songsPerArtist = Number.parseInt(cacheSongsPerArtistInput.value, 10);
      if (!Number.isFinite(songsPerArtist) || songsPerArtist < 1 || songsPerArtist > 50) { showStatus('Songs per artist must be between 1 and 50.', false); return; }
      saveButton.disabled = true;
      showStatus('Saving…', true);
      ApiClient.getPluginConfiguration(pluginId).then(function (config) {
        config = config || {};
        // Persisted settings: API key and songs per artist. Do not recreate removed fields
        // (display Position / ShowSongTiles were removed in 1.2.1).
        config.LastFmApiKey = keyInput.value.trim();
        config.CacheSongsPerArtist = songsPerArtist;
        delete config.SectionPosition;
        delete config.ShowSongTiles;
        return ApiClient.updatePluginConfiguration(pluginId, config);
      }).then(function () { showStatus('Settings saved.', true); })
        .catch(function () { showStatus('Could not save settings. Check the Emby server log.', false); })
        .finally(function () { saveButton.disabled = false; });
    });
    runDiagnosticsButton.addEventListener('click', runDiagnostics);
    copyDiagnosticsButton.addEventListener('click', copyReport);
  };
});
