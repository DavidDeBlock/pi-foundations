(function () {
  'use strict';

  /* ============================================================
     Opening hours — single source of truth (matches brief §7)
     0 = Sun, 1 = Mon, 2 = Tue, 3 = Wed, 4 = Thu, 5 = Fri, 6 = Sat
     null = closed all day
     ============================================================ */
  var HOURS = {
    1: null, // Mon closed
    2: [{ open: '09:30', close: '12:30' }, { open: '13:30', close: '18:30' }], // Tue
    3: [{ open: '09:30', close: '12:30' }, { open: '13:30', close: '18:30' }], // Wed
    4: null, // Thu closed
    5: [{ open: '09:30', close: '12:30' }, { open: '13:30', close: '18:30' }], // Fri
    6: [{ open: '10:00', close: '12:30' }, { open: '13:30', close: '18:00' }], // Sat
    0: null  // Sun closed
  };

  var DAY_NAMES = ['Zo', 'Ma', 'Di', 'Wo', 'Do', 'Vr', 'Za'];

  function parseTime(baseDate, timeStr) {
    var parts = timeStr.split(':');
    var d = new Date(baseDate.getTime());
    d.setHours(parseInt(parts[0], 10), parseInt(parts[1], 10), 0, 0);
    return d;
  }

  function formatTime(date) {
    var h = date.getHours();
    var m = date.getMinutes();
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  }

  function findNextOpenDay(fromDay) {
    for (var i = 1; i <= 7; i++) {
      var nextDay = (fromDay + i) % 7;
      if (HOURS[nextDay] && HOURS[nextDay].length) {
        return { day: nextDay, offset: i, hours: HOURS[nextDay] };
      }
    }
    return null;
  }

  function computeStatus(now) {
    var day = now.getDay();
    var todays = HOURS[day];

    // Currently open?
    if (todays && todays.length) {
      for (var i = 0; i < todays.length; i++) {
        var open = parseTime(now, todays[i].open);
        var close = parseTime(now, todays[i].close);
        if (now >= open && now < close) {
          return {
            state: 'open',
            text: 'Vandaag open tot ' + formatTime(close)
          };
        }
      }

      // Before today's first opening?
      var firstOpen = parseTime(now, todays[0].open);
      if (now < firstOpen) {
        return {
          state: 'closed',
          text: 'Vandaag open om ' + formatTime(firstOpen)
        };
      }
    }

    // Closed now — find next opening
    var next = findNextOpenDay(day);
    if (next) {
      var label = next.offset === 1 ? 'Morgen' : DAY_NAMES[next.day];
      return {
        state: 'closed',
        text: 'Gesloten · ' + label + ' open om ' + next.hours[0].open
      };
    }

    return { state: 'closed', text: 'Gesloten' };
  }

  /* ============================================================
     Operational status render
     ============================================================ */
  var statusEl = document.getElementById('operational-status');
  if (statusEl) {
    var status = computeStatus(new Date());
    statusEl.textContent = status.text;
    if (status.state === 'closed') {
      statusEl.classList.add('operational-strip__status--closed');
    }
  }

  /* ============================================================
     Sticky operational strip — mobile only, after hero scrolls out
     ============================================================ */
  var strip = document.getElementById('operational-strip');
  var heroSection = document.querySelector('.hero');

  function isMobile() {
    return window.matchMedia('(max-width: 1023px)').matches;
  }

  if (strip && heroSection) {
    var ticking = false;

    function updateStrip() {
      if (!isMobile()) {
        strip.classList.remove('is-sticky');
        ticking = false;
        return;
      }
      var heroBottom = heroSection.getBoundingClientRect().bottom;
      var shouldStick = heroBottom < 0;
      strip.classList.toggle('is-sticky', shouldStick);
      ticking = false;
    }

    window.addEventListener('scroll', function () {
      if (!ticking) {
        window.requestAnimationFrame(updateStrip);
        ticking = true;
      }
    }, { passive: true });

    window.addEventListener('resize', updateStrip);
    updateStrip();
  }

  /* ============================================================
     Sticky mobile "Bel of maak afspraak" CTA
     Show once hero is out, hide when contact section is in view.
     ============================================================ */
  var stickyCta = document.getElementById('sticky-cta');
  var contactSection = document.getElementById('contact-teaser');

  if (stickyCta && heroSection) {
    var visible = false;
    var scrollTicking = false;

    function updateStickyCta() {
      if (!isMobile()) {
        if (visible) {
          stickyCta.hidden = true;
          stickyCta.setAttribute('data-visible', 'false');
          document.body.classList.remove('has-sticky-cta');
          visible = false;
        }
        scrollTicking = false;
        return;
      }

      var heroBottom = heroSection.getBoundingClientRect().bottom;
      var inContact = false;
      if (contactSection) {
        var rect = contactSection.getBoundingClientRect();
        inContact = rect.top < window.innerHeight * 0.6;
      }

      var shouldShow = heroBottom < 0 && !inContact;

      if (shouldShow !== visible) {
        visible = shouldShow;
        stickyCta.hidden = !shouldShow;
        stickyCta.setAttribute('data-visible', String(shouldShow));
        document.body.classList.toggle('has-sticky-cta', shouldShow);
      }
      scrollTicking = false;
    }

    window.addEventListener('scroll', function () {
      if (!scrollTicking) {
        window.requestAnimationFrame(updateStickyCta);
        scrollTicking = true;
      }
    }, { passive: true });

    window.addEventListener('resize', updateStickyCta);
    updateStickyCta();
  }

  /* ============================================================
     Mobile nav toggle
     ============================================================ */
  var navToggle = document.querySelector('.site-header__toggle');
  var mobileNav = document.getElementById('mobile-nav');

  if (navToggle && mobileNav) {
    navToggle.addEventListener('click', function () {
      var expanded = navToggle.getAttribute('aria-expanded') === 'true';
      navToggle.setAttribute('aria-expanded', String(!expanded));
      mobileNav.hidden = expanded;
      navToggle.setAttribute('aria-label', expanded ? 'Menu openen' : 'Menu sluiten');
    });

    // Close mobile nav when a link is clicked
    var mobileLinks = mobileNav.querySelectorAll('a');
    for (var i = 0; i < mobileLinks.length; i++) {
      mobileLinks[i].addEventListener('click', function () {
        navToggle.setAttribute('aria-expanded', 'false');
        mobileNav.hidden = true;
        navToggle.setAttribute('aria-label', 'Menu openen');
      });
    }
  }
})();