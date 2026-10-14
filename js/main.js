(function () {
  var page = document.getElementById('page');
  var loader = document.getElementById('loader');
  var counterEl = document.getElementById('loaderCount');

  var hasGSAP = typeof gsap !== 'undefined';
  var hasScrollTrigger = typeof ScrollTrigger !== 'undefined';
  var hasLenis = typeof Lenis !== 'undefined';

  if (hasGSAP && hasScrollTrigger) {
    gsap.registerPlugin(ScrollTrigger);
  }

  var EASE = 'power3.out';
  // Shared with js/network-graph.js so the graph's motion matches the rest of the site.
  window.Recall = { EASE: EASE };

  function revealPage() {
    if (page) page.style.opacity = '1';
    if (hasGSAP) {
      gsap.fromTo(page, { opacity: 0 }, { opacity: 1, duration: 0.5, ease: EASE });
    }
  }

  function finishLoader() {
    if (!loader) { revealPage(); return; }
    if (hasGSAP) {
      gsap.to(loader, {
        yPercent: -100,
        duration: 0.9,
        ease: 'power4.inOut',
        onComplete: function () {
          loader.style.display = 'none';
        }
      });
      revealPage();
    } else {
      loader.style.display = 'none';
      revealPage();
    }
  }

  // Progress counter (cosmetic minimum-duration loader)
  var progress = 0;
  var interval = setInterval(function () {
    progress += Math.random() * 22 + 8;
    if (progress >= 100) {
      progress = 100;
      clearInterval(interval);
      setTimeout(finishLoader, 220);
    }
    if (counterEl) counterEl.textContent = Math.floor(progress) + '%';
  }, 130);

  // Safety net: never let the loader trap the page
  setTimeout(function () {
    if (loader && loader.style.display !== 'none') finishLoader();
  }, 2600);

  // Smooth scroll (Lenis)
  if (hasLenis) {
    var lenis = new Lenis({
      duration: 1.1,
      easing: function (t) { return 1 - Math.pow(1 - t, 3); },
      smoothWheel: true
    });
    if (hasGSAP && hasScrollTrigger) {
      lenis.on('scroll', ScrollTrigger.update);
      gsap.ticker.add(function (time) { lenis.raf(time * 1000); });
      gsap.ticker.lagSmoothing(0);
    } else {
      function raf(time) { lenis.raf(time); requestAnimationFrame(raf); }
      requestAnimationFrame(raf);
    }
  }

  // Hero background video. It's always visible (the poster frame shows until it plays), so
  // there's no "ready" state to miss. Autoplay can be refused (low-power mode, data saver), so
  // retry on the first interaction; reduced motion keeps it paused on the poster.
  var heroVideo = document.getElementById('heroVideo');
  if (heroVideo) {
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) {
      heroVideo.removeAttribute('autoplay');
      heroVideo.pause();
    } else {
      var tryPlay = function () {
        var p = heroVideo.play();
        if (p && p.catch) p.catch(function () {});
      };
      tryPlay();
      ['pointerdown', 'keydown', 'touchstart', 'scroll'].forEach(function (evt) {
        window.addEventListener(evt, function once() {
          window.removeEventListener(evt, once);
          if (heroVideo.paused) tryPlay();
        }, { passive: true });
      });
      document.addEventListener('visibilitychange', function () {
        if (!document.hidden && heroVideo.paused) tryPlay();
      });
    }
  }

  if (!hasGSAP) return;

  // Hero entrance
  gsap.set('.reveal-up, .reveal-scale', { opacity: 0 });
  gsap.set('.hero-word .w', { opacity: 0 });

  var heroTl = gsap.timeline({ delay: 1.15, defaults: { ease: EASE } });
  heroTl
    .fromTo('.hero-word .w', { yPercent: 32, opacity: 0 }, { yPercent: 0, opacity: 1, duration: 1.2, ease: 'expo.out' }, 0)
    .fromTo('.hero .reveal-up', { y: 26, opacity: 0 }, { y: 0, opacity: 1, duration: 0.9, stagger: 0.12 }, 0.35);

  // Scroll-triggered reveals for everything below the hero
  if (hasScrollTrigger) {
    var items = gsap.utils.toArray('.reveal-up:not(.hero .reveal-up), .reveal-scale');
    items.forEach(function (el) {
      gsap.fromTo(el,
        { opacity: 0, y: 28 },
        {
          opacity: 1, y: 0, duration: 0.85, ease: EASE,
          scrollTrigger: {
            trigger: el,
            start: 'top 88%',
            toggleActions: 'play none none reverse'
          }
        }
      );
    });

    // Stagger the step cards together
    gsap.utils.toArray('.steps').forEach(function (group) {
      var cards = group.querySelectorAll('.step');
      gsap.fromTo(cards, { opacity: 0, y: 30 }, {
        opacity: 1, y: 0, duration: 0.7, stagger: 0.12, ease: EASE,
        scrollTrigger: { trigger: group, start: 'top 85%' }
      });
    });

    // Scroll-driven quiz deck fan. It starts dark so it continues the hero, then the
    // colours turn over to cream as the cards fan out. Text flips colour a little
    // before the halfway point so it never sits on a mid-tone background it can't read.
    var deckCards = gsap.utils.toArray('.deck-card');
    if (deckCards.length) {
      var deckTl = gsap.timeline({
        scrollTrigger: {
          trigger: '.deck',
          start: 'top top',
          end: '+=2200',
          pin: true,
          scrub: 1
        }
      });
      deckTl
        .fromTo('.deck', { backgroundColor: '#211D17' }, { backgroundColor: '#EEE6D6', duration: 1.2, ease: 'none' }, 0)
        .fromTo('.deck .section-title', { color: '#F6F1E7' }, { color: '#211D17', duration: 0.2, ease: 'none' }, 0.4)
        .fromTo('.deck .eyebrow', { color: '#F0DCCB' }, { color: '#A8461F', duration: 0.2, ease: 'none' }, 0.4);
      deckCards.forEach(function (card, i) {
        var dir = i - (deckCards.length - 1) / 2;
        deckTl.to(card, {
          x: dir * 140,
          y: -Math.abs(dir) * 20,
          rotate: dir * 9,
          duration: 1
        }, i * 0.2);
      });
    }
  }
})();
