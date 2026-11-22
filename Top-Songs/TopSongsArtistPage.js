/* Embedded in TopSongs.dll and served by GET /emby/TopSongs/ArtistPageScript.
   The artist preview uses Emby's native item renderer; the expanded Top Songs
   view navigates to Emby's native artist Songs route and supplies Last.fm-ranked
   Emby item DTOs through that page's native list data provider. */
(function initializeTopSongsArtistPage() {
  'use strict';
  if (window.__topSongsArtistPageInitialized) return;
  var getApiClient = window.__topSongsGetApiClient;
  var visible = window.__topSongsIsVisible;
  if (typeof getApiClient !== 'function' || typeof visible !== 'function') {
    console.error('[TopSongs] Required loader helpers are unavailable; the loader must initialize first.');
    return;
  }
  window.__topSongsArtistPageInitialized = true;

  var SECTION_CLASS = 'topSongsArtistSection';
  var currentItemId = '';
  var generation = 0;
  var activeSectionObserver = null;
  var activeSectionProbeTimer = 0;
  var startupFailureItemId = '';
  var startupFailureAt = 0;
  var lastStartupRecoveryAt = 0;
  var nativeListIntentSequence = 0;
  // Set when the native Top Songs list route returns to its originating artist.
  // A return navigation keeps the same artist ID, so the normal same-item guard
  // would otherwise skip initialization and leave the early shell stuck loading.
  var pendingNativeListReturnArtistId = '';

  function getCurrentItemId() {
    // Route parsing is owned by TopSongsItemPageLoader. If that contract is
    // missing, fail closed instead of maintaining a second route parser here.
    var getRouteItemId = window.__topSongsGetRouteItemId;
    return typeof getRouteItemId === 'function' ? (getRouteItemId() || '') : '';
  }

  function getVisibleItemView() {
    var views = Array.prototype.slice.call(document.querySelectorAll('.itemView'));
    for (var i = views.length - 1; i >= 0; i--) if (visible(views[i])) return views[i];
    // Emby has used several detail-page wrapper classes between web builds.
    // Fall back to the last visible item/detail page rather than depending on .itemView alone.
    var fallbacks = Array.prototype.slice.call(document.querySelectorAll(
      '.itemDetailPage, .detailPage, .view-item-item, [data-role="page"], main'
    ));
    for (var j = fallbacks.length - 1; j >= 0; j--) if (visible(fallbacks[j])) return fallbacks[j];
    return null;
  }

  function apiGet(path, params) {
    var api = getApiClient();
    return api.ajax({ type: 'GET', url: api.getUrl(path, params || {}), dataType: 'json' });
  }

  function recordLoaderActivity(name, amount) {
    var record = window.__topSongsRecordActivity;
    if (typeof record === 'function') record(name, amount);
  }

  function statusText(status, message) {
    var text = message || '';
    if (status) {
      status.textContent = text;
      if (status.classList) status.classList.toggle('hide', !text);
    }
  }

  // The loader owns heading binding and the initial native scroller shell.
  // Keep this module focused on chart data, native-list navigation and rendering.
  function ensureHeadingClickBinding(host) {
    var binder = window.__topSongsEnsureHeadingClickBinding;
    if (typeof binder !== 'function') {
      console.warn('[TopSongs] Shared heading binder is unavailable; the loader must initialize first.');
      return false;
    }
    binder(host);
    return true;
  }

  function createNativeSongRowsPlaceholder() {
    var factory = window.__topSongsCreateNativeSongRowsPlaceholder;
    if (typeof factory !== 'function') throw new Error('Top Songs loader row factory is unavailable.');
    return factory();
  }

  function createNativeSongContainer(host, items, listView, existingContainer) {
    // Reuse the exact EmbyItemsContainer created before the section was mounted.
    // Replacing it after EmbyScroller connects can leave the scroller and its
    // horizontal scroll controls pointing at an empty, detached slider.
    var layout = 'horizontal-grid';
    var container = existingContainer && existingContainer.getAttribute('is') === 'emby-itemscontainer'
      ? existingContainer
      : createNativeSongRowsPlaceholder();
    var prepareRows = window.__topSongsPrepareNativeSongRows;
    if (typeof prepareRows !== 'function') throw new Error('Top Songs loader row-preparation helper is unavailable.');
    container = prepareRows(host, container);
    if (!container) throw new Error('Top Songs loader could not prepare the native song rows.');
    container.fetchData = function (query, signal) {
      if (signal && signal.aborted) return Promise.reject(new Error('Top Songs list load was cancelled.'));
      query = query || {};
      var start = Math.max(0, Number(query.StartIndex) || 0);
      var limit = Number(query.Limit);
      if (!isFinite(limit) || limit <= 0) limit = items.length || 1;
      return Promise.resolve({ Items: items.slice(start, start + limit), TotalRecordCount: items.length });
    };
    container.getListOptions = function () {
      return {
        renderer: listView,
        options: {
          action: 'playallfromhere',
          verticalWrap: true,
          mediaInfo: false,
          enableSideMediaInfo: false,
          enableUserDataButtons: false,
          fields: ['Name', 'ParentName']
        },
        virtualScrollLayout: layout,
        commandOptions: { openArtist: false },
        indexOnStartItemId: true
      };
    };
    return container;
  }

  // The expanded Top Songs view uses Emby's native list route only.
  // No custom full-page overlay is created by this plugin.
  function getCurrentRouteContext() {
    // Emby 4.10 normally routes through the SPA, but the native list link can
    // also be represented as a real list/list.html pathname. Detect both forms
    // so the data override is cleaned up on Back and can be armed again on the
    // next click. Do not rely only on location.hash: it can retain the artist ID
    // while a path-based native list view is active.
    var pathname = window.location.pathname || '';
    if (/(?:^|\/)list\/list\.html$/i.test(pathname)) {
      return {
        path: 'list/list.html',
        params: new URLSearchParams(window.location.search || '')
      };
    }

    var fragment = (window.location.hash || '').replace(/^#/, '').replace(/^!/, '').replace(/^\/+/, '');
    var queryIndex = fragment.indexOf('?');
    var routePath = queryIndex >= 0 ? fragment.slice(0, queryIndex) : fragment;
    var query = queryIndex >= 0 ? fragment.slice(queryIndex + 1) : '';
    return {
      path: String(routePath || '').toLowerCase(),
      params: new URLSearchParams(query)
    };
  }

  function routeIsNativeArtistSongsList(intent) {
    if (!intent) return false;
    var route = getCurrentRouteContext();
    if (route.path.indexOf('list') !== 0) return false;
    var routeArtistId = route.params.get('artistId') || route.params.get('ArtistId') || route.params.get('artistid') || '';
    if (!routeArtistId) {
      route.params.forEach(function (value, key) {
        if (!routeArtistId && String(key).toLowerCase() === 'artistid') routeArtistId = value;
      });
    }
    return String(routeArtistId || '') === String(intent.artistId);
  }

  function isVisibleInTree(node) {
    if (!node || !node.isConnected) return false;
    var current = node;
    while (current && current !== document.documentElement) {
      var style = window.getComputedStyle(current);
      if (style.display === 'none' || style.visibility === 'hidden' || current.classList && current.classList.contains('hide')) return false;
      current = current.parentElement;
    }
    var rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function findNativeListPageRoot(container) {
    if (!container) return null;
    var root = container.closest('#listPage, .listPage, .view-list-list, [data-route="list"], [data-role="page"]');
    if (root && isVisibleInTree(root)) return root;
    var current = container.parentElement;
    var pageFallback = null;
    while (current && current !== document.body) {
      if (isVisibleInTree(current) && current.querySelector &&
          current.querySelector('.itemName-primary, .itemName-secondary')) return current;
      if (!pageFallback && current.classList && current.classList.contains('page') && isVisibleInTree(current)) pageFallback = current;
      current = current.parentElement;
    }
    return pageFallback || container.parentElement || document.body;
  }

  function findNativeListPageContainer(intent) {
    // During binding the native container is intentionally hidden to avoid
    // briefly showing the full Songs collection. Reuse that exact container
    // until it is actually replaced by Emby; visibility is not a reason to lose it.
    if (intent && intent.nativeContainer && intent.nativeContainer.isConnected &&
        (!intent.nativeRoot || isVisibleInTree(intent.nativeRoot))) {
      return intent.nativeContainer;
    }
    var rootCandidates = Array.prototype.slice.call(document.querySelectorAll('#listPage, .listPage, .view-list-list, [data-route="list"]'))
      .filter(isVisibleInTree);
    var root = rootCandidates.length ? rootCandidates[rootCandidates.length - 1] : null;
    var selector = 'div[is="emby-itemscontainer"], emby-itemscontainer';
    var candidates = Array.prototype.slice.call((root || document).querySelectorAll(selector)).filter(function (node) {
      if (!node.isConnected || node.closest('.topSongsArtistSection, .artistSongsSection')) return false;
      if (node.closest('.itemView, .itemDetailPage, .detailPage, .view-item-item')) return false;
      return isVisibleInTree(node);
    });
    if (!candidates.length && root) {
      candidates = Array.prototype.slice.call(document.querySelectorAll(selector)).filter(function (node) {
        return node.isConnected && !node.closest('.topSongsArtistSection, .artistSongsSection, .itemView, .itemDetailPage, .detailPage, .view-item-item') && isVisibleInTree(node);
      });
    }
    // Native list containers expose fetchData and list layout metadata. Prefer
    // those over unrelated Emby items containers if a page has more than one.
    candidates.sort(function (a, b) {
      function score(node) {
        var value = 0;
        if (typeof node.fetchData === 'function') value += 1000;
        if (node.hasAttribute('data-virtualscrolllayout') || node.hasAttribute('layout')) value += 100;
        if (node.parentContainer) value += 25;
        var rect = node.getBoundingClientRect();
        return value + Math.min(20, (node.clientWidth || rect.width) / 200);
      }
      return score(b) - score(a);
    });
    return candidates[0] || null;
  }

  function setNativeListHeading(intent, container) {
    var root = findNativeListPageRoot(container);
    if (!root) return;
    var changes = intent.titleChanges || (intent.titleChanges = []);
    function rememberAndSet(node, value) {
      if (!node) return;
      var entry = changes.find(function (candidate) { return candidate.node === node; });
      if (node.textContent === value) {
        if (entry) entry.assignedText = value;
        return;
      }
      if (!entry) {
        entry = { node: node, originalText: node.textContent, assignedText: value };
        changes.push(entry);
      } else {
        entry.assignedText = value;
      }
      node.textContent = value;
    }

    // Keep Emby's native title structure, but provide the known artist name in
    // the primary slot even if the list route only supplied a generic title.
    var primary = root.querySelector('.itemName-primary');
    if (primary && intent.artistName) {
      rememberAndSet(primary, intent.artistName);
    }

    var secondary = root.querySelector('.itemName-secondary');
    if (secondary) {
      rememberAndSet(secondary, 'Top Songs');
      return;
    }

    // Some Web layouts use a single page title instead of itemName-secondary.
    // Change only an exact Songs heading outside the actual song rows.
    var headings = Array.prototype.slice.call(root.querySelectorAll('h1, h2, h3, .pageTitle, .listTitle, .sectionTitleTextButton'));
    for (var i = 0; i < headings.length; i++) {
      if (container.contains(headings[i])) continue;
      var label = String(headings[i].textContent || '').replace(/\s+/g, ' ').trim();
      if (/^songs$/i.test(label)) {
        rememberAndSet(headings[i], 'Top Songs');
        return;
      }
    }
  }

  function normalizeNativeTrackText(value) {
    var text = String(value || '').toLowerCase();
    try { if (typeof text.normalize === 'function') text = text.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch (ignore) { }
    return text.replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function waitForOrderedNativeListRows(container, intent, timeoutMs) {
    var started = Date.now();
    var expectedItems = (intent.items || []).slice(0, Math.min(3, (intent.items || []).length));
    return new Promise(function (resolve) {
      function probe() {
        if (window.__topSongsNativeListIntent !== intent || !container.isConnected) {
          resolve(false);
          return;
        }
        var rows = Array.prototype.slice.call(container.children || []).filter(function (row) {
          return row && (row.classList.contains('virtualScrollItem') || row.classList.contains('listItem') ||
            row.querySelector && row.querySelector('.listItem-content, .listItem'));
        });
        var checks = expectedItems.map(function (item, index) {
          var expectedName = normalizeNativeTrackText(item && item.Name);
          var row = rows[index];
          var actualText = normalizeNativeTrackText(row && row.textContent);
          return {
            index: index,
            expected: String(item && item.Name || ''),
            actual: String(row && row.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 180),
            matches: !!(expectedName && actualText.indexOf(expectedName) >= 0)
          };
        });
        var providerIsInstalled = !!(intent.rankedFetchData && container.fetchData === intent.rankedFetchData);
        var providerCallsDuringRefresh = Number(intent.lastRefreshProviderCalls) || 0;
        var providerWasUsed = providerCallsDuringRefresh > 0;
        var orderedRowsMatch = expectedItems.length > 0 && checks.length === expectedItems.length &&
          rows.length >= expectedItems.length && checks.every(function (check) { return check.matches; });

        // A coincidence on the first song is not enough: verify the first three
        // visible native rows are the first three Last.fm-ranked library matches,
        // in order. Also require evidence that the native list actually requested
        // the replacement provider rather than keeping its original Songs data.
        intent.lastNativeListVerification = {
          providerIsInstalled: providerIsInstalled,
          providerWasUsed: providerWasUsed,
          providerFetchCalls: intent.providerFetchCalls || 0,
          providerCallsDuringRefresh: providerCallsDuringRefresh,
          rowChecks: checks
        };
        if (providerIsInstalled && providerWasUsed && orderedRowsMatch) {
          resolve(true);
          return;
        }
        if (Date.now() - started >= timeoutMs) {
          resolve(false);
          return;
        }
        window.setTimeout(probe, 150);
      }
      probe();
    });
  }

  function cleanupNativeListIntent(intent) {
    if (!intent) return;
    if (intent.observer) {
      try { intent.observer.disconnect(); } catch (ignore) { }
      intent.observer = null;
    }
    if (intent.timer) {
      window.clearTimeout(intent.timer);
      intent.timer = 0;
    }
    restoreNativeListContainer(intent);
    (intent.titleChanges || []).forEach(function (entry) {
      if (entry.node && entry.node.isConnected && entry.node.textContent === entry.assignedText) {
        entry.node.textContent = entry.originalText;
      }
    });
    if (window.__topSongsNativeListIntent === intent) window.__topSongsNativeListIntent = null;
  }

  function noteNativeListReturn(intent) {
    // Emby returns to the same #!/item?id=... route used before opening the list.
    // Preserve this signal outside the intent because its MutationObserver may
    // observe Back and clean the intent before processRoute's route timer runs.
    if (intent && intent.routeSeen && !routeIsNativeArtistSongsList(intent) &&
        String(getCurrentItemId() || '') === String(intent.artistId || '')) {
      pendingNativeListReturnArtistId = String(intent.artistId || '');
    }
  }

  function failNativeListIntent(intent, reason) {
    if (window.__topSongsNativeListIntent !== intent || intent.failed) return;
    intent.failed = true;
    console.warn('[TopSongs] Could not bind the ranked data to Emby\'s native Songs page. ' + reason, {
      artistId: intent.artistId,
      nativeRoute: getCurrentRouteContext(),
      providerFetchCalls: intent.providerFetchCalls || 0,
      expectedFirstTracks: (intent.items || []).slice(0, 3).map(function (item) { return item && item.Name || ''; }),
      lastNativeListVerification: intent.lastNativeListVerification || null
    });

    // Native page only: if Emby opened its Songs route but the ranked data
    // could not be bound, return to the originating artist page. Never create
    // a custom overlay as a fallback.
    if (routeIsNativeArtistSongsList(intent)) {
      if (intent.returnHash && intent.returnHash !== window.location.hash) {
        window.location.hash = intent.returnHash;
      } else if (window.history && typeof window.history.back === 'function') {
        window.history.back();
      } else {
        cleanupNativeListIntent(intent);
      }
      return;
    }
    cleanupNativeListIntent(intent);
  }

  function restoreNativeListContainer(intent) {
    var container = intent && intent.nativeContainer;
    if (!container) return;
    if (intent.originalFetchData && container.fetchData !== intent.originalFetchData) {
      container.fetchData = intent.originalFetchData;
    }
    if (container.style && intent.originalVisibility !== undefined) {
      container.style.visibility = intent.originalVisibility;
    }
    intent.nativeContainer = null;
    intent.nativeRoot = null;
    intent.originalFetchData = null;
    intent.originalVisibility = undefined;
    intent.bound = false;
    intent.binding = false;
    intent.bindingToken = (intent.bindingToken || 0) + 1;
  }

  // Resume the native component first, then reinstall the ranked provider before
  // explicitly refreshing it. Some native list/page initializers can reassign the
  // ordinary Songs fetchData provider during resume; installing only before resume
  // therefore does not guarantee that refreshItems reads the Top Songs data.
  function refreshNativeListProvider(container, intent) {
    var upgrade = typeof container.waitForCustomElementUpgrade === 'function'
      ? container.waitForCustomElementUpgrade()
      : Promise.resolve();
    function installRankedProvider() {
      if (intent && typeof intent.rankedFetchData === 'function') {
        container.fetchData = intent.rankedFetchData;
        if (container.dataset) container.dataset.topSongsNativeDataSource = String(intent.artistId || '');
      }
    }
    return Promise.resolve(upgrade).then(function () {
      var resumed;
      if (typeof container.resume === 'function') resumed = container.resume();
      return Promise.resolve(resumed);
    }).then(function () {
      // Some native page initializers reassign the normal Songs provider during
      // resume. Reapply the ranked source after resume, then measure whether the
      // explicit data refresh actually called it.
      installRankedProvider();
      var callsBeforeRefresh = intent ? (Number(intent.providerFetchCalls) || 0) : 0;
      var refreshResult;
      if (typeof container.refreshItems === 'function') {
        refreshResult = container.refreshItems();
      } else if (typeof container.resume === 'function') {
        refreshResult = container.resume({ refresh: true });
      } else {
        throw new Error('The native Emby list exposes neither refreshItems nor resume.');
      }
      return Promise.resolve(refreshResult).then(function (result) {
        if (intent) intent.lastRefreshProviderCalls = Math.max(0, (Number(intent.providerFetchCalls) || 0) - callsBeforeRefresh);
        // Leave the custom provider installed for subsequent native paging and
        // verify its use separately from the currently rendered row contents.
        installRankedProvider();
        return result;
      });
    });
  }

  function bindNativeListContainer(intent, container) {
    if (window.__topSongsNativeListIntent !== intent || intent.bound || intent.binding || !container) return;
    if (typeof container.fetchData !== 'function') return;
    intent.binding = true;
    intent.nativeContainer = container;
    intent.nativeRoot = findNativeListPageRoot(container);
    intent.originalFetchData = container.fetchData;
    intent.originalVisibility = container.style.visibility;
    var bindingToken = intent.bindingToken = (intent.bindingToken || 0) + 1;
    container.style.visibility = 'hidden';
    setNativeListHeading(intent, container);

    // Stop any in-flight request for the full Songs collection before swapping in
    // Top Songs. The native list's renderer, options, page shell and actions stay intact.
    try { if (typeof container.pause === 'function') container.pause(); } catch (ignore) { }
    var items = intent.items.slice();
    intent.providerFetchCalls = 0;
    intent.lastRefreshProviderCalls = 0;
    intent.lastNativeListVerification = null;
    intent.rankedFetchData = function (query, signal) {
      if (signal && signal.aborted) return Promise.reject(new Error('Top Songs list load was cancelled.'));
      intent.providerFetchCalls++;
      query = query || {};
      var startValue = query.StartIndex;
      if (startValue === undefined) startValue = query.startIndex;
      if (startValue === undefined) startValue = query.start;
      var start = Math.max(0, Number(startValue) || 0);
      var limitValue = query.Limit;
      if (limitValue === undefined) limitValue = query.limit;
      if (limitValue === undefined) limitValue = query.pageSize;
      var limit = Number(limitValue);
      if (!isFinite(limit) || limit <= 0) limit = items.length || 1;
      var page = items.slice(start, start + limit);
      intent.lastProviderItemIds = page.map(function (item) { return String(item && item.Id || ''); });
      console.debug('[TopSongs] Native list requested ranked Top Songs items.', {
        artistId: intent.artistId,
        start: start,
        limit: limit,
        total: items.length,
        firstItems: page.slice(0, 3).map(function (item) { return item && item.Name || ''; }),
        request: intent.providerFetchCalls
      });
      return Promise.resolve({ Items: page, TotalRecordCount: items.length });
    };
    container.fetchData = intent.rankedFetchData;
    container.dataset.topSongsNativeDataSource = String(intent.artistId);

    refreshNativeListProvider(container, intent).then(function () {
      return waitForOrderedNativeListRows(container, intent, 10000);
    }).then(function (rendered) {
      if (window.__topSongsNativeListIntent !== intent || intent.bindingToken !== bindingToken || intent.nativeContainer !== container) return;
      if (!rendered) {
        intent.bindAttempts = (intent.bindAttempts || 0) + 1;
        if (intent.bindAttempts < 3) {
          // Retain the binding lock during the short retry delay so the route
          // observer cannot start overlapping refreshes on this same container.
          intent.binding = true;
          window.setTimeout(function () {
            if (window.__topSongsNativeListIntent !== intent || intent.bindingToken !== bindingToken || intent.nativeContainer !== container) return;
            try { if (typeof container.pause === 'function') container.pause(); } catch (ignore) { }
            refreshNativeListProvider(container, intent).then(function () {
              return waitForOrderedNativeListRows(container, intent, 6000);
            }).then(function (retryRendered) {
              if (window.__topSongsNativeListIntent !== intent || intent.bindingToken !== bindingToken || intent.nativeContainer !== container) return;
              intent.binding = false;
              if (retryRendered) {
                intent.bound = true;
                container.style.visibility = intent.originalVisibility;
                if (intent.observer) { intent.observer.disconnect(); intent.observer = null; }
                console.info('[TopSongs] Top Songs is now using the native Emby list page.');
              } else {
                failNativeListIntent(intent, 'Emby did not render the first three ranked Top Songs items in order from the ranked provider. See the logged lastNativeListVerification for expected and actual row text and provider calls.');
              }
            }).catch(function (error) {
              if (window.__topSongsNativeListIntent !== intent || intent.bindingToken !== bindingToken || intent.nativeContainer !== container) return;
              intent.binding = false;
              failNativeListIntent(intent, error && error.message || 'Native list refresh failed.');
            });
          }, 700);
        } else {
          intent.binding = false;
          failNativeListIntent(intent, 'Emby did not render the first three ranked Top Songs items in order from the ranked provider. See the logged lastNativeListVerification for expected and actual row text and provider calls.');
        }
        return;
      }
      intent.binding = false;
      intent.bound = true;
      container.style.visibility = intent.originalVisibility;
      if (intent.observer) { intent.observer.disconnect(); intent.observer = null; }
      console.info('[TopSongs] Top Songs is now using the native Emby list page.');
    }).catch(function (error) {
      if (window.__topSongsNativeListIntent !== intent || intent.bindingToken !== bindingToken || intent.nativeContainer !== container) return;
      intent.binding = false;
      failNativeListIntent(intent, error && error.message || 'Native list refresh failed.');
    });
  }

  function probeNativeListIntent(intent) {
    if (window.__topSongsNativeListIntent !== intent) return;

    if (intent.failed) {
      if (intent.routeSeen && !routeIsNativeArtistSongsList(intent)) {
        noteNativeListReturn(intent);
        cleanupNativeListIntent(intent);
      }
      return;
    }

    if (!routeIsNativeArtistSongsList(intent)) {
      if (intent.routeSeen || Date.now() - intent.createdAt > 15000) {
        // Back to the same artist must trigger a fresh chart/list population run.
        // Record it before clearing the intent; the watcher's observer may get
        // this event before the central route handler does.
        noteNativeListReturn(intent);
        // The user navigated away or the native route never appeared. Clear
        // our intent and restore any temporarily replaced provider; do not
        // substitute a plugin-created page.
        cleanupNativeListIntent(intent);
      }
      return;
    }

    intent.routeSeen = true;
    if (intent.nativeContainer && (!intent.nativeContainer.isConnected ||
        (intent.nativeRoot && !isVisibleInTree(intent.nativeRoot)))) {
      // Emby can replace the native route page while retaining an old page node
      // in its SPA stack. Restore that old container so the active page can bind.
      restoreNativeListContainer(intent);
    }
    var container = findNativeListPageContainer(intent);
    if (container) {
      if (intent.nativeContainer && intent.nativeContainer !== container) {
        restoreNativeListContainer(intent);
      }
      if (!intent.bound) bindNativeListContainer(intent, container);
      else setNativeListHeading(intent, container);
    } else if (Date.now() - intent.createdAt > 15000) {
      failNativeListIntent(intent, 'No native Emby list container appeared for the artist route.');
    }
  }

  function startNativeListIntentWatch(intent) {
    if (intent.observer || intent.timer) return;
    if (typeof MutationObserver === 'function') {
      intent.observer = new MutationObserver(function () { probeNativeListIntent(intent); });
      intent.observer.observe(document.documentElement || document.body, { childList: true, subtree: true });
    }
    function poll() {
      if (window.__topSongsNativeListIntent !== intent) {
        if (intent.timer) { window.clearTimeout(intent.timer); intent.timer = 0; }
        return;
      }
      probeNativeListIntent(intent);
      if (window.__topSongsNativeListIntent === intent) {
        // After binding, poll less frequently to detect Back/navigation and a
        // native page DOM replacement without continuously working at 250ms.
        intent.timer = window.setTimeout(poll, intent.bound ? 900 : 250);
      }
    }
    intent.timer = window.setTimeout(poll, 0);
  }

  function nativeListRouteUrl(host) {
    var titleLink = host && host.querySelector('a[is="emby-sectiontitle"].sectionTitleTextButton');
    var href = titleLink && titleLink.getAttribute('href');
    if (href && href !== '#' && !/^javascript:/i.test(href)) return Promise.resolve(href);
    var api = getApiClient();
    var emby = window.Emby || (typeof Emby !== 'undefined' ? Emby : null);
    if (!api || !emby || typeof emby.importModule !== 'function') return Promise.reject(new Error('Emby native list route is unavailable.'));
    return emby.importModule('./modules/approuter.js').then(function (module) {
      var router = module && (module.default || module);
      if (!router || typeof router.getRouteUrl !== 'function') throw new Error('Emby AppRouter did not expose getRouteUrl.');
      return router.getRouteUrl('list', { serverId: api.serverId(), itemTypes: 'Audio', artistId: String(host.dataset.topSongsArtistId || '') });
    });
  }

  // Convert the native section-title href into Emby's in-app hash route when
  // the regular section-title click is prevented but does not complete navigation.
  // Native links expose /list/list.html?..., while the SPA keeps the current document
  // alive and represents that same route as #!/list/list.html?... . Preserving the SPA
  // matters because the ranked-item intent is held in this page until the native list
  // container is rebound to Last.fm order.
  function navigateNativeListRouteHref(intent, href) {
    var target = new URL(String(href), window.location.href);
    if (target.origin !== window.location.origin) {
      throw new Error('Native list route points to a different origin.');
    }

    if (target.hash) {
      if (target.hash !== window.location.hash) window.location.hash = target.hash;
      else probeNativeListIntent(intent);
      return;
    }

    if (/(?:^|\/)list\/list\.html$/i.test(target.pathname)) {
      var spaRouteHash = '#!/list/list.html' + (target.search || '');
      if (spaRouteHash !== window.location.hash) window.location.hash = spaRouteHash;
      else probeNativeListIntent(intent);
      return;
    }

    if (target.pathname === window.location.pathname && target.search) {
      window.location.search = target.search;
      return;
    }

    throw new Error('Native list route did not resolve to an Emby in-app list route: ' + target.pathname);
  }

  function openNativeTopSongsList(host, useNativeClickNavigation) {
    if (!host) return false;
    var artistId = String(host.dataset.topSongsArtistId || '');
    if (!artistId) return false;
    if (!host._topSongsOrderedItems || !host._topSongsListView) {
      host._topSongsPendingNavigation = true;
      return false;
    }
    var existing = window.__topSongsNativeListIntent;
    if (existing) {
      // A stale intent can survive if Emby's Back route used the pathname form
      // rather than an item hash. Record a return to the originating artist and
      // restore the native list's original provider before arming a new click.
      if (!routeIsNativeArtistSongsList(existing) && String(getCurrentItemId() || '') === String(existing.artistId || '')) {
        noteNativeListReturn(existing);
      }
      cleanupNativeListIntent(existing);
    }
    var intent = {
      id: ++nativeListIntentSequence,
      artistId: artistId,
      artistName: host._topSongsArtistName || '',
      returnHash: window.location.hash || '',
      items: host._topSongsOrderedItems.slice(),
      host: host,
      createdAt: Date.now(),
      routeSeen: false,
      bound: false,
      binding: false,
      bindAttempts: 0,
      failed: false,
      titleChanges: []
    };
    window.__topSongsNativeListIntent = intent;
    startNativeListIntentWatch(intent);

    // When this was initiated by the native section-title click, let Emby's own
    // section-title handler perform navigation. v1.0.36 proved this exact route
    // works; manually changing location.hash here swallowed the native click path
    // on some 4.10.1 pages. The intent is already armed so the list can be rebound
    // as soon as Emby creates its native list container.
    if (useNativeClickNavigation) {
      // Prefer the cloned native section-title action. Some Emby Web builds do
      // not delegate the click for dynamically cloned headings, so verify that
      // the native list route actually starts and fall back to AppRouter if it did not.
      var startingHash = window.location.hash || '';
      window.setTimeout(function () {
        if (window.__topSongsNativeListIntent !== intent || routeIsNativeArtistSongsList(intent) ||
            (window.location.hash || '') !== startingHash) return;
        nativeListRouteUrl(host).then(function (href) {
          if (window.__topSongsNativeListIntent !== intent || routeIsNativeArtistSongsList(intent)) return;
          navigateNativeListRouteHref(intent, href);
        }).catch(function (error) {
          if (window.__topSongsNativeListIntent === intent) {
            console.warn('[TopSongs] The native heading did not navigate; fallback route failed.', error);
            cleanupNativeListIntent(intent);
          }
        });
      }, 450);
      return true;
    }

    nativeListRouteUrl(host).then(function (href) {
      if (window.__topSongsNativeListIntent !== intent) return;
      navigateNativeListRouteHref(intent, href);
    }).catch(function (error) {
      if (window.__topSongsNativeListIntent !== intent) return;
      console.warn('[TopSongs] Could not open Emby\'s native artist Songs route for Top Songs.', error);
      cleanupNativeListIntent(intent);
    });
  }

  function activateNativeSongContainer(container) {
    if (!container) return Promise.resolve();
    if (typeof container.waitForCustomElementUpgrade === 'function') {
      return container.waitForCustomElementUpgrade().then(function () {
        if (typeof container.resume === 'function') return container.resume({ refresh: true });
        if (typeof container.refreshItems === 'function') return container.refreshItems();
      });
    }
    if (typeof container.resume === 'function') return Promise.resolve(container.resume({ refresh: true }));
    if (typeof container.refreshItems === 'function') return Promise.resolve(container.refreshItems());
    return Promise.resolve();
  }

  // Emby's list resume promise can resolve before the virtualized item rows have
  // actually been inserted. Wait for real child rows before declaring success.
  function waitForNativeSongRows(container, timeoutMs) {
    if (container && container.children && container.children.length) return Promise.resolve(true);
    return new Promise(function (resolve) {
      var finished = false;
      var observer = null;
      var timer = 0;
      function finish(rendered) {
        if (finished) return;
        finished = true;
        if (observer) observer.disconnect();
        if (timer) window.clearTimeout(timer);
        resolve(!!rendered);
      }
      if (typeof MutationObserver === 'function' && container) {
        observer = new MutationObserver(function (mutations) {
          recordLoaderActivity('nativeRowsMutationCallbacks');
          if (container.children && container.children.length) finish(true);
        });
        observer.observe(container, { childList: true });
      }
      timer = window.setTimeout(function () {
        finish(!!(container && container.children && container.children.length));
      }, timeoutMs || 2800);
    });
  }

  // Keep the same scroller and slider nodes for the lifetime of the section.
  // EmbyScroller stores an internal reference to .scrollSlider, and the native
  // horizontal arrow controls are attached when this complete structure connects.
  // Recovery therefore clears the existing slider instead of replacing it.
  function resetNativeSongScroller(host) {
    if (!host) return;
    var ensureScroller = window.__topSongsEnsureNativeSongScroller;
    if (typeof ensureScroller !== 'function') {
      console.warn('[TopSongs] Shared native-scroller repair is unavailable.');
      return;
    }
    // Delegate structural repair to the loader so Emby custom-element setup is
    // performed identically for initial mounting and later recovery.
    ensureScroller(host);
    var scroller = host._topSongsScroller || host.querySelector(':scope > .emby-scroller');
    var rows = host._topSongsRowsPlaceholder || host._topSongsRows ||
      (scroller && scroller.querySelector('.topSongsRows'));
    if (!scroller || scroller.getAttribute('is') !== 'emby-scroller' || scroller.parentNode !== host ||
        !rows || rows.getAttribute('is') !== 'emby-itemscontainer' || rows.parentNode !== scroller ||
        !rows.classList || !rows.classList.contains('scrollSlider')) {
      console.warn('[TopSongs] Native-scroller repair did not produce a valid Emby scroller/row pair.');
      return;
    }
    try { if (typeof rows.pause === 'function') rows.pause(); } catch (ignore) { }
    while (rows.firstChild) rows.removeChild(rows.firstChild);
    var prepareRows = window.__topSongsPrepareNativeSongRows;
    if (typeof prepareRows !== 'function' || !prepareRows(host, rows)) {
      console.warn('[TopSongs] Shared native-row preparation is unavailable; recovery remains pending.');
      return;
    }
    rows.style.removeProperty('min-width');
    rows.style.removeProperty('height');
    rows.fetchData = function () { return Promise.resolve({ Items: [], TotalRecordCount: 0 }); };
    host._topSongsScroller = scroller;
    host._topSongsRowsPlaceholder = rows;
    host._topSongsRows = null;
  }

  var MAX_CHART_LOAD_ATTEMPTS = 5;

  function isCurrentChartAttempt(host, artistId, token, attemptNumber) {
    return token === generation && currentItemId === artistId && host.isConnected &&
      host._topSongsActiveAttempt === attemptNumber;
  }

  function recordClientFailure(stage, message) {
    // Local-only, failure-path telemetry: no extra network request and no normal-success overhead.
    try {
      var key = 'topSongs.v11.clientFailures';
      var records = JSON.parse(window.localStorage.getItem(key) || '[]');
      if (!Array.isArray(records)) records = [];
      records.push({ utc: new Date().toISOString(), stage: String(stage || 'artist-page').slice(0, 80), reason: String(message || 'Unknown failure').replace(/\s+/g, ' ').slice(0, 300) });
      window.localStorage.setItem(key, JSON.stringify(records.slice(-30)));
    } catch (ignore) { }
  }

  // Performance telemetry is intentionally passive: timestamps are captured in memory,
  // and one small localStorage write is deferred until a chart succeeds or finally fails.
  // It adds no requests, observers, timers, or per-row work to the artist-page hot path.
  var PERF_METRICS_KEY = 'topSongs.v11.artistMetrics';
  function ensurePerformanceMetric(host, artistId) {
    if (!host || host._topSongsPerfMetric) return host && host._topSongsPerfMetric;
    var now = Date.now();
    var shellCreatedAt = Number(host.dataset && host.dataset.topSongsShellCreatedAt) || 0;
    host._topSongsPerfMetric = {
      utc: new Date().toISOString(), artistId: String(artistId || ''), artist: '',
      startedAt: now, shellCreatedAt: shellCreatedAt || null,
      rendererReadyAt: null, rendererSetupMs: null, chartStartAt: null,
      rendererToChartStartMs: null, shellToChartStartMs: null,
      nativeArtistSectionPresentAtChartStart: null, nativeArtistRowsAtChartStart: null,
      nativeArtistRowsReadyAtChartStart: null, chartResponseAt: null,
      chartResponseToEmbyStartMs: null, chartResponseToFirstRowMs: null, shellToFirstRowMs: null,
      chartAttempts: 0, chartRequestMs: null, chartTotalRequestMs: 0,
      serverLastFmMs: null, serverLibraryPreparationMs: null, serverMatchMs: null, serverBuildMs: null,
      matchedTracks: null, embyLoadMs: null, embyItemsMs: null, listRenderMs: null, firstRowMs: null, totalMs: null,
      loadPolicy: 'independent-chart-load', outcome: 'loading', failureStage: '', failure: ''
    };
    return host._topSongsPerfMetric;
  }
  function savePerformanceMetric(host, outcome, stage, reason) {
    var metric = host && host._topSongsPerfMetric;
    if (!metric || metric.saved) return;
    metric.outcome = outcome || metric.outcome || 'unknown';
    if (stage) metric.failureStage = String(stage).slice(0, 80);
    if (reason) metric.failure = String(reason).replace(/\s+/g, ' ').slice(0, 240);
    if (metric.startedAt) metric.totalMs = Date.now() - metric.startedAt;
    metric.saved = true;
    // Do not synchronously touch storage during rendering; persist after the current task.
    window.setTimeout(function () {
      try {
        var records = JSON.parse(window.localStorage.getItem(PERF_METRICS_KEY) || '[]');
        if (!Array.isArray(records)) records = [];
        records.push(metric);
        window.localStorage.setItem(PERF_METRICS_KEY, JSON.stringify(records.slice(-20)));
      } catch (ignore) { }
    }, 0);
  }

  function publishChartLoadError(host, message) {
    recordClientFailure('chart-display', message);
    savePerformanceMetric(host, 'failed', 'chart-display', message);
    host._topSongsLoadError = message;
    var status = host.querySelector('.topSongsStatus');
    statusText(status, message);
  }

  function retryChartLoad(host, artistId, token, attemptNumber, reason, finalMessage, maxAttempts) {
    if (token !== generation || currentItemId !== artistId || !host.isConnected ||
        host._topSongsActiveAttempt !== attemptNumber || host._topSongsRetryTimer) return;

    var limit = maxAttempts || MAX_CHART_LOAD_ATTEMPTS;
    if (attemptNumber + 1 >= limit) {
      var message = finalMessage || chartFailureMessage(null);
      publishChartLoadError(host, message);
      console.warn('[TopSongs] Chart/list initialization failed after ' + limit + ' attempts. ' + (reason || 'Unknown loading error.'));

      // A completed empty-library result is not a renderer failure. For other
      // transient request/list failures, perform at most two slow recovery cycles
      // while the same artist page remains active; a manual refresh should not be
      // required just because startup raced Emby's route/list initialization.
      var clearlyPermanent = /invalid api key|no last\.fm api key|configure a last\.fm api key|no matching songs were found in your emby library/i.test(message);
      // Link mode: an artist with no matching songs gets no "Top Songs >" link.
      if (/no matching songs/i.test(message)) {
        host.dataset.topSongsNoMatches = 'true';
        host._topSongsPendingNavigation = false;
        if (typeof window.__topSongsRememberArtist === 'function') window.__topSongsRememberArtist(artistId, false);
        if (typeof window.__topSongsEnsureInlineLink === 'function') window.__topSongsEnsureInlineLink();
      }
      var recoveryCycles = Number(host._topSongsRecoveryCycles) || 0;
      if (!clearlyPermanent && recoveryCycles < 2 && !host._topSongsRecoveryTimer) {
        host._topSongsRecoveryCycles = recoveryCycles + 1;
        host._topSongsRecoveryTimer = window.setTimeout(function () {
          host._topSongsRecoveryTimer = 0;
          if (token !== generation || currentItemId !== artistId || !host.isConnected) return;
          host._topSongsLoadError = '';
          statusText(host.querySelector('.topSongsStatus'), '');
          resetNativeSongScroller(host);
          console.warn('[TopSongs] Starting delayed recovery cycle ' + host._topSongsRecoveryCycles + ' for artist ' + artistId + '.');
          requestChart(host, artistId, token, 0);
        }, 12000);
      }
      return;
    }

    var delay = Math.min(700 * Math.pow(2, attemptNumber), 5000);
    host._topSongsLoadError = '';
    statusText(host.querySelector('.topSongsStatus'), '');
    console.warn('[TopSongs] Load attempt ' + (attemptNumber + 1) + ' failed; retrying in ' + delay + 'ms. ' + (reason || 'Transient loading failure.'));
    host._topSongsRetryTimer = window.setTimeout(function () {
      host._topSongsRetryTimer = 0;
      if (token !== generation || currentItemId !== artistId || !host.isConnected) return;
      resetNativeSongScroller(host);
      requestChart(host, artistId, token, attemptNumber + 1);
    }, delay);
  }

  function renderChart(host, chart, id, token, attemptNumber) {
    if (!isCurrentChartAttempt(host, id, token, attemptNumber)) return;
    var status = host.querySelector('.topSongsStatus');
    // The placeholder remains inside a detached EmbyScroller until the native
    // items container is ready. This lets EmbyScroller connect only after its
    // required .scrollSlider child exists, rather than initializing empty.
    var body = host._topSongsRowsPlaceholder || host.querySelector('.topSongsRows');
    if (!body) {
      retryChartLoad(host, id, token, attemptNumber, 'Top Songs list placeholder was missing.', 'Top Songs could not initialize its list container.');
      return;
    }

    // Last.fm supplies ordering only. Emby item objects and its native artist-song
    // list renderer provide artwork, row layout, playback actions and context menus.
    var tracks = chart && Array.isArray(chart.Items) ? chart.Items.filter(function (track) {
      return track && track.Matched && track.ItemId && typeof track.Title === 'string' && track.Title.trim();
    }) : [];
    var metric = ensurePerformanceMetric(host, id);
    if (metric) {
      metric.artist = String((chart && chart.ArtistName) || host._topSongsArtistName || '').slice(0, 120);
      metric.matchedTracks = tracks.length;
      metric.chartReceivedAt = Date.now();
    }
    if (!tracks.length) {
      // A single empty response during artist navigation can be transient; retry
      // briefly, but keep the empty-library result bounded and informative.
      retryChartLoad(host, id, token, attemptNumber,
        'The chart response contained no Emby-matched tracks.',
        'No matching songs were found in your Emby library.', 3);
      return;
    }

    var api = getApiClient();
    var emby = window.Emby || (typeof Emby !== 'undefined' ? Emby : null);
    if (!api || !emby || typeof emby.importModule !== 'function') {
      retryChartLoad(host, id, token, attemptNumber,
        'Emby API/listview module was not ready.',
        'Emby’s native song renderer is unavailable. Reload Emby Web and try again.');
      return;
    }
    var ids = tracks.map(function (track) { return String(track.ItemId); });
    if (metric) metric.embyLoadStartedAt = Date.now();
    Promise.all([
      apiGet('Items', { UserId: api.getCurrentUserId(), Ids: ids.join(','), Fields: 'PrimaryImageAspectRatio,ProductionYear,AlbumArtist,Artists,Genres,CommunityRating,RunTimeTicks,UserData', ImageTypeLimit: 1 }),
      emby.importModule('./modules/listview/listview.js')
    ]).then(function (results) {
      if (!isCurrentChartAttempt(host, id, token, attemptNumber)) return;
      if (metric && metric.embyLoadStartedAt) {
        metric.embyItemsMs = Date.now() - metric.embyLoadStartedAt;
        metric.chartResponseToEmbyStartMs = metric.chartResponseAt ? metric.embyLoadStartedAt - metric.chartResponseAt : null;
        // Keep the legacy field accurate for any older diagnostics reader.
        metric.embyLoadMs = metric.embyItemsMs;
      }
      var response = results[0] || {};
      var fetched = Array.isArray(response.Items) ? response.Items : (Array.isArray(response) ? response : []);
      var byId = Object.create(null);
      fetched.forEach(function (item) { if (item && item.Id) byId[String(item.Id)] = item; });
      var ordered = ids.map(function (itemId) { return byId[itemId]; }).filter(Boolean);
      if (!ordered.length) {
        retryChartLoad(host, id, token, attemptNumber,
          'Emby returned no items for the matched IDs.',
          'No matching songs were returned by Emby.');
        return;
      }
      var listViewModule = results[1];
      var listView = listViewModule && (listViewModule.default || listViewModule);
      if (!listView) throw new Error('Emby listview module did not expose a renderer.');
      host._topSongsOrderedItems = ordered;
      host._topSongsListView = listView;
      if (host.classList) host.classList.add('topSongsHasItems');
      delete host.dataset.topSongsNoMatches;
      if (typeof window.__topSongsRememberArtist === 'function') window.__topSongsRememberArtist(id, true);
      // Tiles turned off: put "Top Songs >" beside Emby's own "Songs >" heading.
      keepInlineTopSongsLink(host);
      host._topSongsArtistName = (chart && chart.ArtistName) || host._topSongsArtistName || '';
      host._topSongsLoadError = '';
      if (host._topSongsPendingNavigation) {
        host._topSongsPendingNavigation = false;
        var pendingNativeHeading = host.querySelector('a[is="emby-sectiontitle"].sectionTitleTextButton');
        if (pendingNativeHeading && typeof pendingNativeHeading.click === 'function') {
          // Replay through the same native link after the ranked data is ready;
          // this arms the provider substitution then lets Emby route normally.
          pendingNativeHeading.click();
        } else {
          openNativeTopSongsList(host);
        }
      }
      var scroller = host._topSongsScroller || host.querySelector(':scope > .emby-scroller');
      if (!scroller || body.parentNode !== scroller) {
        retryChartLoad(host, id, token, attemptNumber,
          'The prepared Emby scroller or placeholder was detached before rendering.',
          'Top Songs could not initialize its scroller.');
        return;
      }

      // Keep Emby's original EmbyItemsContainer node. It was placed inside the
      // scroller before the host was connected, allowing EmbyScroller and its
      // scrollbutton helper to retain the correct slider reference after data arrives.
      if (metric) metric.listRenderStartedAt = Date.now();
      var container = createNativeSongContainer(host, ordered, listView, body);
      if (container !== body) body.replaceWith(container);
      host._topSongsRowsPlaceholder = null;
      host._topSongsRows = container;
      if (scroller.parentNode !== host) host.appendChild(scroller);
      return activateNativeSongContainer(container).then(function () {
        return waitForNativeSongRows(container, 2800);
      }).then(function (rowsRendered) {
        if (!isCurrentChartAttempt(host, id, token, attemptNumber)) return;
        if (!rowsRendered) {
          retryChartLoad(host, id, token, attemptNumber,
            'Emby list activation resolved but inserted no child rows.',
            'Top Songs data loaded, but Emby did not render the song rows. Retrying automatically.');
          return;
        }
        if (metric) {
          var completedAt = Date.now();
          metric.firstRowAt = completedAt;
          metric.firstRowMs = completedAt - metric.startedAt;
          metric.shellToFirstRowMs = metric.shellCreatedAt ? completedAt - metric.shellCreatedAt : null;
          metric.chartResponseToFirstRowMs = metric.chartResponseAt ? completedAt - metric.chartResponseAt : null;
          metric.listRenderMs = metric.listRenderStartedAt ? completedAt - metric.listRenderStartedAt : null;
          metric.totalMs = completedAt - metric.startedAt;
          metric.outcome = 'success';
        }
        if (host._topSongsRetryTimer) {
          window.clearTimeout(host._topSongsRetryTimer);
          host._topSongsRetryTimer = 0;
        }
        host._topSongsLoadError = '';
        // Emby calculates horizontal scroll affordances from the connected
        // slider. Its width changes when the virtualized rows are rendered.
        // Nudge the native scroller/button observers without replacing elements.
        try {
          scroller.scrollLeft = 0;
          scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
          window.dispatchEvent(new Event('resize'));
          window.requestAnimationFrame(function () {
            if (!scroller.isConnected) return;
            scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
          });
        } catch (ignore) { }
        if (host._topSongsStaticPlaceholder && host._topSongsStaticPlaceholder.parentNode) {
          host._topSongsStaticPlaceholder.parentNode.removeChild(host._topSongsStaticPlaceholder);
          host._topSongsStaticPlaceholder = null;
        }
        statusText(status, '');
        savePerformanceMetric(host, 'success');
      });
    }).catch(function (error) {
      if (!isCurrentChartAttempt(host, id, token, attemptNumber)) return;
      var detail = error && (error.message || error.statusText) ? (error.message || error.statusText) : 'Emby list initialization failed.';
      retryChartLoad(host, id, token, attemptNumber,
        'Native song list initialization failed (' + detail + ').',
        'Emby’s native song list could not be loaded. Check the browser console and Emby Web version.');
    });
  }

  function readApiError(error) {
    if (!error) return '';
    var data = error.responseJSON || error.response || null;
    if (!data && typeof error.responseText === 'string' && error.responseText.length < 20000) {
      try { data = JSON.parse(error.responseText); } catch (ignore) { data = null; }
    }
    if (data && typeof data === 'object') {
      var responseStatus = data.ResponseStatus || data.responseStatus || {};
      var candidates = [data.Error, data.error, data.Message, data.message, data.ErrorMessage, data.errorMessage,
        responseStatus.Message, responseStatus.message];
      for (var i = 0; i < candidates.length; i++) {
        if (typeof candidates[i] === 'string' && candidates[i].trim()) return candidates[i].trim().slice(0, 220);
      }
    }
    return '';
  }

  function chartFailureMessage(error) {
    var status = Number(error && (error.status || error.statusCode || (error.response && error.response.status))) || 0;
    var detail = readApiError(error);
    if (/invalid api key|api key is invalid/i.test(detail)) return 'Last.fm rejected the API key. Re-enter it in Dashboard → Plugins → TopSongs and save settings.';
    if (/no last\.fm api key is saved|configure a last\.fm api key/i.test(detail)) return 'No Last.fm API key is saved. Open Dashboard → Plugins → TopSongs, enter the key, and save settings.';
    if (status === 404) return 'Emby could not find the TopSongs chart API (HTTP 404). Install the rebuilt TopSongs.dll and restart Emby.';
    if (status === 400) return 'Emby rejected the artist ID or chart request (HTTP 400). Confirm the updated TopSongs.dll is installed and Emby was restarted.';
    if (status === 401 || status === 403) return 'Emby denied the chart request (HTTP ' + status + '). Refresh Emby Web and sign in again.';
    if (detail) return 'Top Songs could not load: ' + detail;
    if (status >= 500) return 'The TopSongs server request failed (HTTP ' + status + '). Check the Emby server log.';
    if (status) return 'Top Songs request failed (HTTP ' + status + '). Check the Emby server log.';
    return 'Top Songs could not reach the TopSongs API. Refresh Emby Web and check the server log if it continues.';
  }

  function requestChart(host, artistId, token, attemptNumber) {
    attemptNumber = typeof attemptNumber === 'number' ? attemptNumber : 0;
    if (token !== generation || currentItemId !== artistId || !host.isConnected) return;
    host._topSongsActiveAttempt = attemptNumber;
    var metric = ensurePerformanceMetric(host, artistId);
    if (metric) {
      metric.chartAttempts++;
      metric.currentChartRequestAt = Date.now();
      if (!metric.firstChartRequestAt) {
        metric.firstChartRequestAt = metric.currentChartRequestAt;
        metric.chartStartAt = metric.currentChartRequestAt;
        metric.rendererToChartStartMs = metric.rendererReadyAt ? metric.chartStartAt - metric.rendererReadyAt : null;
        metric.shellToChartStartMs = metric.shellCreatedAt ? metric.chartStartAt - metric.shellCreatedAt : null;
      }
    }
    var status = host.querySelector('.topSongsStatus');
    statusText(status, '');
    apiGet('TopSongs/Chart', { ArtistId: artistId }).then(function (chart) {
      if (metric) {
        metric.chartResponseAt = Date.now();
        metric.serverLastFmMs = chart && (chart.LastFmFetchMs != null ? chart.LastFmFetchMs : chart.lastFmFetchMs);
        metric.serverLibraryPreparationMs = chart && (chart.LibraryPreparationMs != null ? chart.LibraryPreparationMs : chart.libraryPreparationMs);
        metric.serverMatchMs = chart && (chart.MatchMs != null ? chart.MatchMs : chart.matchMs);
        metric.serverBuildMs = chart && (chart.ServerBuildMs != null ? chart.ServerBuildMs : chart.serverBuildMs);
      }
      if (metric && metric.currentChartRequestAt) {
        var requestMs = Date.now() - metric.currentChartRequestAt;
        metric.chartRequestMs = requestMs;
        metric.chartTotalRequestMs += requestMs;
      }
      if (!isCurrentChartAttempt(host, artistId, token, attemptNumber)) return;
      if (chart && chart.Error) {
        var chartError = String(chart.Error).slice(0, 240);
        if (/invalid api key|no last\.fm api key is saved|configure a last\.fm api key/i.test(chartError)) {
          publishChartLoadError(host, chartError);
          return;
        }
        retryChartLoad(host, artistId, token, attemptNumber,
          'The chart endpoint returned an error (' + chartError + ').', chartError);
        return;
      }
      if (!chart || !Array.isArray(chart.Items)) {
        retryChartLoad(host, artistId, token, attemptNumber,
          'The chart endpoint returned an incomplete response.',
          'Top Songs received an incomplete chart response.');
        return;
      }
      renderChart(host, chart, artistId, token, attemptNumber);
    }).catch(function (error) {
      if (metric && metric.currentChartRequestAt) {
        var failedRequestMs = Date.now() - metric.currentChartRequestAt;
        metric.chartRequestMs = failedRequestMs;
        metric.chartTotalRequestMs += failedRequestMs;
      }
      if (!isCurrentChartAttempt(host, artistId, token, attemptNumber)) return;
      var message = chartFailureMessage(error);
      if (/invalid api key|no last\.fm api key is saved|configure a last\.fm api key/i.test(message)) {
        publishChartLoadError(host, message);
        return;
      }
      retryChartLoad(host, artistId, token, attemptNumber,
        'The chart request failed (' + message + ').', message);
    });
  }

  function findDetailsContent(root) {
    if (!root) return null;
    return root.querySelector('.details-additionalContent');
  }

  // Snapshot Emby's regular artist Songs list for diagnostics only. Top Songs owns
  // its chart data and its own Emby-native list renderer, so the unrelated artist
  // list is deliberately not a prerequisite for starting the chart request.
  function getNativeArtistListSnapshot() {
    var root = getVisibleItemView();
    var parent = root && findDetailsContent(root);
    var nativeSection = parent && Array.prototype.slice.call(parent.querySelectorAll('.artistSongsSection')).find(function (node) {
      return !node.classList.contains(SECTION_CLASS) && node.isConnected;
    });
    var nativeRows = nativeSection && nativeSection.querySelector('.artistSongsItemsContainer:not(.topSongsRows)');
    var rowCount = nativeRows && nativeRows.children ? nativeRows.children.length : 0;
    var firstRow = nativeRows && nativeRows.firstElementChild;
    var hasActualSongRow = !!(firstRow &&
      (firstRow.classList.contains('virtualScrollItem') ||
       firstRow.classList.contains('listItem') ||
       firstRow.querySelector('.listItem-content, .card, .virtualScrollItem')));
    var listReady = !!(nativeRows && nativeRows.isConnected &&
      nativeRows.getAttribute('is') === 'emby-itemscontainer' &&
      typeof nativeRows.resume === 'function' && typeof nativeRows.fetchData === 'function' &&
      rowCount > 0 && hasActualSongRow);
    return {
      sectionPresent: !!nativeSection,
      rowsPresent: !!nativeRows,
      rowCount: rowCount,
      ready: listReady
    };
  }

  // "Top Songs >" beside Emby's "Songs >" heading is owned by the loader
  // (window.__topSongsEnsureInlineLink) so it can appear before the songs load.
  function keepInlineTopSongsLink(host) {
    if (window.__topSongsShowTiles !== false || !host) return;
    if (typeof window.__topSongsEnsureInlineLink === 'function') window.__topSongsEnsureInlineLink();
  }

  function startChartLoad(host, artistId, token) {
    if (!host || host._topSongsChartRequested) return;
    host._topSongsChartRequested = true;
    if (host.classList) host.classList.remove('topSongsHasItems');
    var metric = ensurePerformanceMetric(host, artistId);
    var nativeSnapshot = getNativeArtistListSnapshot();
    if (metric) {
      metric.nativeArtistSectionPresentAtChartStart = nativeSnapshot.sectionPresent;
      metric.nativeArtistRowsAtChartStart = nativeSnapshot.rowCount;
      metric.nativeArtistRowsReadyAtChartStart = nativeSnapshot.ready;
    }
    // This log makes the intentional non-dependency visible in browser diagnostics
    // without delaying chart loading or running a second readiness polling loop.
    console.info('[TopSongs] Starting chart load independently of the regular artist Songs list.', {
      artistId: artistId,
      nativeArtistSectionPresent: nativeSnapshot.sectionPresent,
      nativeArtistRowsPresent: nativeSnapshot.rowsPresent,
      nativeArtistRowCount: nativeSnapshot.rowCount,
      nativeArtistRowsReady: nativeSnapshot.ready
    });
    requestChart(host, artistId, token, 0);
  }

  function buildSection(artistId, token) {
    var root = getVisibleItemView();
    if (!root) return false;
    var parent = findDetailsContent(root);
    if (!parent) return false;

    var existing = Array.prototype.slice.call(document.querySelectorAll('.' + SECTION_CLASS)).find(function (node) {
      return node.isConnected && node.dataset.topSongsArtistId === String(artistId) && parent.contains(node);
    });
    if (existing && existing.dataset.topSongsRendererReady === 'true') return true;

    // The loader is the sole owner of section markup, heading creation and the
    // initial native Emby scroller/rows pair. This module adopts that shell only.
    var host = existing;
    if (!host) {
      var ensureShell = window.__topSongsEnsureArtistShell;
      if (typeof ensureShell !== 'function') return false;
      host = ensureShell(artistId);
    }
    if (!host || !host.isConnected || !parent.contains(host)) return false;

    // The regular artist Songs list is not a prerequisite for this independent section.

    ensurePerformanceMetric(host, artistId);
    host._topSongsNavigate = function () {
      return openNativeTopSongsList(host, true);
    };
    ensureHeadingClickBinding(host);

    var status = host.querySelector('.topSongsStatus');
    if (!status) {
      console.warn('[TopSongs] Loader-created section is missing its status element; waiting for shell repair.');
      return false;
    }
    status.classList.add('padded-left', 'padded-left-page', 'padded-right');
    if (!status.getAttribute('role')) status.setAttribute('role', 'status');
    if (!status.getAttribute('aria-live')) status.setAttribute('aria-live', 'polite');

    var ensureScroller = window.__topSongsEnsureNativeSongScroller;
    if (typeof ensureScroller !== 'function') return false;
    ensureScroller(host);
    var scroller = host._topSongsScroller || host.querySelector(':scope > .emby-scroller');
    var rows = host._topSongsRowsPlaceholder || host._topSongsRows ||
      (scroller && scroller.querySelector('.topSongsRows'));
    if (!scroller || scroller.getAttribute('is') !== 'emby-scroller' || scroller.parentNode !== host ||
        !rows || rows.getAttribute('is') !== 'emby-itemscontainer' || rows.parentNode !== scroller ||
        !rows.classList || !rows.classList.contains('scrollSlider')) return false;

    host._topSongsScroller = scroller;
    host._topSongsRowsPlaceholder = rows;
    host._topSongsRows = null;
    host._topSongsStaticPlaceholder = host.querySelector('.topSongsShellPlaceholder');
    host.dataset.topSongsRendererReady = 'true';
    var performanceMetric = ensurePerformanceMetric(host, artistId);
    if (performanceMetric && !performanceMetric.rendererReadyAt) {
      performanceMetric.rendererReadyAt = Date.now();
      performanceMetric.rendererSetupMs = performanceMetric.rendererReadyAt - performanceMetric.startedAt;
    }

    // A click before artist-page initialization is queued by the loader shell.
    if (host._topSongsPendingNavigation) {
      host._topSongsPendingNavigation = false;
      openNativeTopSongsList(host);
    }

    if (host._topSongsStaticPlaceholder && host._topSongsStaticPlaceholder.parentNode) {
      host._topSongsStaticPlaceholder.textContent = '';
      if (host._topSongsStaticPlaceholder.classList) host._topSongsStaticPlaceholder.classList.add('hide');
    }
    statusText(status, '');
    startChartLoad(host, artistId, token);
    return true;
  }

  function watchForArtistSection(artistId, token) {
    if (activeSectionObserver) {
      activeSectionObserver.disconnect();
      activeSectionObserver = null;
    }
    if (activeSectionProbeTimer) {
      window.clearTimeout(activeSectionProbeTimer);
      activeSectionProbeTimer = 0;
    }
    var observer;

    function rendererInitializedInCurrentDetails() {
      var root = getVisibleItemView();
      var parent = root && findDetailsContent(root);
      if (!parent) return false;
      var section = Array.prototype.slice.call(parent.querySelectorAll('.' + SECTION_CLASS)).find(function (node) {
        return node.isConnected && node.dataset.topSongsArtistId === String(artistId);
      });
      return !!(section && section.dataset.topSongsRendererReady === 'true');
    }

    function stopIfInitialized() {
      if (!rendererInitializedInCurrentDetails()) return false;
      if (observer) observer.disconnect();
      if (activeSectionObserver === observer) activeSectionObserver = null;
      if (activeSectionProbeTimer) {
        window.clearTimeout(activeSectionProbeTimer);
        activeSectionProbeTimer = 0;
      }
      return true;
    }

    function attempt() {
      if (token !== generation || currentItemId !== artistId) {
        if (observer) observer.disconnect();
        if (activeSectionObserver === observer) activeSectionObserver = null;
        return;
      }
      // The loader-created shell is attached before this module's data/rendering
      // phase. Being attached is not completion; adopt it until native renderer
      // setup is initialized.
      if (stopIfInitialized()) return;
      buildSection(artistId, token);
      stopIfInitialized();
    }

    observer = new MutationObserver(function (mutations) {
      recordLoaderActivity('artistSectionMutationCallbacks');
      recordLoaderActivity('artistSectionMutationRecords', mutations ? mutations.length : 0);
      if (token !== generation || currentItemId !== artistId) {
        observer.disconnect();
        if (activeSectionObserver === observer) activeSectionObserver = null;
        return;
      }
      if (stopIfInitialized()) return;
      attempt();
    });
    activeSectionObserver = observer;
    observer.observe(document.body, { childList: true, subtree: true });
    attempt();

    // Probe until the renderer initializes, not merely until the early shell is attached.
    function scheduleSectionProbe() {
      if (activeSectionProbeTimer) window.clearTimeout(activeSectionProbeTimer);
      activeSectionProbeTimer = window.setTimeout(function () {
        activeSectionProbeTimer = 0;
        recordLoaderActivity('artistSectionProbeRuns');
        if (token !== generation || currentItemId !== artistId) return;
        if (stopIfInitialized()) return;
        attempt();
        if (!stopIfInitialized()) scheduleSectionProbe();
      }, 1400);
    }
    if (!stopIfInitialized()) scheduleSectionProbe();
  }

  function removeOldSections(keepArtistId) {
    if (activeSectionObserver) {
      activeSectionObserver.disconnect();
      activeSectionObserver = null;
    }
    if (activeSectionProbeTimer) {
      window.clearTimeout(activeSectionProbeTimer);
      activeSectionProbeTimer = 0;
    }
    document.querySelectorAll('.' + SECTION_CLASS).forEach(function (node) {
      // The loader creates the section shell before this embedded script initializes.
      // Preserve only the not-yet-initialized shell for the artist route we are
      // entering; discard stale rendered sections as before.
      if (keepArtistId && String(node.dataset.topSongsArtistId || '') === String(keepArtistId) &&
          node.dataset.topSongsShell === 'true' && node.dataset.topSongsRendererReady !== 'true') return;
      if (node._topSongsRetryTimer) {
        window.clearTimeout(node._topSongsRetryTimer);
        node._topSongsRetryTimer = 0;
      }
      if (node._topSongsRecoveryTimer) {
        window.clearTimeout(node._topSongsRecoveryTimer);
        node._topSongsRecoveryTimer = 0;
      }
      closeContextMenus(node);
      node.remove();
    });
  }

  // A restored Emby SPA artist view can keep the same item ID while Emby
  // clears/replaces the Top Songs row container. The normal same-item route guard
  // must not treat that empty shell as a healthy, already-rendered section.
  function needsSameArtistReentryRecovery(artistId) {
    var root = getVisibleItemView();
    var parent = root && findDetailsContent(root);
    if (!root || !parent || !root.isConnected || !parent.isConnected) return false;

    var section = Array.prototype.slice.call(parent.querySelectorAll('.' + SECTION_CLASS)).find(function (node) {
      return node.isConnected && String(node.dataset.topSongsArtistId || '') === String(artistId);
    });
    if (!section) return true;
    if (window.__topSongsShowTiles === false && section._topSongsOrderedItems && section._topSongsOrderedItems.length) return false;

    var rows = section._topSongsRows || section._topSongsRowsPlaceholder || section.querySelector('.topSongsRows');
    var renderedRows = rows && Array.prototype.slice.call(rows.children || []).some(function (row) {
      return row && (row.classList && (row.classList.contains('virtualScrollItem') || row.classList.contains('listItem')) ||
        row.querySelector && row.querySelector('.listItem-content, .card, .virtualScrollItem'));
    });
    if (renderedRows) return false;

    var metric = section._topSongsPerfMetric;
    var now = Date.now();
    var age = metric && metric.startedAt ? now - metric.startedAt : Infinity;
    var shellCreatedAt = Number(section.dataset.topSongsShellCreatedAt) || 0;
    var shellAge = shellCreatedAt ? now - shellCreatedAt : Infinity;
    var pendingWork = !!(section._topSongsRetryTimer || section._topSongsRecoveryTimer);
    // Do not restart a newly inserted early shell before the embedded renderer
    // has had time to adopt it. If an older shell never acquired a renderer metric,
    // treat it as stale instead of leaving it stuck indefinitely.
    if (section.dataset.topSongsShell === 'true' && !metric && shellAge < 12000) return false;
    // Allow active chart/recovery work to complete. A previously successful
    // section that has lost its rows, or a stalled load older than the recovery
    // window, is stale and needs a fresh initialization cycle.
    if ((pendingWork || metric && metric.outcome === 'loading') && age < 90000) return false;
    return true;
  }

  var lastSameArtistReentryRecoveryAt = 0;
  var lastSameArtistReentryRecoveryId = '';

  function processRoute(forceReentryAudit) {
    var nativeIntent = window.__topSongsNativeListIntent;
    if (nativeIntent) {
      probeNativeListIntent(nativeIntent);
      if (routeIsNativeArtistSongsList(nativeIntent)) return;
    }
    var itemId = getCurrentItemId();
    // Returning from the native Top Songs list uses the same #!/item?id=... hash
    // as the original artist page. Force one clean artist-page initialization when
    // that return is detected, even if the observer already cleared the list intent.
    if (itemId && itemId === pendingNativeListReturnArtistId) {
      pendingNativeListReturnArtistId = '';
      currentItemId = '';
      startupFailureItemId = '';
      startupFailureAt = 0;
      console.info('[TopSongs] Returned from the native Top Songs list; restarting artist-page population for ' + itemId + '.');
    }
    if (itemId === currentItemId) {
      if (!itemId) return;

      var now = Date.now();
      var mayAuditSameArtist = forceReentryAudit === true &&
        (lastSameArtistReentryRecoveryId !== itemId || now - lastSameArtistReentryRecoveryAt >= 10000);
      if (mayAuditSameArtist && needsSameArtistReentryRecovery(itemId)) {
        lastSameArtistReentryRecoveryAt = now;
        lastSameArtistReentryRecoveryId = itemId;
        startupFailureItemId = '';
        startupFailureAt = 0;
        currentItemId = '';
        console.info('[TopSongs] The same artist page was restored without populated Top Songs rows; restarting its section and chart load.', { artistId: itemId });
      } else {
        // When all startup retries fail before the artist observer is installed,
        // the same-route polling used to return forever. Retry this same artist
        // slowly rather than forcing the user to reload the whole page.
        if (startupFailureItemId !== itemId || !startupFailureAt || activeSectionObserver ||
            Date.now() - startupFailureAt < 12000 || Date.now() - lastStartupRecoveryAt < 30000) return;
        lastStartupRecoveryAt = Date.now();
        startupFailureItemId = '';
        startupFailureAt = 0;
        currentItemId = '';
        console.warn('[TopSongs] Retrying startup on the current artist page after a previous transient failure.');
      }
    }
    if (itemId === currentItemId) return;
    currentItemId = itemId;
    generation += 1;
    var token = generation;
    startupFailureItemId = '';
    startupFailureAt = 0;
    removeOldSections(itemId);
    if (!itemId) return;

    var maxStartupRetries = 6; // Initial attempt plus up to six bounded retries.
    function retryStartup(attemptNumber, reason) {
      if (token !== generation || currentItemId !== itemId) return;
      if (attemptNumber >= maxStartupRetries) {
        startupFailureItemId = itemId;
        startupFailureAt = Date.now();
        console.warn('[TopSongs] Artist-page startup did not complete after retries. ' + (reason || 'The startup request remained unavailable.') + ' The same-page recovery watchdog will retry without requiring a refresh.');
        return;
      }
      // Back off while Emby finishes loading the artist detail view/API, but keep
      // retries bounded and cancel them immediately if the user changes pages.
      var delay = Math.min(500 * Math.pow(2, attemptNumber), 5000);
      window.setTimeout(function () {
        if (token === generation && currentItemId === itemId) loadItemWhenApiReady(attemptNumber + 1);
      }, delay);
    }

    function loadItemWhenApiReady(attemptNumber) {
      attemptNumber = typeof attemptNumber === 'number' ? attemptNumber : 0;
      if (token !== generation || currentItemId !== itemId) return;
      var api = getApiClient();
      if (!api || typeof api.ajax !== 'function') {
        window.setTimeout(function () { loadItemWhenApiReady(attemptNumber); }, 350);
        return;
      }
      // The loader only injects this module after /TopSongs/Status succeeded. Reuse
      // that availability result and the loader's cached/in-flight current-item lookup
      // instead of issuing two more API requests on every artist navigation.
      var availabilityPromise;
      if (window.__topSongsPluginAvailable === true) {
        availabilityPromise = Promise.resolve(true);
      } else {
        availabilityPromise = apiGet('TopSongs/Status', {}).then(function (pluginStatus) {
          var available = pluginStatus && (pluginStatus.Available === true || pluginStatus.available === true);
          window.__topSongsPluginAvailable = available === true;
          window.__topSongsPluginStatusAt = Date.now();
          return available === true;
        });
      }
      availabilityPromise.then(function (available) {
        if (token !== generation || currentItemId !== itemId) return null;
        if (!available) {
          retryStartup(attemptNumber, 'The plugin status endpoint temporarily reported unavailable.');
          return null;
        }
        var getSharedItem = window.__topSongsGetCurrentItemInfo;
        if (typeof getSharedItem === 'function') {
          return Promise.resolve(getSharedItem(itemId)).then(function (item) { return { item: item }; });
        }
        // Compatibility fallback for an older loader during a rolling upgrade.
        var userId = api.getCurrentUserId();
        if (!userId) {
          retryStartup(attemptNumber, 'Emby had not provided the current user ID yet.');
          return null;
        }
        return apiGet('Users/' + encodeURIComponent(userId) + '/Items/' + encodeURIComponent(itemId), { Fields: 'Type,Name' })
          .then(function (item) { return { item: item }; });
      }).then(function (result) {
        if (!result || token !== generation || currentItemId !== itemId) return;
        if (!result.item || !result.item.Type) {
          retryStartup(attemptNumber, 'Emby returned incomplete item metadata for the current page.');
          return;
        }
        startupFailureItemId = '';
        startupFailureAt = 0;
        // A valid non-artist page is not a transient startup failure.
        if (result.item.Type !== 'MusicArtist') return;
        watchForArtistSection(itemId, token);
      }).catch(function (error) {
        if (token !== generation || currentItemId !== itemId) return;
        var details = error && (error.statusText || error.message) ? (error.statusText || error.message) : 'request failed';
        retryStartup(attemptNumber, 'The initial artist-page API request failed (' + details + ').');
      });
    }
    loadItemWhenApiReady(0);
  }

  // The route/lifecycle source is the loader's sole History/hash/visibility manager;
  // this module exposes a callback rather than wrapping History or polling separately.
  var scheduledRouteCheck = 0;
  var scheduledReentryAudit = false;
  function scheduleProcessRoute(forceReentryAudit) {
    if (forceReentryAudit) scheduledReentryAudit = true;
    if (scheduledRouteCheck) window.clearTimeout(scheduledRouteCheck);
    scheduledRouteCheck = window.setTimeout(function () {
      scheduledRouteCheck = 0;
      var audit = scheduledReentryAudit;
      scheduledReentryAudit = false;
      try { processRoute(audit); }
      catch (error) { console.warn('[TopSongs] Route initialization check failed.', error); }
    }, 0);
  }

  // The loader owns all History/hash/focus/visibility listeners and route polling.
  // This callback is the only hand-off into the data/population lifecycle, so the
  // two embedded scripts cannot compete to wrap the same SPA navigation methods.
  window.__topSongsArtistPageRouteCheck = function (forceReentryAudit) {
    scheduleProcessRoute(forceReentryAudit === true);
  };

  // Called from the loader's existing 700 ms route check (no extra timers).
  // Fixes the "needs a refresh" case: Emby can replace the artist view while it
  // loads, and the loader rebuilds the Top Songs section. This adopts that fresh,
  // empty section straight away instead of waiting for a focus/history event.
  window.__topSongsAdoptShell = function (artistId) {
    artistId = String(artistId || '');
    if (!artistId) return false;
    if (currentItemId !== artistId) {
      scheduleProcessRoute(true);
      return false;
    }
    try { return buildSection(artistId, generation) === true; }
    catch (error) {
      console.warn('[TopSongs] Could not adopt the rebuilt Top Songs section; will retry.', error);
      return false;
    }
  };


  processRoute();
}());
