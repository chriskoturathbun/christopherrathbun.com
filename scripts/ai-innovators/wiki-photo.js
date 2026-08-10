/* WikiPhoto — loads freely licensed lead images + photographer credits
   live from the Wikipedia / Wikimedia Commons APIs (CORS via origin=*).
   Images stay hotlinked from upload.wikimedia.org; nothing is rehosted. */
var WikiPhoto = (function () {
  var WP = 'https://en.wikipedia.org/w/api.php';
  var COMMONS = 'https://commons.wikimedia.org/w/api.php';

  function api(base, params) {
    var qs = 'action=query&format=json&origin=*';
    for (var k in params) qs += '&' + k + '=' + encodeURIComponent(params[k]);
    return fetch(base + '?' + qs).then(function (r) { return r.json(); });
  }

  // Resolve requested titles through the API's normalization + redirect maps.
  function titleMap(query) {
    var fwd = {};
    (query.normalized || []).forEach(function (n) { fwd[n.from] = n.to; });
    (query.redirects || []).forEach(function (n) { fwd[n.from] = n.to; });
    return function (t) {
      var seen = {};
      while (fwd[t] && !seen[t]) { seen[t] = 1; t = fwd[t]; }
      return t;
    };
  }

  function attach(slot, url, alt) {
    var img = new Image();
    img.className = 'headshot';
    img.alt = alt || '';
    img.referrerPolicy = 'no-referrer';
    img.onload = function () { img.classList.add('loaded'); };
    img.onerror = function () { img.remove(); };
    img.src = url;
    img.style.position = 'absolute';
    img.style.inset = '0';
    slot.style.position = 'relative';
    slot.appendChild(img);
  }

  function stripHtml(html) {
    var d = document.createElement('div');
    d.innerHTML = html;
    var t = (d.textContent || '').replace(/\s+/g, ' ').trim();
    return t.length > 80 ? t.slice(0, 77) + '…' : t;
  }

  /* Index grid: batch-load thumbnails, ≤50 titles per request. */
  function loadThumbs(slots, size) {
    var byTitle = {};
    slots.forEach(function (s) { (byTitle[s.dataset.wiki] = byTitle[s.dataset.wiki] || []).push(s); });
    var titles = Object.keys(byTitle);
    for (var i = 0; i < titles.length; i += 50) {
      (function (chunk) {
        api(WP, { titles: chunk.join('|'), prop: 'pageimages', piprop: 'thumbnail', pithumbsize: size, redirects: 1 })
          .then(function (data) {
            if (!data.query) return;
            var resolve = titleMap(data.query);
            var pages = {};
            Object.keys(data.query.pages || {}).forEach(function (id) {
              var p = data.query.pages[id];
              if (p.thumbnail) pages[p.title] = p.thumbnail.source;
            });
            chunk.forEach(function (t) {
              var url = pages[resolve(t)];
              if (url) byTitle[t].forEach(function (slot) { attach(slot, url, t); });
            });
          })
          .catch(function () { /* placeholders already visible */ });
      })(titles.slice(i, i + 50));
    }
  }

  /* Person page: load a large portrait plus artist/license credit. */
  function loadPortrait(box, creditEl, googleUrl) {
    var title = box.dataset.wiki;
    var fallback = 'No freely licensed photo found — <a href="' + googleUrl + '" target="_blank" rel="noopener">search Google Images ↗</a>';
    if (!title) { creditEl.innerHTML = fallback; return; }

    api(WP, { titles: title, prop: 'pageimages', piprop: 'thumbnail|name', pithumbsize: 800, redirects: 1 })
      .then(function (data) {
        var pages = (data.query && data.query.pages) || {};
        var page = pages[Object.keys(pages)[0]];
        if (!page || !page.thumbnail) { creditEl.innerHTML = fallback; return; }
        attach(box, page.thumbnail.source, title);
        return credit(page.pageimage, creditEl);
      })
      .catch(function () { creditEl.innerHTML = fallback; });

    function credit(fileName, el) {
      if (!fileName) { el.textContent = 'Photo via Wikipedia'; return; }
      var params = {
        titles: 'File:' + fileName,
        prop: 'imageinfo',
        iiprop: 'extmetadata|url',
        iiextmetadatafilter: 'Artist|LicenseShortName|LicenseUrl'
      };
      return api(COMMONS, params).then(function (data) {
        var pages = (data.query && data.query.pages) || {};
        var key = Object.keys(pages)[0];
        if (key === '-1' || !pages[key].imageinfo) {
          // file hosted on en.wikipedia rather than Commons
          return api(WP, params).then(function (d2) {
            var p2 = (d2.query && d2.query.pages) || {};
            var k2 = Object.keys(p2)[0];
            render(k2 !== '-1' && p2[k2].imageinfo ? p2[k2].imageinfo[0] : null, 'Wikipedia');
          });
        }
        render(pages[key].imageinfo[0], 'Wikimedia Commons');
      }).catch(function () { el.textContent = 'Photo via Wikimedia Commons'; });

      function render(info, host) {
        if (!info) { el.textContent = 'Photo via ' + host; return; }
        var md = info.extmetadata || {};
        var artist = md.Artist ? stripHtml(md.Artist.value) : 'Unknown photographer';
        var lic = md.LicenseShortName ? md.LicenseShortName.value : '';
        var licUrl = md.LicenseUrl ? md.LicenseUrl.value : '';
        var filePage = info.descriptionurl || '#';
        var html = 'Photo: <a href="' + filePage + '" target="_blank" rel="noopener">' + artist + '</a>';
        if (lic) html += ' · ' + (licUrl ? '<a href="' + licUrl + '" target="_blank" rel="noopener">' + lic + '</a>' : lic);
        html += ' · via ' + host;
        el.innerHTML = html;
      }
    }
  }

  return { loadThumbs: loadThumbs, loadPortrait: loadPortrait };
})();
