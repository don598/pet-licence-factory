// ── Goofy Licenses — Council seal (shared vector art) ─────────────────────────
// Gerald (he has seniority) under the crown, ringed by CERTIFIED GOAT /
// GREATEST OF ALL TIME: the same motif as the seal on the licence card. Pure
// #000 vector so it prints crisp on thermal, laser or inkjet. Used by the 6×4
// certificate (public/goofy/certificate.html) and the G.O.A.T. envelope label
// in Command Station. Edit the seal HERE, never in a page.
//
//   GOOFY_SEAL.art(id)       shapes only (rings, Gerald, crown, stars); id makes
//                            the clipPath unique when a page shows several seals
//   GOOFY_SEAL.textSvg(id)   the two ring-text lines as SVG textPath (the page
//                            must load Cinzel 700)
//   GOOFY_SEAL.svg(id, px)   a complete <svg> (art + text), px wide
//   GOOFY_SEAL.TEXT          ring-text geometry (seal units, viewBox 0 0 120 120)
//                            for canvas redraws that can't use textPath
(function (root) {
  'use strict';
  var ART = "<defs><clipPath id=\"{ID}In\"><circle cx=\"60\" cy=\"60\" r=\"37.3\"/></clipPath></defs><circle cx=\"60\" cy=\"60\" r=\"58\" fill=\"none\" stroke=\"#000\" stroke-width=\"2.6\"/><circle cx=\"60\" cy=\"60\" r=\"54.6\" fill=\"none\" stroke=\"#000\" stroke-width=\"1.1\"/><circle cx=\"60\" cy=\"60\" r=\"38\" fill=\"none\" stroke=\"#000\" stroke-width=\"1.5\"/><g clip-path=\"url(#{ID}In)\"><g transform=\"translate(31 37) scale(0.56)\"><g fill=\"#000\"><path d=\"M36 120 C35 90 37 70 42 60 C45 52 48 45 53 41 C57 37 63 36 67 38 C72 41 77 48 82 56 C86 62 90 67 91 71 C92 75 89 77 86 76 C84 76 82 77 80 78 C78 80 76 81 73 80 C73 86 71 92 67 98 C65 93 62 89 60 85 C59 92 59 100 60 120 Z\"/><path d=\"M65 38 C61 18 41 8 25 14 C15 18 10 28 15 40 C16 31 22 24 32 24 C42 24 49 31 51 42 Z\"/><path d=\"M51 49 C44 46 34 48 27 55 C26 56 27 57 28 57 C36 57 44 56 51 55 Z\"/></g><g fill=\"none\" stroke=\"#fff\" stroke-width=\"1.8\" stroke-linecap=\"round\"><path d=\"M56.2 32.2 L59.8 29.8\"/><path d=\"M50 25.8 L53 22.2\"/><path d=\"M42.6 21.6 L44.4 17.4\"/><path d=\"M34.2 20.4 L34.8 15.6\"/><path d=\"M25.4 23.4 L23.6 18.6\"/><path d=\"M18.8 30 L15.2 27\"/></g><path d=\"M69 53 Q72.5 50.5 76 53 Q72.5 54.5 69 53 Z\" fill=\"#fff\"/></g></g><g transform=\"translate(60 31)\" fill=\"#000\"><path d=\"M-7.5 4 L-7.5 -2 L-3.8 1.2 L0 -5 L3.8 1.2 L7.5 -2 L7.5 4 Z\"/><rect x=\"-7.5\" y=\"4.8\" width=\"15\" height=\"1.8\"/><circle cx=\"-7.5\" cy=\"-3\" r=\"1.1\"/><circle cx=\"0\" cy=\"-6.1\" r=\"1.2\"/><circle cx=\"7.5\" cy=\"-3\" r=\"1.1\"/></g><g fill=\"#000\"><path transform=\"translate(13.6 60)\" d=\"M0,-3.2 L0.94,-1.29 L3.04,-0.99 L1.52,0.49 L1.88,2.59 L0,1.6 L-1.88,2.59 L-1.52,0.49 L-3.04,-0.99 L-0.94,-1.29 Z\"/><path transform=\"translate(106.4 60)\" d=\"M0,-3.2 L0.94,-1.29 L3.04,-0.99 L1.52,0.49 L1.88,2.59 L0,1.6 L-1.88,2.59 L-1.52,0.49 L-3.04,-0.99 L-0.94,-1.29 Z\"/></g>";
  var TEXT = [
    { text: 'CERTIFIED GOAT', r: 43.1, size: 9.4, ls: 1.6, bottom: false },
    { text: 'GREATEST OF ALL TIME', r: 49.7, size: 7.6, ls: 1.1, bottom: true }
  ];
  function art(id) { return ART.split('{ID}').join(id || 'seal'); }
  function textSvg(id) {
    id = id || 'seal';
    return '<defs>' +
      '<path id="' + id + 'ArcTop" d="M60,60 m-43.1,0 a43.1,43.1 0 1,1 86.2,0"/>' +
      '<path id="' + id + 'ArcBot" d="M60,60 m-49.7,0 a49.7,49.7 0 0,0 99.4,0"/>' +
      '</defs>' +
      TEXT.map(function (t) {
        return '<text font-family="Cinzel,serif" font-weight="700" font-size="' + t.size + '" letter-spacing="' + t.ls +
          '" fill="#000" text-anchor="middle"><textPath href="#' + id + (t.bottom ? 'ArcBot' : 'ArcTop') +
          '" startOffset="50%">' + t.text + '</textPath></text>';
      }).join('');
  }
  function svg(id, px) {
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"' + (px ? ' width="' + px + '" height="' + px + '"' : '') +
      ' role="img" aria-label="Certified GOAT seal">' + art(id) + textSvg(id) + '</svg>';
  }
  root.GOOFY_SEAL = { art: art, textSvg: textSvg, svg: svg, TEXT: TEXT };
})(typeof window !== 'undefined' ? window : this);
