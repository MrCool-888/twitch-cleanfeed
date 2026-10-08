const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { test } = require('node:test');
const source = fs.readFileSync(path.join(__dirname, './twitch-cleanfeed.user.js'), 'utf8');
function fn(name) {
    const start = source.search(new RegExp(`^    (?:async )?function ${name}\\(`, 'm'));
    assert(start >= 0, name);
    return source.slice(start, source.indexOf('\n    }', start) + 6);
}
const BASE = 'https://video-weaver.test.hls.ttvnw.net/live/main.m3u8';
const target = { Resolution: '1920x1080', FrameRate: 60, Codecs: 'avc1.4D402A,mp4a.40.2' };
function live(seq, prefix = 'main', count = 2, date = null, map = null) {
    let text = `#EXTM3U\n#EXT-X-VERSION:${map ? 6 : 3}\n#EXT-X-TARGETDURATION:2\n#EXT-X-TWITCH-LIVE-SEQUENCE:${seq}\n`;
    if (date) text += '#EXT-X-PROGRAM-DATE-TIME:' + date + '\n';
    if (map) text += '#EXT-X-MAP:URI="' + map + '"\n';
    for (let i = 0; i < count; i++) text += '#EXTINF:2,live\n' + prefix + (seq + i) + '.ts\n';
    return text;
}
const AD = '#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXT-X-DATERANGE:ID="stitched-ad",CLASS="twitch-stitched-ad"\n#EXTINF:5,ad\nad.ts\n';
function master(type, variants = [{ res: '1920x1080', fps: 60 }]) {
    return '#EXTM3U\n' + variants.map(v => `#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=${v.res},FRAME-RATE=${v.fps ?? 60},CODECS="${v.codec || target.Codecs}"\nhttps://video-weaver.test.hls.ttvnw.net/${type}/${v.res}.m3u8\n`).join('');
}
const names = ['declareOptions', 'createStreamInfo', 'parseAttributes', 'videoCodecFamily', 'hasAdTags',
    'getStreamVariantForResolution', 'getStreamUrlForResolution', 'backupQualityScore', 'isFullQualityBackup',
    'fetchBackupText', 'probeBackupType', 'searchSourceBackups', 'findBackupStream', 'directSessionIsActive',
    'watchDirectBackup', 'reportDirectAdStatus', 'directProbeStatus', 'directWaitDelay',
    'processDirectPlaylist', 'processM3U8', 'createDirectHlsTools'];
function setup(plans = {}) {
    const messages = [], tokens = [], requests = [];
    const ctx = vm.createContext({ console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout,
        setInterval, clearInterval, Response, Headers, URL, Blob, AbortController, Date, Map, Set, Uint8Array, atob,
        postMessage: message => messages.push(message) });
    ctx.window = ctx; ctx.self = ctx;
    ctx.directAdStatus = { clientAdGate: 'checking' };
    vm.runInContext(names.map(fn).join('\n') + '\ndeclareOptions(globalThis); const DirectHls = createDirectHlsTools(); globalThis.HLS = DirectHls;', ctx);
    // Retain coverage of the optional native-ad policy as well as strict tests below.
    ctx.StrictAdBlocking = false;
    const info = ctx.createStreamInfo('test', master('native'), '?allow_source=true');
    info.Urls[BASE] = target;
    ctx.StreamInfos.test = info;
    ctx.StreamInfosByUrl[BASE] = info;
    ctx.getAccessToken = async (channel, type) => {
        tokens.push(type);
        return new Response(JSON.stringify({ data: { streamPlaybackAccessToken: { signature: 'test', value: type } } }));
    };
    const realFetch = async url => {
        requests.push(String(url));
        const u = new URL(url);
        const type = u.hostname === 'usher.ttvnw.net' ? u.searchParams.get('token') : u.pathname.split('/')[1];
        const plan = plans[type] || {};
        if (plan.hang && u.hostname !== 'usher.ttvnw.net') return new Promise(() => {});
        if (u.hostname === 'usher.ttvnw.net') return new Response(master(type, plan.variants));
        return new Response(plan.clean ? live(plan.seq ?? 100, type, 14) : AD);
    };
    // Playback tests deliberately avoid real recurring browser timers.
    ctx.watchDirectBackup = () => {};
    return { ctx, info, messages, tokens, requests, realFetch, plans, hls: ctx.HLS };
}
test('token requests follow Android platform selection and use a full GraphQL document', async () => {
    const s = setup(), bodies = [];
    s.ctx.gqlRequest = body => { bodies.push(body); return Promise.resolve(new Response('{}')); };
    vm.runInContext(fn('getAccessToken'), s.ctx);
    for (const type of ['mobile_feed', 'popout', 'autoplay']) await s.ctx.getAccessToken('test', type);
    assert.deepEqual(bodies.map(b => b.variables.platform), ['android', 'web', 'android']);
    assert(bodies.every(b => b.query.includes('playerBackend: "mediaplayer"')));
});

test('page header capture handles Request objects without changing the native request', async () => {
    const s = setup(), messages = [], nativeCalls = [];
    s.ctx.postTwitchWorkerMessage = (key, value) => messages.push({ key, value });
    s.ctx.fetch = (input, init) => { nativeCalls.push({ input, init }); return Promise.resolve(new Response('{}')); };
    vm.runInContext(fn('maskAsNative') + '\n' + fn('hookFetch'), s.ctx);
    s.ctx.hookFetch();
    const request = new Request('https://gql.twitch.tv/gql', { method: 'POST', body: '{}',
        headers: { 'X-Device-Id': 'synthetic-device', Authorization: 'OAuth synthetic-test', 'Client-Integrity': 'synthetic-integrity' } });
    await s.ctx.fetch(request);
    assert.equal(nativeCalls[0].input, request);
    assert.equal(messages.find(m => m.key === 'UpdateDeviceId').value, 'synthetic-device');
    assert.equal(messages.find(m => m.key === 'UpdateAuthorizationHeader').value, 'OAuth synthetic-test');
    assert.equal(messages.find(m => m.key === 'UpdateClientIntegrityHeader').value, 'synthetic-integrity');
});
test('mobile_feed is tried first and can preserve full resolution/frame rate', async () => {
    const s = setup({ mobile_feed: { clean: true } });
    const backup = await s.ctx.findBackupStream(s.info, target, s.realFetch);
    assert.equal(s.tokens[0], 'mobile_feed');
    assert.equal(backup.type, 'mobile_feed');
    assert.equal(backup.variant.Resolution, '1920x1080');
    assert.equal(backup.variant.FrameRate, 60);
    assert(backup.playlist.supported);
});
test('matching popout quality beats an earlier low-quality mobile_feed result', async () => {
    const s = setup({ mobile_feed: { clean: true, variants: [{ res: '854x480', fps: 30 }] }, popout: { clean: true } });
    assert.equal((await s.ctx.findBackupStream(s.info, target, s.realFetch)).type, 'popout');
});
test('autoplay is last resort and can be disabled', async () => {
    const s = setup({ autoplay: { clean: true, variants: [{ res: '640x360', fps: 30 }] } });
    assert.equal((await s.ctx.findBackupStream(s.info, target, s.realFetch)).type, 'autoplay');
    assert.deepEqual(s.tokens, ['mobile_feed', 'popout', 'autoplay']);
    const disabled = setup({ autoplay: { clean: true } });
    disabled.ctx.PreferLowQualityBackup = false;
    assert.equal(await disabled.ctx.findBackupStream(disabled.info, target, disabled.realFetch), null);
    assert(!disabled.tokens.includes('autoplay'));
});
test('unsupported backup formats and missing broadcast sequences are not spliced', async () => {
    const s = setup();
    s.info.BackupEncodingsM3U8Cache.mobile_feed = master('mobile_feed');
    s.info.BackupMasterFetchedAt.mobile_feed = Date.now();
    const bad = '#EXTM3U\n#EXTINF:2,live\nlive.ts\n';
    assert.equal(await s.ctx.probeBackupType(s.info, 'mobile_feed', target,
        async () => new Response(bad), Date.now() + 1000, 0), null);
});
test('video codec matching distinguishes HVC1 and HEV1', () => {
    const s = setup();
    const m = master('test', [{ res: '1920x1080', codec: 'hev1.1.6.L120.90' }]);
    assert.equal(s.ctx.getStreamVariantForResolution(m, { ...target, Codecs: 'hvc1.1.6.L120.90' }), null);
});
test('direct context warmup is permitted outside an ad break', async () => {
    const s = setup({ mobile_feed: { clean: true } });
    assert.equal(s.info.IsShowingAd, false);
    assert.equal((await s.ctx.findBackupStream(s.info, target, s.realFetch)).type, 'mobile_feed');
});
test('overlapping rendition requests coalesce a backup search', async () => {
    const s = setup({ mobile_feed: { clean: true } });
    const [a, b] = await Promise.all([s.ctx.findBackupStream(s.info, target, s.realFetch), s.ctx.findBackupStream(s.info, target, s.realFetch)]);
    assert.equal(a.type, b.type);
    assert.equal(s.tokens.filter(t => t === 'mobile_feed').length, 1);
});
test('idle/channel-replaced sessions cannot commit late backup results', async () => {
    const s = setup({ mobile_feed: { clean: true } });
    const pending = s.ctx.findBackupStream(s.info, target, s.realFetch);
    s.ctx.StreamInfos.test = s.ctx.createStreamInfo('test', master('native'), '');
    assert.equal(await pending, null);
    s.info.LastSeenAt = Date.now() - 13000;
    assert.equal(s.ctx.directSessionIsActive(s.info), false);
});
test('search timeouts also bound a media fetch that ignores abort', async () => {
    const s = setup({ mobile_feed: { hang: true }, popout: { hang: true }, autoplay: { hang: true } });
    s.ctx.BackupSearchBudgetMs = 80; s.ctx.BackupRequestTimeoutMs = 20;
    const started = Date.now();
    assert.equal(await s.ctx.findBackupStream(s.info, target, s.realFetch), null);
    assert(Date.now() - started < 500);
});
test('the parser rejects unsafe hosts, encrypted, byte-range, delta and partial playlists', () => {
    const s = setup();
    for (const extra of ['#EXT-X-KEY:METHOD=AES-128,URI="key"\n', '#EXT-X-BYTERANGE:100\n',
        '#EXT-X-PART:URI="part.ts"\n', '#EXT-X-SKIP:SKIPPED-SEGMENTS=1\n']) {
        assert.equal(s.hls.parse(live(100) + extra, BASE).supported, false);
    }
    assert.equal(s.hls.parse(live(100).replace('main100.ts', 'https://evil.test/100.ts'), BASE).supported, false);
    assert.equal(s.hls.parse(live(100).replace('main100.ts', 'https://ttvnw.net.evil.test/100.ts'), BASE).supported, false);
});
test('the parser bounds sequences to exact JavaScript integers and refuses duplicate attributes', () => {
    const s = setup();
    assert.equal(s.hls.parse(live(Number.MAX_SAFE_INTEGER), BASE).supported, false);
    assert.throws(() => s.hls.attributes('URI="a",URI="b"'), /Duplicate/);
    assert.equal(s.hls.attributes('CODECS="avc1.4D402A,mp4a.40.2",RESOLUTION=1920x1080').CODECS, target.Codecs);
});

const CLEAN_TRIGGER = '#EXT-X-DATERANGE:ID="trigger-1791415742",CLASS="twitch-trigger",START-DATE="2026-10-07T23:29:02.062Z"\n';
test('a generic twitch-trigger on real-shaped live media is not an ad marker', () => {
    const s = setup();
    const text = live(3681, 'real', 8, '2026-10-07T23:29:02.062Z') + CLEAN_TRIGGER;
    const p = s.hls.parse(text, BASE);
    assert(p.supported); assert.equal(p.ads, false);
    assert.equal(p.segments.filter(segment => segment.liveSequence !== null).length, 8);
    assert.equal(s.ctx.hasAdTags(text), false);
});
test('a clean backup with twitch-trigger metadata is accepted and replaces actual ad media', async () => {
    const s = setup({ mobile_feed: { clean: true } });
    const fetch = async (url, options) => {
        const response = await s.realFetch(url, options);
        return new URL(url).hostname === 'usher.ttvnw.net' ? response : new Response(await response.text() + CLEAN_TRIGGER);
    };
    s.ctx.StrictAdBlocking = true;
    const output = await s.ctx.processM3U8(BASE, AD, fetch);
    assert(!output.includes('ad.ts'));
    assert.equal(s.messages.at(-1).status, 'replaced');
    assert.equal(s.info.DirectProbeStatus.mobile_feed.state, 'clean');
});
test('actual ad attributes on a trigger still count as an ad', () => {
    const s = setup();
    assert(s.hls.parse(live(3681) + CLEAN_TRIGGER.replace('\n', ',X-TV-TWITCH-AD-POD-POSITION="0"\n'), BASE).ads);
});
test('autoplay is probed before slow source contexts exhaust the budget', async () => {
    const s = setup({ mobile_feed: { hang: true }, popout: { hang: true }, autoplay: { clean: true, variants: [{ res: '640x360', fps: 30 }] } });
    s.ctx.BackupSearchBudgetMs = 35; s.ctx.BackupRequestTimeoutMs = 25;
    const result = await s.ctx.findBackupStream(s.info, target, s.realFetch);
    assert.equal(result.type, 'autoplay');
    assert(s.info.DirectProbeStatus.mobile_feed.state.includes('failed'));
});
test('strict mode withholds detected ads until clean native content arrives', async () => {
    const s = setup();
    s.ctx.StrictAdBlocking = true; s.ctx.StrictAdPollMs = 1; s.ctx.StrictAdWaitLimitMs = 1000;
    let polls = 0;
    const fetch = (url, options) => url === BASE ? Promise.resolve(new Response(++polls < 2 ? AD : live(500) + CLEAN_TRIGGER)) : s.realFetch(url, options);
    const output = await s.ctx.processM3U8(BASE, AD, fetch);
    assert(!output.includes('ad.ts')); assert(output.includes('main500.ts'));
    assert(s.messages.some(message => message.status === 'waiting'));
    assert.equal(s.messages.at(-1).status, 'native');
});
test('strict mode rejects after its wait limit rather than returning the ad playlist', async () => {
    const s = setup();
    s.ctx.StrictAdBlocking = true; s.ctx.StrictAdPollMs = 1; s.ctx.StrictAdWaitLimitMs = 12;
    await assert.rejects(s.ctx.processM3U8(BASE, AD, s.realFetch), /detected ad playlist withheld/);
    assert.equal(s.messages.at(-1).status, 'waiting');
});
test('strict waiting respects navigation/request cancellation', async () => {
    const s = setup(), controller = new AbortController();
    s.ctx.StrictAdBlocking = true; s.ctx.StrictAdPollMs = 1000; s.ctx.StrictAdWaitLimitMs = 2000;
    const pending = s.ctx.processM3U8(BASE, AD, s.realFetch, { signal: controller.signal });
    const timer = setTimeout(() => controller.abort(), 15);
    await assert.rejects(pending, { name: 'AbortError' });
    clearTimeout(timer);
});
test('strict handling also withholds unsupported playlists with actual ad markers', async () => {
    const s = setup(); s.ctx.StrictAdBlocking = true; s.ctx.StrictAdPollMs = 1;
    const unsupported = AD + '#EXT-X-PART:URI="ad-part.ts"\n';
    const fetch = url => url === BASE ? Promise.resolve(new Response(live(1000))) : s.realFetch(url);
    const output = await s.ctx.processM3U8(BASE, unsupported, fetch);
    assert(!output.includes('ad.ts')); assert(s.messages.some(m => m.status === 'waiting'));
});
test('strict wait banner accurately describes withholding rather than native playback', () => {
    const s = bannerSetup();
    s.ctx.updateAdblockBanner({ status: 'waiting', hasAds: true, strict: true, probes: { popout: { state: 'backup-has-ads' } } });
    assert.match(s.notice().textContent, /Ads withheld.*waiting for clean/);
    assert.equal(s.ctx.directAdStatus.probes.popout.state, 'backup-has-ads');
});
test('relative media and map URLs resolve to the observed Twitch CDN', () => {
    const s = setup(), p = s.hls.parse(live(10, 'main', 1, null, 'init.mp4'), BASE);
    assert.equal(p.segments[0].uri, 'https://video-weaver.test.hls.ttvnw.net/live/main10.ts');
    assert(p.segments[0].map.endsWith('/live/init.mp4'));
});
test('overlaps keep published URLs and one clock across native/backup sources', () => {
    const s = setup(), w = new s.hls.LiveWindow();
    w.absorb(s.hls.parse(live(100, 'main', 2, '2026-10-02T17:00:00Z'), BASE), 'main'); w.advance();
    w.absorb(s.hls.parse(live(101, 'backup', 3, '2026-10-02T17:00:09Z'), BASE), 'mobile_feed'); w.advance();
    const out = w.render();
    assert(out.includes('main101.ts')); assert(!out.includes('backup101.ts')); assert(out.includes('backup102.ts'));
    assert(out.includes('2026-10-02T17:00:04.000Z')); assert(!out.includes('2026-10-02T17:00:09'));
    assert(out.includes('#EXT-X-DISCONTINUITY\n'));
});
test('a missed range advances to a fresh run rather than freezing or regressing to late segments', () => {
    const s = setup(), w = new s.hls.LiveWindow();
    w.absorb(s.hls.parse(live(10), BASE), 'main'); w.advance();
    w.absorb(s.hls.parse(live(13, 'backup'), BASE), 'popout'); assert(w.advance());
    assert(w.render().includes('#EXT-X-MEDIA-SEQUENCE:13\n'));
    assert(!w.render().includes('main10.ts'));
    w.absorb(s.hls.parse(live(12, 'late', 1), BASE), 'main'); assert.equal(w.advance(), false);
});
test('ad-only preroll is replaced with actual clean broadcast segments', async () => {
    const s = setup({ mobile_feed: { clean: true, seq: 7977 } });
    const out = await s.ctx.processM3U8(BASE, AD, s.realFetch);
    assert(out.includes('#EXT-X-MEDIA-SEQUENCE:7977\n'));
    assert(out.includes('#EXT-X-TWITCH-LIVE-SEQUENCE:7977\n'));
    assert(!out.includes('ad.ts')); assert(!out.includes('stitched-ad'));
    assert(!s.messages.some(m => m.key === 'ReloadPlayer'));
    assert.equal(s.messages[0].status, 'searching');
    assert.equal(s.messages.at(-1).status, 'replaced');
    assert.equal(s.messages.at(-1).activeBackupPlayerType, 'mobile_feed');
    assert.equal(s.messages.at(-1).resolution, '1920x1080');
});
test('no suitable backup preserves original playback without empty segments or repeated stale windows', async () => {
    const s = setup();
    await s.ctx.processM3U8(BASE, live(100), s.realFetch);
    assert.equal(await s.ctx.processM3U8(BASE, AD, s.realFetch), AD);
    assert.equal(s.info.DirectLanes[BASE], undefined);
    assert.equal(s.ctx.AdSegmentCache.size, 0);
    assert.equal(s.messages.at(-1).status, 'fallback');
    assert.equal(s.messages.at(-1).activeBackupPlayerType, null);
    assert(!s.messages.some(m => ['ReloadPlayer', 'PauseResumePlayer'].includes(m.key)));
});

test('a first preroll bypasses stale negative background-probe cooldowns', async () => {
    const s = setup({ mobile_feed: { clean: true } });
    s.info.FailedBackupPlayerTypes.set('mobile_feed', Date.now());
    s.info.FailedBackupPlayerTypes.set('popout', Date.now());
    const out = await s.ctx.processM3U8(BASE, AD, s.realFetch);
    assert(!out.includes('ad.ts'));
    assert.equal(s.messages.at(-1).status, 'replaced');
});

test('unsupported ad playlists report native fallback and clean playlists clear that status', async () => {
    const s = setup();
    const unsupported = AD + '#EXT-X-PART:URI="ad-part.ts"\n';
    assert.equal(await s.ctx.processM3U8(BASE, unsupported, s.realFetch), unsupported);
    assert.equal(s.messages.at(-1).status, 'unsupported');
    assert.equal(s.messages.at(-1).hasAds, true);
    await s.ctx.processM3U8(BASE, live(200), s.realFetch);
    assert.equal(s.messages.at(-1).status, 'native');
    assert.equal(s.messages.at(-1).hasAds, false);
});

test('a late preroll search cannot overwrite newer native playback or status', async () => {
    const s = setup();
    let resolveBackup;
    s.ctx.findBackupStream = () => new Promise(resolve => { resolveBackup = resolve; });
    const old = s.ctx.processM3U8(BASE, AD, s.realFetch);
    const native = await s.ctx.processM3U8(BASE, live(400), s.realFetch);
    resolveBackup({ type: 'popout', variant: target, playlist: s.hls.parse(live(401, 'backup'), BASE) });
    assert.equal(await old, native);
    assert.equal(s.messages.at(-1).status, 'native');
});

function bannerSetup() {
    const s = setup(), callbacks = new Map(); let sequence = 0, hidden = 0;
    s.ctx.directAdBannerTimer = null;
    function element() {
        return { isConnected: true, style: {}, dataset: {}, children: [], addEventListener() {}, setAttribute() {},
            appendChild(node) { this.children.push(node); node.parentNode = this; },
            querySelector(selector) {
                for (const child of this.children) {
                    if ('.' + child.className === selector) return child;
                    const match = child.querySelector(selector); if (match) return match;
                }
                return null;
            } };
    }
    const root = element();
    s.ctx.cachedPlayerRootDiv = root;
    s.ctx.document = { createElement: element };
    s.ctx.setTimeout = fn => { callbacks.set(++sequence, fn); return sequence; };
    s.ctx.clearTimeout = id => callbacks.delete(id);
    s.ctx.hideTwitchAdOverlays = () => hidden++;
    vm.runInContext(['directBannerIsHidden', 'applyDirectBannerVisibility', 'ensureDirectBannerControls', 'updateAdblockBanner'].map(fn).join('\n'), s.ctx);
    return { ...s, callbacks, notice: () => root.querySelector('.tas-adblock-overlay'), hidden: () => hidden };
}

test('banner distinguishes searching, actual playlist replacement, and native fallback', () => {
    const s = bannerSetup();
    s.ctx.updateAdblockBanner({ status: 'searching', hasAds: true });
    assert.match(s.notice().textContent, /checking replacement/);
    assert.equal(s.hidden(), 0);
    s.ctx.updateAdblockBanner({ status: 'fallback', hasAds: true });
    assert.match(s.notice().textContent, /no clean replacement; native playback/);
    assert.equal(s.hidden(), 0);
    s.ctx.updateAdblockBanner({ status: 'replaced', hasAds: true, activeBackupPlayerType: 'popout', resolution: '1920x1080', frameRate: 60 });
    assert.match(s.notice().textContent, /Ad playlist replaced \(popout\).*1920x1080/);
    assert.equal(s.hidden(), 1);
    assert(!s.notice().textContent.includes('Blocking ads'));
    assert.equal(s.callbacks.size, 1);
});

test('banner hides on native content and expires when playlist messages stop', () => {
    const s = bannerSetup();
    s.ctx.updateAdblockBanner({ status: 'replaced', hasAds: true });
    [...s.callbacks.values()][0]();
    assert.equal(s.notice().style.display, 'none');
    assert.equal(s.ctx.directAdStatus.playlist, 'stale');
    s.ctx.updateAdblockBanner({ status: 'native', hasAds: false });
    assert.equal(s.notice().style.display, 'none');
    assert.equal(s.notice().textContent, '');
    assert.equal(s.ctx.directAdStatus.playlist, 'native');
});

test('client-ad hook is rechecked after success and recovers when the manager resets', () => {
    const s = setup(), callbacks = []; let enabled = false, calls = 0;
    s.ctx.declineBrowserClientAds = () => { calls++; enabled = true; return true; };
    s.ctx.setTimeout = (fn, ms) => { callbacks.push({ fn, ms }); return callbacks.length; };
    vm.runInContext(fn('startBrowserClientAdBlock'), s.ctx);
    s.ctx.startBrowserClientAdBlock();
    assert.equal(s.ctx.directAdStatus.clientAdGate, 'declined');
    assert.equal(callbacks[0].ms, 5000);
    enabled = false;
    callbacks[0].fn();
    assert.equal(enabled, true); assert.equal(calls, 2);
});
test('return to native playback keeps forward numbering and requires no player reset', async () => {
    const s = setup({ mobile_feed: { clean: true, seq: 102 } });
    await s.ctx.processM3U8(BASE, live(100), s.realFetch);
    await s.ctx.processM3U8(BASE, AD, s.realFetch);
    const out = await s.ctx.processM3U8(BASE, live(115, 'native', 4), s.realFetch);
    assert(out.includes('native118.ts'));
    assert(!out.includes('ad.ts'));
    assert(!s.messages.some(m => ['ReloadPlayer', 'PauseResumePlayer'].includes(m.key)));
});
test('initialization maps and source discontinuities survive reconstruction', () => {
    const s = setup(), w = new s.hls.LiveWindow();
    w.acceptCleanBackup(s.hls.parse(live(80, 'clean', 1, null, 'clean-init.mp4'), BASE), 'mobile_feed');
    w.acceptCleanBackup(s.hls.parse(live(81, 'next', 1, null, 'next-init.mp4'), BASE), 'popout');
    const rendered = s.hls.parse(w.render(), BASE);
    assert(rendered.supported); assert.equal(rendered.version, 6);
    assert(rendered.segments[1].map.endsWith('next-init.mp4'));
    assert(rendered.segments[1].discontinuity);
});
test('already-announced prefetch URLs remain frozen across source switches', () => {
    const s = setup(), w = new s.hls.LiveWindow();
    w.absorb(s.hls.parse(live(100, 'main', 1) + '#EXT-X-TWITCH-PREFETCH:main101.ts\n#EXT-X-TWITCH-PREFETCH:main102.ts\n', BASE), 'main');
    w.advance(); w.render();
    w.acceptCleanBackup(s.hls.parse(live(101, 'backup', 2), BASE), 'popout');
    const out = w.render();
    assert(out.includes('main101.ts')); assert(out.includes('main102.ts')); assert(!out.includes('backup101.ts'));
});
test('quality lanes share broadcast numbering rather than unrelated counters', () => {
    const s = setup(), high = new s.hls.LiveWindow(), low = new s.hls.LiveWindow();
    high.acceptCleanBackup(s.hls.parse(live(90, 'high', 15), BASE), 'popout');
    low.acceptCleanBackup(s.hls.parse(live(94, 'low', 15), BASE), 'popout');
    const a = s.hls.parse(high.render(), BASE), b = s.hls.parse(low.render(), BASE);
    assert.equal(a.mediaSequence + 10, b.mediaSequence + 6);
});
test('a long session remains bounded and never regresses sequence numbers', () => {
    const s = setup(), w = new s.hls.LiveWindow();
    for (let i = 0; i < 5000; i++) { w.absorb(s.hls.parse(live(i, 'main', 1), BASE), 'main'); w.advance(); }
    const rendered = w.render(2, true);
    assert(rendered.includes('#EXT-X-MEDIA-SEQUENCE:4985\n'));
    assert(w.window.length <= 60); assert(w.seconds <= 30);
    w.absorb(s.hls.parse(live(1, 'late', 10), BASE), 'main'); assert.equal(w.advance(), false);
    assert.equal(w.render(2, true), rendered);
});
test('warmup polls every two seconds while observed and stops after session replacement', async () => {
    const s = setup({ mobile_feed: { clean: true } }), scheduled = [];
    s.ctx.setTimeout = (callback, delay) => { scheduled.push({ callback, delay }); return scheduled.length; };
    s.ctx.clearTimeout = () => {};
    vm.runInContext(fn('watchDirectBackup'), s.ctx);
    s.ctx.watchDirectBackup(s.info, target, s.realFetch);
    assert.equal(scheduled[0].delay, 0);
    await scheduled.shift().callback();
    const next = scheduled.find(item => item.delay === 2000);
    assert(next); assert.equal(Object.keys(s.info.DirectSnapshots).length, 1);
    s.ctx.StreamInfos.test = {};
    const count = scheduled.length;
    await next.callback();
    assert.equal(scheduled.length, count);
});
test('browser ad manager uses its existing decline path without fabricating fetch responses', () => {
    const s = setup(), calls = [];
    function Manager() {}
    Manager.startProcessingRequests = () => {};
    Manager.decline = (reason, options) => { calls.push({ reason, options }); Manager.declineReason = reason; };
    const req = () => ({ Manager });
    req.m = { target: function() { const startProcessingRequests = 1, declineReason = 1; } };
    let captures = 0;
    s.ctx.webpackChunkapp = { push: entry => { captures++; entry[2](req); } };
    vm.runInContext(fn('declineBrowserClientAds'), s.ctx);
    assert.equal(s.ctx.declineBrowserClientAds(), true);
    assert.equal(calls[0].reason, 'player_size'); assert.equal(calls[0].options.sendEvent, false);
    assert.equal(s.ctx.declineBrowserClientAds(), true); assert.equal(calls.length, 1);
    assert.equal(captures, 1);
    Manager.declineReason = null;
    assert.equal(s.ctx.declineBrowserClientAds(), true); assert.equal(calls.length, 2);
    assert.equal(captures, 1);
});
test('client-ad lookup fails safely when the browser module is unavailable', () => {
    const s = setup(); vm.runInContext(fn('declineBrowserClientAds'), s.ctx);
    assert.equal(s.ctx.declineBrowserClientAds(), false);
});
test('actual generated worker initializes the direct-session model and loads Twitch code', async () => {
    const s = setup(); let blob;
    s.ctx.URL = class extends URL { static createObjectURL(b) { blob = b; return 'blob:https://www.twitch.tv/injected'; } static revokeObjectURL() {} };
    s.ctx.Worker = class { addEventListener() {} postMessage() {} };
    s.ctx.XMLHttpRequest = class { open() {} overrideMimeType() {} send() { this.responseText = 'globalThis.originalWorkerLoaded = true;'; } };
    s.ctx.getWorkersForReinsert = () => []; s.ctx.getCleanWorker = w => w; s.ctx.reinsertWorkers = w => w;
    s.ctx.isValidWorker = () => true; s.ctx.twitchWorkers = [];
    vm.runInContext(['getMatchedAdSignifiers', 'getAccessToken', 'gqlRequest', 'getWasmWorkerJs',
        'getServerTimeFromM3u8', 'replaceServerTimeInM3u8', 'pruneStreamInfos', 'hookWorkerFetch', 'maskAsNative']
        .map(fn).join('\n') + '\nlet injectedBlobUrl = null; let originalRevokeObjectURL = null;\n' + fn('hookWindowWorker') +
        '\nhookWindowWorker(); new window.Worker("blob:https://www.twitch.tv/original");', s.ctx);
    const workerSource = await blob.text(); new vm.Script(workerSource);
    const worker = setup(); worker.ctx.XMLHttpRequest = s.ctx.XMLHttpRequest; worker.ctx.fetch = async () => new Response(live(100));
    worker.ctx.addEventListener = () => {}; worker.ctx.setInterval = () => 1;
    // Avoid predeclaring DirectHls in the same scope as the generated blob.
    const fresh = vm.createContext({ ...worker.ctx }); fresh.self = fresh; fresh.window = fresh;
    vm.runInContext(workerSource, fresh);
    assert.equal(fresh.originalWorkerLoaded, true);
    assert.equal(typeof fresh.directSessionIsActive, 'function');
    assert(!/\b(?:const|let|var)\s+BLANK_MP4/.test(workerSource));
    assert(!/function\s+stripAdSegments\(/.test(workerSource));
});
test('the complete userscript starts in a browser-like page with no deleted-helper references', () => {
    const s = setup();
    const storage = new Map();
    s.ctx.localStorage = { getItem: k => storage.get(k) ?? null, setItem: (k,v) => storage.set(k,v), removeItem: k => storage.delete(k) };
    s.ctx.document = { location: { hostname: 'www.twitch.tv', pathname: '/test' }, readyState: 'loading', addEventListener() {} };
    s.ctx.frameElement = null;
    s.ctx.XMLHttpRequest = class { open() {} };
    s.ctx.Worker = class Worker {};
    s.ctx.URL = class extends URL { static createObjectURL() { return 'blob:https://www.twitch.tv/test'; } static revokeObjectURL() {} };
    s.ctx.fetch = async () => new Response('{}');
    s.ctx.addEventListener = () => {};
    s.ctx.setTimeout = () => 1;
    s.ctx.setInterval = () => 1;
    vm.runInContext(source, s.ctx);
    assert.equal(s.ctx.twitchAdSolutionsVersion, 95);
    assert.equal(typeof s.ctx.reloadTwitchPlayer, 'function');
    const installedFetch = s.ctx.fetch;
    vm.runInContext(source, s.ctx);
    assert.equal(s.ctx.fetch, installedFetch);
});

test('an aged warm playlist cannot suppress a fresh foreground media request', async () => {
    const s = setup({ mobile_feed: { clean: true, seq: 120 } });
    // Use the implementation's codec family to avoid fixture assumptions.
    const actualKey = target.Resolution + '/' + target.FrameRate + '/' + s.ctx.videoCodecFamily(target.Codecs);
    s.info.DirectSnapshots[actualKey] = { observed: Date.now() - 3000,
        backup: { type: 'mobile_feed', variant: target, playlist: s.hls.parse(live(100, 'stale', 14), BASE) } };
    const output = await s.ctx.processM3U8(BASE, AD, s.realFetch);
    assert(s.requests.some(url => url.includes('/mobile_feed/')));
    assert(output.includes('mobile_feed120.ts'));
    assert(!output.includes('stale100.ts'));
});
test('a recent warm playlist without a newer segment still refreshes media', async () => {
    const s = setup({ mobile_feed: { clean: true, seq: 120 } });
    await s.ctx.processM3U8(BASE, live(100, 'main', 14), s.realFetch);
    const key = target.Resolution + '/' + target.FrameRate + '/' + s.ctx.videoCodecFamily(target.Codecs);
    s.info.DirectSnapshots[key] = { observed: Date.now(),
        backup: { type: 'mobile_feed', variant: target, playlist: s.hls.parse(live(100, 'old', 14), BASE) } };
    const output = await s.ctx.processM3U8(BASE, AD, s.realFetch);
    assert(output.includes('mobile_feed120.ts'));
    assert(s.requests.some(url => url.includes('/mobile_feed/')));
});
test('fresh advancing warm media avoids a redundant foreground search', async () => {
    const s = setup();
    const key = target.Resolution + '/' + target.FrameRate + '/' + s.ctx.videoCodecFamily(target.Codecs);
    s.info.DirectSnapshots[key] = { observed: Date.now(),
        backup: { type: 'popout', variant: target, playlist: s.hls.parse(live(120, 'warm', 14), BASE) } };
    const output = await s.ctx.processM3U8(BASE, AD, s.realFetch);
    assert(output.includes('warm120.ts'));
    assert.equal(s.requests.length, 0);
});
test('backup media bypasses HTTP caches while retaining request cancellation', async () => {
    const s = setup(); let options;
    const abort = new AbortController();
    await s.ctx.fetchBackupText(async (url, init) => { options = init; return new Response('live'); }, BASE, 100,
        { signal: abort.signal, credentials: 'omit', cache: 'force-cache' });
    assert.equal(options.cache, 'no-store');
    assert.equal(options.credentials, 'omit');
    assert(options.signal instanceof AbortSignal);
});
function latencySetup() {
    let time = 1000, channel = 'test', enabled = true;
    const status = { channel, updatedAt: time, playlist: 'replaced' };
    const handlers = new Map();
    let ranges = [[0, 17]];
    const video = { currentTime: 10, readyState: 4, playbackRate: 1, paused: false, seeking: false, ended: false,
        buffered: { get length() { return ranges.length; }, start: i => ranges[i][0], end: i => ranges[i][1] },
        addEventListener: (event, fn) => handlers.set(event, fn), removeEventListener: event => handlers.delete(event) };
    const ctx = vm.createContext({ Date, Math, Number });
    vm.runInContext(fn('createDirectLatencyController'), ctx);
    let selectedVideo = video;
    const controller = ctx.createDirectLatencyController({ getVideo: () => selectedVideo, getStatus: () => status,
        getChannel: () => channel, enabled: () => enabled, now: () => time });
    return { controller, video, status, handlers, ranges: value => { ranges = value; },
        time: value => { time = value; }, channel: value => { channel = value; }, enabled: value => { enabled = value; },
        selectedVideo: value => { selectedVideo = value; } };
}
test('catch-up consumes excess buffered video gradually and keeps a playable reserve', () => {
    const s = latencySetup(); s.controller.tick();
    assert.equal(s.video.playbackRate, 1.08);
    assert.equal(s.video.currentTime, 10); // No seek or skipped video.
    s.ranges([[0, 14]]); s.controller.tick(); assert.equal(s.video.playbackRate, 1.05);
    s.ranges([[0, 12]]); s.controller.tick(); assert.equal(s.video.playbackRate, 1);
    assert.equal(s.status.catchUp.bufferedAheadSeconds, 2);
});
test('catch-up stops immediately on a stall or user pause and respects low readyState', () => {
    const s = latencySetup(); s.controller.tick();
    s.handlers.get('waiting')(); assert.equal(s.video.playbackRate, 1);
    s.time(7000); s.status.updatedAt = 7000; s.video.readyState = 2;
    s.controller.tick(); assert.equal(s.video.playbackRate, 1);
    s.video.readyState = 4; s.controller.tick(); assert.equal(s.video.playbackRate, 1.08);
    s.video.paused = true; s.handlers.get('pause')(); s.controller.tick();
    assert.equal(s.video.playbackRate, 1); assert.equal(s.video.paused, true);
});
test('catch-up yields to other speed controls and leaves manual speed intact on navigation', () => {
    const s = latencySetup(); s.controller.tick(); s.video.playbackRate = 1.5; s.controller.tick();
    assert.equal(s.video.playbackRate, 1.5);
    s.video.playbackRate = 1; s.time(2000); s.status.updatedAt = 2000; s.controller.tick();
    assert.equal(s.video.playbackRate, 1);
    s.video.playbackRate = 1.5; s.channel('different'); s.controller.tick();
    assert.equal(s.video.playbackRate, 1.5);
});
test('catch-up ignores disjoint future ranges, stale status, and explicit opt-out', () => {
    const s = latencySetup(); s.ranges([[0, 12], [40, 50]]); s.controller.tick();
    assert.equal(s.video.playbackRate, 1);
    s.ranges([[0, 17]]); s.time(10000); s.controller.tick(); assert.equal(s.video.playbackRate, 1);
    s.status.updatedAt = 10000; s.enabled(false); s.controller.tick(); assert.equal(s.video.playbackRate, 1);
});
test('catch-up expires after returning to native and restores a replaced video element', () => {
    const s = latencySetup(); s.controller.tick(); s.status.playlist = 'native';
    s.time(3000); s.status.updatedAt = 3000; s.controller.tick(); assert.equal(s.video.playbackRate, 1.08);
    s.selectedVideo(null); s.controller.tick(); assert.equal(s.video.playbackRate, 1);
    s.selectedVideo(s.video); s.time(50000); s.status.updatedAt = 50000; s.controller.tick();
    assert.equal(s.video.playbackRate, 1);
});
