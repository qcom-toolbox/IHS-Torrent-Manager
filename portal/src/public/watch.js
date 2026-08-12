(function () {
  'use strict';

  var video = document.getElementById('player');
  var select = document.getElementById('audio-track-select');
  if (!video) return;

  var streamUrl = video.dataset.streamUrl;
  var defaultTrackRaw = video.dataset.defaultTrack;
  var defaultTrack = defaultTrackRaw === '' ? null : parseInt(defaultTrackRaw, 10);
  // False when the default track's own codec isn't browser-decodable (e.g.
  // AC-3/DTS) -- the server already routed the initial <source> through
  // the remux+transcode path in that case, so the "fast path" doesn't
  // exist for this file at all, not even for the default track.
  var fastPathEligible = video.dataset.fastPathEligible === 'true';

  // Which track is currently loaded. Starts at the server-picked default
  // (the plain, Range-enabled /stream URL with no ?track= at all, when eligible).
  var currentTrack = defaultTrack;

  function usesFastPath(track) {
    return fastPathEligible && track === defaultTrack;
  }

  function urlFor(track, seekSeconds) {
    if (usesFastPath(track)) {
      return streamUrl; // no ?track= -- the fast, Range-enabled path
    }
    var url = streamUrl + '?track=' + encodeURIComponent(track);
    if (seekSeconds && seekSeconds > 0.5) {
      url += '&t=' + encodeURIComponent(seekSeconds.toFixed(2));
    }
    return url;
  }

  function switchTrack(track, seekSeconds) {
    var wasPlaying = !video.paused;
    currentTrack = track;
    video.src = urlFor(track, seekSeconds);
    video.load();
    if (seekSeconds && seekSeconds > 0.5 && usesFastPath(track)) {
      // The fast path supports real Range seeking -- just set currentTime
      // once metadata is available instead of baking a start offset in.
      video.addEventListener(
        'loadedmetadata',
        function () {
          video.currentTime = seekSeconds;
        },
        { once: true }
      );
    }
    if (wasPlaying) {
      video.play().catch(function () {
        // Autoplay was blocked; the user still has visible controls to hit play.
      });
    }
  }

  if (select) {
    select.addEventListener('change', function () {
      var chosen = parseInt(select.value, 10);
      if (chosen === currentTrack) return;
      switchTrack(chosen, video.currentTime);
    });
  }

  // Non-default tracks are served by a live ffmpeg remux with no
  // Content-Length and no Range support (see the server-side comment in
  // portal/src/index.ts), so the browser can only natively seek within
  // whatever's already buffered. A seek beyond that would otherwise just
  // stall -- detect that case and reload the stream starting from the
  // requested time instead, which restarts the remux at that offset
  // (fast: ffmpeg only seeks to the nearest keyframe, still copy-only).
  var seekDebounce = null;
  video.addEventListener('seeking', function () {
    if (usesFastPath(currentTrack)) return; // native Range seeking handles this fine
    var target = video.currentTime;
    var covered = false;
    for (var i = 0; i < video.buffered.length; i++) {
      if (target >= video.buffered.start(i) && target <= video.buffered.end(i)) {
        covered = true;
        break;
      }
    }
    if (covered) return;
    clearTimeout(seekDebounce);
    seekDebounce = setTimeout(function () {
      switchTrack(currentTrack, target);
    }, 300);
  });
})();
