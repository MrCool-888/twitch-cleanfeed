// ==UserScript==
// @name         Twitch Direct Session - Android Method
// @namespace    twitch-direct-session-browser-port
// @version      1.1.1
// @downloadURL  https://raw.githubusercontent.com/MrCool-888/twitch-direct-session-browser/main/twitch-direct-session.user.js
// @updateURL    https://raw.githubusercontent.com/MrCool-888/twitch-direct-session-browser/main/twitch-direct-session.user.js
// @homepageURL  https://github.com/MrCool-888/twitch-direct-session-browser
// @supportURL   https://github.com/MrCool-888/twitch-direct-session-browser/issues
// @description  Browser adaptation of twitch-patched: Android playback contexts, warm backups, and a consistent broadcast timeline
// @author       https://github.com/cleanlock/VideoAdBlockForTwitch#credits
// @match        *://*.twitch.tv/*
// @run-at       document-start
// @inject-into  page
// @license      GPL-3.0-only
// @grant        none
// ==/UserScript==
// Adapted 2026-10-07 from ryykitty/twitch-patched ac1d3cbe090a482a256219938e6b77211319c95b.
// Browser transport derives from the supplied ryanbr vaft v68.5.7 and local stability revision.
// Client-ad gate derives from scamorza/TwitchAdBlock a1453021869b43870e30fac4c384d09b60bef435.
// Copyright (c) 2020-present TwitchAdSolutions Contributors.
// Copyright (c) 2026-present TwitchAdBlock Contributors.
// Modified JavaScript port: 2026-10-07. GPL-3.0-only; retain accompanying LICENSE and NOTICE.

(function() {
    // Skip injection in nested frames that aren't legitimate Twitch embed contexts.
    // Twitch's main channel page has 5+ hidden cross-origin iframes (auth, analytics,
    // ad SDK, etc.) and userscript managers / uBO inject into all matching ones. Each
    // becomes a racing vaft instance that fights for player control. Only the top frame
    // hosts the player on twitch.tv/CHANNEL; nested auxiliary frames are noise.
    // Allow-list for nested-frame injection: Twitch's three documented embed contexts
    // (https://dev.twitch.tv/docs/embed/video-and-clips/) — preserves Twitch streams
    // embedded on third-party sites where vaft runs in an iframe whose parent is on
    // a different origin.
    // Use window.frameElement to detect nested frames — null on top frame, the iframe
    // element on a same-origin nested frame, throws on a cross-origin nested frame.
    // More reliable than 'window !== window.top' because Tampermonkey wraps window in a
    // proxy where the strict comparison can return true even on the top frame.
    let _isNested = false;
    try { _isNested = window.frameElement !== null; } catch (_e) { _isNested = true; }
    if (_isNested) {
        const _host = document.location.hostname;
        const _isEmbedContext = _host === 'player.twitch.tv' || _host === 'embed.twitch.tv' || document.location.pathname.startsWith('/embed/');
        if (!_isEmbedContext) {
            console.log('[DIRECT] vaft skipped — nested frame on ' + _host + document.location.pathname + ' (not a Twitch embed). If you see this on twitch.tv/CHANNEL top frame, please report.');
            return;
        }
    }
    // Skip injection on the Twitch clip editor — clips.twitch.tv host or /<channel>/clip/<slug> path.
    // Our fetch/Worker hooks and buffer monitor are aimed at the live channel player; on the
    // clip editor's seekable preview they have no ads to act on and have caused the preview
    // to freeze when the user drags the trim range. (Sync'd with TTV-AB v6.4.9.)
    {
        const _clipHost = document.location.hostname;
        const _clipPath = document.location.pathname || '';
        if (_clipHost === 'clips.twitch.tv' || /^\/[^/]+\/clip\/[^/]+/.test(_clipPath)) {
            console.log('[DIRECT] vaft skipped — clip editor page (' + _clipHost + _clipPath + ').');
            return;
        }
    }
    'use strict';
    const ourTwitchAdSolutionsVersion = 95;// Used to prevent conflicts with outdated versions of the scripts
    console.log('[DIRECT] TwitchAdSolutions vaft v' + ourTwitchAdSolutionsVersion + ' loading');
    if (typeof window.twitchAdSolutionsVersion !== 'undefined') {
        console.log('[DIRECT] CONFLICT: vaft v' + ourTwitchAdSolutionsVersion + ' skipped — another script already active (v' + window.twitchAdSolutionsVersion + '). Remove duplicate scripts.');
        return;
    }
    window.twitchAdSolutionsVersion = ourTwitchAdSolutionsVersion;
    const directAdStatus = { version: '1.1.1', playlist: 'waiting', clientAdGate: 'checking',
        channel: null, context: null, resolution: null, frameRate: null, reason: null, updatedAt: null };
    let directAdBannerTimer = null;
    window.twitchDirectStatus = () => ({ ...directAdStatus, probes: { ...directAdStatus.probes } });
    // Configuration and state shared between window and worker scopes
    function declareOptions(scope) {
        scope.AdSignifiers = ['stitched-ad', 'EXT-X-CUE-OUT', 'twitch-stitched', 'EXT-X-DATERANGE:CLASS="twitch-maf-ad"'];
        scope.KnownNonAdSignifiers = ['twitch-session', 'twitch-stream-source', 'twitch-ad-quartile', 'twitch-assignment'];
        scope.AdSegmentURLPatterns = ['/adsquared/', '/_404/', '/processing'];
        scope.TwitchAdUrlRewriteRegex = /(X-TV-TWITCH-AD(?:-[A-Z]+)*-URLS?=")[^"]*(")/g;
        scope.UriAttributeRegex = /URI="([^"]+)"/;
        scope.ClientID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
        scope.BackupPlayerTypes = ['mobile_feed', 'popout'];
        scope.BackupSearchBudgetMs = 2200;
        scope.BackupRequestTimeoutMs = 1200;
        scope.BackupQualityRetryMs = 15000;
        scope.FallbackPlayerType = 'site';
        scope.ForceAccessTokenPlayerType = '';
        scope.PreferLowQualityBackup = true;
        scope.StrictAdBlocking = true;
        scope.StrictAdPollMs = 2000;
        scope.StrictAdWaitLimitMs = 90000;
        scope.FastAutoplayFirstTry = false;
        scope.BackupSwapFirst = true;
        scope.DisableAdSpoofing = true;
        scope.RecoverFromSilentMute = true;
        scope.SoftReloadNoStrip = true;
        scope.DisablePostBreakWedge = false;
        scope.SkipPlayerReloadOnHevc = false;
        scope.AlwaysReloadPlayerOnAd = false;
        scope.ReloadPlayerAfterAd = true;
        scope.ReloadCooldownSeconds = 30;
        scope.DisableReloadCap = false;
        scope.DriftCorrectionRate = 0;
        scope.EarlyReloadPollThreshold = 5;
        scope.PinBackupPlayerType = true;
        scope.PlayerReloadMinimalRequestsTime = 1500;
        scope.PlayerReloadMinimalRequestsPlayerIndex = 0;
        scope.HasTriggeredPlayerReload = false;
        scope.StreamInfos = Object.create(null);
        scope.StreamInfosByUrl = Object.create(null);
        scope.GQLDeviceID = null;
        scope.GQLDeviceIDInvented = false;
        scope.ClientVersion = null;
        scope.ClientSession = null;
        scope.ClientIntegrityHeader = null;
        scope.AuthorizationHeader = undefined;
        scope.SimulatedAdsDepth = 0;
        scope.PlayerBufferingFix = false;
        scope.PlayerBufferingDelay = 600;
        scope.PlayerBufferingSameStateCount = 5;
        scope.PlayerBufferingDangerZone = 0.5;
        scope.PlayerBufferingDoPlayerReload = false;
        scope.PlayerBufferingMinRepeatDelay = 15000;
        scope.PlayerBufferingPrerollCheckEnabled = false;
        scope.PlayerBufferingPrerollCheckOffset = 5;
        scope.V2API = false;
        scope.IsAdStrippingEnabled = true;
        scope.AdSegmentCache = new Map();
        scope.AllSegmentsAreAdSegments = false;
        scope.StreamInfoMaxAgeMs = 30 * 60 * 1000;
    }
    function pruneStreamInfos() {
        const now = Date.now();
        for (const channelName in StreamInfos) {
            const streamInfo = StreamInfos[channelName];
            if (!streamInfo || !streamInfo.LastSeenAt || (now - streamInfo.LastSeenAt) > StreamInfoMaxAgeMs) {
                if (streamInfo && streamInfo.Urls) {
                    for (const url in streamInfo.Urls) {
                        delete StreamInfosByUrl[url];
                    }
                }
                delete StreamInfos[channelName];
            }
        }
    }
    // Creates a new StreamInfo with the full field shape declared up-front.
    // When adding a new streamInfo field, declare it here with an appropriate
    // zero value so the complete shape is visible in one place.
    function createStreamInfo(channelName, encodingsM3u8, usherParams) {
        return {
            ChannelName: channelName, LastSeenAt: Date.now(), EncodingsM3U8: encodingsM3u8,
            UsherParams: usherParams, Urls: Object.create(null), ResolutionList: [],
            ModifiedM3U8: null, IsUsingModifiedM3U8: false, IsShowingAd: false, IsMidroll: false,
            BackupEncodingsM3U8Cache: [], BackupMasterFetchedAt: Object.create(null),
            BackupMasterRequests: Object.create(null), BackupPlaybackByQuality: Object.create(null),
            FailedBackupPlayerTypes: new Map(), LoggedBackupAdsByType: null,
            AdBreakGeneration: 0, PinnedBackupPlayerType: null, ActiveBackupPlayerType: null,
            LastPlayerReload: 0, DirectLanes: Object.create(null), DirectSnapshots: Object.create(null),
            DirectWatchTarget: null, DirectWarmTimer: 0, DirectWarmRunning: false,
            DirectProbeStatus: Object.create(null)
        };
    }
    function maskAsNative(fn, name) {
        fn.toString = () => 'function ' + name + '() { [native code] }';
        return fn;
    }
    // CSAI ad-request counters, keyed by type and split on whether a detected ad break was in
    // progress. The no-break tally is the point: an ad served while the m3u8 carried no markers
    // is one vaft never sees — nothing stripped, no backup searched, nothing else in the log.
    // The previous once-per-session latch could not surface that at all.
    const csaiRequestCounts = Object.create(null);
    function countCsaiRequest(csaiType, transport) {
        const inBreak = playerBufferState.inAdBreak === true;
        const c = csaiRequestCounts[csaiType] || (csaiRequestCounts[csaiType] = { inBreak: 0, noBreak: 0 });
        const n = inBreak ? ++c.inBreak : ++c.noBreak;
        // First, then every 10th. Both totals and the channel ride on every line so a dump
        // spanning several channels reads as a ratio without the whole session in hand.
        if (n !== 1 && n % 10 !== 0) { return; }
        const chan = playerBufferState.channelName ? ' on ' + playerBufferState.channelName : '';
        console.log('[DIRECT] CSAI ad request (' + transport + ') — type: ' + csaiType + chan
            + (inBreak ? ' during a detected break' : ' with NO break detected — vaft never saw this ad')
            + ' | this type so far: ' + c.noBreak + ' unseen, ' + c.inBreak + ' during breaks'
            + (n === 1 ? ' (client-side insertion, not blockable via m3u8)' : ''));
    }
    let isActivelyStrippingAds = false;
    let localStorageHookFailed = false;
    const twitchWorkers = [];
    let cachedRootNode = null;// Cached #root DOM element (never changes in React SPAs)
    let cachedPlayerRootDiv = null;// Cached .video-player element
    // One-shot flags for overlay-hide logs. Twitch's React tree re-mounts SDA
    // wrappers and ad-break cards constantly during an ad break, so the
    // hide-and-log fires hundreds of times. Log the first occurrence of each
    // hide type per page load, then stay silent — the hide itself still runs
    // on every tick via dataset-based dedup.
    let loggedSdaHide = false;
    // Strings used to detect and handle conflicting Twitch worker overrides (e.g. TwitchNoSub)
    const workerStringConflicts = [
        'twitch',
        'isVariantA'// TwitchNoSub
    ];
    const workerStringReinsert = [
        'isVariantA',// TwitchNoSub (prior to (0.9))
        'besuper/',// TwitchNoSub (0.9)
        '${patch_url}'// TwitchNoSub (0.9.1)
    ];
    // Walk the Worker prototype chain and remove conflicting overrides
    function getCleanWorker(worker) {
        let root = null;
        let parent = null;
        let proto = worker;
        while (proto) {
            const workerString = proto.toString();
            if (workerStringConflicts.some((x) => workerString.includes(x))) {
                if (parent !== null) {
                    // Another extension may have frozen Worker.prototype or set non-configurable
                    // [[Prototype]]; setPrototypeOf throws TypeError in that case. Catch per-link
                    // so a single foreign-frozen ring doesn't abort the whole chain walk.
                    try { Object.setPrototypeOf(parent, Object.getPrototypeOf(proto)); } catch {}
                }
            } else {
                if (root === null) {
                    root = proto;
                }
                parent = proto;
            }
            proto = Object.getPrototypeOf(proto);
        }
        return root;
    }
    function getWorkersForReinsert(worker) {
        const result = [];
        let proto = worker;
        while (proto) {
            const workerString = proto.toString();
            if (workerStringReinsert.some((x) => workerString.includes(x))) {
                result.push(proto);
            }
            proto = Object.getPrototypeOf(proto);
        }
        return result;
    }
    function reinsertWorkers(worker, reinsert) {
        let parent = worker;
        for (let i = 0; i < reinsert.length; i++) {
            // Per-link try-catch: a foreign extension that froze a single proto entry
            // shouldn't break the whole reinsertion chain. Skip the failing link, keep going.
            try { Object.setPrototypeOf(reinsert[i], parent); } catch {}
            parent = reinsert[i];
        }
        return parent;
    }
    function isValidWorker(worker) {
        const workerString = worker.toString();
        const hasConflict = workerStringConflicts.some((x) => workerString.includes(x));
        const hasReinsert = workerStringReinsert.some((x) => workerString.includes(x));
        if (hasConflict && !hasReinsert) {
            console.log('[DIRECT] Worker rejected — conflict string found: ' + workerStringConflicts.filter((x) => workerString.includes(x)).join(', '));
        }
        return !hasConflict || hasReinsert;
    }
    // Replace window.Worker to intercept Twitch's video worker and inject ad-blocking logic
    let injectedBlobUrl = null;
    let originalRevokeObjectURL = null;
    function hookWindowWorker() {
        // Prevent Twitch from revoking our injected worker blob URL
        if (!URL.revokeObjectURL.__tasMasked) {
            originalRevokeObjectURL = URL.revokeObjectURL;
            URL.revokeObjectURL = maskAsNative(function(url) {
                if (url === injectedBlobUrl) return;
                return originalRevokeObjectURL.call(this, url);
            }, 'revokeObjectURL');
            URL.revokeObjectURL.__tasMasked = true;
        }
        const reinsert = getWorkersForReinsert(window.Worker);
        const cleanWorker = getCleanWorker(window.Worker) || window.Worker;
        const newWorker = class Worker extends cleanWorker {
            constructor(twitchBlobUrl, options) {
                let isTwitchWorker = false;
                try {
                    isTwitchWorker = new URL(twitchBlobUrl).origin.endsWith('.twitch.tv');
                } catch {}
                if (!isTwitchWorker) {
                    super(twitchBlobUrl, options);
                    console.log('[DIRECT] Non-Twitch worker skipped: ' + twitchBlobUrl);
                    return;
                }
                // Pre-check: verify we can fetch the worker JS before injecting
                let prefetchedWorkerJs = null;
                try { prefetchedWorkerJs = getWasmWorkerJs(twitchBlobUrl); } catch {}
                if (!prefetchedWorkerJs) {
                    super(twitchBlobUrl, options);
                    console.log('[DIRECT] Failed to fetch worker JS — falling back to unmodified worker');
                    return;
                }
                // Blob already carries our hooks: re-injecting would install
                // hookWorkerFetch twice and double-process every m3u8 response.
                // Reuse it as-is, but still register below so its messages are heard.
                const alreadyHooked = prefetchedWorkerJs.includes('hookWorkerFetch');
                const newBlobStr = `
                    const pendingFetchRequests = new Map();
                    ${hasAdTags.toString()}
                    ${getMatchedAdSignifiers.toString()}
                    ${videoCodecFamily.toString()}
                    ${getStreamUrlForResolution.toString()}
                    ${getStreamVariantForResolution.toString()}
                    ${backupQualityScore.toString()}
                    ${isFullQualityBackup.toString()}
                    ${fetchBackupText.toString()}
                    ${probeBackupType.toString()}
                    ${searchSourceBackups.toString()}
                    ${findBackupStream.toString()}
                    ${createDirectHlsTools.toString()}
                    const DirectHls = createDirectHlsTools();
                    ${directSessionIsActive.toString()}
                    ${reportDirectAdStatus.toString()}
                    ${directProbeStatus.toString()}
                    ${directWaitDelay.toString()}
                    ${watchDirectBackup.toString()}
                    ${processDirectPlaylist.toString()}
                    ${processM3U8.toString()}
                    ${hookWorkerFetch.toString()}
                    ${declareOptions.toString()}
                    ${getAccessToken.toString()}
                    ${gqlRequest.toString()}
                    ${parseAttributes.toString()}
                    ${getWasmWorkerJs.toString()}
                    ${getServerTimeFromM3u8.toString()}
                    ${replaceServerTimeInM3u8.toString()}
                    ${pruneStreamInfos.toString()}
                    ${createStreamInfo.toString()}
                    const workerString = getWasmWorkerJs('${twitchBlobUrl.replaceAll("'", "%27")}');
                    declareOptions(self);
                    if (!self.__tasPruneInterval) {
                        self.__tasPruneInterval = setInterval(pruneStreamInfos, 5 * 60 * 1000);
                    }
                    ReloadPlayerAfterAd = ${ReloadPlayerAfterAd};
                    ReloadCooldownSeconds = ${ReloadCooldownSeconds};
                    DisableReloadCap = ${DisableReloadCap};
                    EarlyReloadPollThreshold = ${EarlyReloadPollThreshold};
                    PinBackupPlayerType = ${PinBackupPlayerType};
                    PreferLowQualityBackup = ${PreferLowQualityBackup};
                    StrictAdBlocking = ${StrictAdBlocking};
                    FastAutoplayFirstTry = ${FastAutoplayFirstTry};
                    BackupSwapFirst = ${BackupSwapFirst};
                    DisableAdSpoofing = ${DisableAdSpoofing};
                    SoftReloadNoStrip = ${SoftReloadNoStrip};
                    ForceAccessTokenPlayerType = '${ForceAccessTokenPlayerType}';
                    GQLDeviceID = ${GQLDeviceID ? "'" + GQLDeviceID + "'" : null};
                    AuthorizationHeader = ${AuthorizationHeader ? "'" + AuthorizationHeader + "'" : undefined};
                    ClientIntegrityHeader = ${ClientIntegrityHeader ? "'" + ClientIntegrityHeader + "'" : null};
                    ClientVersion = ${ClientVersion ? "'" + ClientVersion + "'" : null};
                    ClientSession = ${ClientSession ? "'" + ClientSession + "'" : null};
                    self.addEventListener('message', function(e) {
                        if (['UpdateClientVersion','UpdateClientSession','UpdateClientId','UpdateDeviceId','UpdateClientIntegrityHeader','UpdateAuthorizationHeader','FetchResponse','TriggeredPlayerReload','ReloadSkipped','SimulateAds','AllSegmentsAreAdSegments'].includes(e.data?.key)) e.stopImmediatePropagation();
                        if (e.data.key == 'UpdateClientVersion') {
                            ClientVersion = e.data.value;
                        } else if (e.data.key == 'UpdateClientSession') {
                            ClientSession = e.data.value;
                        } else if (e.data.key == 'UpdateClientId') {
                            ClientID = e.data.value;
                        } else if (e.data.key == 'UpdateDeviceId') {
                            GQLDeviceID = e.data.value;
                            GQLDeviceIDInvented = false;
                        } else if (e.data.key == 'UpdateClientIntegrityHeader') {
                            ClientIntegrityHeader = e.data.value;
                        } else if (e.data.key == 'UpdateAuthorizationHeader') {
                            AuthorizationHeader = e.data.value;
                        } else if (e.data.key == 'FetchResponse') {
                            const responseData = e.data.value;
                            if (pendingFetchRequests.has(responseData.id)) {
                                const { resolve, reject, timeoutId } = pendingFetchRequests.get(responseData.id);
                                clearTimeout(timeoutId);
                                pendingFetchRequests.delete(responseData.id);
                                if (responseData.error) {
                                    reject(new Error(responseData.error));
                                } else {
                                    // Create a Response object from the response data.
                                    // Response constructor only takes status/statusText/headers — url/redirected/type
                                    // must be defined on the instance. IVS WASM validates these (Spade/tracking
                                    // requests) and throws NetworkError if they're missing — TTV-AB v6.3.5 fix.
                                    const response = new Response(responseData.body, {
                                        status: responseData.status,
                                        statusText: responseData.statusText,
                                        headers: responseData.headers
                                    });
                                    try {
                                        Object.defineProperty(response, 'url', { value: responseData.url || '', configurable: true });
                                        Object.defineProperty(response, 'redirected', { value: !!responseData.redirected, configurable: true });
                                        Object.defineProperty(response, 'type', { value: responseData.type || 'basic', configurable: true });
                                    } catch {}
                                    resolve(response);
                                }
                            }
                        } else if (e.data.key == 'TriggeredPlayerReload') {
                            HasTriggeredPlayerReload = true;
                        } else if (e.data.key == 'ReloadSkipped') {
                            // Main thread refused the reload (player healthy) — clear the
                            // early-reload flags so we can re-fire if the player later stalls.
                            // Without this clear, the worker's EarlyReloadTriggered /
                            // EarlyReloadAwaitingResult flags stay set after a healthy-skip,
                            // blocking subsequent early-reload firings in the same break even
                            // if a later poll legitimately calls for one.
                            let cleared = false;
                            for (const channel in StreamInfos) {
                                const si = StreamInfos[channel];
                                if (si && si.EarlyReloadTriggered) {
                                    si.EarlyReloadTriggered = false;
                                    si.EarlyReloadAwaitingResult = false;
                                    si.EarlyReloadCount = Math.max(0, (si.EarlyReloadCount || 0) - 1);
                                    cleared = true;
                                }
                            }
                            if (cleared) {
                                console.log('[DIRECT] Reload skipped by main thread (player healthy) — early reload state cleared, can retry');
                            }
                        } else if (e.data.key == 'SimulateAds') {
                            SimulatedAdsDepth = e.data.value;
                            console.log('SimulatedAdsDepth: ' + SimulatedAdsDepth);
                        } else if (e.data.key == 'AllSegmentsAreAdSegments') {
                            AllSegmentsAreAdSegments = !AllSegmentsAreAdSegments;
                            console.log('AllSegmentsAreAdSegments: ' + AllSegmentsAreAdSegments);
                        }
                    });
                    hookWorkerFetch();
                    // Guard the eval — malformed workerString shouldn't silently break
                    // Twitch's player logic without a diagnostic. Worker stays alive on
                    // throw (vaft hooks installed above), but Twitch's logic wouldn't run.
                    try { eval(workerString); } catch (e) { console.error('[DIRECT] Worker eval failed — Twitch player logic not loaded:', e); }
                `;
                if (alreadyHooked) {
                    super(twitchBlobUrl, options);
                    console.log('[DIRECT] Worker already hooked — reusing without re-injection');
                } else {
                    console.log('[DIRECT] Worker intercepted — injecting ad-block hooks');
                    // Revoke previous blob URL to prevent memory accumulation across worker replacements
                    if (injectedBlobUrl && originalRevokeObjectURL) {
                        try { originalRevokeObjectURL.call(URL, injectedBlobUrl); } catch {}
                    }
                    injectedBlobUrl = URL.createObjectURL(new Blob([newBlobStr]));
                    super(injectedBlobUrl, options);
                }
                twitchWorkers.length = 0;
                twitchWorkers.push(this);
                for (const [key, value] of [['UpdateDeviceId', GQLDeviceID], ['UpdateClientVersion', ClientVersion],
                    ['UpdateClientSession', ClientSession], ['UpdateClientIntegrityHeader', ClientIntegrityHeader],
                    ['UpdateAuthorizationHeader', AuthorizationHeader]]) {
                    if (value) this.postMessage({ key, value });
                }
                this.addEventListener('message', (e) => {
                    if (e.data.key == 'UpdateAdBlockBanner') {
                        if (e.data.hasAds && !playerBufferState.inAdBreak) {
                            try { playerBufferState.preAdQualityLS = localStorage.getItem('video-quality'); } catch {}
                        }
                        const backupChanged = e.data.activeBackupPlayerType &&
                            e.data.activeBackupPlayerType !== playerBufferState.activeBackupPlayerType;
                        playerBufferState.activeBackupPlayerType = e.data.activeBackupPlayerType || null;
                        if (backupChanged) playerBufferState.lastBackupSwitchAt = Date.now();
                        updateAdblockBanner(e.data);
                        // Track backup stream switches (start and end of ad break)
                        if (e.data.hasAds !== !!playerBufferState.inAdBreak) {
                            playerBufferState.lastBackupSwitchAt = Date.now();
                            // Reset position tracking on ad-end so the stream switch gap isn't detected as a jump
                            if (!e.data.hasAds) {
                                playerBufferState.position = 0;
                            }
                        }
                        playerBufferState.inAdBreak = !!e.data.hasAds;
                        // Clear drift catch-up when ads start — don't run 1.1x during ad handling
                        if (e.data.hasAds && (driftCatchUpInterval || driftCatchUpTimeout)) {
                            if (driftCatchUpInterval) { clearInterval(driftCatchUpInterval); driftCatchUpInterval = null; }
                            if (driftCatchUpTimeout) { clearTimeout(driftCatchUpTimeout); driftCatchUpTimeout = null; }
                            try { getPlayerVideoElement().playbackRate = 1.0; } catch {}
                        }
                    } else if (e.data.key == 'PauseResumePlayer') {
                        doTwitchPlayerTask(true, false);
                    } else if (e.data.key == 'ReloadPlayer') {
                        doTwitchPlayerTask(false, true, e.data.kind);
                    }
                });
                this.addEventListener('message', async event => {
                    if (event.data.key == 'FetchRequest') {
                        const fetchRequest = event.data.value;
                        const responseData = await handleWorkerFetchRequest(fetchRequest);
                        this.postMessage({
                            key: 'FetchResponse',
                            value: responseData
                        });
                    }
                });
                // Worker crash recovery — IVS WASM worker can fire RuntimeError
                // (e.g. "index out of bounds") and die. A single crash fires multiple
                // error events; dedupe via a local flag. On first error, trigger a
                // hard reload via the main reload path — Twitch re-spawns the worker
                // as part of the new player instance, and existing reload cooldown
                // prevents runaway restart loops.
                let crashed = false;
                this.addEventListener('error', (e) => {
                    if (crashed) return;
                    crashed = true;
                    console.log('[DIRECT] IVS WASM worker crashed: ' + ((e && e.message) || 'unknown error') + ' — triggering hard reload to recover');
                    try { doTwitchPlayerTask(false, true, 'early'); } catch (err) {
                        console.log('[DIRECT] Worker crash recovery failed: ' + err.message);
                    }
                });
            }
        };
        let workerInstance = reinsertWorkers(newWorker, reinsert);
        Object.defineProperty(window, 'Worker', {
            get: function() {
                return workerInstance;
            },
            set: function(value) {
                if (isValidWorker(value)) {
                    workerInstance = value;
                } else {
                    console.log('Attempt to set twitch worker denied');
                }
            }
        });
    }
    function getWasmWorkerJs(twitchBlobUrl) {
        if (!getWasmWorkerJs.cache) {
            getWasmWorkerJs.cache = Object.create(null);
        }
        if (getWasmWorkerJs.cache[twitchBlobUrl]) {
            return getWasmWorkerJs.cache[twitchBlobUrl];
        }
        const req = new XMLHttpRequest();
        req.open('GET', twitchBlobUrl, false);
        req.overrideMimeType("text/javascript");
        req.send();
        const text = req.responseText;
        getWasmWorkerJs.cache[twitchBlobUrl] = text;
        return text;
    }
    // Hook fetch() in the worker scope to intercept m3u8 playlist requests and ad segments
    function hookWorkerFetch() {
        console.log('[DIRECT] hookWorkerFetch (direct session)');

        const realFetch = fetch;
        fetch = async function(url, options) {
            if (typeof url === 'string') {
                url = url.trimEnd();
                if ((StreamInfosByUrl[url] || /\.m3u8(?:$|[?#])/.test(url)) && !url.includes('/channel/hls/')) {
                    return new Promise(function(resolve, reject) {
                        const processAfter = async function(response) {
                            if (response.status === 200) {
                                resolve(new Response(await processM3U8(url, await response.text(), realFetch, options)));
                            } else {
                                resolve(response);
                            }
                        };
                        realFetch(url, options).then(function(response) {
                            return processAfter(response);
                        })['catch'](function(err) {
                            reject(err);
                        });
                    });
                } else if (url.includes('/channel/hls/') && !url.includes('picture-by-picture')) {
                    V2API = url.includes('/api/v2/');
                    const parsedUrl = new URL(url);
                    const channelName = parsedUrl.pathname.match(/([^\/]+)(?=\.\w+$)/)?.[0];
                    if (ForceAccessTokenPlayerType) {
                        // parent_domains is used to determine if the player is embeded and stripping it gets rid of fake ads
                        parsedUrl.searchParams.delete('parent_domains');
                        url = parsedUrl.toString();
                    }
                    return new Promise(function(resolve, reject) {
                        const processAfter = async function(response) {
                            if (response.status == 200) {
                                const encodingsM3u8 = await response.text();
                                const serverTime = getServerTimeFromM3u8(encodingsM3u8);
                                let streamInfo = StreamInfos[channelName];
                                const cachedNativeUrl = streamInfo?.EncodingsM3U8?.match(/^https?:[^\r\n ]+/m)?.[0];
                                if (cachedNativeUrl && await fetchBackupText(realFetch, cachedNativeUrl, BackupRequestTimeoutMs).catch(() => null) === null) {
                                    // The cached encodings are dead (the stream probably restarted)
                                    streamInfo = null;
                                }
                                if (streamInfo == null || streamInfo.EncodingsM3U8 == null) {
                                    // Clear reload-pending flag from a prior stream session — without this,
                                    // a reload triggered on the previous channel bleeds into the new channel's
                                    // cooldown calculation, blocking legitimate end-of-break reloads.
                                    HasTriggeredPlayerReload = false;
                                    console.log('[DIRECT] New stream session — channel: ' + channelName + ', API: ' + (V2API ? 'v2' : 'v1'));
                                    StreamInfos[channelName] = streamInfo = createStreamInfo(channelName, encodingsM3u8, parsedUrl.search);
                                    const lines = encodingsM3u8.split(/\r?\n/);
                                    for (let i = 0; i < lines.length - 1; i++) {
                                        if (lines[i].startsWith('#EXT-X-STREAM-INF') && /^https?:\/\//.test(lines[i + 1].trim())) {
                                            const attributes = parseAttributes(lines[i]);
                                            const resolution = attributes['RESOLUTION'];
                                            if (resolution) {
                                                const resolutionInfo = {
                                                    Resolution: resolution,
                                                    FrameRate: attributes['FRAME-RATE'],
                                                    Bandwidth: attributes['BANDWIDTH'],
                                                    AverageBandwidth: attributes['AVERAGE-BANDWIDTH'],
                                                    // || '' like the three below: CODECS is optional on a STREAM-INF line,
                                                    // and this entry is pushed whenever RESOLUTION is present. Leaving it
                                                    // undefined is what let a direct .startsWith() reader throw and hang the
                                                    // master-playlist fetch. Keep every field in this object string-valued.
                                                    Codecs: attributes['CODECS'] || '',
                                                    // AUDIO/VIDEO/SUBTITLES groups are copied onto the rewritten STREAM-INF
                                                    // line during HEVC→AVC fallback so the variant references matching media
                                                    // groups (mirrors TTV-AB v6.7.5 parser fix). Without these, the rewritten
                                                    // line keeps the original HEVC variant's group ids, which point at audio
                                                    // tracks the AVC backup may not carry — black screen / audio desync.
                                                    Audio: attributes['AUDIO'] || '',
                                                    Video: attributes['VIDEO'] || '',
                                                    Subtitles: attributes['SUBTITLES'] || '',
                                                    Url: lines[i + 1]
                                                };
                                                streamInfo.Urls[lines[i + 1]] = resolutionInfo;
                                                streamInfo.ResolutionList.push(resolutionInfo);
                                            }
                                            StreamInfosByUrl[lines[i + 1]] = streamInfo;
                                        }
                                    }
                                    if (streamInfo.ResolutionList.length === 0) {
                                        console.log('[DIRECT] No resolutions parsed from encodings m3u8 — Twitch may have changed the format');
                                    }

                                }
                                streamInfo.LastSeenAt = Date.now();
                                // Note: do NOT set streamInfo.LastPlayerReload here. It was previously
                                // set unconditionally on new stream session creation, which caused the
                                // first end-of-break reload of every new channel to be blocked by
                                // cooldown — the cooldown check treated the session-creation timestamp
                                // as a recent reload, even though no reload had actually occurred.
                                resolve(new Response(replaceServerTimeInM3u8(streamInfo.IsUsingModifiedM3U8 ? streamInfo.ModifiedM3U8 : streamInfo.EncodingsM3U8, serverTime)));
                            } else {
                                resolve(response);
                            }
                        };
                        realFetch(url, options).then(function(response) {
                            return processAfter(response);
                        })['catch'](function(err) {
                            reject(err);
                        });
                    });
                }
            }
            return realFetch.apply(this, arguments);
        };
    }
    function getServerTimeFromM3u8(encodingsM3u8) {
        if (V2API) {
            const matches = encodingsM3u8.match(/#EXT-X-SESSION-DATA:DATA-ID="SERVER-TIME",VALUE="([^"]+)"/);
            return matches && matches.length > 1 ? matches[1] : null;
        }
        const matches = encodingsM3u8.match(/SERVER-TIME="([0-9.]+)"/);
        return matches && matches.length > 1 ? matches[1] : null;
    }
    function replaceServerTimeInM3u8(encodingsM3u8, newServerTime) {
        if (V2API) {
            return newServerTime ? encodingsM3u8.replace(/(#EXT-X-SESSION-DATA:DATA-ID="SERVER-TIME",VALUE=")[^"]+(")/, `$1${newServerTime}$2`) : encodingsM3u8;
        }
        return newServerTime ? encodingsM3u8.replace(/(SERVER-TIME=")[0-9.]+"/, `SERVER-TIME="${newServerTime}"`) : encodingsM3u8;
    }
    function hasAdTags(textStr) {
        return AdSignifiers.some((s) => s && textStr.includes(s));
    }
    // Spoof ad completion to Twitch's GQL endpoint when an ad break is detected.
    // Twitch's player would normally fire video_ad_impression / video_ad_quartile_complete
    // / video_ad_pod_complete beacons as the ad plays. With ad-blocking, those beacons
    // never fire. Spoofing them mimics the "ad played normally" signal, potentially
    // reducing detection escalation. RADS-token extracted from the stitched-ad DATERANGE
    // line. Failures swallowed — never block normal ad-block flow.

    function getMatchedAdSignifiers(textStr) {
        return AdSignifiers.filter((s) => textStr.includes(s));
    }
    // Remove ad segments from an m3u8 playlist and cache their URLs for replacement

    // Find the closest matching stream URL for a given resolution from a master m3u8
    // Video codec family from an m3u8 CODECS attribute. Returns 'unknown' for a missing or
    // unrecognised attribute rather than throwing — a variant without CODECS used to blow up
    // the raw .startsWith() checks below and hang the master-playlist fetch. Ported from
    // testing v674. Serialized into the worker blob — must not reference outer-scope variables.
    function videoCodecFamily(codecs) {
        if (!codecs) return 'unknown';
        // Scan every comma-separated entry rather than assuming the video codec is listed
        // first — an audio-first CODECS value would otherwise silently classify 'unknown'.
        const parts = String(codecs).toLowerCase().split(',');
        for (let i = 0; i < parts.length; i++) {
            const c = parts[i].trim();
            if (c.startsWith('avc')) return 'avc';
            if (c.startsWith('hev') || c.startsWith('hvc')) return 'hevc';
            if (c.startsWith('av0')) return 'av1';
        }
        return 'unknown';
    }
    // Match the codec as well as dimensions: an AVC backup must not be fed into
    // an HEVC/AV1 decoder. Ignore audio-only and malformed master entries.
    function getStreamVariantForResolution(master, target) {
        const lines = master.split(/\r?\n/);
        const [tw, th] = String(target.Resolution).split('x').map(Number);
        if (!(tw > 0 && th > 0)) return null;
        const family = videoCodecFamily(target.Codecs);
        const codecKey = (target.Codecs || '').split(',').map(c => c.trim()).find(c => /^(?:avc1|hvc1|hev1|av01)/i.test(c))?.slice(0, 4).toLowerCase();
        if (family === 'unknown') return null;
        const candidates = [];
        for (let i = 0; i < lines.length - 1; i++) {
            if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
            const attrs = parseAttributes(lines[i]);
            const [w, h] = String(attrs.RESOLUTION || '').split('x').map(Number);
            const next = lines[i + 1].trim();
            if (!(w > 0 && h > 0) || !/^https?:\/\//.test(next) ||
                videoCodecFamily(attrs.CODECS) !== family ||
                !(attrs.CODECS || '').split(',').some(c => c.trim().slice(0, 4).toLowerCase() === codecKey)) continue;
            candidates.push({ Url: next, Resolution: `${w}x${h}`,
                FrameRate: Number(attrs['FRAME-RATE']) || 0, Codecs: attrs.CODECS,
                Area: w * h, Exact: w === tw && h === th });
        }
        const tf = Number(target.FrameRate) || 0;
        candidates.sort((a, b) => Number(b.Exact) - Number(a.Exact) ||
            Math.abs(a.Area - tw * th) - Math.abs(b.Area - tw * th) ||
            Math.abs(a.FrameRate - tf) - Math.abs(b.FrameRate - tf));
        return candidates[0] || null;
    }
    function getStreamUrlForResolution(master, target) {
        return getStreamVariantForResolution(master, target)?.Url || null;
    }
    function backupQualityScore(candidate, target) {
        const [w, h] = String(target.Resolution).split('x').map(Number);
        const tf = Number(target.FrameRate) || 0;
        const v = candidate.variant;
        // Resolution dominates; frame rate breaks ties between similar variants.
        return Math.min(1, v.Area / (w * h)) * 1000 +
            (tf ? Math.min(1, v.FrameRate / tf) : 1) * 100;
    }
    function isFullQualityBackup(candidate, target) {
        return !!candidate && candidate.variant.Resolution === target.Resolution &&
            (!Number(target.FrameRate) || candidate.variant.FrameRate >= Number(target.FrameRate) - 0.1);
    }
    // Covers both headers and body. The race also bounds a fetch implementation
    // that ignores AbortSignal; its eventual rejection still has a handler.
    async function fetchBackupText(realFetch, url, timeoutMs, requestOptions = {}) {
        const controller = new AbortController();
        const callerSignal = requestOptions?.signal;
        const cancel = () => controller.abort();
        if (callerSignal?.aborted) cancel();
        else callerSignal?.addEventListener('abort', cancel, { once: true });
        let timer;
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => {
                controller.abort();
                reject(new Error('Backup playlist timeout'));
            }, Math.max(1, timeoutMs));
        });
        try {
            return await Promise.race([(async () => {
                const response = await realFetch(url, { ...requestOptions, signal: controller.signal });
                if (!response.ok) throw new Error('Backup HTTP ' + response.status);
                return await response.text();
            })(), timeout]);
        } finally { clearTimeout(timer); callerSignal?.removeEventListener('abort', cancel); }
    }
    async function probeBackupType(info, type, target, realFetch, deadline, generation) {
        const remaining = () => {
            const ms = Math.min(BackupRequestTimeoutMs, deadline - Date.now());
            if (ms <= 0) throw new Error('Backup search budget exhausted');
            return ms;
        };
        let probeStage = "token";
        directProbeStatus(info, type, "checking");
        const failedAt = info.FailedBackupPlayerTypes.get(type);
        if (failedAt && Date.now() - failedAt < 3000) { directProbeStatus(info, type, "cooldown"); return null; }
        try {
            let master = info.BackupEncodingsM3U8Cache[type];
            if (!master || Date.now() - (info.BackupMasterFetchedAt[type] || 0) > 120000) {
                // Several native renditions can poll together. Share the token/master
                // request, but fetch each rendition's media playlist separately.
                let pending = info.BackupMasterRequests[type];
                if (!pending) {
                    pending = (async () => {
                        const tokenResponse = await getAccessToken(info.ChannelName, type, remaining());
                        if (!tokenResponse.ok) throw new Error('Token HTTP ' + tokenResponse.status);
                        const payload = await tokenResponse.json();
                        const token = payload?.data?.streamPlaybackAccessToken || payload?.streamPlaybackAccessToken;
                        if (!token?.signature || !token?.value) throw new Error('Missing playback token');
                        const masterUrl = new URL('https://usher.ttvnw.net/api/' + (V2API ? 'v2/' : '') +
                            'channel/hls/' + info.ChannelName + '.m3u8' + info.UsherParams);
                        masterUrl.searchParams.set('sig', token.signature);
                        masterUrl.searchParams.set('token', token.value);
                        probeStage = "master";
                        const text = await fetchBackupText(realFetch, masterUrl.href, remaining());
                        if (info.AdBreakGeneration === generation) {
                            info.BackupEncodingsM3U8Cache[type] = text;
                            info.BackupMasterFetchedAt[type] = Date.now();
                        }
                        return text;
                    })();
                    info.BackupMasterRequests[type] = pending;
                }
                try { master = await pending; }
                finally {
                    if (info.BackupMasterRequests[type] === pending) delete info.BackupMasterRequests[type];
                }
            }
            if (info.AdBreakGeneration !== generation || !directSessionIsActive(info)) return null;
            const variant = getStreamVariantForResolution(master, target);
            if (!variant) { directProbeStatus(info, type, "no-compatible-rendition"); return null; }
            probeStage = "media";
            const text = await fetchBackupText(realFetch, variant.Url, remaining());
            if (info.AdBreakGeneration !== generation || !directSessionIsActive(info)) return null;
            const playlist = DirectHls.parse(text, variant.Url);
            if (!playlist.supported || playlist.ads || playlist.ended || !playlist.segments.length ||
                playlist.segments.some(segment => segment.liveSequence === null)) {
                directProbeStatus(info, type, !playlist.supported ? "unsupported-media" : playlist.ads ? "backup-has-ads" :
                    playlist.ended ? "ended" : "missing-live-sequence");
                // Keep the master: ad markers in a media playlist do not expire its token.
                info.LoggedBackupAdsByType ||= new Set();
                if (!info.LoggedBackupAdsByType.has(type)) {
                    info.LoggedBackupAdsByType.add(type);
                    console.log('[DIRECT] Backup stream (' + type + ') unavailable or also has ads');
                }
                return null;
            }
            info.FailedBackupPlayerTypes.delete(type);
            directProbeStatus(info, type, "clean");
            return { type, variant, text, playlist };
        } catch (error) {
            if (info.AdBreakGeneration === generation) {
                info.FailedBackupPlayerTypes.set(type, Date.now());
                delete info.BackupEncodingsM3U8Cache[type];
                delete info.BackupMasterFetchedAt[type];
            }
            directProbeStatus(info, type, probeStage + "-failed");
            console.log('[DIRECT] Backup ' + type + ': ' + error.message);
            return null;
        }
    }
    async function searchSourceBackups(info, target, realFetch, deadline, generation, exclude) {
        const types = BackupPlayerTypes.filter(t => t !== exclude && t !== 'autoplay');
        // Only a Source-capable type may be pinned ahead of the quality search.
        const pinned = info.PinnedBackupPlayerType;
        if (PinBackupPlayerType && ['mobile_feed', 'popout'].includes(pinned) && types.includes(pinned)) {
            types.splice(types.indexOf(pinned), 1);
            types.unshift(pinned);
        }
        let best = null;
        // Two simultaneous probes keep the search short without a burst of every type.
        for (let i = 0; i < types.length && Date.now() < deadline; i += 2) {
            const probes = types.slice(i, i + 2).map(type =>
                probeBackupType(info, type, target, realFetch, deadline, generation));
            const all = Promise.all(probes);
            // A slow competing endpoint must not delay an already-clean full-quality
            // result. Every remaining probe still has a timeout/rejection handler.
            const firstFull = Promise.any(probes.map(async pending => {
                const candidate = await pending;
                if (!isFullQualityBackup(candidate, target)) throw new Error('Not full quality');
                return candidate;
            })).then(candidate => [candidate]).catch(() => all);
            const candidates = await Promise.race([all, firstFull]);
            for (const candidate of candidates) {
                if (candidate && (!best || backupQualityScore(candidate, target) > backupQualityScore(best, target))) best = candidate;
            }
            if (isFullQualityBackup(best, target)) break;
        }
        return best;
    }
    async function findBackupStream(info, target, realFetch) {
        const generation = info.AdBreakGeneration;
        const key = target.Resolution + '/' + target.FrameRate + '/' + videoCodecFamily(target.Codecs);
        const state = info.BackupPlaybackByQuality[key] ||= {
            activeType: null, inFlight: null, lastResult: null, resultAt: 0,
            lastQualityProbeAt: 0, upgradeType: null, upgradeProbe: null
        };
        if (state.inFlight) return state.inFlight;
        // Coalesce simultaneous requests, never replay a playlist for whole seconds.
        if (state.lastResult && Date.now() - state.resultAt < 250) return state.lastResult;
        const search = (async () => {
            const deadline = Date.now() + BackupSearchBudgetMs;
            const activeType = state.upgradeType || state.activeType;
            state.upgradeType = null;
            let active = activeType ? await probeBackupType(info, activeType, target, realFetch, deadline, generation) : null;
            if (!active && state.activeType && activeType !== state.activeType && Date.now() < deadline) {
                active = await probeBackupType(info, state.activeType, target, realFetch, deadline, generation);
            }
            if (active) {
                state.activeType = active.type;
                if (!isFullQualityBackup(active, target) && !state.upgradeProbe &&
                    Date.now() - state.lastQualityProbeAt >= BackupQualityRetryMs) {
                    // Re-test full-quality types in the background while the clean
                    // lower-quality stream keeps playing. Commit on a fresh later poll.
                    state.lastQualityProbeAt = Date.now();
                    const upgrade = searchSourceBackups(info, target, realFetch,
                        Date.now() + BackupSearchBudgetMs, generation, active.type);
                    state.upgradeProbe = upgrade;
                    upgrade.then(candidate => {
                        if (candidate && directSessionIsActive(info) && info.AdBreakGeneration === generation &&
                            backupQualityScore(candidate, target) > backupQualityScore(active, target)) {
                            state.upgradeType = candidate.type;
                        }
                    }).catch(() => {}).finally(() => {
                        if (state.upgradeProbe === upgrade) state.upgradeProbe = null;
                    });
                }
                return active;
            }
            state.lastQualityProbeAt = Date.now();
            const sourceProbe = searchSourceBackups(info, target, realFetch, deadline, generation, activeType);
            const fallbackProbe = PreferLowQualityBackup && Date.now() < deadline && activeType !== 'autoplay' ?
                probeBackupType(info, 'autoplay', target, realFetch, deadline, generation) : Promise.resolve(null);
            let best = await sourceProbe;
            if (!best) best = await fallbackProbe;
            if (best && info.AdBreakGeneration === generation) state.activeType = best.type;
            return best;
        })();
        state.inFlight = search;
        try {
            const result = await search;
            if (info.AdBreakGeneration === generation) {
                state.lastResult = result;
                state.resultAt = Date.now();
            }
            return result;
        } finally { if (state.inFlight === search) state.inFlight = null; }
    }

    // JavaScript adaptation of HlsPlaylist/LiveWindow from ryykitty/twitch-patched,
    // commit ac1d3cbe090a482a256219938e6b77211319c95b. GPL-3.0; see accompanying NOTICE.
    function createDirectHlsTools() {
        const MAX_SEQUENCE = Number.MAX_SAFE_INTEGER - 256;
        function attributes(input) {
            const result = Object.create(null);
            let start = 0, quoted = false;
            for (let i = 0; i <= input.length; i++) {
                if (input[i] === '"') quoted = !quoted;
                if (i !== input.length && (input[i] !== ',' || quoted)) continue;
                const part = input.slice(start, i).trim(), equals = part.indexOf('=');
                if (equals <= 0) throw new Error('Malformed HLS attributes');
                const key = part.slice(0, equals).trim();
                let value = part.slice(equals + 1);
                if (value.startsWith('"')) {
                    if (!value.endsWith('"') || value.length < 2) throw new Error('Unclosed HLS string');
                    value = value.slice(1, -1);
                }
                if (Object.hasOwn(result, key)) throw new Error('Duplicate HLS attribute');
                result[key] = value;
                start = i + 1;
            }
            if (quoted) throw new Error('Unclosed HLS attributes');
            return result;
        }
        function resolve(base, relative) {
            const url = new URL(relative, base), host = url.hostname.toLowerCase();
            const allowed = ['ttvnw.net', 'jtvnw.net', 'twitch.tv'].some(root => host === root || host.endsWith('.' + root));
            if (url.protocol !== 'https:' || url.username || url.password ||
                (url.port && url.port !== '443') || !allowed) throw new Error('Unsupported media host');
            return url.href;
        }
        function sequence(value) {
            if (!/^\d+$/.test(value)) throw new Error('Invalid broadcast sequence');
            const n = Number(value);
            if (!Number.isSafeInteger(n) || n > MAX_SEQUENCE) throw new Error('Invalid broadcast sequence');
            return n;
        }
        function parse(text, base) {
            const out = { variants: [], segments: [], hints: [], ads: false, ended: false,
                targetDuration: 2, version: 3, mediaSequence: null, supported: text.startsWith('#EXTM3U') };
            if (text.length > 512 * 1024) { out.supported = false; return out; }
            let seq = null, date = -1, duration = 0, map = null, variant = null, discontinuity = false, cueOut = false, adSegment = false;
            const value = line => line.slice(line.indexOf(':') + 1);
            try {
                for (const raw of text.split('\n')) {
                    const line = raw.trim();
                    if (!line) continue;
                    if (line.startsWith('#EXT-X-STREAM-INF:')) variant = attributes(value(line));
                    else if (line.startsWith('#EXT-X-VERSION:')) out.version = Number(value(line));
                    else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) out.mediaSequence = sequence(value(line));
                    else if (line.startsWith('#EXT-X-TWITCH-LIVE-SEQUENCE:')) seq = sequence(value(line));
                    else if (line === '#EXT-X-DISCONTINUITY') { seq = null; discontinuity = true; }
                    else if (line.startsWith('#EXT-X-CUE-OUT')) { cueOut = true; out.ads = true; }
                    else if (line.startsWith('#EXT-X-CUE-IN')) cueOut = false;
                    else if (line.startsWith('#EXT-X-TWITCH-PREFETCH:')) {
                        out.hints.push({ liveSequence: cueOut ? null : seq, uri: resolve(base, value(line)), map });
                        if (seq !== null) seq++;
                    } else if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
                        date = Date.parse(value(line));
                        if (!Number.isFinite(date)) throw new Error('Invalid program date');
                    } else if (line.startsWith('#EXT-X-TARGETDURATION:')) out.targetDuration = Number(value(line));
                    else if (line.startsWith('#EXTINF:')) {
                        const parts = value(line).split(',');
                        duration = Number(parts[0]);
                        adSegment = cueOut || /^ad(?:$|[-_ ])/i.test(parts.slice(1).join(','));
                        if (adSegment) out.ads = true;
                    } else if (line.startsWith('#EXT-X-MAP:')) {
                        const attrs = attributes(value(line));
                        if (!attrs.URI || attrs.BYTERANGE) throw new Error('Unsupported initialization map');
                        map = resolve(base, attrs.URI);
                    } else if (line.startsWith('#EXT-X-KEY:') && attributes(value(line)).METHOD !== 'NONE') out.supported = false;
                    else if (/^#EXT-X-(?:BYTERANGE|PART|SKIP|PRELOAD-HINT):/.test(line)) out.supported = false;
                    else if (line === '#EXT-X-ENDLIST') out.ended = true;
                    else if (line.startsWith('#EXT-X-DATERANGE:')) {
                        attributes(value(line));
                        // A generic twitch-trigger is also present on clean live
                        // playlists. Only actual ad identifiers/attributes count.
                        if (/stitched-ad|twitch-maf-ad|X-TV-TWITCH-AD/.test(line)) out.ads = true;
                    } else if (!line.startsWith('#')) {
                        const uri = resolve(base, line);
                        if (variant) {
                            const [width, height] = (variant.RESOLUTION || '0x0').split('x').map(Number);
                            const fps = Number(variant['FRAME-RATE'] || 0), bandwidth = Number(variant.BANDWIDTH || 0);
                            const codec = (variant.CODECS || '').toLowerCase().split(',').map(c => c.trim())
                                .find(c => /^(?:avc1|hvc1|hev1|av01)/.test(c));
                            if (!Number.isInteger(width) || !Number.isInteger(height) || width < 0 || height < 0 ||
                                width > 8192 || height > 8192 || !Number.isFinite(fps) || fps < 0 || fps > 240 ||
                                !Number.isFinite(bandwidth) || bandwidth < 0 || (height > 0 && !codec)) throw new Error('Unsupported rendition');
                            out.variants.push({ uri, width, height, frameRate: fps, bandwidth, codec: codec?.slice(0, 4) || variant.CODECS || '',
                                attributes: variant });
                            variant = null;
                        } else {
                            if (!(duration > 0 && duration <= 60) || !Number.isFinite(duration)) throw new Error('Invalid segment duration');
                            const blocked = adSegment || /\/(?:adsquared|_404|processing)\//.test(new URL(uri).pathname);
                            if (blocked) out.ads = true;
                            out.segments.push({ liveSequence: blocked ? null : seq, uri, duration, map, date, discontinuity });
                            if (seq !== null) seq++;
                            duration = 0; date = -1; discontinuity = false; adSegment = false;
                        }
                    }
                }
            } catch { out.supported = false; }
            if (!Number.isInteger(out.targetDuration) || out.targetDuration < 1 || out.targetDuration > 60 ||
                !Number.isInteger(out.version) || out.version < 1 || out.version > 20 || out.variants.length > 64 ||
                out.segments.length > 256 || out.hints.length > 8 || variant || duration !== 0) out.supported = false;
            return out;
        }
        class LiveWindow {
            constructor() {
                this.live = new Map(); this.window = []; this.hints = new Map(); this.emittedHints = new Map();
                this.lastLive = null; this.nextDate = -1; this.discontinuities = 0; this.seconds = 0; this.version = 3;
            }
            absorb(playlist, source) {
                this.version = Math.max(this.version, playlist.version);
                for (const segment of playlist.segments) {
                    const number = segment.liveSequence;
                    if (number === null || (this.lastLive !== null && number <= this.lastLive)) continue;
                    if (!this.live.has(number) || source === 'main') this.live.set(number, { segment, source });
                }
                while (this.live.size > 256) this.live.delete(Math.min(...this.live.keys()));
                for (const hint of playlist.hints) {
                    if (hint.liveSequence === null || (this.lastLive !== null && hint.liveSequence <= this.lastLive)) continue;
                    if (!this.hints.has(hint.liveSequence) || source === 'main') this.hints.set(hint.liveSequence, { hint, source });
                }
                while (this.hints.size > 256) this.hints.delete(this.hints.keys().next().value);
            }
            acceptCleanBackup(playlist, source) {
                if (!playlist.supported || playlist.ads || playlist.ended || !playlist.segments.length ||
                    playlist.segments.some(s => s.liveSequence === null)) return false;
                this.absorb(playlist, source);
                this.advance();
                return this.window.length > 0;
            }
            advance() {
                let added = false;
                const numbers = [...this.live.keys()].sort((a, b) => a - b);
                for (const number of numbers) {
                    let { segment, source } = this.live.get(number);
                    this.live.delete(number);
                    if (this.lastLive !== null && number <= this.lastLive) continue;
                    const gap = this.lastLive !== null && number !== this.lastLive + 1;
                    if (gap) {
                        for (const item of this.window) if (item.discontinuity) this.discontinuities++;
                        this.window.length = 0; this.seconds = 0;
                        if (segment.date >= 0) this.nextDate = Math.max(this.nextDate, segment.date);
                    }
                    if (this.nextDate < 0 && segment.date >= 0) this.nextDate = segment.date;
                    const frozen = this.emittedHints.get(number);
                    if (frozen && frozen.hint.map === segment.map) {
                        segment = { ...segment, uri: frozen.hint.uri };
                        source = frozen.source;
                    }
                    const previous = this.window[this.window.length - 1];
                    const boundary = (gap && !previous) || !!previous && (gap || segment.discontinuity ||
                        previous.source !== source || previous.segment.map !== segment.map);
                    this.window.push({ sequence: number, segment, source, date: this.nextDate, discontinuity: boundary });
                    if (this.nextDate >= 0) this.nextDate += Math.round(segment.duration * 1000);
                    this.seconds += segment.duration;
                    while (this.window.length > 1 && (this.window.length > 60 || this.seconds - this.window[0].segment.duration >= 30)) {
                        const removed = this.window.shift();
                        this.seconds -= removed.segment.duration;
                        if (removed.discontinuity) this.discontinuities++;
                    }
                    this.lastLive = number;
                    added = true;
                }
                return added;
            }
            finish(primary, cleanBackupAccepted) {
                if (!cleanBackupAccepted && (primary.ads || primary.segments.some(s => s.liveSequence === null))) return null;
                return this.render(primary.targetDuration, primary.ended && !primary.ads);
            }
            render(declaredTarget = 2, ended = false) {
                const first = this.window[0];
                if (!first) return null;
                const target = Math.max(declaredTarget, ...this.window.map(item => Math.ceil(item.segment.duration)));
                const version = this.window.some(item => item.segment.map) ? Math.max(6, this.version) : this.version;
                const lines = ['#EXTM3U', '#EXT-X-VERSION:' + version, '#EXT-X-TARGETDURATION:' + target,
                    '#EXT-X-MEDIA-SEQUENCE:' + first.sequence, '#EXT-X-DISCONTINUITY-SEQUENCE:' + this.discontinuities];
                let lastMap = null;
                for (const item of this.window) {
                    if (item.discontinuity) lines.push('#EXT-X-DISCONTINUITY');
                    if (item === first || item.discontinuity) lines.push('#EXT-X-TWITCH-LIVE-SEQUENCE:' + item.sequence);
                    if (item.segment.map && (item.segment.map !== lastMap || item.discontinuity)) lines.push('#EXT-X-MAP:URI="' + item.segment.map + '"');
                    lastMap = item.segment.map;
                    if (item.date >= 0) lines.push('#EXT-X-PROGRAM-DATE-TIME:' + new Date(item.date).toISOString());
                    lines.push('#EXTINF:' + item.segment.duration + ',live', item.segment.uri);
                }
                const last = this.window[this.window.length - 1];
                if (!ended) {
                    for (let number = last.sequence + 1; number <= last.sequence + 2; number++) {
                        let hint = this.emittedHints.get(number);
                        if (!hint) {
                            hint = this.hints.get(number);
                            if (!hint || hint.hint.map !== last.segment.map) break;
                            this.emittedHints.set(number, hint);
                        }
                        lines.push('#EXT-X-TWITCH-PREFETCH:' + hint.hint.uri);
                    }
                }
                for (const hints of [this.hints, this.emittedHints]) for (const number of hints.keys()) {
                    if (this.lastLive !== null && number < this.lastLive - 64) hints.delete(number);
                }
                if (ended) lines.push('#EXT-X-ENDLIST');
                return lines.join('\n') + '\n';
            }
        }
        return { parse, attributes, resolve, LiveWindow };
    }

    const DirectHls = createDirectHlsTools();
    // Browser counterpart of the Android ad-eligibility gate, adapted from
    // scamorza/TwitchAdBlock a1453021869b43870e30fac4c384d09b60bef435 (MIT).
    function declineBrowserClientAds() {
        const key = Object.keys(window).find(name => /^webpackChunk/i.test(name));
        const queue = key && window[key];
        if (!queue || typeof queue.push !== 'function') return false;
        let requireModule = declineBrowserClientAds.queue === queue ? declineBrowserClientAds.requireModule : null;
        if (!requireModule) {
            const entry = [[Symbol('twitch-direct-session')], {}, require => { requireModule = require; }];
            queue.push(entry);
            const index = typeof queue.indexOf === 'function' ? queue.indexOf(entry) : -1;
            if (index >= 0) queue.splice(index, 1);
            if (!requireModule) return false;
            // Rechecking the gate should reuse the captured runtime instead of
            // registering another synthetic chunk every five seconds.
            declineBrowserClientAds.queue = queue;
            declineBrowserClientAds.requireModule = requireModule;
        }
        for (const [id, factory] of Object.entries(requireModule.m || {})) {
            const source = Function.prototype.toString.call(factory);
            if (!source.includes('startProcessingRequests') || !source.includes('declineReason')) continue;
            let exports;
            try { exports = requireModule(id); } catch { continue; }
            for (const name of Object.keys(exports || {})) {
                let manager;
                try { manager = exports[name]; } catch { continue; }
                if (typeof manager !== 'function' || typeof manager.startProcessingRequests !== 'function' ||
                    typeof manager.decline !== 'function') continue;
                if (manager.declineReason) return true;
                // Twitch's own existing refusal path; no fabricated ad JSON or
                // Turbo entitlement and no ad tracking beacons are injected.
                manager.decline('player_size', { sendEvent: false });
                if (manager.declineReason) {
                    console.log('[DIRECT] Browser client-ad manager declined');
                    return true;
                }
            }
        }
        return false;
    }
    function startBrowserClientAdBlock() {
        let attempts = 0;
        const attempt = () => {
            attempts++;
            let declined = false;
            try { declined = declineBrowserClientAds(); } catch {}
            directAdStatus.clientAdGate = declined ? 'declined' : 'unavailable';
            if (declined) {
                attempts = 0;
                // Twitch can replace/reset the manager on channel navigation.
                setTimeout(attempt, 5000);
            } else if (attempts < 240) setTimeout(attempt, 500);
            else {
                console.log('[DIRECT] Browser client-ad manager unavailable; client-side blocking unverified');
                setTimeout(attempt, 30000);
            }
        };
        attempt();
    }

    // Core ad-blocking logic: detect ads in m3u8, fetch backup streams, strip ad segments
    function directSessionIsActive(info) {
        return StreamInfos[info.ChannelName] === info && Date.now() - info.LastSeenAt < 12000;
    }
    function reportDirectAdStatus(info, target, status, type = null, variant = null, reason = null) {
        postMessage({ key: 'UpdateAdBlockBanner', hasAds: info.IsShowingAd,
            status, channel: info.ChannelName, reason,
            strict: StrictAdBlocking, probes: { ...info.DirectProbeStatus },
            activeBackupPlayerType: type,
            resolution: (variant || target)?.Resolution || null,
            frameRate: (variant || target)?.FrameRate || null,
            isStrippingAdSegments: false, numStrippedAdSegments: 0 });
    }
    function watchDirectBackup(info, target, realFetch) {
        info.DirectWatchTarget = target;
        if (info.DirectWarmTimer || info.DirectWarmRunning) return;
        const poll = async () => {
            info.DirectWarmTimer = 0;
            if (!directSessionIsActive(info)) return;
            info.DirectWarmRunning = true;
            const watched = info.DirectWatchTarget;
            try {
                const backup = await findBackupStream(info, watched, realFetch);
                if (backup && directSessionIsActive(info)) {
                    const key = watched.Resolution + '/' + watched.FrameRate + '/' + videoCodecFamily(watched.Codecs);
                    info.DirectSnapshots[key] = { backup, observed: Date.now() };
                    const keys = Object.keys(info.DirectSnapshots);
                    while (keys.length > 3) delete info.DirectSnapshots[keys.shift()];
                }
            } catch (error) { console.log('[DIRECT] Warm backup: ' + error.message); }
            finally {
                info.DirectWarmRunning = false;
                if (directSessionIsActive(info)) info.DirectWarmTimer = setTimeout(poll, 2000);
            }
        };
        info.DirectWarmTimer = setTimeout(poll, 0);
    }
    function directProbeStatus(info, type, state) {
        info.DirectProbeStatus[type] = { state, updatedAt: Date.now() };
    }
    function directWaitDelay(ms, signal) {
        return new Promise((resolve, reject) => {
            const fail = () => {
                clearTimeout(timer);
                signal?.removeEventListener('abort', fail);
                const error = new Error('Playback request cancelled'); error.name = 'AbortError'; reject(error);
            };
            const timer = setTimeout(() => { signal?.removeEventListener('abort', fail); resolve(); }, ms);
            if (signal?.aborted) fail();
            else signal?.addEventListener('abort', fail, { once: true });
        });
    }
    async function processM3U8(url, textStr, realFetch, options = {}) {
        const started = Date.now(), info = StreamInfosByUrl[url], target = info?.Urls[url];
        let nativeText = textStr;
        for (;;) {
            if (options.signal?.aborted) {
                const error = new Error('Playback request cancelled'); error.name = 'AbortError'; throw error;
            }
            if (info && (StreamInfos[info.ChannelName] !== info || StreamInfosByUrl[url] !== info)) {
                const error = new Error('Playback session replaced'); error.name = 'AbortError'; throw error;
            }
            const output = await processDirectPlaylist(url, nativeText, realFetch);
            const parsed = DirectHls.parse(output, url);
            if (!StrictAdBlocking || !(parsed.ads || hasAdTags(output))) return output;
            // No detected ad playlist crosses this boundary in strict mode.
            // Waiting cannot create a live feed when Twitch supplies only ads.
            if (Date.now() - started >= StrictAdWaitLimitMs) {
                if (info) reportDirectAdStatus(info, target, 'waiting', null, null, 'Clean-content wait timed out');
                throw new Error('No clean live content available; detected ad playlist withheld');
            }
            if (info) reportDirectAdStatus(info, target, 'waiting', null, null, 'Detected ad playlist withheld; retrying clean sources');
            await directWaitDelay(Math.min(StrictAdPollMs, StrictAdWaitLimitMs - (Date.now() - started)), options.signal);
            if (info) info.LastSeenAt = Date.now();
            try {
                nativeText = await fetchBackupText(realFetch, url,
                    Math.min(BackupRequestTimeoutMs, Math.max(1, StrictAdWaitLimitMs - (Date.now() - started))), options);
            } catch (error) {
                if (options.signal?.aborted) throw error;
                if (info) reportDirectAdStatus(info, target, 'waiting', null, null, 'Native playlist refresh failed; retrying');
            }
        }
    }
    async function processDirectPlaylist(url, textStr, realFetch) {
        const info = StreamInfosByUrl[url], target = info?.Urls[url];
        if (!info || !target) return textStr;
        info.LastSeenAt = Date.now();
        const primary = DirectHls.parse(textStr, url);
        if (!primary.supported || !primary.segments.length) {
            info.IsShowingAd = primary.ads || hasAdTags(textStr);
            info.ActiveBackupPlayerType = null;
            delete info.DirectLanes[url];
            reportDirectAdStatus(info, target, info.IsShowingAd ? 'unsupported' : 'native', null, null,
                'Playlist cannot be safely rewritten');
            return textStr;
        }
        watchDirectBackup(info, target, realFetch);
        const needsReplacement = primary.ads || primary.segments.some(s => s.liveSequence === null);
        const wasAd = info.IsShowingAd;
        info.IsShowingAd = primary.ads;
        info.IsMidroll = /"(?:MIDROLL|midroll)"/.test(textStr);
        // A negative background probe before the first media request must not
        // suppress the foreground preroll search for several more seconds.
        if (primary.ads && !wasAd) info.FailedBackupPlayerTypes.clear();
        if (primary.ads && !wasAd) console.log('[DIRECT] Ad detected — searching Android playback contexts');
        if (!primary.ads && wasAd) console.log('[DIRECT] Ad ended — returning to native media without reloading');
        const lane = info.DirectLanes[url] ||= { window: new DirectHls.LiveWindow(), latestPrimary: primary, latestNative: textStr, lastType: null };
        lane.latestPrimary = primary;
        lane.latestNative = textStr;
        lane.window.absorb(primary, 'main');
        lane.window.advance();
        let backupUsed = false;
        if (needsReplacement) {
            reportDirectAdStatus(info, target, 'searching');
            const key = target.Resolution + '/' + target.FrameRate + '/' + videoCodecFamily(target.Codecs);
            const warm = info.DirectSnapshots[key];
            if (warm && Date.now() - warm.observed <= 8000) {
                backupUsed = lane.window.acceptCleanBackup(warm.backup.playlist, warm.backup.type);
                if (backupUsed) { lane.lastType = warm.backup.type; lane.lastVariant = warm.backup.variant; }
            }
            if (!backupUsed) {
                const backup = await findBackupStream(info, target, realFetch);
                if (!directSessionIsActive(info)) return textStr;
                // A newer poll may already have returned to native playback.
                // Its status and response take precedence over this late search.
                if (lane.latestPrimary !== primary) return lane.latestOutput || lane.latestNative;
                if (backup) {
                    backupUsed = lane.window.acceptCleanBackup(backup.playlist, backup.type);
                    if (backupUsed) {
                        lane.lastType = backup.type;
                        lane.lastVariant = backup.variant;
                        info.DirectSnapshots[key] = { backup, observed: Date.now() };
                        console.log('[DIRECT] Backup ' + backup.type + ' — ' + backup.variant.Resolution + ' @ ' + backup.variant.FrameRate + 'fps');
                    }
                }
            }
        }
        const output = lane.window.finish(lane.latestPrimary, backupUsed);
        if (!output) {
            // Same policy as the Android patch: never answer a media request with
            // invented/empty bytes or a permanently repeated dead playlist.
            delete info.DirectLanes[url];
            info.ActiveBackupPlayerType = null;
            console.log(StrictAdBlocking ? '[DIRECT] No clean replacement yet — strict mode will withhold detected ads' :
                '[DIRECT] No safe replacement — preserving native playback (ads may appear)');
        } else info.ActiveBackupPlayerType = needsReplacement && backupUsed ? lane.lastType : null;
        lane.latestOutput = output || lane.latestNative;
        reportDirectAdStatus(info, target, output && needsReplacement && backupUsed ? 'replaced' :
            needsReplacement && !output ? 'fallback' : 'native', info.ActiveBackupPlayerType,
            info.ActiveBackupPlayerType ? lane.lastVariant : null,
            needsReplacement && !output ? 'No compatible clean backup available' : null);
        return lane.latestOutput;
    }
    function parseAttributes(str) {
        if (!str) return {};
        // Normalize: always pass only attribute section
        if (str.charCodeAt(0) === 35) { // '#'
            const idx = str.indexOf(':');
            if (idx !== -1) str = str.slice(idx + 1);
        }
        return Object.fromEntries(
            str.split(/(?:^|,)((?:[^=]*)=(?:"[^"]*"|[^,]*))/)
            .filter(Boolean)
            .map(x => {
                const idx = x.indexOf('=');
                const key = x.substring(0, idx);
                const value = x.substring(idx + 1);
                const num = Number(value);
                return [key, Number.isNaN(num) ? value.startsWith('"') ? JSON.parse(value) : value : num];
            }));
    }
    // Request a playback access token from Twitch GQL using the given player type
    function getAccessToken(channelName, playerType, timeoutMs = 5000) {
        const body = {
            operationName: 'PlaybackAccessToken',
            variables: {
                isLive: true,
                login: channelName,
                isVod: false,
                vodID: "",
                playerType: playerType,
                platform: playerType === 'popout' ? 'web' : 'android'
            },
            query: 'query PlaybackAccessToken($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!, $platform: String!) {' +
                ' streamPlaybackAccessToken(channelName: $login, params: {platform: $platform, playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isLive) { value signature }' +
                ' videoPlaybackAccessToken(id: $vodID, params: {platform: $platform, playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isVod) { value signature }' +
                ' }' 
        };
        return gqlRequest(body, timeoutMs);
    }
    // Send a GQL request to Twitch via the main thread (workers can't make credentialed requests)
    function gqlRequest(body, timeoutMs = 5000) {
        if (!GQLDeviceID) {
            GQLDeviceIDInvented = true;
            GQLDeviceID = '';
            const dcharacters = 'abcdefghijklmnopqrstuvwxyz0123456789';
            const dcharactersLength = dcharacters.length;
            for (let i = 0; i < 32; i++) {
                GQLDeviceID += dcharacters.charAt(Math.floor(Math.random() * dcharactersLength));
            }
        }
        let headers = {
            'Client-ID': ClientID,
            'X-Device-Id': GQLDeviceID,
            ...(AuthorizationHeader && {'Authorization': AuthorizationHeader}),
            'Content-Type': 'text/plain;charset=UTF-8',
            ...(!GQLDeviceIDInvented && ClientIntegrityHeader && {'Client-Integrity': ClientIntegrityHeader}),
            ...(ClientVersion && {'Client-Version': ClientVersion}),
            ...(ClientSession && {'Client-Session-Id': ClientSession})
        };
        return new Promise((resolve, reject) => {
            const requestId = Math.random().toString(36).substring(2, 15);
            const fetchRequest = {
                id: requestId,
                timeoutMs,
                url: 'https://gql.twitch.tv/gql',
                options: {
                    method: 'POST',
                    body: JSON.stringify(body),
                    headers
                }
            };
            const timeoutId = setTimeout(() => {
                if (pendingFetchRequests.has(requestId)) {
                    pendingFetchRequests.delete(requestId);
                    reject(new Error('FetchRequest timed out'));
                }
            }, timeoutMs);
            pendingFetchRequests.set(requestId, {
                resolve,
                reject,
                timeoutId
            });
            postMessage({
                key: 'FetchRequest',
                value: fetchRequest
            });
        });
    }
    let playerForMonitoringBuffering = null;
    let driftCatchUpInterval = null;
    let driftCatchUpTimeout = null;
    function startDriftCorrection(videoElement) {
        if (DriftCorrectionRate <= 1) return;
        if (driftCatchUpInterval) { clearInterval(driftCatchUpInterval); driftCatchUpInterval = null; }
        if (driftCatchUpTimeout) { clearTimeout(driftCatchUpTimeout); driftCatchUpTimeout = null; }
        videoElement.playbackRate = DriftCorrectionRate;
        console.log('[DIRECT] Drift correction: catching up at ' + DriftCorrectionRate + 'x');
        driftCatchUpInterval = setInterval(() => {
            try {
                const vid = getPlayerVideoElement();
                if (vid && vid.buffered.length > 0) {
                    if (vid.buffered.end(vid.buffered.length - 1) - vid.currentTime <= 1) {
                        vid.playbackRate = 1.0;
                        console.log('[DIRECT] Drift correction complete — resumed normal playback speed');
                        clearInterval(driftCatchUpInterval); driftCatchUpInterval = null;
                        if (driftCatchUpTimeout) { clearTimeout(driftCatchUpTimeout); driftCatchUpTimeout = null; }
                    }
                }
            } catch { clearInterval(driftCatchUpInterval); driftCatchUpInterval = null; }
        }, 500);
        driftCatchUpTimeout = setTimeout(() => {
            try { videoElement.playbackRate = 1.0; } catch {}
            if (driftCatchUpInterval) { clearInterval(driftCatchUpInterval); driftCatchUpInterval = null; }
            driftCatchUpTimeout = null;
        }, 30000);
    }
    const playerBufferState = {
        channelName: null,
        hasStreamStarted: false,
        position: 0,
        bufferedPosition: 0,
        bufferDuration: 0,
        numSame: 0,
        fixAttempts: 0,
        lastFixTime: 0,
        isLive: true,
        lastBackupSwitchAt: 0,
        lastReloadAt: 0,
        recoveryReloadUsed: false,
        userPauseIntent: false,
        loggedPauseIntent: false,
        weJustPaused: 0,
        inAdBreak: false,
        vaftEverUnmuted: false
    };
    // Poll the player state to detect and fix buffering caused by ad stream switching

    // document.querySelector('video') returns the first <video> in the DOM, which since
    // July 2026 can be a separate Twitch ad element beside the player or in chat (#249).
    // Skip anything the guard below has marked, so mute/playbackRate work always lands on
    // the real player instead of being aimed at — or skipped because of — an ad element.
    function getPlayerVideoElement() {
        const videos = document.getElementsByTagName('video');
        for (let i = 0; i < videos.length; i++) {
            if (!videos[i].dataset.tasAdHidden) { return videos[i]; }
        }
        return null;
    }
    // Hide Twitch's ad break / Turbo promo / stream display ad overlays when we're already blocking ads
    function hideTwitchAdOverlays() {
        if (!cachedPlayerRootDiv || !cachedPlayerRootDiv.isConnected) return;
        // Hide stream display ad (SDA) wrapper
        const sdaElements = document.querySelectorAll('[data-test-selector="sda-wrapper"]');
        for (let i = 0; i < sdaElements.length; i++) {
            if (!sdaElements[i].dataset.tasHidden) {
                sdaElements[i].dataset.tasHidden = '';
                sdaElements[i].style.setProperty('display', 'none', 'important');
                if (!loggedSdaHide) {
                    loggedSdaHide = true;
                    console.log('[DIRECT] Hidden Twitch stream display ad');
                }
            }
        }
        // Separate video-ad guard (mirrors GosuDRM/TTV-AB v12.0.1-12.0.8 — issue #249): since
        // July 2026 Twitch renders standalone <video> ad elements beside the player and in chat
        // — a second "player" with a Play-ad button. They are delivered outside the m3u8, so
        // neither segment stripping nor backup-swapping touches them.
        // Matched ONLY on the Amazon ad-CDN host. That is the safety property: the live stream is
        // fed by MediaSource and always carries a blob: URL, so the primary player can never match
        // this test. The player-owned element is skipped as a second, independent guard.
        // Muted + paused as well as hidden — a display:none <video> still plays audio (TTV-AB v12.0.7).
        const primaryVideo = playerForMonitoringBuffering?.player?.getHTMLVideoElement?.();
        const allVideos = document.getElementsByTagName('video');
        for (let i = 0; i < allVideos.length; i++) {
            const vid = allVideos[i];
            let adHost = '';
            try {
                const vidSrc = vid.currentSrc || vid.getAttribute('src') || '';
                if (vidSrc && !vidSrc.startsWith('blob:')) {
                    const host = new URL(vidSrc, document.location.href).hostname.toLowerCase();
                    if (host === 'media-amazon.com' || host.endsWith('.media-amazon.com')) {
                        adHost = host;
                    }
                }
            } catch {}
            if (adHost && vid !== primaryVideo) {
                // Re-assert every tick rather than marking once: a React re-render can drop the
                // inline style while keeping the element, and a one-shot marker would never re-hide it.
                vid.style.setProperty('display', 'none', 'important');
                try { vid.muted = true; if (!vid.paused) vid.pause(); } catch {}
                if (!vid.dataset.tasAdHidden) {
                    // '1', not '': dataset returns the empty string as-is, which is falsy —
                    // the dedup, the restore branch and getPlayerVideoElement() would all misread it.
                    vid.dataset.tasAdHidden = '1';
                    console.log('[DIRECT] Hidden separate Twitch video ad (' + adHost + ') — issue #249');
                }
            } else if (vid.dataset.tasAdHidden && !adHost) {
                // Twitch RECYCLES <video> nodes: an element that held an ad can later be handed real
                // content. Without this it would stay display:none + muted forever — invisible content.
                // Deliberately not gated on the primary check, so an element promoted to primary is
                // still restored. Mirrors TTV-AB v12.0.2 ("safely restores videos that Twitch reuses").
                delete vid.dataset.tasAdHidden;
                vid.style.removeProperty('display');
                try { vid.muted = false; } catch {}
                console.log('[DIRECT] Restored recycled <video> — source is no longer an ad (#249)');
            }
        }
    }
    function updateAdblockBanner(data) {
        if (directAdBannerTimer) clearTimeout(directAdBannerTimer);
        directAdBannerTimer = null;
        Object.assign(directAdStatus, { playlist: data.status || 'unknown', channel: data.channel || null,
            context: data.activeBackupPlayerType || null, resolution: data.resolution || null,
            frameRate: data.frameRate || null, reason: data.reason || null, strict: data.strict,
            probes: data.probes || {}, updatedAt: Date.now() });
        if (!cachedPlayerRootDiv || !cachedPlayerRootDiv.isConnected) {
            cachedPlayerRootDiv = document.querySelector('.video-player');
        }
        const root = cachedPlayerRootDiv;
        if (!root) return;
        let notice = root.querySelector('.tas-adblock-overlay');
        if (!notice) {
            notice = document.createElement('div');
            notice.className = 'tas-adblock-overlay';
            notice.style.cssText = 'position:absolute;top:0;left:0;z-index:10;padding:5px;color:white;background:rgba(0,0,0,.8);pointer-events:none';
            root.appendChild(notice);
        }
        const labels = {
            searching: 'Ad detected — checking replacement streams…',
            replaced: 'Ad playlist replaced' + (data.activeBackupPlayerType ? ' (' + data.activeBackupPlayerType + ')' : '') +
                (data.resolution ? ' · ' + data.resolution + (data.frameRate ? ' / ' + data.frameRate + 'fps' : '') : ''),
            waiting: 'Ads withheld — waiting for clean live content',
            fallback: data.strict ? 'Ad detected — checking clean sources' : 'Ad detected — no clean replacement; native playback',
            unsupported: data.strict ? 'Ad detected — unsafe playlist withheld' : 'Ad detected — unsupported playlist; native playback'
        };
        notice.textContent = labels[data.status] || '';
        notice.style.display = data.hasAds && labels[data.status] ? 'block' : 'none';
        // Selecting a clean playlist is observable; successful video rendering
        // or a separate client-side ad is not proved by that selection.
        isActivelyStrippingAds = false;
        if (data.status === 'replaced') hideTwitchAdOverlays();
        directAdBannerTimer = setTimeout(() => {
            notice.style.display = 'none';
            directAdStatus.playlist = 'stale';
            directAdStatus.context = null;
            directAdStatus.reason = 'No recent playlist update';
            directAdBannerTimer = null;
        }, 12000);
    }
    // Traverse React's fiber tree to find Twitch's player and player state instances
    function getPlayerAndState() {
        function findReactNode(root, constraint) {
            if (root.stateNode && constraint(root.stateNode)) {
                return root.stateNode;
            }
            let node = root.child;
            while (node) {
                const result = findReactNode(node, constraint);
                if (result) {
                    return result;
                }
                node = node.sibling;
            }
            return null;
        }
        function findReactRootNode() {
            let reactRootNode = null;
            if (!cachedRootNode) {
                cachedRootNode = document.querySelector('#root');
            }
            const rootNode = cachedRootNode;
            if (rootNode && rootNode._reactRootContainer && rootNode._reactRootContainer._internalRoot && rootNode._reactRootContainer._internalRoot.current) {
                reactRootNode = rootNode._reactRootContainer._internalRoot.current;
            }
            if (reactRootNode == null && rootNode != null) {
                const containerName = Object.keys(rootNode).find(x => x.startsWith('__reactContainer') || x.startsWith('__reactFiber'));
                if (containerName != null) {
                    reactRootNode = rootNode[containerName];
                }
            }
            return reactRootNode;
        }
        const reactRootNode = findReactRootNode();
        if (!reactRootNode) {
            return null;
        }
        // Primary: named property lookup
        let player = findReactNode(reactRootNode, node => node.setPlayerActive && node.props && node.props.mediaPlayerInstance);
        player = player && player.props && player.props.mediaPlayerInstance ? player.props.mediaPlayerInstance : null;
        if (player?.playerInstance) {
            player = player.playerInstance;
        }
        // Fallback: structural match if Twitch obfuscates property names
        if (!player) {
            player = findReactNode(reactRootNode, node => node.getHTMLVideoElement && node.getBufferDuration && node.core?.state);
        }
        // Primary: named property lookup
        const playerState = findReactNode(reactRootNode, node => node.setSrc && node.setInitialPlaybackSettings);
        // Fallback: structural match — setSrc exists but setInitialPlaybackSettings was renamed
        const playerStateFallback = !playerState ? findReactNode(reactRootNode, node => node.setSrc && node.setStreamManagerNode && !node.getHTMLVideoElement) : null;
        // Fallback 2: TTV-AB's approach — videoPlayerInstance with playerMode
        const playerStateFallback2 = !playerState && !playerStateFallback ? findReactNode(reactRootNode, node => node.state?.videoPlayerInstance?.playerMode !== undefined)?.state?.videoPlayerInstance : null;
        const finalPlayerState = playerState || playerStateFallback || playerStateFallback2;
        // Grace period before logging "not found" warnings. The buffer monitor can tick
        // before React has finished mounting the player, leading to a false-positive
        // log that fires once on every page load. Only log if the null state persists
        // for 10+ seconds — by then React is definitely mounted and a persistent null
        // indicates real API drift (Twitch renamed setPlayerActive/setSrc/etc).
        if (!player) {
            if (!getPlayerAndState.firstPlayerNullAt) getPlayerAndState.firstPlayerNullAt = Date.now();
            if (!getPlayerAndState.loggedNoPlayer && (Date.now() - getPlayerAndState.firstPlayerNullAt) > 10000) {
                getPlayerAndState.loggedNoPlayer = true;
                console.log('[DIRECT] Player not found for 10s+ — Twitch may have renamed setPlayerActive/mediaPlayerInstance');
            }
        } else {
            getPlayerAndState.firstPlayerNullAt = 0;// reset on successful find
        }
        if (!finalPlayerState) {
            if (!getPlayerAndState.firstStateNullAt) getPlayerAndState.firstStateNullAt = Date.now();
            if (!getPlayerAndState.loggedNoState && (Date.now() - getPlayerAndState.firstStateNullAt) > 10000) {
                getPlayerAndState.loggedNoState = true;
                console.log('[DIRECT] Player state not found for 10s+ — Twitch may have renamed setSrc/setInitialPlaybackSettings');
            }
        } else {
            getPlayerAndState.firstStateNullAt = 0;// reset on successful find
        }
        return  {
            player: player,
            state: finalPlayerState
        };
    }
    // Apple touch-device detection. iPadOS 13+ reports navigator.platform 'MacIntel' with a desktop
    // Safari UA — distinguished from a real Mac only by touch support (real Macs report maxTouchPoints 0).
    // iPhone/iPod/older iPadOS report platform directly.
    const isAppleTouchDevice = (function() {
        try {
            const p = navigator.platform || '';
            if (/^(iPhone|iPad|iPod)/.test(p)) return true;
            return p === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1;
        } catch { return false; }
    })();
    // On Apple touch devices a hard reload re-instantiates the media element (setSrc isNewMediaPlayerInstance),
    // which iOS/iPadOS treats as not user-gesture-"blessed" → play() is rejected → black frame + native play
    // icon the user must tap (issue: iPad ad black-screen). Downgrade hard reloads to soft so the existing
    // blessed element is reused and resumes without a tap. Opt-out: twitchAdSolutions_iosSoftReload=false.
    const iosSoftReload = isAppleTouchDevice && (function() {
        try { return localStorage.getItem('twitchAdSolutions_iosSoftReload') !== 'false'; } catch { return true; }
    })();
    // Pause/play or fully reload the Twitch player, preserving quality/volume settings
    function doTwitchPlayerTask(isPausePlay, isReload, reloadKind) {
        const playerAndState = getPlayerAndState();
        if (!playerAndState) {
            console.log('Could not find react root');
            return;
        }
        const player = playerAndState.player;
        const playerState = playerAndState.state;
        if (!player) {
            console.log('Could not find player');
            return;
        }
        if (!playerState) {
            console.log('Could not find player state');
            return;
        }
        const wasPaused = player.isPaused() || player.core?.paused;
        if (wasPaused) {
            // User deliberately paused — respect their intent, don't auto-resume
            if (playerBufferState.userPauseIntent) {
                if (!playerBufferState.loggedPauseIntent) {
                    playerBufferState.loggedPauseIntent = true;
                    console.log('[DIRECT] Respecting user pause intent — skipping auto-resume');
                }
                return;
            }
            // If WE recently called pause/play and player is still paused, retry play (stuck from autoplay policy or ad-state interference)
            if (playerBufferState.weJustPaused && (Date.now() - playerBufferState.weJustPaused) < 10000) {
                try { player.play()?.catch?.(() => {}); } catch {}
            }
            if (!isReload) return;
        }
        if (!wasPaused) {
            playerBufferState.weJustPaused = 0;
        }
        playerBufferState.lastFixTime = Date.now();
        playerBufferState.numSame = 0;
        if (isPausePlay) {
            player.pause();
            player.play()?.catch?.(() => {});
            playerBufferState.weJustPaused = Date.now();
            return;
        }
        if (isReload && document.pictureInPictureElement) {
            // Downgrade to pause/play to preserve PiP — setSrc exits PiP
            player.pause();
            player.play()?.catch?.(() => {});
            console.log('[DIRECT] Downgraded reload to pause/play to preserve PiP');
            return;
        }
        const restoresQuality = reloadKind === 'quality-restore' || reloadKind === 'post-ad-flush';
        // All emergency reload paths share a cooldown, including worker requests.
        if (isReload && !restoresQuality && playerBufferState.lastReloadAt &&
            Date.now() - playerBufferState.lastReloadAt < Math.max(15000, ReloadCooldownSeconds * 1000)) {
            postTwitchWorkerMessage('ReloadSkipped');
            return;
        }
        if (isReload && !restoresQuality && reloadKind !== 'codec-fallback') {
            // Skip reload if the player is already healthy — avoids disrupting smooth playback.
            // But if we're way behind live edge (e.g. after a long ad break), proceed with reload to reset latency.
            const video = player.getHTMLVideoElement?.();
            if (video && video.readyState >= 3 && !video.paused && !video.ended) {
                let latencySec = 0;
                let latencyKnown = false;
                try {
                    if (video.seekable && video.seekable.length > 0) {
                        const seekableEnd = video.seekable.end(video.seekable.length - 1);
                        if (Number.isFinite(seekableEnd)) {
                            const calc = Math.max(0, seekableEnd - video.currentTime);
                            // Sanity cap: values >1h indicate garbage from the Media Source API
                            // (seen right after a reload while the seekable range is in a transient state).
                            if (calc < 3600) {
                                latencySec = calc;
                                latencyKnown = true;
                            }
                        }
                    }
                } catch (e) {}
                if (!latencyKnown) {
                    console.log('[DIRECT] Latency unknown (seekable unavailable) — proceeding with reload');
                } else if (latencySec > 7) {
                    console.log('[DIRECT] Player playing but ' + latencySec.toFixed(1) + 's behind live — proceeding with reload to reset latency');
                } else {
                    console.log('[DIRECT] Skipping reload — player healthy (readyState=' + video.readyState + ', playing, latency=' + latencySec.toFixed(1) + 's)');
                    postTwitchWorkerMessage('ReloadSkipped');
                    return;
                }
            }
        }
        if (isReload) {
            const lsKeyQuality = 'video-quality';
            const lsKeyMuted = 'video-muted';
            const lsKeyVolume = 'volume';
            const lsKeyLowLatency = 'lowLatencyModeEnabled';// Preserve user's low-latency toggle across reloads (TTV-AB parity)
            const lsKeyPersistence = 'persistenceEnabled';// Preserve autoplay/persistence toggle across reloads (TTV-AB parity)
            let currentQualityLS = null;
            let currentMutedLS = null;
            let currentVolumeLS = null;
            let currentLowLatencyLS = null;
            let currentPersistenceLS = null;
            try {
                currentQualityLS = restoresQuality && playerBufferState.preAdQualityLS !== undefined
                    ? playerBufferState.preAdQualityLS : localStorage.getItem(lsKeyQuality);
                currentMutedLS = localStorage.getItem(lsKeyMuted);
                currentVolumeLS = localStorage.getItem(lsKeyVolume);
                currentLowLatencyLS = localStorage.getItem(lsKeyLowLatency);
                currentPersistenceLS = localStorage.getItem(lsKeyPersistence);
                if (localStorageHookFailed && player?.core?.state) {
                    localStorage.setItem(lsKeyMuted, JSON.stringify({default:player.core.state.muted}));
                    localStorage.setItem(lsKeyVolume, player.core.state.volume);
                }
                if (restoresQuality) {
                    if (currentQualityLS !== null) localStorage.setItem(lsKeyQuality, currentQualityLS);
                    else localStorage.removeItem(lsKeyQuality);
                }
                if (!restoresQuality && player?.core?.state?.quality?.group) {
                    localStorage.setItem(lsKeyQuality, JSON.stringify({default:player.core.state.quality.group}));
                }
            } catch {}
            playerBufferState.lastReloadAt = Date.now();
            playerBufferState.adStallStartAt = 0;// clear stale stall timer so post-reload readyState=0 isn't attributed to pre-reload stall
            playerBufferState.userPauseIntent = false;
            playerBufferState.loggedPauseIntent = false;
            // playerForMonitoringBuffering re-acquired fresh every tick — no manual invalidation needed
            // Hard reload for 'early' (mid-break escape — fresh session gets new ad-decision bucket).
            // Soft reload for 'post-ad' (smooth transition, no black screen teardown).
            // Apple touch devices: force soft — a new media instance needs a user tap to resume (black-screen + play icon).
            const hardReload = ['early', 'post-ad-flush', 'codec-fallback'].includes(reloadKind) && !iosSoftReload;
            // Decoupled from hardReload on purpose. The iOS downgrade below exists to keep the
            // media element user-gesture-blessed, which only requires skipping the new media
            // instance — not the token refresh. An 'early' reload after an autoplay commit
            // depends on refreshAccessToken to leave the autoplay-scoped 360p variant ladder;
            // without it an iOS user stays pinned at 360p, since 'early' is always downgraded
            // here and 'post-ad' is soft by definition, so nothing refreshes the token again.
            const refreshToken = reloadKind === 'early' || restoresQuality;
            if (reloadKind === 'early' && iosSoftReload) {
                console.log('[DIRECT] iOS/iPadOS: downgrading hard reload to soft — keeps media element user-gesture-blessed (avoids black-screen + play-icon stall); access-token refresh is retained, so Source quality can still be restored. Opt-out: twitchAdSolutions_iosSoftReload=false');
            }
            console.log('[DIRECT] Reloading Twitch player' + (hardReload ? ' (hard)' : ' (soft)'));
            // Pre-mute through hard reload to hide the MediaSource-teardown audio click.
            // New MSE initialization crosses a discontinuity boundary that produces an
            // audible pop on first frames. Restored on `canplay` (audio decodable) with a
            // 1500ms safety cap. Skipped if user was already muted (preserves intent).
            // Existing 3000ms LS-restore timer below acts as ultimate backstop.
            if (hardReload) {
                try {
                    const v = getPlayerVideoElement();
                    const wasInitiallyUnmuted = v && !v.muted;
                    // Issue #200 fix: also set up restore+backstop when the element is already
                    // muted IF vaft has successfully unmuted at any point earlier this session.
                    // Strong signal of Twitch's silent re-mute pattern (confirmed via v633
                    // diagnostic logs) rather than user-initiated mute. Without this, AFK
                    // users come back to persistently-muted streams (Tgod1991 on v635). First-
                    // session-mute users have vaftEverUnmuted=false → backstop never engages
                    // → mute respected. Disabled by twitchAdSolutions_recoverFromSilentMute=
                    // false for users who deliberately mute mid-session.
                    const shouldRecover = playerBufferState.vaftEverUnmuted && RecoverFromSilentMute;
                    if (v && (wasInitiallyUnmuted || shouldRecover)) {
                        if (wasInitiallyUnmuted) {
                            v.muted = true;
                        }
                        // setSrc({isNewMediaPlayerInstance:true}) replaces the <video> element,
                        // so a listener on the original `v` never fires — events fire on the
                        // new element. Listen on document (capture phase) instead so we catch
                        // them regardless of which <video> Twitch attaches the new MediaSource
                        // to. Three event triggers are wired up because Edge dispatches
                        // `loadeddata` / `playing` independently of `canplay` and any of them
                        // is sufficient signal that the new element is ready for unmute.
                        // First-fired wins via the idempotent `done` guard.
                        let done = false;
                        const restore = () => {
                            if (done) return;
                            done = true;
                            document.removeEventListener('canplay', listener, true);
                            document.removeEventListener('playing', listener, true);
                            document.removeEventListener('loadeddata', listener, true);
                            try {
                                const cur = getPlayerVideoElement();
                                if (cur) {
                                    cur.muted = false;
                                    playerBufferState.vaftEverUnmuted = true;
                                }
                                // Undo OUR pre-mute if it landed on a different element than `cur`.
                                // `cur` is whichever <video> is first in the DOM — not necessarily the one
                                // we muted, now that Twitch renders extra <video> elements for side/chat
                                // ads (#249), and Firefox's PiP is browser-native so the
                                // document.pictureInPictureElement reload guard never fires there (#248).
                                // Gated on wasInitiallyUnmuted so it only ever clears a mute we set —
                                // it can never unmute an ad video. No-op on a normal hard reload, where
                                // the old element is disconnected.
                                if (v && v !== cur && v.isConnected && v.muted && wasInitiallyUnmuted) {
                                    v.muted = false;
                                    console.log('[DIRECT] Restore — cleared leaked pre-mute on the original element (cur resolved to a different <video>) — issue #248');
                                }
                            } catch {}
                        };
                        const listener = (e) => {
                            if (e.target && e.target.tagName === 'VIDEO') restore();
                        };
                        document.addEventListener('canplay', listener, true);
                        document.addEventListener('playing', listener, true);
                        document.addEventListener('loadeddata', listener, true);
                        setTimeout(restore, 4000);// Bumped 2500ms → 4000ms for Edge slow-init slack — issue #200 follow-up reports muted state on hard reloads where MSE init exceeded 2500ms.
                        // Final backstop: if the player ends up muted at 5500ms despite our
                        // restore (Twitch's own LS-restore at ~3000ms can re-mute if the
                        // captured pre-reload muted snapshot was true), force one more
                        // unmute. Idempotent — no-op if already unmuted. Skipped if the user
                        // explicitly muted (`weJustPaused` paths preserve user-mute intent;
                        // checking `playerBufferState.userPauseIntent` here is a cheap proxy
                        // — pause+mute are conceptually correlated by Twitch's player code).
                        setTimeout(() => {
                            try {
                                const cur = getPlayerVideoElement();
                                if (cur && cur.muted) {
                                    if (playerBufferState.userPauseIntent) {
                                        console.log('[DIRECT] Hard reload backstop SKIPPED — element muted at 5500ms but userPauseIntent set (likely false-positive pause event during MSE teardown — issue #200 follow-up)');
                                    } else {
                                        cur.muted = false;
                                        playerBufferState.vaftEverUnmuted = true;
                                        console.log('[DIRECT] Hard reload backstop unmute fired — element was still muted at 5500ms (initial: ' + (wasInitiallyUnmuted ? 'unmuted, we pre-muted' : 'already-muted on entry — recovering from silent Twitch re-mute') + ')');
                                    }
                                }
                                // Same leaked-pre-mute catch as in restore(), at the backstop — see #248.
                                if (v && v !== cur && v.isConnected && v.muted && wasInitiallyUnmuted
                                    && !playerBufferState.userPauseIntent) {
                                    v.muted = false;
                                    console.log('[DIRECT] Backstop — cleared leaked pre-mute on the original element (cur resolved to a different <video>) — issue #248');
                                }
                            } catch {}
                        }, 5500);
                    }
                } catch {}
            }
            // Set weJustPaused so the pause-listener filters out the MSE-teardown
            // pause event that Twitch dispatches on the old <video> during setSrc.
            // Without this, userPauseIntent would falsely flip to true during the
            // reload window, blocking the 5500ms backstop's unmute on stuck-muted
            // recovery (issue #200 follow-up). Reuses the existing 2s pause-listener
            // guard.
            // refreshToken as well as hardReload: a token refresh swaps the source even when
            // the media instance is reused (the iOS downgrade), so Twitch can still dispatch
            // the teardown pause. Unarmed, that reads as userPauseIntent and suppresses the
            // unmute backstop — muted stream on exactly the devices this path targets.
            if (hardReload || refreshToken) {
                playerBufferState.weJustPaused = Date.now();
            }
            playerState.setSrc({ isNewMediaPlayerInstance: hardReload, refreshAccessToken: refreshToken });
            postTwitchWorkerMessage('TriggeredPlayerReload');
            player.play()?.catch?.(() => {});
            // Always restore muted/volume state after reload — Chrome autoplay policy can force muted.
            // Block must always run: if Twitch hasn't written LS values yet (fresh session, private mode,
            // cleared cache), the video still needs unmute after Chrome's autoplay mute on reload.
            {
                setTimeout(() => {
                    try {
                        if (currentQualityLS) {
                            localStorage.setItem(lsKeyQuality, currentQualityLS);
                        }
                        if (currentMutedLS) {
                            localStorage.setItem(lsKeyMuted, currentMutedLS);
                        }
                        if (currentVolumeLS) {
                            localStorage.setItem(lsKeyVolume, currentVolumeLS);
                        }
                        if (currentLowLatencyLS !== null) {
                            localStorage.setItem(lsKeyLowLatency, currentLowLatencyLS);
                        }
                        if (currentPersistenceLS !== null) {
                            localStorage.setItem(lsKeyPersistence, currentPersistenceLS);
                        }
                        const videos = document.getElementsByTagName('video');
                        // Respect user's mute intent: only force-unmute if LS didn't say mute.
                        // Twitch writes video-muted as '{"default":true}' when user muted via UI;
                        // Chrome autoplay policy can mute even if user didn't (no LS signal).
                        const userIntendedMute = currentMutedLS && currentMutedLS.includes('"default":true');
                        if (videos.length > 0 && videos[0].muted && !userIntendedMute) {
                            videos[0].muted = false;
                        }
                        // Correct live drift after reload.
                        // For hard reload with large drift (>5s), hard-seek to live edge to flush
                        // any A/V timestamp desync from strip+BLANK_MP4+recovery activity. Drift
                        // correction at 1.1x would take minutes to catch up 30-60s of drift.
                        // For soft reload or small drift, use existing gradual catch-up.
                        if (videos.length > 0 && videos[0].buffered.length > 0 && videos[0].readyState >= 3) {
                            const liveEdge = videos[0].buffered.end(videos[0].buffered.length - 1);
                            const drift = liveEdge - videos[0].currentTime;
                            if (hardReload && drift > 5 && Number.isFinite(liveEdge) && liveEdge < 3600) {
                                console.log('[DIRECT] Post-hard-reload seek to live — ' + drift.toFixed(1) + 's behind, jumping to live edge to flush A/V drift');
                                videos[0].currentTime = Math.max(videos[0].currentTime, liveEdge - 1);
                            } else if (drift > 2) {
                                console.log('[DIRECT] Post-reload live drift correction: ' + drift.toFixed(1) + 's behind');
                                startDriftCorrection(videos[0]);
                            }
                        }
                    } catch {}
                }, 3000);
            }
            return;
        }
    }
    window.reloadTwitchPlayer = () => {
        doTwitchPlayerTask(false, true);
    };
    function postTwitchWorkerMessage(key, value) {
        twitchWorkers.forEach((worker) => {
            worker.postMessage({key: key, value: value});
        });
    }
    async function handleWorkerFetchRequest(fetchRequest) {
        // 5s AbortController timeout. The worker uses this path for GQL requests
        // (access tokens + ad-spoof beacons). Without a timeout, a hung GQL endpoint
        // would block the worker's backup-search loop indefinitely (until browser's
        // ~30s default), turning a slow-network blip into a multi-second player
        // freeze during the ad break. 5s is well above normal Twitch GQL response
        // (<1s) but bounds worst-case wait. AbortError flows through the existing
        // catch + FailedBackupPlayerTypes lockout naturally.
        const controller = new AbortController();
        const timeoutMs = Math.max(1, Math.min(5000, Number(fetchRequest.timeoutMs) || 5000));
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await window.realFetch(fetchRequest.url, {
                ...fetchRequest.options,
                signal: controller.signal
            });
            const responseBody = await response.text();
            clearTimeout(timeoutId);
            const responseObject = {
                id: fetchRequest.id,
                status: response.status,
                statusText: response.statusText,
                ok: response.ok,
                redirected: response.redirected,
                type: response.type,
                url: response.url,
                headers: Object.fromEntries(response.headers.entries()),
                body: responseBody
            };
            return responseObject;
        } catch (error) {
            clearTimeout(timeoutId);
            return {
                id: fetchRequest.id,
                error: error.name === 'AbortError' ? 'GQL fetch timeout (' + (timeoutMs / 1000) + 's)' : error.message
            };
        }
    }
    // Hook fetch() in the window scope to capture auth headers and modify player type requests
    function hookFetch() {
        console.log('[DIRECT] Window fetch hook installed');
        let hasLoggedHeaders = false;
        const realFetch = window.fetch;
        window.realFetch = realFetch;
        window.fetch = maskAsNative(function(input, init) {
            const url = typeof input === 'string' ? input : input?.url || input?.href;
            if (typeof url === 'string') {
                if (url.includes('gql')) {
                    const requestHeaders = new Headers(init?.headers ?? input?.headers);
                    let deviceId = requestHeaders.get('X-Device-Id');
                    if (typeof deviceId !== 'string') {
                        deviceId = requestHeaders.get('Device-ID');
                    }
                    if (typeof deviceId === 'string' && GQLDeviceID != deviceId) {
                        GQLDeviceID = deviceId;
                        postTwitchWorkerMessage('UpdateDeviceId', GQLDeviceID);
                    }
                    if (typeof requestHeaders.get('Client-Version') === 'string' && requestHeaders.get('Client-Version') !== ClientVersion) {
                        postTwitchWorkerMessage('UpdateClientVersion', ClientVersion = requestHeaders.get('Client-Version'));
                    }
                    if (typeof requestHeaders.get('Client-Session-Id') === 'string' && requestHeaders.get('Client-Session-Id') !== ClientSession) {
                        postTwitchWorkerMessage('UpdateClientSession', ClientSession = requestHeaders.get('Client-Session-Id'));
                    }
                    if (typeof requestHeaders.get('Client-Integrity') === 'string' && requestHeaders.get('Client-Integrity') !== ClientIntegrityHeader) {
                        postTwitchWorkerMessage('UpdateClientIntegrityHeader', ClientIntegrityHeader = requestHeaders.get('Client-Integrity'));
                    }
                    if (typeof requestHeaders.get('Authorization') === 'string' && requestHeaders.get('Authorization') !== AuthorizationHeader) {
                        postTwitchWorkerMessage('UpdateAuthorizationHeader', AuthorizationHeader = requestHeaders.get('Authorization'));
                    }
                    if (!hasLoggedHeaders && GQLDeviceID && AuthorizationHeader) {
                        hasLoggedHeaders = true;
                        console.log('[DIRECT] GQL headers captured — DeviceId: ' + (GQLDeviceID ? 'yes' : 'no') + ', Auth: ' + (AuthorizationHeader ? 'yes' : 'no') + ', Integrity: ' + (ClientIntegrityHeader ? 'yes' : 'no'));
                    }
                    // Get rid of mini player above chat - TODO: Reject this locally instead of having server reject it
                    if (init && typeof init.body === 'string' && init.body.includes('PlaybackAccessToken') && init.body.includes('picture-by-picture')) {
                        init.body = '';
                    }
                    if (ForceAccessTokenPlayerType && init && typeof init.body === 'string' && init.body.includes('PlaybackAccessToken')) {
                        let replacedPlayerType = '';
                        let newBody;
                        try { newBody = JSON.parse(init.body); }
                        catch { return realFetch.apply(this, arguments); }
                        if (Array.isArray(newBody)) {
                            for (let i = 0; i < newBody.length; i++) {
                                if (newBody[i]?.variables?.playerType && newBody[i]?.variables?.playerType !== ForceAccessTokenPlayerType) {
                                    replacedPlayerType = newBody[i].variables.playerType;
                                    newBody[i].variables.playerType = ForceAccessTokenPlayerType;
                                }
                            }
                        } else {
                            if (newBody?.variables?.playerType && newBody?.variables?.playerType !== ForceAccessTokenPlayerType) {
                                replacedPlayerType = newBody.variables.playerType;
                                newBody.variables.playerType = ForceAccessTokenPlayerType;
                            }
                        }
                        if (replacedPlayerType) {
                            console.log(`[DIRECT] Replaced '${replacedPlayerType}' player type with '${ForceAccessTokenPlayerType}' player type`);
                            init.body = JSON.stringify(newBody);
                        }
                    }
                }
                if (url.includes('edge.ads.twitch.tv')) {
                    const csaiType = url.includes('bp=midroll') ? 'midroll' : url.includes('bp=preroll') ? 'preroll' : 'unknown';
                    countCsaiRequest(csaiType, 'fetch');
                }
            }
            return realFetch.apply(this, arguments);
        }, 'fetch');
    }
    // Set up visibility overrides and localStorage hooks to preserve player state across reloads
    function onContentLoaded() {
        if (document.getElementById('seventv-extension')) {
            console.log('[DIRECT] Warning: 7TV extension detected — may cause black screen or buffering issues. If you experience problems, try disabling 7TV.');
        }
        // Resume the player on tab focus if Twitch paused it during an ad on a hidden tab.
        // Previously also spoofed document.hidden / visibilityState / hasFocus and swallowed
        // the events on the capture phase. That broke other extensions that key off real
        // visibility (e.g. BetterTTV "Mute Invisible Player"). Resume-on-focus alone is
        // enough to keep playback alive across hidden→visible transitions during ads.
        // Sync'd with TTV-AB v6.5.0.
        let wasVideoPlaying = true;
        const visibilityChange = () => {
            const videos = document.getElementsByTagName('video');
            if (videos.length === 0) return;
            if (document.hidden) {
                wasVideoPlaying = !videos[0].paused && !videos[0].ended;
                return;
            }
            if (!playerBufferState.hasStreamStarted) {
                playerBufferState.hasStreamStarted = true;
            }
            if (wasVideoPlaying && !videos[0].ended && videos[0].paused) {
                videos[0].play()?.catch?.(() => {});
            }
        };
        document.addEventListener('visibilitychange', visibilityChange);
        // Hooks for preserving volume / resolution
        try {
            const keysToCache = [
                'video-quality',
                'video-muted',
                'volume',
                'lowLatencyModeEnabled',// Low Latency
                'persistenceEnabled',// Mini Player
            ];
            const cachedValues = new Map();
            for (let i = 0; i < keysToCache.length; i++) {
                cachedValues.set(keysToCache[i], localStorage.getItem(keysToCache[i]));
            }
            const realSetItem = localStorage.setItem;
            localStorage.setItem = maskAsNative(function(key, value) {
                if (cachedValues.has(key)) {
                    cachedValues.set(key, value);
                }
                realSetItem.apply(this, arguments);
            }, 'setItem');
            const realRemoveItem = localStorage.removeItem;
            localStorage.removeItem = maskAsNative(function(key) {
                if (cachedValues.has(key)) cachedValues.set(key, null);
                return realRemoveItem.apply(this, arguments);
            }, 'removeItem');
            const realGetItem = localStorage.getItem;
            localStorage.getItem = maskAsNative(function(key) {
                if (cachedValues.has(key)) {
                    return cachedValues.get(key);
                }
                return realGetItem.apply(this, arguments);
            }, 'getItem');
            if (localStorage.getItem === realGetItem) {
                // These hooks are useful to preserve player state on player reload
                // Firefox doesn't allow hooking of localStorage functions but chrome does
                localStorageHookFailed = true;
            }
        } catch (err) {
            console.log('localStorageHooks failed ' + err)
            localStorageHookFailed = true;
        }
    }
    declareOptions(window);
    try { StrictAdBlocking = localStorage.getItem('twitchDirect_allowNativeAds') !== 'true'; } catch {}
    try {
        const lsReloadAfterAd = localStorage.getItem('twitchAdSolutions_reloadPlayerAfterAd');
        if (lsReloadAfterAd !== null) {
            ReloadPlayerAfterAd = lsReloadAfterAd === 'true';
        }
        const lsReloadCooldown = parseInt(localStorage.getItem('twitchAdSolutions_reloadCooldownSeconds'));
        if (!isNaN(lsReloadCooldown) && lsReloadCooldown >= 0) {
            ReloadCooldownSeconds = lsReloadCooldown;
        }
        const lsDisableReloadCap = localStorage.getItem('twitchAdSolutions_disableReloadCap');
        if (lsDisableReloadCap !== null) {
            DisableReloadCap = lsDisableReloadCap === 'true';
        }
        const lsDriftRate = parseFloat(localStorage.getItem('twitchAdSolutions_driftCorrectionRate'));
        if (!isNaN(lsDriftRate) && lsDriftRate >= 0) {
            DriftCorrectionRate = lsDriftRate;
        }
        const lsEarlyReload = parseInt(localStorage.getItem('twitchAdSolutions_earlyReloadPollThreshold'));
        if (!isNaN(lsEarlyReload) && lsEarlyReload >= 0) {
            EarlyReloadPollThreshold = lsEarlyReload;
        }
        const lsPinBackup = localStorage.getItem('twitchAdSolutions_pinBackupPlayerType');
        if (lsPinBackup !== null) {
            PinBackupPlayerType = lsPinBackup === 'true';
        }
        const lsPreferLow = localStorage.getItem('twitchAdSolutions_preferLowQualityBackup');
        if (lsPreferLow === 'false') {
            PreferLowQualityBackup = false;
            console.log('[DIRECT] 360p fallback disabled via localStorage — clean matching higher-quality contexts only');
        }
        const lsFastAutoplay = localStorage.getItem('twitchAdSolutions_fastAutoplayFirstTry');
        if (lsFastAutoplay === 'false') {
            FastAutoplayFirstTry = false;
            console.log('[DIRECT] FastAutoplayFirstTry disabled via localStorage — full Source-tier probe on every break (no autoplay fast-path)');
        }
        const lsBackupSwapFirst = localStorage.getItem('twitchAdSolutions_backupSwapFirst');
        if (lsBackupSwapFirst === 'false') {
            BackupSwapFirst = false;
            console.log('[DIRECT] BackupSwapFirst disabled via localStorage — using sticky CSAI path (strip on native stream)');
        }
        const lsDisableAdSpoofing = localStorage.getItem('twitchAdSolutions_disableAdSpoofing');
        if (lsDisableAdSpoofing === 'false') {
            DisableAdSpoofing = false;
            console.log('[DIRECT] AdSpoofing enabled via localStorage opt-in — firing GQL ad-tracking beacons on ad detect');
        }
        const lsRecoverFromSilentMute = localStorage.getItem('twitchAdSolutions_recoverFromSilentMute');
        if (lsRecoverFromSilentMute === 'false') {
            RecoverFromSilentMute = false;
            console.log('[DIRECT] RecoverFromSilentMute disabled via localStorage — hard-reload backstop respects already-muted state, mid-session manual mutes preserved across reloads');
        }
        const lsSoftReloadNoStrip = localStorage.getItem('twitchAdSolutions_softReloadNoStrip');
        if (lsSoftReloadNoStrip === 'false') {
            SoftReloadNoStrip = false;
            console.log('[DIRECT] SoftReloadNoStrip disabled via localStorage — post-ad reload always hard, even on no-strip CSAI breaks (issue #129)');
        }
        const lsDisablePostBreakWedge = localStorage.getItem('twitchAdSolutions_disablePostBreakWedge');
        if (lsDisablePostBreakWedge === 'true') {
            DisablePostBreakWedge = true;
            console.log('[DIRECT] Post-break video-wedge recovery DISABLED via localStorage — audio-alive/video-frozen after a break will not be auto-recovered');
        }
        const lsHideAdOverlay = localStorage.getItem('twitchAdSolutions_hideAdOverlay');
        if (lsHideAdOverlay === 'true') {
            const style = document.createElement('style');
            style.textContent = '.tas-adblock-overlay { display: none !important; }';
            (document.head || document.documentElement).appendChild(style);
        }
    } catch {}
    console.log('[DIRECT] Config: ReloadPlayerAfterAd = ' + ReloadPlayerAfterAd + ', ForceAccessTokenPlayerType = ' + ForceAccessTokenPlayerType + ', PinBackupPlayerType = ' + PinBackupPlayerType);
    hookWindowWorker();
    hookFetch();
    // Hook XHR to detect CSAI ad requests that bypass fetch
    const realXHROpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = maskAsNative(function(method, url) {
        if (typeof url === 'string' && url.includes('edge.ads.twitch.tv')) {
            const csaiType = url.includes('bp=midroll') ? 'midroll' : url.includes('bp=preroll') ? 'preroll' : 'unknown';
            countCsaiRequest(csaiType, 'xhr');
        }
        return realXHROpen.apply(this, arguments);
    }, 'open');
    startBrowserClientAdBlock();
    if (document.readyState === "complete" || document.readyState === "interactive") {
        onContentLoaded();
    } else {
        window.addEventListener("DOMContentLoaded", function() {
            onContentLoaded();
        });
    }
    window.simulateAds = (depth) => {
        if (depth === undefined || depth < 0) {
            console.log('Ad depth parameter required (0 = no simulated ad, 1+ = use backup player for given depth)');
            return;
        }
        postTwitchWorkerMessage('SimulateAds', depth);
    };
    window.allSegmentsAreAdSegments = () => {
        postTwitchWorkerMessage('AllSegmentsAreAdSegments');
    };
})();
