(function () {
    var loaderState = window.__topSongsWebLoaderState || (window.__topSongsWebLoaderState = {});
    loaderState.implementationStarted = true;
    loaderState.implementationStartedAt = Date.now();
    if (window.__topSongsEmbeddedModuleBootstrapped) {
        loaderState.implementationAlreadyBootstrapped = true;
        return;
    }
    window.__topSongsEmbeddedModuleBootstrapped = true;

    var retryTimer = 0;
    var statusRequestInFlight = false;
    var retryCount = 0;
    var fastRetryDelays = [500, 1000, 2000, 4000, 8000, 12000, 15000];
    var slowRetryDelay = 20000;

    // The section shell is created as soon as Emby identifies the current item as
    // a MusicArtist and the detail-section host exists. This work is independent
    // of /TopSongs/Status, Last.fm and the native list's DB render timing.
    var shellRouteItemId = '';
    var shellRouteGeneration = 0;
    var shellItem = null;

    // ----- Remembered artists (this browser only) -----
    // itemId -> 'a' (artist with Top Songs) or 'n' (artist, no matching songs).
    // A remembered artist skips the "is this page an artist?" lookup, so the
    // Top Songs > link can appear the moment Emby draws the page. The songs still
    // load each visit and correct the remembered answer if the library changed.
    var ARTIST_MEMORY_KEY = 'topSongs.knownArtists';
    var ARTIST_MEMORY_LIMIT = 3000;
    var artistMemory = null;
    function loadArtistMemory() {
        if (artistMemory) return artistMemory;
        artistMemory = { order: [], map: Object.create(null) };
        try {
            var saved = window.localStorage && JSON.parse(window.localStorage.getItem(ARTIST_MEMORY_KEY) || '[]');
            if (Array.isArray(saved)) saved.forEach(function (entry) {
                if (!Array.isArray(entry) || typeof entry[0] !== 'string' || (entry[1] !== 'a' && entry[1] !== 'n')) return;
                if (!(entry[0] in artistMemory.map)) artistMemory.order.push(entry[0]);
                artistMemory.map[entry[0]] = entry[1];
            });
        } catch (ignore) { }
        return artistMemory;
    }
    var artistMemorySaveTimer = 0;
    function saveArtistMemorySoon() {
        if (artistMemorySaveTimer) return;
        artistMemorySaveTimer = window.setTimeout(function () {
            artistMemorySaveTimer = 0;
            try {
                var memory = loadArtistMemory();
                window.localStorage && window.localStorage.setItem(ARTIST_MEMORY_KEY,
                    JSON.stringify(memory.order.map(function (id) { return [id, memory.map[id]]; })));
            } catch (ignore) { }
        }, 1000);
    }
    function rememberedArtist(itemId) {
        var memory = loadArtistMemory();
        return memory.map[String(itemId || '')] || '';
    }
    // Called by the artist-page script when an artist's songs finish loading.
    window.__topSongsRememberArtist = function (itemId, hasSongs) {
        itemId = String(itemId || '');
        if (!itemId) return;
        var memory = loadArtistMemory();
        var value = hasSongs ? 'a' : 'n';
        var index = memory.order.indexOf(itemId);
        if (index >= 0) memory.order.splice(index, 1);   // most recent last
        memory.order.push(itemId);
        memory.map[itemId] = value;
        while (memory.order.length > ARTIST_MEMORY_LIMIT) delete memory.map[memory.order.shift()];
        saveArtistMemorySoon();
    };
    var shellItemRequestInFlight = false;
    var shellItemRequestPromise = null;
    var shellItemRequestItemId = '';
    var shellItemRetryAt = 0;

    // Local-only activity counters help diagnose page-observer/polling overhead.
    // The counters never include artist names, API keys, auth tokens, or URLs.
    var activityStorageKey = 'topSongs.v11.loaderActivity';
    var activity = window.__topSongsLoaderActivity || (window.__topSongsLoaderActivity = {
        startedUtc: new Date().toISOString(),
        routePollTicks: 0, shellApiRequests: 0, sharedItemInfoCalls: 0,
        cachedItemInfoHits: 0, statusRequests: 0, artistScriptLoads: 0,
        loaderMutationCallbacks: 0, loaderMutationRecords: 0, loaderMutationAddedNodes: 0,
        loaderMutationDurationMsTotal: 0, loaderMutationDurationMsMax: 0,
        shellPlacementProbes: 0, nativeScrollerRepairs: 0, lifecycleEvents: 0,
        artistSectionMutationCallbacks: 0, artistSectionMutationRecords: 0,
        artistSectionProbeRuns: 0, nativeRowsMutationCallbacks: 0,
        longTaskCount: 0, longTaskDurationMsTotal: 0, longTaskDurationMsMax: 0,
        updatedUtc: null
    });
    var activityPersistTimer = 0;
    function scheduleActivityPersist() {
        if (activityPersistTimer) return;
        activityPersistTimer = window.setTimeout(persistActivityMetrics, 5000);
    }
    function persistActivityMetrics() {
        activityPersistTimer = 0;
        activity.updatedUtc = new Date().toISOString();
        try { window.localStorage.setItem(activityStorageKey, JSON.stringify(activity)); } catch (ignore) { }
    }
    function recordActivity(name, amount) {
        activity[name] = (Number(activity[name]) || 0) + (typeof amount === 'number' ? amount : 1);
        scheduleActivityPersist();
    }
    function recordActivityDuration(name, durationMs) {
        var value = Math.max(0, Number(durationMs) || 0);
        activity[name + 'MsTotal'] = (Number(activity[name + 'MsTotal']) || 0) + value;
        activity[name + 'MsMax'] = Math.max(Number(activity[name + 'MsMax']) || 0, value);
        scheduleActivityPersist();
    }
    window.__topSongsRecordActivity = recordActivity;
    window.addEventListener('pagehide', persistActivityMetrics, true);
    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') persistActivityMetrics();
    }, true);
    try {
        if (typeof window.PerformanceObserver === 'function') {
            var longTaskObserver = new window.PerformanceObserver(function (list) {
                var entries = list.getEntries();
                if (!entries || !entries.length) return;
                recordActivity('longTaskCount', entries.length);
                entries.forEach(function (entry) { recordActivityDuration('longTaskDuration', entry.duration); });
            });
            longTaskObserver.observe({ entryTypes: ['longtask'] });
        }
    } catch (ignoreLongTaskObserver) { }
    var shellItemRetryCount = 0;
    var shellLastWarnAt = 0;

    function getApiClient() {
        return window.ApiClient || (typeof ApiClient !== "undefined" ? ApiClient : null);
    }

    // Share the client resolver with the artist module so Emby API detection has one implementation.
    window.__topSongsGetApiClient = getApiClient;

    function getRouteItemId() {
        // Do not mistake a stale artist hash for the current item while the
        // original native /list/list.html route is active. This lets the shell
        // lifecycle reset on entry and recreate it on Back, as Emby's router does.
        if (/(?:^|\/)list\/list\.html$/i.test(window.location.pathname || "")) return "";
        var hash = window.location.hash || "";
        var match = hash.match(/^#!?\/?item\?(.*)$/);
        if (!match) return "";
        try { return new URLSearchParams(match[1]).get("id") || ""; }
        catch (ignore) { return ""; }
    }

    // The loader is the single owner of Emby route identification. The artist-page
    // module consumes this helper instead of parsing the SPA route independently.
    window.__topSongsGetRouteItemId = getRouteItemId;

    function isItemRoute() { return !!getRouteItemId(); }

    function hasLoadedArtistScript() {
        return !!(window.__topSongsArtistPageInitialized || window.__topSongsArtistPageScriptInserted);
    }

    // Navigation hooks live here once. The artist-page module registers a narrow
    // callback and owns only the chart/population lifecycle triggered by it.
    function notifyArtistPageRoute(forceReentryAudit) {
        var callback = window.__topSongsArtistPageRouteCheck;
        if (typeof callback !== 'function') return;
        try { callback(forceReentryAudit === true); }
        catch (error) { console.warn('[TopSongs] Artist-page route callback failed; it will be retried.', error); }
    }

    function isVisible(element) {
        if (!element) return false;
        var style = window.getComputedStyle(element);
        var rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    }

    // Share the same basic visibility test instead of maintaining a copy in ArtistPage.js.
    window.__topSongsIsVisible = isVisible;

    function findVisibleDetailsContent() {
        var itemViews = Array.prototype.slice.call(document.querySelectorAll(
            '.itemView, .itemDetailPage, .detailPage, .view-item-item, [data-role="page"]'
        ));
        for (var i = itemViews.length - 1; i >= 0; i--) {
            if (!isVisible(itemViews[i])) continue;
            var content = itemViews[i].querySelector('.details-additionalContent');
            if (content) return content;
        }
        var fallbacks = Array.prototype.slice.call(document.querySelectorAll('.details-additionalContent'));
        for (var j = fallbacks.length - 1; j >= 0; j--) {
            if (isVisible(fallbacks[j])) return fallbacks[j];
        }
        return null;
    }

    // ----- Display: a "Top Songs >" link beside Emby's "Songs >" heading -----
    // This is the only display. The Top Songs section itself is always hidden: it
    // loads the ranked songs that the link opens.
    window.__topSongsShowTiles = false;
    if (!document.getElementById('topSongsDisplayStyle')) {
        var displayStyle = document.createElement('style');
        displayStyle.id = 'topSongsDisplayStyle';
        displayStyle.textContent =
            '.topSongsArtistSection{display:none!important}' +
            '.topSongsInlineLink{margin-left:1.5em}';
        (document.head || document.documentElement).appendChild(displayStyle);
    }
    // Setting remembered by 1.1.22-1.2.0 (Top/Bottom choice); no longer used.
    try { window.localStorage && window.localStorage.removeItem('topSongs.showTiles'); } catch (ignore) { }

    function element(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = String(text);
        return node;
    }

    // Attach the early click guard to the current live heading link. Use a JS
    // expando rather than a data-* flag because Emby's SPA may clone/restore the
    // section markup; data attributes survive while click listeners do not.
    function ensureShellClickBinding(host) {
        if (!host) return;
        var titleLink = host.querySelector('a[is="emby-sectiontitle"].sectionTitleTextButton');
        if (!titleLink || titleLink.__topSongsShellClickHandlerBound === true) return;
        titleLink.__topSongsShellClickHandlerBound = true;
        titleLink.removeAttribute('data-top-songs-shell-click-bound');
        titleLink.removeAttribute('data-top-songs-action-bound');
        titleLink.addEventListener('click', function (event) {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            var owner = titleLink.closest('.topSongsArtistSection') || host;
            var nativeNavigationPrepared = false;
            if (owner && typeof owner._topSongsNavigate === 'function') {
                try { nativeNavigationPrepared = owner._topSongsNavigate() === true; }
                catch (error) { console.warn('[TopSongs] Could not prepare native Songs navigation.', error); }
            }
            // When ready, allow Emby's own heading/link handler to perform the
            // transition. Otherwise queue the action and stop the regular Songs
            // route from opening with the full library list.
            if (nativeNavigationPrepared) return;
            event.preventDefault();
            event.stopPropagation();
            if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
            if (owner) owner._topSongsPendingNavigation = true;
        }, true);
    }

    // The DLL reuses this binder so a click handler can be restored after Emby
    // replaces the heading during Back/playback navigation.
    window.__topSongsEnsureHeadingClickBinding = ensureShellClickBinding;

    var nativeSongRowsClass = 'scrollSlider focuscontainer-x itemsContainer focusable artistSongsItemsContainer itemsContainer-sideFooters scrollSliderX emby-scrollbuttons-scrollSlider generalItemsContainer vertical-list virtualItemsContainer virtual-scroller-overflowvisible virtual-scroller topSongsRows';

    function prepareNativeSongRows(host, rows) {
        if (!rows) return null;
        rows.setAttribute('is', 'emby-itemscontainer');
        rows.className = nativeSongRowsClass;
        rows.setAttribute('data-focusabletype', 'nearest');
        rows.setAttribute('data-virtualscrolllayout', 'horizontal-grid');
        rows.setAttribute('aria-label', 'Top Songs');
        rows.setAttribute('data-minoverhang', '1');
        rows.setAttribute('layout', 'horizontal-grid');
        rows.style.whiteSpace = 'nowrap';
        if (host) {
            rows.parentContainer = host;
            host._topSongsRowsPlaceholder = rows;
            if (!host._topSongsRows) host._topSongsRows = null;
        }
        return rows;
    }

    function createNativeSongRowsPlaceholder() {
        var rows = document.createElement('div', { is: 'emby-itemscontainer' });
        rows.setAttribute('is', 'emby-itemscontainer');
        // Normalize every row through the same single helper, even while detached.
        return prepareNativeSongRows(null, rows);
    }

    function createNativeSongScroller() {
        var scroller = document.createElement('div', { is: 'emby-scroller' });
        scroller.setAttribute('is', 'emby-scroller');
        scroller.className = 'emby-scroller padded-top-focusscale padded-bottom-focusscale padded-left padded-left-page padded-right scrollX hiddenScrollX scrollFrameX flex-direction-row';
        scroller.setAttribute('data-focusscroll', 'true');
        scroller.setAttribute('data-horizontal', 'true');
        scroller.setAttribute('data-scrollsnap', 'true');
        var rows = createNativeSongRowsPlaceholder();
        scroller.appendChild(rows);
        return { scroller: scroller, rows: rows };
    }

    function ensureNativeSongScroller(host) {
        if (!host) return;
        var scroller = host._topSongsScroller || host.querySelector(':scope > .emby-scroller');
        var rows = host._topSongsRowsPlaceholder || host._topSongsRows ||
            (scroller && scroller.querySelector('.topSongsRows'));
        var invalidPair = !scroller || scroller.getAttribute('is') !== 'emby-scroller' ||
            scroller.parentNode !== host || !rows || rows.getAttribute('is') !== 'emby-itemscontainer' ||
            rows.parentNode !== scroller || !rows.classList || !rows.classList.contains('scrollSlider');
        var rebuiltPair = false;
        if (invalidPair) {
            // If a previous init left an EmbyScroller without its native `is`
            // identity, rebuild the entire pair while the section is detached.
            // Connecting a replacement scroller to a live section can race Emby's
            // scroll-button enhancer and leave an empty arrow-control element.
            var mountState = null;
            if (host.isConnected && host.parentNode) {
                mountState = { parent: host.parentNode, nextSibling: host.nextSibling };
                mountState.parent.removeChild(host);
            }
            if (scroller && scroller.parentNode === host) host.removeChild(scroller);
            Array.prototype.slice.call(host.children).forEach(function (child) {
                var isButtons = child.getAttribute && child.getAttribute('is') === 'emby-scrollbuttons' ||
                    child.classList && child.classList.contains('emby-scrollbuttons');
                if (isButtons && !child.querySelector('[data-direction]')) child.parentNode.removeChild(child);
            });
            var prepared = createNativeSongScroller();
            scroller = prepared.scroller;
            rows = prepared.rows;
            rebuiltPair = true;
            recordActivity('nativeScrollerRepairs');
            host._topSongsScroller = scroller;
            // Complete the native EmbyItemsContainer shape before reconnecting the
            // section so Emby's scroll-button enhancer never sees an empty slider.
            prepareNativeSongRows(host, rows);
            host.appendChild(scroller);
            if (mountState && mountState.parent.isConnected) {
                var reference = mountState.nextSibling && mountState.nextSibling.parentNode === mountState.parent ? mountState.nextSibling : null;
                mountState.parent.insertBefore(host, reference);
            }
        }
        scroller.setAttribute('is', 'emby-scroller');
        host._topSongsScroller = scroller;
        // Normalize new placeholders and broken structures, but do not reset the
        // class/ARIA attributes on a populated EmbyItemsContainer every 700 ms.
        // Once the artist module owns a rendered list, its renderer state is left alone.
        var shouldPrepareRows = !rebuiltPair && (host._topSongsRowsPlaceholder === rows ||
            rows.getAttribute('is') !== 'emby-itemscontainer' ||
            !rows.classList || !rows.classList.contains('scrollSlider') ||
            !rows.classList.contains('topSongsRows') || rows.parentContainer !== host);
        if (shouldPrepareRows) prepareNativeSongRows(host, rows);
        else {
            rows.setAttribute('is', 'emby-itemscontainer');
            rows.parentContainer = host;
        }
        if (!host._topSongsRows && !host._topSongsRowsPlaceholder) host._topSongsRowsPlaceholder = rows;
        return { scroller: scroller, rows: rows };
    }

    // The loader is the only owner of shell/scroller structure and row CSS/attrs.
    // The artist-page module supplies data and Emby's renderer callbacks only.
    window.__topSongsCreateNativeSongRowsPlaceholder = createNativeSongRowsPlaceholder;
    window.__topSongsPrepareNativeSongRows = prepareNativeSongRows;
    window.__topSongsEnsureNativeSongScroller = ensureNativeSongScroller;

    function currentShellFor(parent, itemId) {
        return Array.prototype.slice.call(document.querySelectorAll('.topSongsArtistSection')).find(function (node) {
            return node.isConnected && String(node.dataset.topSongsArtistId || '') === String(itemId) && parent.contains(node);
        }) || null;
    }

    function buildShell(parent, itemId) {
        var existing = currentShellFor(parent, itemId);
        if (existing) {
            ensureNativeSongScroller(existing);
            ensureShellClickBinding(existing);
            return existing;
        }

        // A route transition may briefly leave the previous artist details mounted.
        // Do not carry the old section over to the new artist.
        Array.prototype.slice.call(document.querySelectorAll('.topSongsArtistSection')).forEach(function (node) {
            if (String(node.dataset.topSongsArtistId || '') !== String(itemId)) node.remove();
        });

        recordActivity('shellSectionsCreated');
        var host = element('div', 'verticalSection verticalSection-cards verticalSection-extrabottompadding artistSongsSection emby-scrollbuttons-scroller topSongsArtistSection');
        host.dataset.topSongsArtistId = String(itemId);
        host.dataset.topSongsShell = 'true';
        host.dataset.topSongsShellCreatedAt = String(Date.now());
        if (rememberedArtist(itemId) === 'n') host.dataset.topSongsNoMatches = 'true';

        var nativeSection = Array.prototype.slice.call(parent.querySelectorAll('.artistSongsSection')).find(function (node) {
            return !node.classList.contains('topSongsArtistSection');
        });
        var nativeHeading = nativeSection && nativeSection.querySelector('.artistSongsItemsHeader');
        var nativeTitleLink = nativeHeading && nativeHeading.querySelector('a[is="emby-sectiontitle"].sectionTitleTextButton');
        var heading;
        var titleLink;
        if (nativeHeading && nativeTitleLink) {
            heading = nativeHeading.cloneNode(false);
            titleLink = nativeTitleLink.cloneNode(true);
            var title = titleLink.querySelector('h2');
            if (title) title.textContent = 'Top Songs';
            else titleLink.textContent = 'Top Songs';
            heading.appendChild(titleLink);
        } else {
            heading = element('div', 'artistSongsItemsHeader sectionTitleContainer sectionTitleContainer-wrappedlistview');
            titleLink = element('a', 'button-link button-link-color-inherit sectionTitleTextButton');
            titleLink.setAttribute('is', 'emby-sectiontitle');
            titleLink.appendChild(element('h2', 'sectionTitle sectionTitle-cards', 'Top Songs'));
            heading.appendChild(titleLink);
        }
        titleLink.setAttribute('aria-label', 'See all Top Songs');
        host.appendChild(heading);
        ensureShellClickBinding(host);

        var status = element('div', 'topSongsStatus hide secondaryText padded-left padded-left-page padded-right', '');
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'polite');
        host.appendChild(status);

        // Mount a complete native scroller/slider pair with the section shell.
        // Emby's horizontal arrow enhancement discovers the section at connection
        // time; adding the scroller later can leave the arrows permanently absent.
        // The DLL fills this same EmbyItemsContainer after the Last.fm data arrives.
        ensureNativeSongScroller(host);
        parent.appendChild(host);
        return host;
    }

    function syncShellHeading(host, parent) {
        if (!host || !parent) return;
        var nativeSection = Array.prototype.slice.call(parent.querySelectorAll('.artistSongsSection')).find(function (node) {
            return !node.classList.contains('topSongsArtistSection');
        });
        var nativeHeading = nativeSection && nativeSection.querySelector('.artistSongsItemsHeader');
        var nativeLink = nativeHeading && nativeHeading.querySelector('a[is="emby-sectiontitle"].sectionTitleTextButton');
        var heading = host.querySelector('.artistSongsItemsHeader');
        var titleLink = heading && heading.querySelector('a[is="emby-sectiontitle"].sectionTitleTextButton');
        if (!titleLink) return;

        // Emby's real Songs heading can arrive after our early shell. Copy its route
        // attributes/content once per live source link while keeping our live anchor
        // (and its capture listener) intact.
        if (nativeLink && nativeLink !== titleLink &&
            (host._topSongsLastNativeHeadingLink !== nativeLink ||
             titleLink.getAttribute('href') !== nativeLink.getAttribute('href'))) {
            Array.prototype.slice.call(nativeLink.attributes).forEach(function (attribute) {
                titleLink.setAttribute(attribute.name, attribute.value);
            });
            while (titleLink.firstChild) titleLink.removeChild(titleLink.firstChild);
            Array.prototype.slice.call(nativeLink.childNodes).forEach(function (child) {
                titleLink.appendChild(child.cloneNode(true));
            });
            host._topSongsLastNativeHeadingLink = nativeLink;
        }
        var title = titleLink.querySelector('h2');
        if (title) title.textContent = 'Top Songs';
        else titleLink.textContent = 'Top Songs';
        titleLink.setAttribute('aria-label', 'See all Top Songs');
    }

    // ----- "Top Songs >" beside Emby's own "Songs >" heading (link mode) -----
    // Shown as soon as the page is known to be an artist page and Emby has drawn
    // its Songs heading; it does not wait for the Last.fm songs. A click before the
    // songs are ready is queued and opens the list the moment they arrive. If the
    // artist has no matching songs, the artist script marks the section and the
    // link is removed.
    var inlineLinkFramePending = false;
    function ensureInlineLink() {
        if (window.__topSongsShowTiles !== false) return false;
        var itemId = getRouteItemId();
        if (!itemId || itemId !== shellRouteItemId || !shellItem || shellItem.Type !== 'MusicArtist') return false;
        var parent = findVisibleDetailsContent();
        if (!parent) return false;
        var shell = currentShellFor(parent, itemId);
        if (!shell) return false;
        var nativeSection = Array.prototype.slice.call(parent.querySelectorAll('.artistSongsSection')).find(function (node) {
            return !node.classList.contains('topSongsArtistSection');
        });
        var heading = nativeSection && nativeSection.querySelector('.artistSongsItemsHeader');
        var nativeLink = heading && heading.querySelector('a[is="emby-sectiontitle"].sectionTitleTextButton:not(.topSongsInlineLink)');
        if (!nativeLink) return false;
        var existing = heading.querySelector('.topSongsInlineLink');
        if (shell.dataset.topSongsNoMatches === 'true') {
            if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
            return false;
        }
        if (existing && existing.dataset.topSongsArtistId === itemId) return true;
        if (existing && existing.parentNode) existing.parentNode.removeChild(existing);

        // A copy of Emby's own "Songs >" link: same look, same native list route.
        var link = nativeLink.cloneNode(true);
        link.classList.add('topSongsInlineLink');
        link.dataset.topSongsArtistId = itemId;
        var title = link.querySelector('h2');
        if (title) title.textContent = 'Top Songs';
        else link.textContent = 'Top Songs';
        link.setAttribute('aria-label', 'See all Top Songs');
        link.addEventListener('click', function (event) {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            var owner = Array.prototype.slice.call(document.querySelectorAll('.topSongsArtistSection')).find(function (node) {
                return node.isConnected && String(node.dataset.topSongsArtistId || '') === itemId;
            });
            var ready = !!(owner && owner._topSongsOrderedItems && owner._topSongsOrderedItems.length &&
                typeof owner._topSongsNavigate === 'function');
            var prepared = false;
            if (ready) {
                try { prepared = owner._topSongsNavigate() === true; }
                catch (error) { console.warn('[TopSongs] Could not prepare Top Songs navigation.', error); }
            }
            if (prepared) return; // Emby's own link handling performs the navigation.
            event.preventDefault();
            event.stopPropagation();
            if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
            if (owner) owner._topSongsPendingNavigation = true; // opened when the songs arrive
            recordActivity('inlineClicksQueued');
        }, true);
        nativeLink.insertAdjacentElement('afterend', link);
        recordActivity('inlineLinksPlaced');
        return true;
    }
    window.__topSongsEnsureInlineLink = ensureInlineLink;

    // At most once per animation frame, only in link mode on an item page.
    function scheduleInlineLink() {
        if (inlineLinkFramePending || window.__topSongsShowTiles !== false || !shellItem || shellItem.Type !== 'MusicArtist') return;
        // Already in place for this artist: nothing to do (avoids layout work while Emby renders).
        var current = shellRouteItemId && document.querySelector('.topSongsInlineLink[data-top-songs-artist-id="' + String(shellRouteItemId).replace(/["\\]/g, '') + '"]');
        if (current && current.isConnected) return;
        inlineLinkFramePending = true;
        var run = function () {
            inlineLinkFramePending = false;
            // Also creates the hidden section if Emby has just drawn the artist page,
            // so the link does not wait for the next 700 ms check.
            try { probeShellPlacement(shellRouteItemId, shellRouteGeneration); } catch (ignore) { }
        };
        if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(run);
        else window.setTimeout(run, 16);
    }

    function ensureArtistShell(itemId) {
        itemId = String(itemId || '');
        if (!itemId || getRouteItemId() !== itemId) return null;
        var parent = findVisibleDetailsContent();
        if (!parent) return null;
        var shell = currentShellFor(parent, itemId);
        if (!shell && shellRouteItemId === itemId && shellItem && shellItem.Type === 'MusicArtist') {
            shell = buildShell(parent, itemId);
        }
        if (!shell) return null;
        ensureNativeSongScroller(shell);
        syncShellHeading(shell, parent);
        ensureShellClickBinding(shell);
        return shell;
    }
    window.__topSongsEnsureArtistShell = ensureArtistShell;

    function probeShellPlacement(itemId, generation) {
        recordActivity('shellPlacementProbes');
        if (generation !== shellRouteGeneration || itemId !== shellRouteItemId || getRouteItemId() !== itemId) return;
        if (!shellItem || shellItem.Type !== 'MusicArtist') return;
        var parent = findVisibleDetailsContent();
        if (!parent) return;
        var shell = currentShellFor(parent, itemId);
        if (!shell) shell = buildShell(parent, itemId);
        if (shell && shell.isConnected) {
            syncShellHeading(shell, parent);
            ensureNativeSongScroller(shell);
            ensureShellClickBinding(shell);
            shellItemRetryCount = 0;
            shellItemRetryAt = 0;
            ensureInlineLink();
        }
    }

    function requestShellItemInfo(itemId) {
        itemId = String(itemId || '');
        if (!itemId || itemId !== shellRouteItemId || getRouteItemId() !== itemId) return Promise.resolve(null);
        if (shellItem && shellItem.Type) {
            recordActivity('cachedItemInfoHits');
            return Promise.resolve(shellItem);
        }
        if (shellItemRequestPromise && shellItemRequestItemId === itemId) {
            recordActivity('sharedItemInfoCalls');
            return shellItemRequestPromise;
        }
        if (Date.now() < shellItemRetryAt) return Promise.resolve(null);

        var api = getApiClient();
        if (!api || typeof api.ajax !== 'function' || typeof api.getUrl !== 'function' || typeof api.getCurrentUserId !== 'function') return Promise.resolve(null);
        var userId = api.getCurrentUserId();
        if (!userId) return Promise.resolve(null);

        var generation = shellRouteGeneration;
        shellItemRequestInFlight = true;
        shellItemRequestItemId = itemId;
        recordActivity('shellApiRequests');
        var request;
        try {
            request = api.ajax({
                type: 'GET',
                url: api.getUrl('Users/' + encodeURIComponent(userId) + '/Items/' + encodeURIComponent(itemId), { Fields: 'Type,Name' }),
                dataType: 'json'
            });
        } catch (error) {
            shellItemRequestInFlight = false;
            shellItemRequestItemId = '';
            shellItemRetryCount++;
            shellItemRetryAt = Date.now() + Math.min(500 * Math.pow(2, shellItemRetryCount), 8000);
            return Promise.resolve(null);
        }

        var sharedPromise;
        sharedPromise = Promise.resolve(request).then(function (item) {
            if (shellItemRequestPromise === sharedPromise) shellItemRequestInFlight = false;
            if (generation !== shellRouteGeneration || itemId !== shellRouteItemId || getRouteItemId() !== itemId) return null;
            if (!item || !item.Type) {
                shellItem = null;
                shellItemRetryCount++;
                shellItemRetryAt = Date.now() + Math.min(500 * Math.pow(2, shellItemRetryCount), 8000);
                return null;
            }
            shellItem = item;
            shellItemRetryCount = 0;
            shellItemRetryAt = 0;
            if (shellItem.Type === 'MusicArtist') probeShellPlacement(itemId, generation);
            return shellItem;
        }).catch(function (error) {
            if (shellItemRequestPromise === sharedPromise) shellItemRequestInFlight = false;
            if (generation !== shellRouteGeneration || itemId !== shellRouteItemId) return null;
            shellItemRetryCount++;
            shellItemRetryAt = Date.now() + Math.min(500 * Math.pow(2, shellItemRetryCount), 8000);
            if (Date.now() - shellLastWarnAt > 15000) {
                shellLastWarnAt = Date.now();
                console.warn('[TopSongs] Could not identify the current Emby item for the early section shell; will retry.', error);
            }
            return null;
        }).then(function (item) {
            if (shellItemRequestPromise === sharedPromise) {
                shellItemRequestPromise = null;
                shellItemRequestItemId = '';
                shellItemRequestInFlight = false;
            }
            return item;
        });
        shellItemRequestPromise = sharedPromise;
        return sharedPromise;
    }

    // The artist-page module reuses this same cached/in-flight lookup instead of
    // issuing a second Users/{id}/Items/{artistId} request on every route visit.
    window.__topSongsGetCurrentItemInfo = function (itemId) {
        itemId = String(itemId || '');
        if (!itemId || getRouteItemId() !== itemId) return Promise.resolve(null);
        // Do not make the artist script wait for the next 700ms poll to notice a
        // freshly changed route; initialize the loader's route state immediately.
        if (itemId !== shellRouteItemId) ensureShellForCurrentRoute(true);
        if (itemId !== shellRouteItemId) return Promise.resolve(null);
        return requestShellItemInfo(itemId);
    };

    function ensureShellForCurrentRoute(suppressArtistRouteNotify) {
        var itemId = getRouteItemId();
        if (itemId !== shellRouteItemId) {
            shellRouteItemId = itemId;
            shellRouteGeneration++;
            shellItem = null;
            shellItemRequestInFlight = false;
            shellItemRequestPromise = null;
            shellItemRequestItemId = '';
            shellItemRetryAt = 0;
            shellItemRetryCount = 0;
            Array.prototype.slice.call(document.querySelectorAll('.topSongsArtistSection')).forEach(function (node) {
                if (!itemId || String(node.dataset.topSongsArtistId || '') !== String(itemId)) node.remove();
            });
            // Known artist: no need to ask Emby what this page is.
            if (itemId && rememberedArtist(itemId)) {
                shellItem = { Id: itemId, Type: 'MusicArtist', __topSongsRemembered: true };
                recordActivity('rememberedArtistHits');
            }
            // Normally this is the one route-change signal used by the artist module.
            // Its own metadata getter can synchronize a just-changed route without
            // recursively scheduling a second startup cycle.
            if (suppressArtistRouteNotify !== true) notifyArtistPageRoute(true);
        }
        if (!itemId) return;

        var generation = shellRouteGeneration;
        if (shellItem && shellItem.Type === 'MusicArtist') {
            probeShellPlacement(itemId, generation);
            return;
        }
        if (shellItem && shellItem.Type && shellItem.Type !== 'MusicArtist') return;
        if (shellItemRequestInFlight || Date.now() < shellItemRetryAt) return;
        requestShellItemInfo(itemId);
    }

    // Same 700 ms check: if the artist script has not picked up the current section
    // (for example Emby replaced the view and the shell was rebuilt), hand it over.
    // Only does work when a section is waiting; otherwise it is a couple of lookups.
    function superviseCurrentShell() {
        var itemId = getRouteItemId();
        if (!itemId || itemId !== shellRouteItemId || !shellItem || shellItem.Type !== 'MusicArtist') return;
        if (!window.__topSongsArtistPageInitialized) return;
        var parent = findVisibleDetailsContent();
        var shell = parent && currentShellFor(parent, itemId);
        if (!shell) return;
        if (shell.dataset.topSongsRendererReady !== 'true') {
            var created = Number(shell.dataset.topSongsShellCreatedAt) || 0;
            var now = Date.now();
            // Give the artist script ~1 s to adopt it normally, then retry every ~1.4 s.
            if (now - created < 1000 || now - (shell._topSongsAdoptAttemptAt || 0) < 1400) return;
            shell._topSongsAdoptAttemptAt = now;
            recordActivity('shellAdoptions');
            if (typeof window.__topSongsAdoptShell === 'function') window.__topSongsAdoptShell(itemId);
            return;
        }
        ensureInlineLink();
    }

    // On a fresh browser start Emby's ApiClient/sign-in is often not ready when this
    // loader runs, and the backoff retries (0.5, 1, 2, 4, 8 s...) could leave the
    // first artist page empty until a refresh. Start as soon as Emby is ready instead.
    var lastStartKickAt = 0;
    var startKicks = 0;
    function kickStartWhenEmbyReady() {
        if (hasLoadedArtistScript() || statusRequestInFlight || startKicks >= 30) return;
        var now = Date.now();
        if (now - lastStartKickAt < 2000) return;
        var api = getApiClient();
        if (!api || typeof api.ajax !== 'function' || typeof api.getUrl !== 'function') return;
        try { if (typeof api.accessToken === 'function' && !api.accessToken()) return; } catch (ignore) { }
        lastStartKickAt = now;
        startKicks++;
        if (retryTimer) {
            window.clearTimeout(retryTimer);
            retryTimer = 0;
        }
        recordActivity('fastStartKicks');
        loadTopSongsScript();
    }

    window.setInterval(function () {
        var pollStart = window.performance && typeof window.performance.now === 'function' ? window.performance.now() : Date.now();
        recordActivity('routePollTicks');
        try { kickStartWhenEmbyReady(); ensureShellForCurrentRoute(); superviseCurrentShell(); }
        catch (error) { console.warn('[TopSongs] Early section-shell check failed; it will retry.', error); }
        finally {
            var pollEnd = window.performance && typeof window.performance.now === 'function' ? window.performance.now() : Date.now();
            recordActivityDuration('routePollDuration', pollEnd - pollStart);
        }
    }, 700);

    function rebindShellsInMutationNode(node) {
        if (!node || node.nodeType !== 1) return;
        var host = node.matches && node.matches('.topSongsArtistSection')
            ? node
            : (node.closest && node.closest('.topSongsArtistSection'));
        if (host) ensureShellClickBinding(host);
        if (node.querySelectorAll) {
            Array.prototype.slice.call(node.querySelectorAll('.topSongsArtistSection')).forEach(ensureShellClickBinding);
        }
    }

    if (typeof MutationObserver === 'function' && document.documentElement) {
        var shellClickObserver = new MutationObserver(function (mutations) {
            var callbackStart = window.performance && typeof window.performance.now === 'function' ? window.performance.now() : Date.now();
            recordActivity('loaderMutationCallbacks');
            recordActivity('loaderMutationRecords', mutations.length);
            var addedNodeCount = 0;
            mutations.forEach(function (mutation) {
                addedNodeCount += (mutation.addedNodes && mutation.addedNodes.length) || 0;
                Array.prototype.slice.call(mutation.addedNodes || []).forEach(rebindShellsInMutationNode);
            });
            if (addedNodeCount) scheduleInlineLink();
            recordActivity('loaderMutationAddedNodes', addedNodeCount);
            var callbackEnd = window.performance && typeof window.performance.now === 'function' ? window.performance.now() : Date.now();
            recordActivityDuration('loaderMutationDuration', callbackEnd - callbackStart);
        });
        shellClickObserver.observe(document.documentElement, { childList: true, subtree: true });
    }

    function scheduleRetry(reason) {
        if (hasLoadedArtistScript() || statusRequestInFlight || retryTimer) return;

        var delay;
        if (retryCount < fastRetryDelays.length) {
            delay = fastRetryDelays[retryCount++];
        } else {
            if (!isItemRoute()) return;
            delay = slowRetryDelay;
        }

        if (reason && retryCount === 1) {
            console.warn('[TopSongs] Initial web-loader check failed; retrying automatically. ' + reason);
        }

        retryTimer = window.setTimeout(function () {
            retryTimer = 0;
            loadTopSongsScript();
        }, delay);
    }

    function loadTopSongsScript() {
        if (hasLoadedArtistScript() || statusRequestInFlight) return;
        var api = getApiClient();
        if (!api || typeof api.ajax !== 'function' || typeof api.getUrl !== 'function') {
            scheduleRetry("Emby's ApiClient is not ready yet.");
            return;
        }

        statusRequestInFlight = true;
        recordActivity('statusRequests');
        var request;
        try {
            request = api.ajax({ type: 'GET', url: api.getUrl('TopSongs/Status', {}), dataType: 'json' });
        } catch (error) {
            statusRequestInFlight = false;
            scheduleRetry('The status request could not be started.');
            return;
        }

        Promise.resolve(request).then(function (status) {
            statusRequestInFlight = false;
            if (hasLoadedArtistScript()) return;
            var available = status && (status.Available === true || status.available === true);
            window.__topSongsPluginAvailable = available === true;
            window.__topSongsPluginStatusAt = Date.now();
            if (!available) {
                scheduleRetry('The TopSongs status endpoint is not available yet.');
                return;
            }

            retryCount = 0;
            window.__topSongsArtistPageScriptInserted = true;
            recordActivity('artistScriptLoads');
            var script = document.createElement('script');
            script.async = true;
            script.src = api.getUrl('TopSongs/ArtistPageScript', { v: '1.2.1.0' });
            script.onload = function () {
                if (!window.__topSongsArtistPageInitialized) {
                    window.__topSongsArtistPageScriptInserted = false;
                    scheduleRetry('The endpoint loaded but the artist-page initializer did not run.');
                } else {
                    notifyArtistPageRoute(true);
                }
            };
            script.onerror = function () {
                window.__topSongsArtistPageScriptInserted = false;
                scheduleRetry('The embedded artist-page script request failed.');
            };
            (document.head || document.documentElement).appendChild(script);
        }).catch(function (error) {
            statusRequestInFlight = false;
            if (hasLoadedArtistScript()) return;
            var detail = error && (error.statusText || error.message) ? (error.statusText || error.message) : 'status request failed';
            scheduleRetry(detail);
        });
    }

    function retryOnEmbyLifecycleEvent() {
        recordActivity('lifecycleEvents');
        try { ensureShellForCurrentRoute(); } catch (ignore) { }
        notifyArtistPageRoute(true);
        if (hasLoadedArtistScript() || statusRequestInFlight) return;
        if (retryTimer) {
            window.clearTimeout(retryTimer);
            retryTimer = 0;
        }
        if (isItemRoute()) loadTopSongsScript();
    }

    function wrapHistoryMethod(methodName) {
        try {
            var original = window.history && window.history[methodName];
            if (typeof original !== 'function' || original.__topSongsShellWrapped) return;
            var wrapped = function () {
                var result = original.apply(this, arguments);
                window.setTimeout(retryOnEmbyLifecycleEvent, 0);
                return result;
            };
            wrapped.__topSongsShellWrapped = true;
            window.history[methodName] = wrapped;
        } catch (ignore) { }
    }

    wrapHistoryMethod('pushState');
    wrapHistoryMethod('replaceState');
    window.addEventListener('hashchange', retryOnEmbyLifecycleEvent);
    window.addEventListener('popstate', retryOnEmbyLifecycleEvent);
    window.addEventListener('pageshow', retryOnEmbyLifecycleEvent);
    window.addEventListener('focus', retryOnEmbyLifecycleEvent);
    document.addEventListener('visibilitychange', function () {
        if (!document.hidden) retryOnEmbyLifecycleEvent();
    });

    ensureShellForCurrentRoute();
    loadTopSongsScript();
}());
