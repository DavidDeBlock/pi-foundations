(function () {
  var root = document.querySelector('[data-youtube-player]')
  if (!root) return
  var iframe = root.querySelector('iframe')
  var videoId = root.getAttribute('data-dashboard-video-id')
  if (!iframe || !videoId) return

  var sessionId = (self.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2)
  var resumeAt = Number(root.getAttribute('data-resume-seconds') || 0)
  var completed = root.getAttribute('data-completed') === 'true'
  var requestedSource = new URLSearchParams(location.search).get('source')
  var source = ['search', 'playlist', 'subscription'].indexOf(requestedSource) >= 0
    ? requestedSource
    : 'embedded_player'
  var player = null
  var timer = null
  var started = false

  function position() { try { return Math.max(0, Number(player && player.getCurrentTime()) || 0) } catch (_) { return 0 } }
  function duration() { try { return Math.max(0, Number(player && player.getDuration()) || 0) } catch (_) { return 0 } }
  function save(event, keepalive) {
    var payload = JSON.stringify({ session_id: sessionId, event: event, source: source, position_seconds: position(), duration_seconds: duration() })
    fetch('/api/videos/' + encodeURIComponent(videoId) + '/playback', {
      method: 'PUT', credentials: 'same-origin', keepalive: Boolean(keepalive),
      headers: { 'content-type': 'application/json' }, body: payload
    }).then(function (response) { if (!response.ok && response.status !== 0) throw new Error('HTTP ' + response.status) })
      .catch(function () { /* a later checkpoint retries current progress */ })
  }
  function stopTimer() { if (timer) clearInterval(timer); timer = null }
  function startTimer() { stopTimer(); timer = setInterval(function () { save('progress', false) }, 10000) }
  function onStateChange(event) {
    if (event.data === 1) { started = true; save('playing', false); startTimer() }
    else if (event.data === 2) { stopTimer(); if (started) save('paused', false) }
    else if (event.data === 0) { stopTimer(); if (started) save('ended', false) }
  }
  function initialise() {
    if (!window.YT || !window.YT.Player) return
    player = new YT.Player(iframe, {
      events: {
        onReady: function (event) {
          if (!completed && resumeAt >= 5) event.target.seekTo(resumeAt, true)
        },
        onStateChange: onStateChange
      }
    })
  }
  var previousReady = window.onYouTubeIframeAPIReady
  window.onYouTubeIframeAPIReady = function () { if (typeof previousReady === 'function') previousReady(); initialise() }
  if (window.YT && window.YT.Player) initialise()
  window.addEventListener('pagehide', function () { stopTimer(); if (started) save('closed', true) })
}())
