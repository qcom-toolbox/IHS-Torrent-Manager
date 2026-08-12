(function () {
  'use strict';

  var video = document.getElementById('player');
  var row = document.getElementById('audio-track-row');
  var select = document.getElementById('audio-track-select');
  if (!video || !row || !select) return;

  function trackLabel(track, index) {
    if (track.label) return track.label;
    if (track.language) return track.language.toUpperCase();
    return 'Track ' + (index + 1);
  }

  // HTMLMediaElement.audioTracks exposes embedded audio tracks (e.g. a
  // video file muxed with multiple language dubs/commentary tracks) and
  // lets a track be selected by toggling its `enabled` flag -- decoding
  // and mixing still happen entirely in the browser/OS media pipeline
  // (the same native, hardware-accelerated path as normal playback), no
  // server involvement. Support varies by browser, so this is strictly a
  // progressive enhancement: with a single track, or without API support,
  // the file just plays with whatever track the browser picked by default.
  function setupAudioTracks() {
    var tracks = video.audioTracks;
    if (!tracks || tracks.length < 2) return;

    select.innerHTML = '';
    for (var i = 0; i < tracks.length; i++) {
      var opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = trackLabel(tracks[i], i);
      if (tracks[i].enabled) opt.selected = true;
      select.appendChild(opt);
    }
    row.hidden = false;

    select.addEventListener('change', function () {
      var chosen = parseInt(select.value, 10);
      for (var i = 0; i < tracks.length; i++) {
        try {
          tracks[i].enabled = i === chosen;
        } catch (e) {
          // Some browsers expose the list read-only; nothing to recover here.
        }
      }
    });

    if (tracks.addEventListener) {
      tracks.addEventListener('change', function () {
        for (var i = 0; i < tracks.length; i++) {
          if (tracks[i].enabled) {
            select.value = String(i);
            break;
          }
        }
      });
    }
  }

  video.addEventListener('loadedmetadata', setupAudioTracks);
  // Some browsers populate audioTracks slightly after loadedmetadata fires.
  video.addEventListener('canplay', setupAudioTracks);
})();
